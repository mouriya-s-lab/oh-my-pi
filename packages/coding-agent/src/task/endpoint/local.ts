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
 *
 * ## Managed opt-in (#9)
 *
 * The default adapter is the passive one described above: `park`/`ensureLive`
 * refuse because an in-process session's suspension belongs to
 * `AgentLifecycleManager`. A caller that is itself implementing the managed
 * protocol — the RPC server, which receives `park`/`resume` commands from a
 * remote peer — passes `managed: true` to get the per-run semantics that
 * protocol requires: an opaque resume reference minted by the endpoint, a park
 * that refuses a run which is still in flight or whose replies have not
 * drained, and a resume that refuses a reference whose owner has not let go.
 * That is the same ownership gate the remote fake models, applied to the
 * session this adapter already holds: nothing is created, suspended on disk, or
 * spawned by it — the endpoint only reports whether the caller may re-enter the
 * run it owns.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import {
	type AgentEndpoint,
	type AgentEndpointHandle,
	ENDPOINT_STILL_OWNED_REFUSAL,
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

/** Why a managed park/resume is refused while the run's owner has not released it (D4, #9). */
const LOCAL_STILL_OWNED_REFUSAL = `${ENDPOINT_STILL_OWNED_REFUSAL}: local run`;

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
	/**
	 * Opt into the managed per-run `park`/`ensureLive` semantics (#9). Off by
	 * default, which keeps the adapter a pure pass-through for local callers:
	 * the managed protocol belongs to the caller that speaks it (the RPC
	 * server), not to every local spawn.
	 */
	managed?: boolean;
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
	readonly #managed: boolean;
	#currentRunId: string | null = null;
	#currentStatus: EndpointSnapshot["status"] = "idle";
	#lastMessage: string | undefined;
	/** The current run's verdict; absent while it is still in flight. */
	#verdictStatus: LocalTerminalResult["status"] | undefined;
	/** True once the current run's replies are accounted for; the other half of the ownership pair. */
	#repliesDrained = false;
	/**
	 * Opaque handle for this session, minted on the first successful park and
	 * stable afterwards. It names the endpoint, not a run, so the caller stores
	 * and echoes it without reading anything out of it.
	 */
	#resumeReference: string | undefined;

	constructor(options: LocalAgentEndpointOptions) {
		this.handle = { kind: "local", session: options.session };
		this.#agent = options.agent;
		this.#awaitTerminal = options.awaitTerminal;
		this.#cancelHook = options.cancelRun;
		this.#terminateHook = options.terminate;
		this.#managed = options.managed === true;
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
		this.#verdictStatus = undefined;
		this.#repliesDrained = false;
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
		this.#verdictStatus = terminal.status;
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
		this.#barrier.markTerminal(runId);
		this.#markRepliesDrained(runId);
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
	 * Not implemented: the negotiated capability set advertises
	 * `ircBidirectional: 0` until #11, so no inbound route exists. In-process
	 * delivery already happens through `IrcBus`; this method is the cross-host
	 * inbound boundary, so the answer is a resolved not-implemented receipt
	 * naming the owning slice.
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
	 * Suspends the run for a caller driving the managed protocol
	 * (`managed: true`); refused otherwise, where parking an in-process session
	 * is `AgentLifecycleManager`'s job.
	 *
	 * The managed answer is about the run this endpoint actually has: an unknown
	 * run id and a run whose owner has not released it — still in flight, or
	 * terminal with replies outstanding — are refusals, and only the released
	 * run is parked. A successful acknowledgement carries the endpoint's opaque
	 * `resumeReference`; nothing is suspended on disk and no session is created.
	 */
	async park(runId: string): Promise<EndpointControlAck> {
		if (!this.#managed) return { acknowledged: false, reason: LOCAL_PARK_REFUSAL };
		if (runId !== this.#currentRunId) {
			return {
				acknowledged: false,
				reason: `unknown run ${JSON.stringify(runId)} (current run: ${this.#currentRunId ?? "none"})`,
			};
		}
		const owned = this.#ownershipRefusal();
		if (owned) return { acknowledged: false, reason: owned };
		const reference = this.#resumeReference ?? `local:${crypto.randomUUID()}`;
		this.#resumeReference = reference;
		return { acknowledged: true, resumeReference: reference };
	}

	/**
	 * Reopen the session behind an opaque reference for a caller driving the
	 * managed protocol (`managed: true`); refused otherwise, because a local
	 * endpoint exists only while the session it was built around does and local
	 * revival stays with `AgentLifecycleManager`.
	 *
	 * A managed resume answers the ownership question and nothing else: a
	 * reference this endpoint never minted is refused as unknown (resuming must
	 * never open a new session), and a reference whose run is still in flight or
	 * still owes replies is refused as `still-owned` — reopening there would run
	 * the same logical session twice. Success means the peer may re-enter the
	 * session this endpoint already holds.
	 */
	async ensureLive(reference: string): Promise<EndpointControlAck> {
		if (!this.#managed) return { acknowledged: false, reason: LOCAL_ENSURE_LIVE_REFUSAL };
		if (this.#resumeReference === undefined || reference !== this.#resumeReference) {
			return {
				acknowledged: false,
				reason: `unknown reference ${JSON.stringify(reference)}; resume never opens a new session`,
			};
		}
		const owned = this.#ownershipRefusal();
		if (owned) return { acknowledged: false, reason: owned };
		return { acknowledged: true };
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

	/**
	 * Record that the current run owes no further replies. Kept separate from
	 * the terminal verdict because the two facts are independent: a caller may
	 * observe the window between them (that window is exactly what the ownership
	 * gate refuses), and the barrier's waiters are released on the pair.
	 */
	#markRepliesDrained(runId: string): void {
		if (this.#repliesDrained) return;
		this.#repliesDrained = true;
		this.#barrier.markDrained(runId);
		this.#events.emit({ type: "reply_drained", runId });
	}

	/**
	 * The run's ownership, as a refusal reason: present while it is in flight,
	 * and present again after its verdict until the replies drain. `undefined`
	 * once the owner has let go — the only state in which the managed `park` and
	 * `ensureLive` proceed.
	 */
	#ownershipRefusal(): string | undefined {
		const runId = this.#currentRunId;
		if (runId === null) return undefined;
		if (this.#verdictStatus === undefined) return `${LOCAL_STILL_OWNED_REFUSAL} ${runId} is in flight`;
		if (!this.#repliesDrained) {
			return `${LOCAL_STILL_OWNED_REFUSAL} ${runId} reached ${this.#verdictStatus} but has not drained its replies`;
		}
		return undefined;
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
