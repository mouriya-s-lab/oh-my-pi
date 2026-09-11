/**
 * Agent endpoint contract (RFC #1 §8 D1/D2) — the transport-agnostic handle a
 * `task` spawn gets regardless of where it executes.
 *
 * Stage 1 (#3) froze the four-method lifecycle (`prepare` / `start` / `run` /
 * `cancelRun`), teardown, and the three read views. Stage 2 (#8) extends the
 * same interface with the control and observation surface the monitor, the
 * registry, and the Hub need: a revision-stamped event stream with a resumable
 * subscription, park/ensureLive, the reply-drained hook, and the inbound
 * boundaries for IRC (#11) and resources/UI (#13). The methods whose owning
 * slice has not landed are *honest* stubs: they answer with a refusal or an
 * explicit not-implemented outcome that names the owning slice instead of
 * fabricating delivery, parking, or content.
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
import type { IrcMessage } from "../irc/bus";
import type { AgentSession } from "../session/agent-session";
import type { ReplyDrainedResult } from "./reply-drained";
import type { StructuredSubagentOutput } from "./types";

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
 */
export type EndpointControlAck = { acknowledged: true } | { acknowledged: false; reason: string };

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
 *   terminal-plus-drained pair the reply barrier waits for.
 */
export type EndpointEventDraft =
	| { type: "snapshot"; runId?: string; snapshot: EndpointSnapshot }
	| { type: "status_changed"; runId?: string; status: EndpointSnapshot["status"]; message?: string }
	| { type: "activity_changed"; runId?: string; message: string }
	| { type: "run_ack"; runId: string; acceptedAt: number }
	| { type: "run_outcome"; runId: string; outcome: RunOutcome }
	| { type: "reply_drained"; runId: string };

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
 * becomes two. #11 implements the routing; #8 freezes the boundary.
 */
export type IrcInboundEnvelope = IrcMessage;

/**
 * Result of {@link AgentEndpoint.deliverIrc}.
 *
 * `not-implemented` is the only variant this slice produces, and it is a
 * resolved answer rather than a thrown error: the boundary exists so the
 * caller above (the IRC routing under #11) has one place to call, and a stub
 * that cannot deliver must say so instead of borrowing the local bus receipt —
 * that receipt would claim a delivery the frame never left the process for.
 * `delivered` / `failed` are the shapes #11 fills in; neither may be inferred
 * from the other.
 */
export type IrcDeliveryReceipt =
	| { status: "not-implemented"; detail: string }
	| { status: "delivered"; to: string; outcome: "injected" | "woken" | "revived" }
	| { status: "failed"; to: string; error: string };

/** Pinned detail for the inbound-IRC deferral; #11 replaces the stub. */
export const IRC_TRANSPORT_DEFERRED = "IRC transport lands under mouriya-s-lab#11";

/** Pinned detail for the resource-read deferral; #13 replaces the stub. */
export const RESOURCE_READ_DEFERRED = "resource reads land under mouriya-s-lab#13";

/** Pinned detail for the UI-response deferral; #13 replaces the stub. */
export const UI_RESPONSE_DEFERRED = "UI responses land under mouriya-s-lab#13";

/**
 * Opaque reference to a resource owned by a peer's session (D7, #13).
 *
 * #8 freezes only the seam: `reference` is the peer's opaque handle (never a
 * local filesystem path), `kind` names the resource family, and `path` is
 * remote display information. #13 owns the content channel and widens this
 * shape; nothing may turn a remote path into a locally openable one.
 */
export interface ResourceRef {
	reference: string;
	kind: "result" | "history" | "attachment";
	path?: string;
}

/**
 * Result of {@link AgentEndpoint.readResource}.
 *
 * The peer-scoped content channel lands under #13; until then the only honest
 * answer is `not-implemented`, and #13 widens this union with the content and
 * availability variants rather than handing callers an empty or invented
 * payload.
 */
export type ResourceReadResult = { status: "not-implemented"; detail: string };

/**
 * One answer to a UI request a peer raised (D7, #13). `requestId` is minted by
 * the asking peer; an absent `value` is an explicit cancel, never an implicit
 * approval. #13 owns the request/response channel.
 */
export interface UiResponse {
	requestId: string;
	value?: string;
}

/**
 * Where a spawn actually runs.
 *
 * Lifecycle: `prepare()` (optional pre-flight) → `start()` (immediate ACK) →
 * `run()` (the only outcome) → `cancelRun()` / `terminate()` as needed; state
 * reads and the control methods below are available throughout.
 *
 * Honest stubs, and the slice that replaces each — the return shapes are real,
 * only the answers are deferred past #8:
 *
 * - `deliverIrc` — inbound IRC routing: #11.
 * - `readResource`, `respondUi` — peer-scoped resources and UI round trips: #13.
 * - `park`, `ensureLive` — the managed park/resume protocol: #9 (a local
 *   endpoint refuses: an in-process session is parked by
 *   `AgentLifecycleManager`, not by an endpoint).
 */
export interface AgentEndpoint {
	/** The session or peer reference this endpoint was built around. */
	readonly handle: AgentEndpointHandle;
	prepare(): Promise<PrepareResult>;
	start(assignment: string): Promise<RunAck>;
	run(runId: string, signal?: AbortSignal): Promise<RunOutcome>;
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
	 * Deliver one inbound IRC frame to this endpoint's peer.
	 *
	 * Not implemented here: #8 defers the inbound routing to #11, so the answer
	 * is a resolved `not-implemented` receipt carrying
	 * {@link IRC_TRANSPORT_DEFERRED} — never a fabricated
	 * `injected`/`woken`/`revived`.
	 */
	deliverIrc(envelope: IrcInboundEnvelope): Promise<IrcDeliveryReceipt>;
	/**
	 * Wait until `runId` is terminal *and* has drained its replies. The result
	 * is about the wait: `aborted` means the caller's signal fired, not that
	 * the run was aborted — a local run auto-drains, a remote one drains when
	 * its peer reports the barrier.
	 */
	waitReplyDrained(runId: string, opts?: { signal?: AbortSignal }): Promise<ReplyDrainedResult>;
	/**
	 * Ask the peer to suspend `runId`, keeping its identity and resume
	 * reference. A refusal must say why; #8 defers the managed park protocol to
	 * #9.
	 */
	park(runId: string): Promise<EndpointControlAck>;
	/**
	 * Open (or confirm) the peer's session for an existing opaque `reference`.
	 * A resume reuses the referenced session — it never creates a new one — and
	 * a refusal must say why.
	 */
	ensureLive(reference: string): Promise<EndpointControlAck>;
	/**
	 * Read a peer-owned resource through the endpoint.
	 *
	 * Not implemented here: #8 defers the peer-scoped content channel to #13,
	 * so the answer is a resolved `not-implemented` result carrying
	 * {@link RESOURCE_READ_DEFERRED}; #13 widens
	 * {@link ResourceReadResult} with the content variants.
	 */
	readResource(ref: ResourceRef): Promise<ResourceReadResult>;
	/**
	 * Answer a UI request raised by this endpoint's peer.
	 *
	 * Not implemented here: #8 defers the interactive channel to #13. The
	 * required `acknowledged: true` cannot honestly signal failure, so an
	 * unsupported invocation rejects with {@link UI_RESPONSE_DEFERRED} rather
	 * than returning a false success.
	 */
	respondUi(response: UiResponse): Promise<{ acknowledged: true }>;
	/** Monitor-facing view (`hub jobs` rows become consumers of this in #8). */
	asJobSnapshot(): EndpointSnapshot;
	/** Handle-facing view (`hub list` rows become consumers of this in #8). */
	asHandleSnapshot(): EndpointSnapshot;
	/** Roster-facing view (agent roster lines become consumers of this in #8). */
	asRosterSnapshot(): EndpointSnapshot;
}
