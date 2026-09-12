/**
 * Agent endpoint contract (RFC #1 §8 D1/D2) — the transport-agnostic handle a
 * `task` spawn gets regardless of where it executes.
 *
 * Stage 1 (#3) froze the four-method lifecycle (`prepare` / `start` / `run` /
 * `cancelRun`), teardown, and the three read views. Stage 2 (#8) extends the
 * same interface with the control and observation surface the monitor, the
 * registry, and the Hub need: a revision-stamped event stream with a resumable
 * subscription, park/ensureLive, the reply-drained hook, and the inbound
 * boundaries for IRC (#11) and resources/UI (#13). Stage 3 (#9) pins the
 * managed facts that surface carries — the receive-side lease events
 * (`heartbeat_received` / `lease_expired`), the opaque resume reference a park
 * may hand back, and the ownership refusals that stop a resume from starting a
 * second execution of a session whose owner has not let go. Stage 4 (#11) turns
 * `deliverIrc` into a real inbound boundary: an endpoint hands the frame's
 * envelope to its own peer or to the connection that peer is reached through,
 * and reports `indeterminate` when a transport cannot confirm the hand-over.
 * The methods whose owning slice has not landed stay *honest* stubs: they
 * answer with a refusal or an explicit not-implemented outcome that names the
 * owning slice instead of fabricating delivery, parking, or content.
 *
 * Two invariants this module protects on its own:
 *
 * 1. **Local behaviour is bit-for-bit preserved.** `LocalAgentEndpoint` is a
 *    passive adapter over an already-created `AgentSession`; nothing in this
 *    module creates a session, spawns a process, or opens a connection, and no
 *    existing execution path is rerouted through it.
 * 2. **`execution-unknown` is a transport verdict, not a failure verdict.** It
 *    means the run reached a state the endpoint can no longer observe (peer
 *    gone, connection dropped, SSH session lost) — not that the run failed.
 *    Only remote endpoints can report it; a local run always reaches one of
 *    `completed` / `failed` / `cancelled`.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import type { IrcDeliveryOptions, IrcMessage } from "../irc/bus";
import type { AgentSession } from "../session/agent-session";
import type { ReplyDrainedResult } from "./reply-drained";
import type { StructuredSubagentOutput } from "./types";
import type { ParamsError, RunContract } from "./params";

/**
 * Delivery switches an inbound frame carries beside its envelope
 * ({@link AgentEndpoint.deliverIrc}); the bus owns their meaning, this module
 * just names them for the transports above it.
 */
export type { IrcDeliveryOptions, IrcEnvelope } from "../irc/bus";

/** Transport family an endpoint belongs to; drives which verdicts it can report. */
export type AgentEndpointKind = "local" | "remote";

/**
 * What the endpoint was handed at construction. The `local` variant carries the
 * in-process session the caller already created and runs; the `remote` variant
 * carries an opaque peer reference whose meaning is owned by whichever remote
 * backend implements it (#5). Callers must not interpret `reference`.
 */
export type AgentEndpointHandle = { kind: "local"; session: AgentSession } | { kind: "remote"; reference: string };

/**
 * The four terminal states of a run. The first three already exist in
 * `AsyncJob.status` and stay wire-compatible with it; `execution-unknown` is
 * the transport verdict, deliberately *not* an alias for `failed` — see the
 * module doc.
 */
export type RunOutcomeStatus = "completed" | "failed" | "cancelled" | "execution-unknown";

/** How a run ended. Produced once per run; a run has exactly one outcome. */
export interface RunOutcome {
	status: RunOutcomeStatus;
	runId: string;
	text?: string;
	error?: string;
	usage?: Usage;
	structured?: StructuredSubagentOutput;
	paramsError?: ParamsError;
	remoteArtifacts?: { repoRef: string; branch?: string; patchRef?: string };
}

/**
 * Receipt for {@link AgentEndpoint.start}. It is a receipt, never a result: an
 * ACK says the assignment was accepted, not that the run produced anything.
 * Callers must await {@link AgentEndpoint.run} for the outcome.
 */
export interface RunAck {
	runId: string;
	acceptedAt: number;
}

/** Optional explicit work contract; the first run argument remains the run identity. */
export interface RunOpts {
	runId?: string;
	signal?: AbortSignal;
	contract?: RunContract;
}

/**
 * What an endpoint can do for a role before a run starts. `capabilities` is a
 * plain string list (one stable token per feature); the negotiated capability
 * set and the `prepare`/`start` gate in front of a spawn land with #7.
 */
export interface PrepareResult {
	role: { agent: string; source: "local" | "remote" };
	capabilities: string[];
}

/**
 * Shared minimum view of one endpoint's current run state. The three
 * `as*Snapshot()` readers on {@link AgentEndpoint} return this same shape, so a
 * job row, a handle badge, and a roster line cannot disagree about the same
 * run. Display-only wording belongs to the wrapping surface, never here.
 */
export interface EndpointSnapshot {
	/** Current run, or `null` before `start()` / after `terminate()`. */
	runId: string | null;
	/** `idle` before a run, `running` while it is in flight, then the run's terminal status. */
	status: "idle" | "running" | RunOutcomeStatus;
	endpointKind: AgentEndpointKind;
	message?: string;
}

/** One observation of an endpoint's run state, stamped with the revision it reflects. */
export interface EndpointSnapshotResult {
	revision: number;
	snapshot: EndpointSnapshot;
}

/**
 * Answer to a control request ({@link AgentEndpoint.park} /
 * {@link AgentEndpoint.ensureLive}). `acknowledged: false` is a real refusal:
 * it carries the transport's reason, and the caller must neither retry blindly
 * nor claim the state the request asked for.
 *
 * A successful `park` may hand back an opaque `resumeReference` (D4, #9): the
 * peer's handle for the suspended session, which a later `ensureLive` — or the
 * managed `resume` command — passes back verbatim. It is deliberately opaque:
 * callers store and echo it, never parse it, and its absence means the peer
 * kept the suspension addressable through the reference the caller already
 * holds.
 */
export type EndpointControlAck =
	| { acknowledged: true; resumeReference?: string }
	| { acknowledged: false; reason: string };

/**
 * Prefix a peer puts on a refusal while it still owns the work it was asked
 * about (D4, #9): the run is in flight, or it reached a terminal verdict with
 * replies still outstanding. Both are the same answer to a resume — the
 * referenced session has an owner — so both carry this token.
 *
 * A refusal's `reason` is the only channel an {@link EndpointControlAck}
 * offers, which makes this prefix its machine-readable half. Callers that act
 * on ownership match it and must *not* fall back to treating every refusal as
 * `still-owned`: an unknown reference is a different fact with a different
 * resolution (a managed resume reports it as `resource-unavailable`, never as
 * "try again later").
 */
export const ENDPOINT_STILL_OWNED_REFUSAL = "still-owned";

/** Envelope fields the event stream stamps onto every event. */
export interface EndpointEventEnvelope {
	endpointKind: AgentEndpointKind;
	/** Monotonic per endpoint; a gap means dropped events, not a retracted fact. */
	revision: number;
}

/**
 * Facts an endpoint publishes about its run state.
 *
 * - `snapshot`: the baseline a subscription starts from (or restarts with when
 *   the requested gap is no longer retained); carries the full state.
 * - `status_changed`: the snapshot's `status` (and possibly its `message`)
 *   moved. Emitted for every status move, terminal ones included, so a
 *   status-only reader never has to infer it from `run_outcome`.
 * - `activity_changed`: the run's activity line changed while its status held.
 * - `run_ack`: an assignment was accepted; a receipt, never a result.
 * - `run_outcome`: the run's single verdict, reported verbatim.
 * - `reply_drained`: the run owes no more replies; the second half of the
 *   terminal-plus-drained pair the reply barrier waits for. The optional
 *   `runStatusRevision` / `outboundWatermark` are the same facts
 *   {@link ReplyDrainedResult} reports when the publisher observed them;
 *   omitted, never defaulted, when it did not.
 * - `heartbeat_received`: a peer heartbeat renewed the receive-side lease (D4,
 *   #9); `timestamp` is the local instant the frame was observed, never the
 *   sender's clock. A viewer watching for liveness reads this as "the lease
 *   just moved", not as a run fact.
 * - `lease_expired`: the receive-side lease ran out with no renewal inside its
 *   window (D4, #9). This is the disconnect signal, not a run verdict: the run
 *   it names becomes `execution-unknown`, and nothing is cancelled, retried, or
 *   replayed on the strength of it. `timestamp` is the instant the expiry was
 *   observed; the deadline is the last renewal (`LeaseState.renewedAt`) plus
 *   the lease window, so several ticks can observe one lapse.
 */
export type EndpointEventDraft =
	| { type: "snapshot"; runId?: string; snapshot: EndpointSnapshot }
	| { type: "status_changed"; runId?: string; status: EndpointSnapshot["status"]; message?: string }
	| { type: "activity_changed"; runId?: string; message: string }
	| { type: "run_ack"; runId: string; acceptedAt: number }
	| { type: "run_outcome"; runId: string; outcome: RunOutcome }
	| { type: "reply_drained"; runId: string; runStatusRevision?: number; outboundWatermark?: number }
	| { type: "heartbeat_received"; runId?: string; timestamp: number }
	| { type: "lease_expired"; runId?: string; timestamp: number };

/** One stamped state event; see {@link EndpointEventDraft} for the variants. */
export type EndpointEvent = EndpointEventDraft & EndpointEventEnvelope;

/** Events kept for `subscribe(fromRevision)`; an older revision restarts from a snapshot. */
const EVENT_LOG_LIMIT = 256;

/**
 * Revision-stamped event log shared by endpoint implementations.
 *
 * The stream owns the numbering, so every subscriber sees a totally ordered
 * sequence per endpoint, and it owns the replay window, so a resuming consumer
 * either continues exactly or is told (via a `snapshot` event) to re-read
 * state. Producers only describe the fact that changed: they hand over an
 * {@link EndpointEventDraft} and the stream stamps kind and revision.
 *
 * Subscriptions are cancellable at any point: `return()` unregisters the
 * listener and settles a `next()` that is already awaiting an event, so a
 * consumer that stops early (or is torn down while waiting) cannot leak a
 * listener or hang on a promise no event will ever resolve.
 */
export class EndpointEventStream {
	readonly #endpointKind: AgentEndpointKind;
	readonly #readSnapshot: () => EndpointSnapshot;
	readonly #listeners = new Set<(event: EndpointEvent) => void>();
	#log: EndpointEvent[] = [];
	#revision = 0;

	constructor(endpointKind: AgentEndpointKind, readSnapshot: () => EndpointSnapshot) {
		this.#endpointKind = endpointKind;
		this.#readSnapshot = readSnapshot;
	}

	/** Latest revision; this number plus a live subscription is a resumable baseline. */
	get revision(): number {
		return this.#revision;
	}

	/** Stamp `draft` with the next revision, retain it, and hand it to every live subscriber. */
	emit(draft: EndpointEventDraft): void {
		this.#revision += 1;
		const event: EndpointEvent = { ...draft, endpointKind: this.#endpointKind, revision: this.#revision };
		this.#log.push(event);
		if (this.#log.length > EVENT_LOG_LIMIT) this.#log.splice(0, this.#log.length - EVENT_LOG_LIMIT);
		for (const listener of [...this.#listeners]) listener(event);
	}

	/** See {@link AgentEndpoint.subscribe}: baseline-or-replay, then live events. */
	subscribe(fromRevision?: number): AsyncIterable<EndpointEvent> {
		// The opening batch and the live listener are taken in one synchronous
		// turn, so no event can fall between the replay boundary and the queue.
		const queue: EndpointEvent[] = [...this.#opening(fromRevision)];
		let closed = false;
		let pending: PromiseWithResolvers<IteratorResult<EndpointEvent, void>> | undefined;
		const listener = (event: EndpointEvent): void => {
			const waiter = pending;
			if (!waiter) {
				queue.push(event);
				return;
			}
			pending = undefined;
			waiter.resolve({ done: false, value: event });
		};
		this.#listeners.add(listener);
		const close = (): void => {
			if (closed) return;
			closed = true;
			this.#listeners.delete(listener);
			const waiter = pending;
			pending = undefined;
			waiter?.resolve({ done: true, value: undefined });
		};
		const iterator: AsyncIterator<EndpointEvent, void> & AsyncIterable<EndpointEvent> = {
			next: (): Promise<IteratorResult<EndpointEvent, void>> => {
				if (closed) return Promise.resolve({ done: true, value: undefined });
				const event = queue.shift();
				if (event !== undefined) return Promise.resolve({ done: false, value: event });
				const waiter = Promise.withResolvers<IteratorResult<EndpointEvent, void>>();
				pending = waiter;
				return waiter.promise;
			},
			return: (): Promise<IteratorResult<EndpointEvent, void>> => {
				close();
				return Promise.resolve({ done: true, value: undefined });
			},
			[Symbol.asyncIterator](): AsyncIterator<EndpointEvent, void> {
				return iterator;
			},
		};
		return iterator;
	}

	/**
	 * Baseline (or gap replay) for one subscription, computed against a single
	 * revision. A gap is replayable only while the log still holds *every*
	 * event after `fromRevision`; a partial replay would silently drop facts,
	 * so it is replaced with a fresh snapshot the consumer must re-read. A
	 * revision the stream never issued (for example one restored from a
	 * previous generation of the endpoint) also falls back to a snapshot
	 * rather than waiting for events that could only ever be older.
	 */
	#opening(fromRevision?: number): EndpointEvent[] {
		if (fromRevision !== undefined) {
			if (fromRevision === this.#revision) return [];
			if (fromRevision < this.#revision) {
				const oldest = this.#log[0]?.revision ?? this.#revision + 1;
				if (fromRevision + 1 >= oldest) {
					return this.#log.filter(event => event.revision > fromRevision);
				}
			}
		}
		return [this.#snapshotEvent()];
	}

	#snapshotEvent(): EndpointEvent {
		const snapshot = this.#readSnapshot();
		return {
			type: "snapshot",
			endpointKind: this.#endpointKind,
			revision: this.#revision,
			...(snapshot.runId !== null ? { runId: snapshot.runId } : {}),
			snapshot,
		};
	}
}

/**
 * One inbound IRC frame handed to an endpoint for delivery to its peer (D3).
 *
 * The envelope keeps the sender's identity verbatim — `id`/`ts` are minted by
 * the sending bus and must never be regenerated in transit, or one message
 * becomes two.
 */
export type IrcInboundEnvelope = IrcMessage;

/**
 * Result of {@link AgentEndpoint.deliverIrc}: three states, and no fourth.
 *
 * `delivered` names how the peer's side took the message; `failed` says the
 * hand-over did not happen and why. `indeterminate` is the transport verdict
 * between them — the frame was handed to a connection that could not confirm
 * it (a dropped link, a receipt that never came back). It exists because
 * guessing would be worse than either answer: reporting `delivered` claims a
 * hand-over nobody observed, and reporting `failed` marks as undelivered a
 * message the peer may already hold. Callers propagate it as-is; nothing
 * retries an unconfirmed frame on its own.
 */
export type IrcDeliveryReceipt =
	| { status: "delivered"; to: string; outcome: "injected" | "woken" | "revived" }
	| { status: "failed"; to: string; error: string }
	| { status: "indeterminate"; to: string; error: string };

/**
 * Peer-scoped resource channel (#13). `ResourceRef` is opaque: `displayPath`
 * is UI display ONLY and must never be opened locally (see
 * `ResourceOwnershipError` in `./resource`). Re-exported here so existing
 * `task/endpoint` import sites keep working.
 */
export type {
	ResourceChunk,
	ResourceReadQuery,
	ResourceRef,
	UiRequest,
	UiResponse,
} from "./resource";
export { ResourceOwnershipError } from "./resource";

/**
 * Result of {@link AgentEndpoint.readResource}.
 *
 * `chunk` carries content (offset into the peer's byte stream, `final` marks
 * the last chunk); `available` is the probe answer (the bytes exist, fetch
 * them with a non-probe read); `unavailable`/`expired` feed the
 * result-ref-first settle (`result-ref-unavailable`); `forbidden` is the
 * cross-peer or remote-path boundary.
 */
export type ResourceReadResult =
	| { status: "chunk"; chunk: import("./resource").ResourceChunk }
	| { status: "available"; ref: import("./resource").ResourceRef }
	| { status: "unavailable"; reason?: string }
	| { status: "expired" }
	| { status: "forbidden"; code: "cross-peer-forbidden" | "remote-path-not-local" };

/**
 * Where a spawn actually runs.
 *
 * Lifecycle: `prepare()` (optional pre-flight) → `start()` (immediate ACK) →
 * `run()` (the only outcome) → `cancelRun()` / `terminate()` as needed; state
 * reads and the control methods below are available throughout.
 *
 * Honest stubs, and the slice that replaces each — the return shapes are real,
 * only the answers are deferred:
 *
 * - `readResource`, `respondUi` — peer-scoped resources and UI round trips: #13.
 *
 * The control pair carries real semantics from #9 on: `ensureLive` refuses a
 * reference whose owner is still active or whose cleanup is unconfirmed, and
 * `park` refuses a run that is busy or still owes replies. A local endpoint
 * refuses both outright — an in-process session is parked by
 * `AgentLifecycleManager`, not by an endpoint.
 */
export interface AgentEndpoint {
	/** The session or peer reference this endpoint was built around. */
	readonly handle: AgentEndpointHandle;
	prepare(): Promise<PrepareResult>;
	start(assignment: string, opts?: RunOpts): Promise<RunAck>;
	run(runId: string, signalOrOpts?: AbortSignal | RunOpts): Promise<RunOutcome>;
	cancelRun(runId: string): Promise<void>;
	terminate(): Promise<void>;
	/**
	 * Read the current state together with the revision it reflects. The pair
	 * is a resumable baseline: events after `revision` are not folded into
	 * `snapshot` yet, so a consumer seeks forward from exactly there. The three
	 * synchronous `as*Snapshot()` readers are retained unchanged for the
	 * job/handle/roster surfaces already reading them; this async pair is the
	 * revision-stamped view a subscriber continues from.
	 */
	snapshot(): Promise<EndpointSnapshotResult>;
	/**
	 * State events in revision order. Without `fromRevision` the stream starts
	 * with a `snapshot` event at the current revision and then yields every
	 * later event; with the revision from {@link snapshot} (or from the last
	 * event already seen) it resumes just after that revision, replaying the
	 * retained events in between instead of losing a wakeup. If that gap is no
	 * longer retained the stream restarts with a fresh `snapshot` event —
	 * dropped events are re-read as state, never replayed as tasks.
	 *
	 * The iterator is cancellable at any point: `return()` (what `for await`
	 * calls on `break`) unregisters the subscription and settles a pending
	 * `next()`, so a consumer that stops while waiting for the next event
	 * neither hangs nor leaves a listener behind.
	 */
	subscribe(fromRevision?: number): AsyncIterable<EndpointEvent>;
	/**
	 * Deliver one inbound IRC frame to this endpoint's peer, forwarding the
	 * envelope exactly as received (never re-minting its `id`/`ts`, never
	 * rewriting its addresses) and answering with the receipt of that delivery.
	 *
	 * The optional {@link IrcDeliveryOptions} describe the hand-over, not the
	 * message: the operation id a receiver deduplicates by (defaulting to the
	 * envelope's own id), the delivery switches of this leg, and — where the
	 * implementation can observe one — a timeout after which an unconfirmed
	 * frame is reported `indeterminate` rather than assumed.
	 */
	deliverIrc(envelope: IrcInboundEnvelope, options?: IrcDeliveryOptions): Promise<IrcDeliveryReceipt>;
	/**
	 * Wait until `runId` is terminal *and* has drained its replies. The result
	 * is about the wait: `aborted` means the caller's signal fired, not that
	 * the run was aborted — a local run auto-drains, a remote one drains when
	 * its peer reports the barrier.
	 */
	waitReplyDrained(runId: string, opts?: { signal?: AbortSignal }): Promise<ReplyDrainedResult>;
	/**
	 * Ask the peer to suspend `runId`, keeping its identity and resume
	 * reference. A refusal must say why: a run that is still busy or that owes
	 * replies is refused rather than frozen mid-flight, and the caller reports
	 * that refusal instead of claiming a park. A successful acknowledgement may
	 * carry the peer's opaque `resumeReference` for the suspended session; the
	 * reference the caller already holds stays valid either way.
	 */
	park(runId: string): Promise<EndpointControlAck>;
	/**
	 * Open (or confirm) the peer's session for an existing opaque `reference`.
	 * A resume reuses the referenced session — it never creates a new one — and
	 * a refusal must say why, distinguishing two cases a caller must not
	 * conflate:
	 *
	 * - `still-owned`: the peer still owns the work, either because the run is
	 *   in flight or because its cleanup is unconfirmed (the run reached a
	 *   terminal verdict but has not drained its replies). Reopening here would
	 *   start a second execution of the same logical session, so the request is
	 *   refused until the owner releases the work.
	 * - unknown reference: the peer never held it, so there is nothing to
	 *   resume and nothing new is minted.
	 */
	ensureLive(reference: string): Promise<EndpointControlAck>;
	/**
	 * Read a peer-owned resource through the endpoint.
	 *
	 * `probe: true` is the availability check (no bytes move); a non-probe
	 * read returns the `chunk` slices (reassembled by the caller). A reference
	 * whose `peerId` does not match the connection's bound owner peer answers
	 * `forbidden/cross-peer-forbidden`.
	 */
	readResource(query: import("./resource").ResourceReadQuery): Promise<ResourceReadResult>;
	/**
	 * Answer a UI request raised by this endpoint's peer.
	 *
	 * Bounded (~30s, see `UI_BRIDGE_TIMEOUT_MS`); `unavailable/no-ui` means no
	 * adapter is attached, `unavailable/disconnected` means the connection
	 * dropped. Never default-approves: an absent answer is a cancel.
	 */
	respondUi(request: import("./resource").UiRequest): Promise<import("./resource").UiResponse>;
	/** Monitor-facing view (`hub jobs` rows become consumers of this in #8). */
	asJobSnapshot(): EndpointSnapshot;
	/** Handle-facing view (`hub list` rows become consumers of this in #8). */
	asHandleSnapshot(): EndpointSnapshot;
	/** Roster-facing view (agent roster lines become consumers of this in #8). */
	asRosterSnapshot(): EndpointSnapshot;
}
