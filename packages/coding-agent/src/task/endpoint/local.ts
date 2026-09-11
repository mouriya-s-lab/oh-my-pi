/**
 * Local (in-process) implementation of {@link AgentEndpoint}.
 *
 * The adapter is passive by design. The caller already created the
 * `AgentSession` and keeps driving it through the existing executor path; this
 * class only records which run is current, translates the session's terminal
 * event into a {@link RunOutcome}, and publishes both as revision-stamped
 * events. It takes no locks, does no I/O, and has no side effects beyond
 * delegating to the hooks it was given — so wiring it in cannot change local
 * execution. The executor-side migration that instantiates one per spawn lands
 * with #8, together with widening `AsyncJob.status`.
 *
 * Local reply accounting is immediate: a run's replies are produced by this
 * same process, so the terminal verdict auto-drains the reply barrier instead
 * of leaving a completion check waiting on a transport that does not exist.
 * Cross-host replies (#11) never pass through this adapter.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import {
	type AgentEndpoint,
	type AgentEndpointHandle,
	type EndpointControlAck,
	type EndpointEvent,
	EndpointEventStream,
	type EndpointSnapshot,
	type EndpointSnapshotResult,
	IRC_TRANSPORT_DEFERRED,
	type IrcDeliveryReceipt,
	type IrcInboundEnvelope,
	type PrepareResult,
	RESOURCE_READ_DEFERRED,
	type ResourceReadResult,
	type ResourceRef,
	type RunAck,
	type RunOutcome,
	UI_RESPONSE_DEFERRED,
	type UiResponse,
} from "../endpoint";
import { ReplyDrainedBarrier, type ReplyDrainedResult } from "../reply-drained";
import type { StructuredSubagentOutput } from "../types";

/** Why a local endpoint refuses a park request; parking is not the endpoint's to perform. */
const LOCAL_PARK_REFUSAL = "local endpoint has no park semantics";

/** Why a local endpoint refuses an ensureLive request; there is no parked reference to revive. */
const LOCAL_ENSURE_LIVE_REFUSAL = "local endpoint holds its session directly; there is no reference to revive";

/**
 * Verdict an already-created local session reached. `execution-unknown` is
 * absent on purpose: a session the process owns is observable until it
 * settles, so there is no "we lost the run" case to report.
 */
export interface LocalTerminalResult {
	status: "completed" | "failed" | "cancelled";
	text?: string;
	error?: string;
	usage?: Usage;
	structured?: StructuredSubagentOutput;
}

export interface LocalAgentEndpointOptions {
	/** Session the caller already created and is running; stored as a handle, never driven. */
	session: AgentSession;
	/** Agent name reported by `prepare()`. */
	agent: string;
	/** Resolves with the current run's terminal verdict. */
	awaitTerminal: (signal?: AbortSignal) => Promise<LocalTerminalResult>;
	/** Cancels the current run. The endpoint delegates; it never touches the session. */
	cancelRun: (runId: string) => Promise<void>;
	/** Releases the session's resources on `terminate()`. */
	terminate: () => Promise<void>;
}

/**
 * Wraps one live `AgentSession` in the endpoint contract.
 *
 * `start()` allocates the run id and records the intent — kicking off the
 * actual session run stays with the executor that owns the session. `run()`
 * waits for the terminal event through the caller's hook, records its verdict
 * on the shared run state, and (because the replies are local) drains the
 * reply barrier in the same step.
 */
export class LocalAgentEndpoint implements AgentEndpoint {
	readonly handle: AgentEndpointHandle;
	readonly #agent: string;
	readonly #awaitTerminal: (signal?: AbortSignal) => Promise<LocalTerminalResult>;
	readonly #cancelHook: (runId: string) => Promise<void>;
	readonly #terminateHook: () => Promise<void>;
	readonly #events: EndpointEventStream;
	readonly #barrier = new ReplyDrainedBarrier();
	#currentRunId: string | null = null;
	#currentStatus: EndpointSnapshot["status"] = "idle";
	#lastMessage: string | undefined;

	constructor(options: LocalAgentEndpointOptions) {
		this.handle = { kind: "local", session: options.session };
		this.#agent = options.agent;
		this.#awaitTerminal = options.awaitTerminal;
		this.#cancelHook = options.cancelRun;
		this.#terminateHook = options.terminate;
		this.#events = new EndpointEventStream(this.handle.kind, () => this.#snapshot());
	}

	async prepare(): Promise<PrepareResult> {
		return {
			role: { agent: this.#agent, source: "local" },
			capabilities: ["agent_session/v0"],
		};
	}

	/** Records the current run and returns immediately; the ACK is not an outcome. */
	async start(assignment: string): Promise<RunAck> {
		const runId = crypto.randomUUID();
		const acceptedAt = Date.now();
		this.#currentRunId = runId;
		this.#currentStatus = "running";
		this.#lastMessage = assignment.trim() || undefined;
		this.#events.emit({ type: "run_ack", runId, acceptedAt });
		const message = this.#lastMessage;
		this.#events.emit({
			type: "status_changed",
			runId,
			status: "running",
			...(message !== undefined ? { message } : {}),
		});
		return { runId, acceptedAt };
	}

	/** Waits for the session's terminal event and records its verdict on the shared run state. */
	async run(runId: string, signal?: AbortSignal): Promise<RunOutcome> {
		this.#assertCurrent(runId, "run");
		const terminal = await this.#awaitTerminal(signal);
		this.#currentStatus = terminal.status;
		const outcome: RunOutcome = { status: terminal.status, runId };
		if (terminal.text !== undefined) outcome.text = terminal.text;
		if (terminal.error !== undefined) outcome.error = terminal.error;
		if (terminal.usage !== undefined) outcome.usage = terminal.usage;
		if (terminal.structured !== undefined) outcome.structured = terminal.structured;
		this.#events.emit({ type: "run_outcome", runId, outcome });
		const message = this.#lastMessage;
		this.#events.emit({
			type: "status_changed",
			runId,
			status: terminal.status,
			...(message !== undefined ? { message } : {}),
		});
		// The verdict is terminal and its replies were produced in-process, so
		// both halves of the drain pair are known here; a local completion check
		// must never wait on a transport that does not exist.
		this.#barrier.markTerminal(runId);
		this.#barrier.markDrained(runId);
		this.#events.emit({ type: "reply_drained", runId });
		return outcome;
	}

	/** Delegates to the cancel hook; a foreign run id is a caller bug, not a silent no-op. */
	async cancelRun(runId: string): Promise<void> {
		this.#assertCurrent(runId, "cancelRun");
		await this.#cancelHook(runId);
	}

	async terminate(): Promise<void> {
		await this.#terminateHook();
	}

	async snapshot(): Promise<EndpointSnapshotResult> {
		return { revision: this.#events.revision, snapshot: this.#snapshot() };
	}

	subscribe(fromRevision?: number): AsyncIterable<EndpointEvent> {
		return this.#events.subscribe(fromRevision);
	}

	/**
	 * Not implemented: #8 defers the inbound routing to #11. In-process delivery
	 * already happens through `IrcBus`; this method is the cross-host inbound
	 * boundary, so the answer is a resolved not-implemented receipt naming the
	 * owning slice.
	 */
	async deliverIrc(_envelope: IrcInboundEnvelope): Promise<IrcDeliveryReceipt> {
		return { status: "not-implemented", detail: IRC_TRANSPORT_DEFERRED };
	}

	/**
	 * Waits for the run's terminal verdict and drain facts. A local run always
	 * reaches both, so this resolves with `drained` unless the caller's signal
	 * arrives first.
	 */
	async waitReplyDrained(runId: string, opts?: { signal?: AbortSignal }): Promise<ReplyDrainedResult> {
		return this.#barrier.await(runId, opts?.signal);
	}

	/**
	 * Refused: parking an in-process session is `AgentLifecycleManager`'s job —
	 * the endpoint does not own the session's lifecycle, and the managed park
	 * protocol for remote peers lands with #9.
	 */
	async park(_runId: string): Promise<EndpointControlAck> {
		return { acknowledged: false, reason: LOCAL_PARK_REFUSAL };
	}

	/**
	 * Refused: a local endpoint exists only while the session it was built
	 * around does, so there is no parked reference for it to open. Local
	 * revival stays with `AgentLifecycleManager`.
	 */
	async ensureLive(_reference: string): Promise<EndpointControlAck> {
		return { acknowledged: false, reason: LOCAL_ENSURE_LIVE_REFUSAL };
	}

	/**
	 * Not implemented: #8 defers the peer-scoped content channel to #13. The
	 * answer is a resolved not-implemented result; a stub that cannot return a
	 * resource must say so rather than invent bytes.
	 */
	async readResource(_ref: ResourceRef): Promise<ResourceReadResult> {
		return { status: "not-implemented", detail: RESOURCE_READ_DEFERRED };
	}

	/**
	 * Not implemented: #8 defers the interactive channel to #13. The required
	 * `acknowledged: true` cannot signal failure, so an unsupported invocation
	 * rejects instead of returning a false success.
	 */
	async respondUi(_response: UiResponse): Promise<{ acknowledged: true }> {
		throw new Error(UI_RESPONSE_DEFERRED);
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
			`LocalAgentEndpoint.${method}: unknown run ${JSON.stringify(runId)} (current run: ${this.#currentRunId ?? "none"}).`,
		);
	}
}
