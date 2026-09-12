import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJobRunResult } from "../async/job-manager";
import type { CustomTool } from "../extensibility/custom-tools/types";
import workpoolBatchTemplate from "../prompts/tools/workpool-batch.md" with { type: "text" };
import workpoolTurnResultTemplate from "../prompts/tools/workpool-turn-result.md" with { type: "text" };
import { AgentRegistry, getLocalSession, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";
import type { ToolSession } from "../tools";
import { isIrcEnabled } from "../tools/hub";
import { ToolError } from "../tools/tool-errors";
import {
	DispatchAuthorizationError,
	type NormalizeResult,
	normalizeAndAuthorize,
	REMOTE_EXECUTION_NOT_WIRED,
} from "./dispatch";
import { RunBoundsLedger } from "./budget-tracker";
import type { AgentEndpoint } from "./endpoint";
import { createWorkpoolItem, ParamsError, type RunContract } from "./params";
import { runSubagentFollowUpTurn } from "./executor";
import {
	type EffectiveSubagentPolicy,
	reserveStructuredSubagentId,
	runStructuredSubagent,
} from "./structured-subagent";
import type { ExecutionTarget, TargetValidationError } from "./target";
import { type AgentProgress, oneLineLabel, type SingleResult, type TaskToolDetails } from "./types";
import { buildWorkPoolOutputSchema, type WorkPoolYieldItem } from "./workpool-yield";

/** One user-supplied unit tracked through a workpool batch. */
export interface WorkPoolItem {
	id: string;
	text: string;
	agentId?: string;
	batchId?: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled" | "execution-unknown";
}

/** Keep-alive subagent and its queued work within a pool. */
export interface WorkPoolAgent {
	id: string;
	index: number;
	/** Execution target bound at pool creation and inherited by this worker. */
	target: ExecutionTarget;
	state: "running" | "idle" | "dead" | "execution-unknown";
	queue: WorkPoolItem[];
	turns: number;
	contextTokens?: number;
	contextWindow?: number;
	jobId?: string;
}

/** One turn assigned to a pool agent and tracked as an internal job. */
export interface WorkPoolBatch {
	id: string;
	agentId: string;
	items: WorkPoolItem[];
	jobId: string;
	startedAt: number;
	status: "running" | "completed" | "failed" | "cancelled" | "execution-unknown";
	output?: string;
}

/** Aggregate pool activity returned by `WorkPool.status()`. */
export interface WorkPoolStatus {
	name: string;
	agent: string;
	limit: number;
	closed: boolean;
	freshAgents: boolean;
	agents: Array<{
		id: string;
		state: WorkPoolAgent["state"];
		queued: number;
		turns: number;
		contextTokens?: number;
		contextWindow?: number;
		current?: string;
	}>;
	items: Record<WorkPoolItem["status"], number>;
	batches: number;
}

/** Non-consuming batch snapshot returned by `WorkPool.peek()`. */
export interface WorkPoolPeekResult {
	batches: Array<{
		id: string;
		agent: string;
		items: string[];
		status: WorkPoolBatch["status"];
		output?: string;
	}>;
	pending: number;
}

/** Resolved policy and optional shared context used to create a pool. */
export interface WorkPoolCreateOptions {
	name: string;
	policy: EffectiveSubagentPolicy;
	context?: string;
	customTools?: CustomTool[];
	/** Explicit endpoint binding; never resolved from the process registry. */
	endpoint?: AgentEndpoint;
	contract?: RunContract;
	/**
	 * Normalized execution target bound to the pool at creation; every worker
	 * and follow-up inherits it. Omitted keeps the pre-target local path.
	 */
	target?: ExecutionTarget;
}

interface TurnOutcome {
	exitCode: number | null;
	output: string;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	paramsError?: ParamsError;
}

const DELIVERY_OUTPUT_LIMIT = 6_000;

/** One ToolError shape for both creation-time and per-run target verdicts. */
function workpoolTargetError(error: TargetValidationError | DispatchAuthorizationError): ToolError {
	return new ToolError(`${error.message} (code: ${error.code})`, { code: error.code });
}

/** Shared immutable local binding for pools created without an explicit target. */
const LOCAL_TARGET: ExecutionTarget = Object.freeze({ kind: "local" });

/**
 * Keep a frozen shallow copy of a bound target so the caller's object cannot be
 * mutated into a different endpoint after creation. The copy is verbatim: shape
 * validation stays the target validator's job, never this boundary's.
 */
function freezeBoundTarget(target: ExecutionTarget): ExecutionTarget {
	return Object.freeze({ ...target });
}

/** Dispatches queued items across keep-alive subagents under one aggregate job. */
export class WorkPool {
	readonly name: string;
	readonly ownerId: string;
	readonly session: ToolSession;
	readonly policy: EffectiveSubagentPolicy;
	/** Immutable execution target bound at creation; workers and follow-ups inherit it. */
	readonly target: ExecutionTarget;
	/**
	 * Creation-time authorization of {@link target} through the shared dispatcher.
	 * Always resolves: `undefined` for target-less pools (which stay on the legacy
	 * local path), otherwise the dispatcher verdict. Never rejects, so the
	 * synchronous constructor cannot leak an unhandled rejection; target-carrying
	 * creation awaits it before the pool becomes reachable or accepts work.
	 */
	readonly ready: Promise<NormalizeResult | undefined>;
	readonly context?: string;
	readonly customTools: CustomTool[];
	readonly freshAgents: boolean;
	readonly endpoint?: AgentEndpoint;
	readonly contract?: RunContract;
	readonly #bounds: RunBoundsLedger;
	readonly agents: WorkPoolAgent[] = [];
	readonly items: WorkPoolItem[] = [];
	readonly batches: WorkPoolBatch[] = [];
	closed = false;
	rrCursor = 0;

	/** Caller-supplied binding only: `undefined` keeps target-less pools on the legacy ungated local path. */
	readonly #boundTarget: ExecutionTarget | undefined;
	#nextAgentIndex = 1;
	#lastCardTs = 0;
	#dispatchChain: Promise<void> = Promise.resolve();
	#poolJobStarted = false;
	readonly #drainWaiters: PromiseWithResolvers<void>[] = [];
	readonly #freshQueue: WorkPoolItem[] = [];

	constructor(session: ToolSession, options: WorkPoolCreateOptions) {
		this.name = options.name;
		this.ownerId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		this.session = session;
		this.policy = options.policy;
		this.context = options.context;
		this.customTools = options.customTools ?? [];
		this.endpoint = options.endpoint;
		this.contract = options.contract;
		this.#bounds = new RunBoundsLedger(options.contract ?? {});
		const boundTarget = options.target === undefined ? undefined : freezeBoundTarget(options.target);
		this.target = boundTarget ?? LOCAL_TARGET;
		this.#boundTarget = boundTarget;
		this.ready =
			this.#boundTarget === undefined ? Promise.resolve(undefined) : this.#gateCreationTarget(this.#boundTarget);
		this.freshAgents = options.contract?.freshAgents ?? session.settings.get("eval.workpool.freshAgents");
		if (!session.asyncJobManager) {
			throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		}
		if (session.asyncJobManager.getJob(this.name)) {
			throw new ToolError(`workpool job id "${this.name}" already exists`);
		}
	}

	/** Current worker ceiling from the live `task.maxConcurrency` setting. */
	limit(): number {
		const configured = this.session.settings.get("task.maxConcurrency");
		return configured > 0 ? configured : Infinity;
	}

	/** Queue items and start the aggregate pool job on the first non-empty push. */
	push(texts: string[]): string[] {
		if (this.closed) throw new ToolError(`workpool ${this.name} is closed`);
		if (texts.length === 0) return [];
		const queued: WorkPoolItem[] = [];
		for (const text of texts) {
			const item: WorkPoolItem = { ...createWorkpoolItem(text), status: "queued" };
			this.items.push(item);
			queued.push(item);
		}
		this.#ensurePoolJob();
		for (const item of queued) this.#queueDispatch(item);
		return queued.map(item => item.id);
	}

	#ensurePoolJob(): void {
		if (this.#poolJobStarted) return;
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		if (manager.getJob(this.name)) throw new ToolError(`workpool job id "${this.name}" already exists`);
		this.#poolJobStarted = true;
		const id = manager.register(
			"task",
			this.name,
			async ({ signal }) => {
				const onAbort = (): void => {
					this.close();
					for (const batch of this.batches) manager.cancel(batch.jobId, { ownerId: this.ownerId });
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				try {
					await this.#waitForDrain();
					const batchIds = this.batches.map(batch => batch.jobId);
					await Promise.allSettled(
						batchIds.flatMap(batchId => {
							const job = manager.getJob(batchId);
							return job ? [job.promise] : [];
						}),
					);
					manager.consumeJobResults(batchIds);
					manager.unwatchJobs(batchIds);
					this.closed = true;
					const summary = `Pool \`${this.name}\` drained: ${this.items.length} item(s), ${this.batches.length} batch(es).`;
					// D2 dependency: draining an unobservable batch does not turn its outcome into success.
					const unknown = this.batches.some(batch => batch.status === "execution-unknown");
					this.#card(unknown ? "execution-unknown" : signal.aborted ? "cancelled" : "completed", this.ownerId, summary);
					const text = this.#renderAggregateResult();
					return unknown ? { status: "execution-unknown" as const, text } : text;
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			},
			{ id: this.name, ownerId: this.ownerId, queued: true },
		);
		if (id !== this.name) {
			manager.cancel(id, { ownerId: this.ownerId });
			throw new ToolError(`workpool job id "${this.name}" is unavailable`);
		}
	}

	async #waitForDrain(): Promise<void> {
		if (this.#isDrained() && (!this.contract?.keepAlive || this.closed)) return;
		const waiter = Promise.withResolvers<void>();
		this.#drainWaiters.push(waiter);
		await waiter.promise;
	}

	#isDrained(): boolean {
		return !this.items.some(item => item.status === "queued" || item.status === "running");
	}

	#notifyDrained(): void {
		if (!this.#isDrained() || (this.contract?.keepAlive && !this.closed)) return;
		for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve();
	}

	#queueDispatch(item: WorkPoolItem): void {
		this.#dispatchChain = this.#dispatchChain
			.then(() => this.#dispatch(item))
			.catch(error => {
				if (item.status === "queued") item.status = "failed";
				logger.warn("workpool: item dispatch failed", {
					pool: this.name,
					item: item.id,
					error: error instanceof Error ? error.message : String(error),
				});
				this.#notifyDrained();
			});
	}

	#contextLoad(agent: WorkPoolAgent): number {
		const tokens = agent.contextTokens ?? 0;
		const window = agent.contextWindow;
		return window !== undefined && window > 0 ? tokens / window : tokens;
	}

	#leastLoadedIdle(): WorkPoolAgent | undefined {
		let selected: WorkPoolAgent | undefined;
		let selectedLoad = Infinity;
		for (const agent of this.agents) {
			if (agent.state !== "idle") continue;
			const load = this.#contextLoad(agent);
			if (load >= selectedLoad) continue;
			selected = agent;
			selectedLoad = load;
		}
		return selected;
	}

	async #dispatch(item: WorkPoolItem): Promise<void> {
		if (this.closed || item.status !== "queued") return;
		if (this.freshAgents) {
			if (this.agents.length < this.limit()) {
				await this.#spawn(item);
			} else {
				this.#freshQueue.push(item);
				this.#card("queued", this.name, `[${item.id}] ${item.text}`);
			}
			return;
		}
		const idle = this.#leastLoadedIdle();
		if (idle) {
			item.agentId = idle.id;
			idle.queue.push(item);
			this.#card("dispatched", idle.id, `[${item.id}] ${item.text}`);
			this.#drain(idle);
			return;
		}
		if (this.agents.length < this.limit()) {
			await this.#spawn(item);
			return;
		}
		const busy = this.#nextBusy();
		if (!busy) {
			await this.#spawn(item);
			return;
		}
		item.agentId = busy.id;
		busy.queue.push(item);
		this.#card("queued", busy.id, `[${item.id}] ${item.text}`);
	}

	async #spawn(item: WorkPoolItem): Promise<void> {
		const index = this.#nextAgentIndex++;
		const id = this.endpoint
			? crypto.randomUUID()
			: await reserveStructuredSubagentId(this.session, { label: `${this.name}-${index}` });
		if (this.closed || item.status !== "queued") return;
		const agent: WorkPoolAgent = { id, index, target: this.target, state: "running", queue: [item], turns: 0 };
		item.agentId = id;
		this.agents.push(agent);
		this.#card("spawned", id, `[${item.id}] ${item.text}`);
		this.#drain(agent);
	}

	#nextBusy(): WorkPoolAgent | undefined {
		if (this.agents.length === 0) return undefined;
		for (let offset = 0; offset < this.agents.length; offset++) {
			const index = (this.rrCursor + offset) % this.agents.length;
			const agent = this.agents[index];
			if (agent?.state === "running") {
				this.rrCursor = (index + 1) % this.agents.length;
				return agent;
			}
		}
		return undefined;
	}

	#drain(agent: WorkPoolAgent): void {
		if (agent.queue.length === 0) {
			agent.state = "idle";
			this.#notifyDrained();
			return;
		}
		const items = agent.queue.splice(0);
		const id = `${agent.id}-b${agent.turns + 1}`;
		const batch: WorkPoolBatch = {
			id,
			agentId: agent.id,
			items,
			jobId: id,
			startedAt: Date.now(),
			status: "running",
		};
		for (const item of items) {
			item.status = "running";
			item.agentId = agent.id;
			item.batchId = batch.id;
		}
		agent.state = "running";
		agent.jobId = batch.jobId;
		this.batches.push(batch);
		const message = this.#batchMessage(batch);
		if (agent.turns > 0) this.#card("batch", agent.id, message);
		this.#startTurn(agent, batch, message);
	}

	#batchMessage(batch: WorkPoolBatch): string {
		return prompt.render(workpoolBatchTemplate, {
			pool: this.name,
			batch: batch.id,
			items: batch.items.map((item, index) => ({ id: item.id, index: index + 1, text: item.text })),
		});
	}

	/** Normalize and authorize a target through the shared dispatcher for this pool's entry point. */
	async #normalizeTarget(target: ExecutionTarget): Promise<NormalizeResult> {
		return await normalizeAndAuthorize(target, {
			session: this.session,
			entryPoint: "workpool",
			agent: this.policy.agentName,
		});
	}

	/** Creation gate that resolves every outcome as data instead of rejecting. */
	async #gateCreationTarget(target: ExecutionTarget): Promise<NormalizeResult> {
		try {
			return await this.#normalizeTarget(target);
		} catch (error) {
			return {
				status: "error",
				error: new DispatchAuthorizationError(
					"target-invalid",
					error instanceof Error ? error.message : String(error),
				),
			};
		}
	}

	/**
	 * Re-normalize and authorize the worker's inherited target before a run. A
	 * pool created without a target skips this entirely, so legacy pools never
	 * pick up target authorization; an explicit binding first honors the
	 * creation-time verdict from {@link ready} — a pool built directly around an
	 * unusable target cannot later run merely because host or policy state
	 * changed — then clears the dispatcher again for this worker and follow-up
	 * run (and has no production ssh execution path yet).
	 */
	async #authorizeTarget(worker: WorkPoolAgent): Promise<void> {
		if (this.#boundTarget === undefined) return;
		// The worker must still carry the creation-time binding object itself; a
		// replaced/rebuilt target is an attempt to re-point the pool mid-flight.
		if (worker.target !== this.#boundTarget) {
			throw new ToolError("workpool binds target at creation");
		}
		const creation = await this.ready;
		if (creation?.status === "error") throw workpoolTargetError(creation.error);
		if (creation?.status === "ssh") throw new ToolError(REMOTE_EXECUTION_NOT_WIRED);
		const gate = await this.#normalizeTarget(worker.target);
		if (gate.status === "local") return;
		if (gate.status === "error") throw workpoolTargetError(gate.error);
		throw new ToolError(REMOTE_EXECUTION_NOT_WIRED);
	}

	#startTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, message: string): void {
		if (this.endpoint) {
			this.#startEndpointTurn(agent, batch, message);
			return;
		}
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		const workPoolYieldItems: WorkPoolYieldItem[] = batch.items.map((item, index) => ({
			id: item.id,
			index: index + 1,
		}));
		const outputSchema = buildWorkPoolOutputSchema(workPoolYieldItems);
		const jobId = manager.register(
			"task",
			batch.id,
			async ({ signal, reportProgress, markRunning }) => {
				markRunning();
				const onProgress = (progress: AgentProgress): void => {
					if (progress.contextTokens !== undefined) agent.contextTokens = progress.contextTokens;
					if (progress.contextWindow !== undefined) agent.contextWindow = progress.contextWindow;
					const details: TaskToolDetails = {
						projectAgentsDir: null,
						results: [],
						totalDurationMs: Date.now() - batch.startedAt,
						progress: [progress],
					};
					void reportProgress(`Running agent ${agent.id}...`, { ...details });
				};
				let result: SingleResult;
				try {
					await this.#authorizeTarget(agent);
					if (agent.turns === 0) {
						const execution = await runStructuredSubagent({
							session: this.session,
							invocationKind: "eval",
							contract: this.#initialContract(message),
							boundsLedger: this.#bounds,
							assignment: message,
							...(this.context ? { context: this.context } : {}),
							agent: this.policy.agentName,
							identity: { id: agent.id },
							customTools: this.customTools,
							outputSchema,
							schemaMode: "strict",
							workPoolYieldItems,
							keepAlive: true,
							retainArtifacts: true,
							shareEvalSession: false,
							enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
							signal,
							onProgress,
						});
						result = execution.result;
					} else {
						result = await runSubagentFollowUpTurn({
							id: agent.id,
							contract: {
								task: message,
								context: this.contract?.context,
								outputSchema: this.contract?.outputSchema ?? outputSchema,
								schemaMode: this.contract?.schemaMode ?? "strict",
								timeout: this.contract?.timeout,
								budget: this.contract?.budget,
								depth: this.contract?.depth,
								spawns: this.contract?.spawns,
							},
							boundsLedger: this.#bounds,
							agent: this.policy.agent,
							message,
							outputSchema,
							outputSchemaMode: "strict",
							outputSchemaSource: "caller",
							workPoolYieldItems,
							signal,
							onProgress,
							eventBus: this.session.eventBus,
							subagentEventBus: this.session.subagentEventBus,
							artifactsDir: this.session.getSessionFile()?.slice(0, -6),
							maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
						});
					}
				} catch (error) {
					const output = error instanceof Error ? error.message : String(error);
					return this.#settleTurn(agent, batch, { exitCode: 1, output, error: output });
				}
				return this.#settleTurn(agent, batch, result);
			},
			{ id: batch.id, agentId: agent.id, ownerId: this.ownerId },
		);
		batch.jobId = jobId;
		agent.jobId = jobId;
		manager.watchJobs([jobId]);
	}

	#initialContract(message: string): RunContract {
		const { freshAgents: _freshAgents, workpoolItems: _items, ...contract } = this.contract ?? { task: message };
		return { ...contract, task: message };
	}

	#startEndpointTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, message: string): void {
		const endpoint = this.endpoint!;
		const manager = this.session.asyncJobManager!;
		const jobId = manager.register(
			"task",
			batch.id,
			async ({ signal, markRunning }) => {
				markRunning();
				let result: TurnOutcome;
				try {
					await this.#authorizeTarget(agent);
					const denied = this.#bounds.reserve({ spawn: agent.turns === 0 });
					if (denied) throw denied;
					const remaining = this.#bounds.remainingTimeoutMs();
					const runSignal = remaining === undefined
						? signal
						: AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, Math.ceil(remaining)))]);
					const contract: RunContract = {
						...this.contract,
						task: message,
						workpoolItems: batch.items.map(({ id, text }) => ({ id, text })),
						...(this.contract?.freshAgents === undefined ? {} : { freshAgents: this.freshAgents }),
					};
					const ack = await endpoint.start(message, { runId: batch.id, signal: runSignal, contract });
					const outcome = await endpoint.run(ack.runId, { signal: runSignal, contract });
					const boundsError = outcome.usage
						? this.#bounds.recordUsage(outcome.usage.totalTokens)
						: this.#bounds.check();
					result = {
						exitCode: outcome.status === "execution-unknown" ? null : outcome.status === "completed" ? 0 : 1,
						output: outcome.text ?? "",
						error: outcome.error ?? boundsError?.message,
						paramsError: outcome.paramsError ?? boundsError,
						aborted: outcome.status === "cancelled",
					};
				} catch (error) {
					const output = error instanceof Error ? error.message : String(error);
					result = {
						exitCode: 1,
						output,
						error: output,
						...(error instanceof ParamsError ? { paramsError: error } : {}),
					};
				}
				return this.#settleTurn(agent, batch, result);
			},
			{ id: batch.id, agentId: agent.id, ownerId: this.ownerId },
		);
		batch.jobId = jobId;
		agent.jobId = jobId;
		manager.watchJobs([jobId]);
	}

	#settleTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): string | AsyncJobRunResult {
		this.#finishTurn(agent, batch, result);
		const delivery = this.#renderTurnResult(agent, batch, result);
		if (batch.status === "execution-unknown") return { status: "execution-unknown", text: delivery };
		if (batch.status !== "completed") {
			if (result.paramsError) throw new ToolError(delivery, { paramsError: result.paramsError, code: result.paramsError.code });
			throw new Error(delivery);
		}
		return delivery;
	}

	#finishTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): void {
		// D2 dependency: a missing exit verdict is neither failure nor cancellation.
		batch.status = result.exitCode === null
			? "execution-unknown"
			: result.aborted ? "cancelled" : result.exitCode !== 0 || result.error ? "failed" : "completed";
		batch.output = result.output;
		for (const item of batch.items) item.status = batch.status;
		agent.turns++;
		agent.jobId = undefined;
		const ref = this.endpoint ? undefined : AgentRegistry.global().get(agent.id);
		if (!this.endpoint) getLocalSession(ref)?.setWorkPoolYieldItems([]);
		if (this.freshAgents) {
			agent.state = batch.status === "execution-unknown" ? "execution-unknown" : "dead";
			const index = this.agents.indexOf(agent);
			if (index !== -1) this.agents.splice(index, 1);
			const next = this.#freshQueue.shift();
			if (next) this.#queueDispatch(next);
			this.#notifyDrained();
			return;
		}
		if ((this.endpoint && batch.status === "completed") || (ref && (ref.status === "idle" || ref.status === "parked"))) {
			this.#drain(agent);
		} else {
			agent.state = batch.status === "execution-unknown" ? "execution-unknown" : "dead";
			const stranded = agent.queue.splice(0);
			const index = this.agents.indexOf(agent);
			if (index !== -1) this.agents.splice(index, 1);
			for (const item of stranded) {
				item.agentId = undefined;
				item.batchId = undefined;
				this.#queueDispatch(item);
			}
		}
		this.#notifyDrained();
	}

	#renderAggregateResult(): string {
		const lines = [
			`Pool \`${this.name}\` completed (${this.items.length} item(s), ${this.batches.length} batch(es)).`,
		];
		for (const batch of this.batches) {
			lines.push("", `## ${batch.id} · agent \`${batch.agentId}\` · ${batch.status}`);
			for (const item of batch.items) {
				lines.push(`- [${item.id}] ${item.status} — ${oneLineLabel(item.text)}`);
			}
			const output = batch.output?.trim();
			if (output) lines.push("", output);
			lines.push(`Transcript: history://${batch.agentId} · full output: agent://${batch.agentId}`);
		}
		lines.push("", "Pool queue drained.");
		return lines.join("\n");
	}

	#renderTurnResult(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): string {
		const remaining = this.items.filter(item => item.status === "queued" || item.status === "running").length;
		const output = result.output.trim() || result.error || result.abortReason || "(no output)";
		const renderedOutput =
			output.length <= DELIVERY_OUTPUT_LIMIT
				? output
				: `${output.slice(0, DELIVERY_OUTPUT_LIMIT)}\n[output truncated to ${DELIVERY_OUTPUT_LIMIT} characters]`;
		return prompt.render(workpoolTurnResultTemplate, {
			pool: this.name,
			agent: agent.id,
			batch: batch.id,
			status: batch.status,
			count: batch.items.length,
			multiple: batch.items.length !== 1,
			items: batch.items.map(item => ({ id: item.id, status: item.status, text: oneLineLabel(item.text) })),
			output: renderedOutput,
			remaining,
		});
	}

	/** Return current workers, item counts, and context usage. */
	status(): WorkPoolStatus {
		const counts: WorkPoolStatus["items"] = {
			queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, "execution-unknown": 0,
		};
		for (const item of this.items) counts[item.status]++;
		return {
			name: this.name,
			agent: this.policy.agentName,
			limit: this.limit(),
			closed: this.closed,
			freshAgents: this.freshAgents,
			agents: this.agents.map(agent => ({
				id: agent.id,
				state: agent.state,
				queued: agent.queue.length,
				turns: agent.turns,
				...(agent.contextTokens !== undefined ? { contextTokens: agent.contextTokens } : {}),
				...(agent.contextWindow !== undefined ? { contextWindow: agent.contextWindow } : {}),
				...(agent.jobId ? { current: agent.jobId } : {}),
			})),
			items: counts,
			batches: this.batches.length,
		};
	}

	/** Return batch results without consuming the aggregate job delivery. */
	peek(): WorkPoolPeekResult {
		return {
			batches: this.batches.map(batch => ({
				id: batch.id,
				agent: batch.agentId,
				items: batch.items.map(item => item.id),
				status: batch.status,
				...(batch.output !== undefined ? { output: batch.output } : {}),
			})),
			pending: this.items.filter(item => item.status === "queued" || item.status === "running").length,
		};
	}

	/** Stop accepting work and cancel items not yet assigned to a turn. */
	close(): { dropped: string[] } {
		this.closed = true;
		const dropped: string[] = [];
		for (const item of this.items) {
			if (item.status !== "queued") continue;
			item.status = "cancelled";
			dropped.push(item.id);
		}
		for (const agent of this.agents) agent.queue.splice(0);
		this.#freshQueue.splice(0);
		this.#notifyDrained();
		return { dropped };
	}

	#card(
		mode: "spawned" | "dispatched" | "queued" | "batch" | "completed" | "cancelled" | "execution-unknown",
		agentId: string,
		body: string,
	): void {
		if (this.endpoint) return;
		const timestamp = Math.max(Date.now(), this.#lastCardTs + 1);
		this.#lastCardTs = timestamp;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:workpool",
			content: `[pool ${this.name} → ${agentId}]\n\n${body}`,
			display: true,
			details: { pool: this.name, from: `pool:${this.name}`, to: agentId, body, mode },
			attribution: "agent",
			timestamp,
		};
		try {
			getLocalSession(AgentRegistry.global().get(this.ownerId))?.emitIrcRelayObservation(record);
		} catch (error) {
			logger.debug("workpool: card emission failed", {
				pool: this.name,
				agent: agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** Process-local workpool registry scoped by owner id and pool name. */
export class WorkPoolRegistry {
	static #instance: WorkPoolRegistry | undefined;

	/** Return the process-global workpool registry. */
	static global(): WorkPoolRegistry {
		WorkPoolRegistry.#instance ??= new WorkPoolRegistry();
		return WorkPoolRegistry.#instance;
	}

	/** Replace the global registry with an empty instance for tests. */
	static resetForTests(): void {
		WorkPoolRegistry.#instance = new WorkPoolRegistry();
	}

	readonly #pools = new Map<string, WorkPool>();

	#key(ownerId: string, name: string): string {
		return `${ownerId}\0${name}`;
	}

	/**
	 * Create a pool and complete its creation-time target authorization before
	 * registering it. Target-carrying creation uses this async path so an
	 * unauthorized target never registers a pool; the synchronous {@link create}
	 * stays for target-less callers.
	 */
	async createAuthorized(session: ToolSession, options: WorkPoolCreateOptions): Promise<WorkPool> {
		const ownerId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const key = this.#key(ownerId, options.name);
		if (this.#pools.has(key)) throw new ToolError(`workpool "${options.name}" already exists`);
		const pool = new WorkPool(session, options);
		const gate = await pool.ready;
		if (gate?.status === "error") throw workpoolTargetError(gate.error);
		if (gate?.status === "ssh") throw new ToolError(REMOTE_EXECUTION_NOT_WIRED);
		// Re-check after the await: a concurrent create may have claimed the name.
		if (this.#pools.has(key)) throw new ToolError(`workpool "${options.name}" already exists`);
		this.#pools.set(key, pool);
		return pool;
	}

	/**
	 * Create a uniquely named pool for the session owner. Target-carrying
	 * creation must go through {@link createAuthorized}, which completes the
	 * creation-time authorization before the pool is registered.
	 */
	create(session: ToolSession, options: WorkPoolCreateOptions): WorkPool {
		if (options.target !== undefined) {
			throw new ToolError("workpool target binding requires createAuthorized()");
		}
		const ownerId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const key = this.#key(ownerId, options.name);
		if (this.#pools.has(key)) throw new ToolError(`workpool "${options.name}" already exists`);
		const pool = new WorkPool(session, options);
		this.#pools.set(key, pool);
		return pool;
	}

	/** Find one pool without creating it. */
	get(ownerId: string, name: string): WorkPool | undefined {
		return this.#pools.get(this.#key(ownerId, name));
	}

	/** Close and forget every pool owned by an ending session. */
	releaseOwner(ownerId: string): void {
		for (const [key, pool] of this.#pools) {
			if (pool.ownerId !== ownerId) continue;
			pool.close();
			this.#pools.delete(key);
		}
	}
}
