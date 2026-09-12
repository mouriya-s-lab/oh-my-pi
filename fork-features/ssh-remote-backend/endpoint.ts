/**
 * SSH (remote) implementation of {@link AgentEndpoint} (RFC #1 §8 D1/D2, #10).
 *
 * One endpoint wraps one managed {@link RpcClient} — the SSH transport built by
 * `./transport.ts` — and turns the facts that client actually publishes into
 * the endpoint contract: a run receipt, one outcome per run, the reply-drained
 * fact, and the control pair the monitor drives. It creates no session, drives
 * no parser, and duplicates no executor: every fact it reports is either a
 * managed frame from the peer (run ids, terminal statuses, the drain report) or
 * an observation of the peer's own event stream (assistant text and usage).
 *
 * ## Run identity
 *
 * The peer mints run ids. `RpcClient.prompt()` is the assignment channel and
 * resolves with a plain ACK that carries no id, so the endpoint takes the id
 * from the `managed_run_start` frame — every id it hands out or addresses
 * (`RunAck.runId`, `run`, `cancelRun`, `park`, `waitReplyDrained`) is the peer's,
 * never a locally minted one. The start frame is emitted by the peer before it
 * answers the prompt, and both are read off the same ordered stream, so a
 * successful ACK can never lack its frame.
 *
 * ## Text and usage
 *
 * Assistant text and usage are captured per run from `client.onEvent` while
 * the run is in flight, and dropped when it settles. Nothing is fetched after
 * the terminal frame: `get_last_assistant_text`-style reads can answer with the
 * *previous* run's text (a local-only run produces no assistant message at
 * all). A run that produced no text reports none, rather than borrowing an
 * earlier run's.
 *
 * ## Verdicts
 *
 * The terminal status is the peer's, mapped verbatim. `execution-unknown` is
 * reserved for the case the peer can no longer be observed — the managed
 * connection reports `execution-unknown` (output loss, receive-lease lapse,
 * termination) with a run still in flight — and it is never rewritten into
 * `failed` or `cancelled`: a silent connection proves nothing about what the
 * far side did with the work. A verdict already observed is never overwritten,
 * so a transport failure *after* a known terminal state leaves that verdict
 * untouched.
 *
 * ## Deferrals
 *
 * `deliverIrc` uses the managed bidirectional side-channel; only its delivery
 * receipt settles delivery. Resource reads and UI responses remain explicit
 * deferrals to #13, never fabricated bytes or acknowledgements.
 *
 * Direct control remains available through {@link SshBackendEndpoint.transport}:
 * `transport.client.getState()` / `.abort()` are diagnostics on the peer's own
 * session, while `start()` below carries an LLM assignment — the two are not
 * interchangeable, and this adapter never re-labels one as the other.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import { isRecord, untilAborted } from "@oh-my-pi/pi-utils";
import { toIrcDeliveryReceipt } from "../../packages/coding-agent/src/irc/inbound";
import { RpcClientError, type RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client";
import type { RpcManagedRunEvent } from "../../packages/coding-agent/src/modes/rpc/rpc-types";
import { AgentRegistry } from "../../packages/coding-agent/src/registry/agent-registry";
import {
	type AgentEndpoint,
	type AgentEndpointHandle,
	type EndpointControlAck,
	type EndpointEvent,
	EndpointEventStream,
	type EndpointSnapshot,
	type EndpointSnapshotResult,
	type IrcDeliveryOptions,
	type IrcDeliveryReceipt,
	type IrcInboundEnvelope,
	type PrepareResult,
	type ResourceReadResult,
	type RunAck,
	type RunOpts,
	type RunOutcome,
	type RunOutcomeStatus,
} from "../../packages/coding-agent/src/task/endpoint";
import {
	ResourceOwnershipError,
	type ResourceReadQuery,
	type UiRequest,
	type UiResponse,
} from "../../packages/coding-agent/src/task/resource";
import { ReplyDrainedBarrier, type ReplyDrainedResult } from "../../packages/coding-agent/src/task/reply-drained";
import type { SshBackendTransport } from "./transport";

/** One finite numeric field of an untrusted record; anything else is absent. */
function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Append the text blocks of one assistant message payload, in order, to the run's buffer. */
function appendAssistantText(target: string[], content: unknown): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type !== "text" || typeof block.text !== "string" || block.text.length === 0) continue;
		target.push(block.text);
	}
}

/**
 * Add one assistant message's provider-reported usage into the run's running
 * totals, which are kept directly in the {@link Usage} shape so the eventual
 * outcome can carry them as read. `reasoningTokens` joins only once a message
 * reports it: absent means unreported, never zero.
 */
function accumulateUsage(totals: Usage, usage: unknown): void {
	if (!isRecord(usage)) return;
	totals.input += numberField(usage, "input") ?? 0;
	totals.output += numberField(usage, "output") ?? 0;
	totals.cacheRead += numberField(usage, "cacheRead") ?? 0;
	totals.cacheWrite += numberField(usage, "cacheWrite") ?? 0;
	totals.totalTokens += numberField(usage, "totalTokens") ?? 0;
	const reasoning = numberField(usage, "reasoningTokens");
	if (reasoning !== undefined) totals.reasoningTokens = (totals.reasoningTokens ?? 0) + reasoning;
	const cost = usage.cost;
	if (!isRecord(cost)) return;
	totals.cost.input += numberField(cost, "input") ?? 0;
	totals.cost.output += numberField(cost, "output") ?? 0;
	totals.cost.cacheRead += numberField(cost, "cacheRead") ?? 0;
	totals.cost.cacheWrite += numberField(cost, "cacheWrite") ?? 0;
	totals.cost.total += numberField(cost, "total") ?? 0;
}

/**
 * Adapter over one managed RPC connection to a remote peer's session.
 *
 * Passive like the local adapter: it observes the client the transport already
 * started and delegates every control to it. The peer's session already exists
 * on the far side; `prepare()` reports the role and capabilities the factory
 * negotiated with that peer, `start()` hands it an assignment, and `run()`
 * reports the verdict the peer's terminal frame carries.
 */
export class SshBackendEndpoint implements AgentEndpoint {
	/** The peer reference this endpoint was built around; opaque to everyone above. */
	readonly handle: AgentEndpointHandle;
	/** The SSH transport, exposed so diagnostics can reach the client without an LLM assignment. */
	readonly transport: SshBackendTransport;
	readonly #client: RpcClient;
	readonly #prepared: PrepareResult;
	readonly #events: EndpointEventStream;
	readonly #barrier = new ReplyDrainedBarrier();
	#unsubscribeRunEvents: (() => void) | undefined;
	#unsubscribeReplyBarrier: (() => void) | undefined;
	#unsubscribeLifecycle: (() => void) | undefined;
	#unsubscribeCapture: (() => void) | undefined;
	#detachIrcEndpoint: (() => void) | undefined;
	#currentRunId: string | null = null;
	#currentStatus: EndpointSnapshot["status"] = "idle";
	#lastMessage: string | undefined;
	/** The current run's single verdict; absent while it is still in flight. First writer wins. */
	#verdict: RunOutcome | undefined;
	#terminalRevision: number | undefined;
	/** True once the peer reported the current run's replies drained; the other half of ownership. */
	#repliesDrained = false;
	/** In-flight `start()` waiting for the peer's `managed_run_start`; guards concurrent starts. */
	#pendingStart: PromiseWithResolvers<RunAck> | undefined;
	/** Callers waiting on `run()` for the current run; they share the one verdict. */
	#runWaiter: PromiseWithResolvers<RunOutcome> | undefined;
	#capturedText: string[] = [];
	#capturedError: string | undefined;
	/** The current run's accumulated usage; absent until a message reports any. */
	#capturedUsage: Usage | undefined;
	/** Memoized teardown, so repeated `terminate()` calls run it once. */
	#termination: Promise<void> | undefined;
	/** True once teardown started; a terminated endpoint never accepts another run. */
	#terminated = false;

	constructor(transport: SshBackendTransport, prepared: PrepareResult, reference: string) {
		this.transport = transport;
		this.#client = transport.client;
		this.#prepared = prepared;
		this.handle = { kind: "remote", reference };
		this.#events = new EndpointEventStream(this.handle.kind, () => this.#snapshot());
		this.#observe();
		const binding = this.#client.getIrcBinding();
		if (binding) {
			this.#detachIrcEndpoint = AgentRegistry.global().attachManagedEndpoint(
				binding.ownerPeerId, binding.generation, this,
			);
		}
	}

	/** The role and capabilities the factory negotiated with the peer; nothing is probed here. */
	async prepare(): Promise<PrepareResult> {
		return { role: { ...this.#prepared.role }, capabilities: [...this.#prepared.capabilities] };
	}

	/**
	 * Hand the peer one assignment and return the receipt its own run id names.
	 *
	 * Subscribing happens before the write (the listeners are live for the whole
	 * endpoint lifetime), and the receipt waits for both facts the contract
	 * needs: the prompt ACK — the peer accepted the command — and the
	 * `managed_run_start` frame, which is the only place the real run id exists.
	 * A rejected prompt is reported as the rejection it is; a run that was
	 * nevertheless started stays tracked, so its terminal frame cannot land on
	 * an endpoint that believes it is idle.
	 */
	async start(assignment: string, opts?: RunOpts): Promise<RunAck> {
		opts?.signal?.throwIfAborted();
		if (this.#terminated)
			throw new Error("SshBackendEndpoint.start: the endpoint is terminated and cannot accept another run");
		if (this.#pendingStart !== undefined)
			throw new Error("SshBackendEndpoint.start: another start is already waiting for its run id");
		if (this.#currentRunId !== null && this.#verdict === undefined)
			throw new Error(
				`SshBackendEndpoint.start: run ${JSON.stringify(this.#currentRunId)} is still in flight`,
			);
		if (this.#client.getManagedLifecycle().status === "inactive")
			throw new Error(
				"SshBackendEndpoint.start: the managed bootstrap has not completed, so the peer would never announce a run",
			);
		const deferred = Promise.withResolvers<RunAck>();
		this.#pendingStart = deferred;
		this.#lastMessage = assignment.trim() || undefined;
		const previousRunId = this.#currentRunId;
		try {
			// Both half-facts are required; `Promise.all` observes each rejection,
			// so a failure on one arm never surfaces as an unhandled rejection on
			// the other.
			const request = opts?.contract === undefined
				? this.#client.prompt(assignment)
				: this.#client.startRun(assignment, opts.contract);
			const prompt = request.then(() => {
				if (this.#currentRunId === previousRunId) {
					throw new RpcClientError("protocol-incompatible", "Prompt acknowledgement omitted its managed run-start frame");
				}
			});
			const [, ack] = await Promise.all([prompt, deferred.promise]);
			return ack;
		} finally {
			this.#pendingStart = undefined;
		}
	}

	/** Wait for the current run's single verdict, which the peer's terminal frame decides. */
	async run(runId: string, signalOrOpts?: AbortSignal | RunOpts): Promise<RunOutcome> {
		const signal = signalOrOpts instanceof AbortSignal ? signalOrOpts : signalOrOpts?.signal;
		this.#assertCurrent(runId, "run");
		// A verdict that already landed is a fact, not a pending wait: report it
		// even when the caller's signal has aborted the wait it no longer needs.
		const settled = this.#verdict;
		if (settled !== undefined) return settled;
		this.#runWaiter ??= Promise.withResolvers<RunOutcome>();
		return untilAborted(signal, this.#runWaiter.promise);
	}

	/**
	 * Cancel the run through the peer and report its cleanup verdict.
	 *
	 * The peer's `cancel_run` answer says whether the run's work was cancelled
	 * *and* its replies drained; `cleanup-unconfirmed` is an explicit failure to
	 * confirm that, so it is raised instead of being returned as a slow success.
	 * The endpoint never records a cancellation the peer did not report: the
	 * verdict still comes from the run's terminal frame.
	 */
	async cancelRun(runId: string): Promise<void> {
		this.#assertCurrent(runId, "cancelRun");
		const result = await this.#client.cancelRun(runId);
		if (result.status === "cleanup-unconfirmed")
			throw new Error(
				`SshBackendEndpoint.cancelRun: cleanup unconfirmed for ${JSON.stringify(runId)}: ${result.detail}`,
			);
	}

	/**
	 * Ask the peer to terminate the session and release this connection.
	 *
	 * Order matters: the peer is asked first, while the connection still exists,
	 * and the transport is closed afterwards — whichever way the exchange went.
	 * Closing *is* the release, so an unacknowledged termination (the peer is
	 * gone, which is exactly when its answer is unreachable) is not turned into
	 * a failed teardown; explicit peer refusals are still surfaced after release.
	 * The call is idempotent: concurrent and repeated calls share one teardown.
	 */
	async terminate(): Promise<void> {
		if (this.#termination) return this.#termination;
		const termination = this.#teardown();
		this.#termination = termination;
		try {
			await termination;
		} catch (error) {
			// Preserve the failure and allow an explicit cleanup retry.
			if (this.#termination === termination) this.#termination = undefined;
			throw error;
		}
	}

	async snapshot(): Promise<EndpointSnapshotResult> {
		return { revision: this.#events.revision, snapshot: this.#snapshot() };
	}

	subscribe(fromRevision?: number): AsyncIterable<EndpointEvent> {
		return this.#events.subscribe(fromRevision);
	}

	/** Forward the existing envelope; the RPC receipt is distinct from the ACK and reply. */
	async deliverIrc(envelope: IrcInboundEnvelope, options?: IrcDeliveryOptions): Promise<IrcDeliveryReceipt> {
		const result = await this.#client.deliverIrc(envelope, {
			operationId: options?.operationId ?? envelope.id,
			targetPeerId: envelope.to,
			generation: options?.generation,
			expectsReply: options?.expectsReply,
			suppressRelay: options?.suppressRelay,
			wake: options?.wake,
		});
		return toIrcDeliveryReceipt(result);
	}

	/**
	 * Wait for both the peer's terminal event and its separate reply-drained
	 * barrier. `run_end` alone cannot prove that preceding outbound replies have
	 * reached their receipt boundary; a lost connection never fabricates a drain.
	 */
	async waitReplyDrained(runId: string, opts?: { signal?: AbortSignal }): Promise<ReplyDrainedResult> {
		return this.#barrier.await(runId, opts?.signal);
	}

	/**
	 * Park the current run through the peer. A run id this endpoint never
	 * accepted is refused here — it is not a run this endpoint can address — and
	 * every other answer is the peer's own: a run still in flight or one that
	 * has not drained its replies is refused with `still-owned` by the owner,
	 * which is the only party that can decide it.
	 */
	async park(runId: string): Promise<EndpointControlAck> {
		if (runId !== this.#currentRunId) {
			return {
				acknowledged: false,
				reason: `unknown run ${JSON.stringify(runId)} (current run: ${this.#currentRunId ?? "none"})`,
			};
		}
		return this.#client.park(runId);
	}

	/**
	 * Reopen the peer's session behind an opaque reference by asking the peer.
	 *
	 * The resume decision is the peer's, not this adapter's: only the peer knows
	 * whether the reference exists and whether its owner has let go, so both
	 * refusals it distinguishes — `still-owned` and an unknown reference — are
	 * passed through unchanged rather than guessed at here.
	 */
	async ensureLive(reference: string): Promise<EndpointControlAck> {
		return this.#client.ensureLive(reference);
	}

	/**
	 * Peer-scoped content channel (#13) over RPC: `read_resource` carries the
	 * opaque ref plus the byte window; the server refuses cross-peer reads and
	 * answers `chunk`/`available`/`unavailable`/`expired`. A `forbidden`
	 * answer surfaces as `ResourceOwnershipError`.
	 */
	async readResource(query: ResourceReadQuery): Promise<ResourceReadResult> {
		const result = await this.#client.readResource(query);
		if (result.status === "forbidden") {
			throw new ResourceOwnershipError(result.code, `Remote resource read refused: ${result.code}`);
		}
		return result;
	}

	/**
	 * Interactive channel (#13) over RPC: `ui_response` carries the answer
	 * back to the peer's pending request. Never default-approves.
	 */
	async respondUi(request: UiRequest): Promise<UiResponse> {
		return this.#client.respondUi(request);
	}

	asJobSnapshot(): EndpointSnapshot {
		return this.#snapshot();
	}

	asHandleSnapshot(): EndpointSnapshot {
		return this.#snapshot();
	}

	asRosterSnapshot(): EndpointSnapshot {
		return this.#snapshot();
	}

	/** Subscribe to the peer's managed facts; live for the whole endpoint lifetime, before any write. */
	#observe(): void {
		this.#unsubscribeRunEvents = this.#client.onManagedRunEvent(event => this.#onManagedRunEvent(event));
		this.#unsubscribeReplyBarrier = this.#client.onReplyDrainedBarrier(frame => {
			if (frame.peerId !== undefined && frame.peerId !== this.#client.getIrcBinding()?.ownerPeerId) return;
			if (frame.runId !== this.#currentRunId) return;
			this.#markRepliesDrained(frame.runId, frame.runStatusRevision, frame.outboundWatermark);
		});
		this.#unsubscribeLifecycle = this.#client.onManagedLifecycle(lifecycle => {
			if (lifecycle.status === "execution-unknown") this.#observeTransportLoss(lifecycle.error.message);
			else if (lifecycle.status === "stopped") {
				this.#observeTransportLoss("the managed connection stopped before the run reported an outcome");
			}
		});
	}

	/**
	 * One managed run boundary from the peer.
	 *
	 * A `prompt` start is adopted only while a `start()` call is waiting for its
	 * id: a run this endpoint did not accept must not be claimed by it. A
	 * `bash` run is a direct control on the client, not an assignment, so it is
	 * ignored. A terminal frame settles the outcome only; reply ownership remains
	 * outstanding until the independent reply-drained barrier arrives.
	 */
	#onManagedRunEvent(event: RpcManagedRunEvent): void {
		if (event.type === "managed_run_start") {
			if (event.command !== "prompt") return;
			const pending = this.#pendingStart;
			if (!pending) return;
			this.#beginRun(event.runId, pending);
			return;
		}
		if (event.runId !== this.#currentRunId) return;
		if (this.#verdict !== undefined) return;
		this.#terminalRevision = event.runStatusRevision;
		this.#settleRun(event.runId, event.status, undefined, event);
	}

	/** Record the peer's acceptance and hand the waiting `start()` its receipt. */
	#beginRun(runId: string, pending: PromiseWithResolvers<RunAck>): void {
		const acceptedAt = Date.now();
		this.#currentRunId = runId;
		this.#currentStatus = "running";
		this.#verdict = undefined;
		this.#terminalRevision = undefined;
		this.#repliesDrained = false;
		this.#runWaiter = undefined;
		this.#capturedText = [];
		this.#capturedError = undefined;
		this.#capturedUsage = undefined;
		this.#startCapture();
		this.#events.emit({ type: "run_ack", runId, acceptedAt });
		const message = this.#lastMessage;
		this.#events.emit({
			type: "status_changed",
			runId,
			status: "running",
			...(message !== undefined ? { message } : {}),
		});
		pending.resolve({ runId, acceptedAt });
	}

	/**
	 * Record the run's one verdict and hand it to every waiter.
	 *
	 * The status is the peer's, mapped verbatim; `execution-unknown` is only
	 * ever supplied by the transport-loss path. The first verdict wins, so a
	 * later writer — a loss arriving after the terminal frame — cannot rewrite
	 * a known ending. Text and usage gathered during the run ride along; a run
	 * that reported none carries none.
	 */
	#settleRun(
		runId: string,
		status: RunOutcomeStatus,
		error?: string,
		terminal?: Extract<RpcManagedRunEvent, { type: "managed_run_end" }>,
	): void {
		if (this.#verdict !== undefined || runId !== this.#currentRunId) return;
		const outcome: RunOutcome = { status, runId };
		if (this.#capturedText.length > 0) outcome.text = this.#capturedText.join("");
		const failure = error ?? this.#capturedError;
		if (status !== "completed" && failure !== undefined) outcome.error = failure;
		if (this.#capturedUsage !== undefined) outcome.usage = this.#capturedUsage;
		if (terminal?.remoteArtifacts !== undefined) outcome.remoteArtifacts = terminal.remoteArtifacts;
		if (terminal?.paramsError !== undefined) outcome.paramsError = terminal.paramsError;
		this.#verdict = outcome;
		this.#currentStatus = status;
		this.#stopCapture();
		this.#events.emit({ type: "run_outcome", runId, outcome });
		const message = this.#lastMessage;
		this.#events.emit({
			type: "status_changed",
			runId,
			status,
			...(message !== undefined ? { message } : {}),
		});
		this.#barrier.markTerminal(runId, { runStatusRevision: this.#terminalRevision });
		const waiter = this.#runWaiter;
		this.#runWaiter = undefined;
		waiter?.resolve(outcome);
	}

	/** Record the peer's drain report for the current run; ownership releases on the pair. */
	#markRepliesDrained(runId: string, runStatusRevision: number, outboundWatermark: number): void {
		if (this.#repliesDrained || this.#verdict === undefined) return;
		if (this.#terminalRevision !== undefined && runStatusRevision !== this.#terminalRevision) return;
		this.#repliesDrained = true;
		this.#barrier.markDrained(runId, { runStatusRevision, outboundWatermark });
		this.#events.emit({ type: "reply_drained", runId, runStatusRevision, outboundWatermark });
	}

	/**
	 * The managed connection can no longer be observed: a start still waiting
	 * for its run id is rejected (the peer will never announce it), and a run
	 * still in flight becomes `execution-unknown` — the transport verdict, never
	 * a failure or a cancellation, because a silent peer proves nothing about
	 * the work it was given.
	 */
	#observeTransportLoss(message: string): void {
		const pending = this.#pendingStart;
		if (pending) {
			this.#pendingStart = undefined;
			pending.reject(new Error(message));
		}
		const runId = this.#currentRunId;
		if (runId === null || this.#verdict !== undefined) return;
		this.#lastMessage = message;
		this.#settleRun(runId, "execution-unknown", message);
	}

	/**
	 * The peer is asked to terminate first, while the connection still exists;
	 * the transport is closed afterwards whatever the answer was, because
	 * closing it is what releases the remote process (and the peer's own EOF
	 * cleanup runs the same path). Explicit refusals are preserved after release.
	 */
	async #teardown(): Promise<void> {
		this.#terminated = true;
		let refusal: { cause: unknown } | undefined;
		try {
			await this.#client.terminate();
		} catch (cause) {
			// A lost connection cannot acknowledge; other failures are not success.
			if (!(cause instanceof RpcClientError && cause.code === "connection-lost")) refusal = { cause };
		}
		this.#stopObserving();
		const runId = this.#currentRunId;
		if (runId !== null && this.#verdict === undefined) {
			this.#lastMessage = "terminated before the run reported an outcome";
			this.#settleRun(runId, "execution-unknown", this.#lastMessage);
		}
		if (this.#currentRunId !== null) {
			this.#currentRunId = null;
			this.#currentStatus = "idle";
			this.#lastMessage = "terminated";
			this.#events.emit({ type: "status_changed", status: "idle", message: this.#lastMessage });
		}
		try {
			// A terminate ACK precedes the final SSH channel close. Half-close
			// rather than racing that orderly exit with a local SIGTERM.
			await this.transport.endInput();
		} finally {
			await this.transport.close();
		}
		if (refusal) throw refusal.cause;
	}

	/** Stop every client subscription; idempotent, so teardown can call it once. */
	#stopObserving(): void {
		this.#unsubscribeRunEvents?.();
		this.#unsubscribeReplyBarrier?.();
		this.#unsubscribeLifecycle?.();
		this.#detachIrcEndpoint?.();
		this.#detachIrcEndpoint = undefined;
		this.#stopCapture();
		this.#unsubscribeRunEvents = undefined;
		this.#unsubscribeReplyBarrier = undefined;
		this.#unsubscribeLifecycle = undefined;
	}

	/**
	 * Capture the running run's own assistant text, error and usage. This is the
	 * only text source: a post-terminal fetch cannot tell one run's answer from
	 * the previous run's.
	 */
	#startCapture(): void {
		this.#unsubscribeCapture = this.#client.onEvent(event => {
			if (event.type !== "message_end") return;
			const message: unknown = event.message;
			if (!isRecord(message) || message.role !== "assistant") return;
			appendAssistantText(this.#capturedText, message.content);
			if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
				this.#capturedError = message.errorMessage;
			}
			if (isRecord(message.usage)) {
				this.#capturedUsage ??= {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				accumulateUsage(this.#capturedUsage, message.usage);
			}
		});
	}

	#stopCapture(): void {
		this.#unsubscribeCapture?.();
		this.#unsubscribeCapture = undefined;
	}

	/** One reading of the shared run state, so the three views above cannot diverge. */
	#snapshot(): EndpointSnapshot {
		const snapshot: EndpointSnapshot = {
			runId: this.#currentRunId,
			status: this.#currentStatus,
			endpointKind: this.handle.kind,
		};
		if (this.#lastMessage !== undefined) snapshot.message = this.#lastMessage;
		return snapshot;
	}

	#assertCurrent(runId: string, method: string): void {
		if (runId === this.#currentRunId) return;
		throw new Error(
			`SshBackendEndpoint.${method}: unknown run ${JSON.stringify(runId)} (current run: ${this.#currentRunId ?? "none"}).`,
		);
	}
}
