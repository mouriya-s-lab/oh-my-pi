/**
 * Test double for a *remote* endpoint.
 *
 * It exists to exercise the parts of the contract a local endpoint cannot:
 * `execution-unknown`, the verdict only a lost transport produces, the reply
 * barrier that keeps a terminal run from reading as "stopped without
 * replying", and a resume that reuses an opaque reference instead of opening a
 * new session. The fake holds a run open until the test advances it (`run()`'s
 * resolver, {@link FakeRemoteEndpoint.completeRun}, or
 * {@link FakeRemoteEndpoint.cancelRun}), so a test can observe the gap between
 * the start ACK and the outcome.
 *
 * It keeps a peer-side session table keyed by `handle.reference`: the same
 * reference resolves to the same session and run identity across a transport
 * loss, `ensureLive` never mints a new one, and `park` suspends the table
 * entry in memory. No `AgentSession` is ever constructed here — that
 * fabrication is exactly what this migration removes.
 *
 * The peer also carries the two #9 facts a resume must respect. Its
 * receive-side lease is renewed by each inbound heartbeat
 * ({@link FakeRemoteEndpoint.receiveHeartbeat}) and, once its window lapses
 * ({@link FakeRemoteEndpoint.advanceLease}), the connection is treated as lost
 * — the run reads `execution-unknown`, never `cancelled`, because a silent peer
 * proves nothing about what the far side did with the work. And its ownership
 * is explicit: a run the peer has not released — in flight, or terminal with
 * replies still outstanding — keeps `park` and `ensureLive` refusing
 * (`still-owned`), so a resume cannot start a second execution of the session
 * the first owner still holds. Reopening happens only on the peer's own drain
 * report, and it reuses the same reference, the same run and the one session
 * the table has always held.
 *
 * Test-only: nothing under `src/` may import this module.
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { deliverInboundEnvelope, toIrcDeliveryReceipt } from "@oh-my-pi/pi-coding-agent/irc/inbound";
import { createLeaseState, isLeaseExpired, tickLease, type LeaseState } from "@oh-my-pi/pi-coding-agent/modes/rpc/lease";
import {
	type AgentEndpoint,
	ENDPOINT_STILL_OWNED_REFUSAL,
	type EndpointControlAck,
	type EndpointEvent,
	EndpointEventStream,
	type EndpointSnapshot,
	type EndpointSnapshotResult,
	type IrcDeliveryOptions,
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
} from "@oh-my-pi/pi-coding-agent/task/endpoint";
import {
	ReplyDrainedBarrier,
	type ReplyDrainedFacts,
	type ReplyDrainedResult,
} from "@oh-my-pi/pi-coding-agent/task/reply-drained";

/** Opaque reference every instance opens its single peer session under. */
const FAKE_REFERENCE = "fake-remote";

/** Caller-supplied behaviour; everything not overridden uses the fixture's defaults. */
export interface FakeRemoteEndpointSimulate {
	/** Overrides `prepare()`. */
	prepare?: () => Promise<PrepareResult>;
	/**
	 * Outcome factory for an in-flight `run()`, read when `run()` starts. The
	 * promise it returns is the only way a non-cancelled run settles, so a test
	 * can hold a run open and resolve it on its own schedule.
	 */
	runResolver?: () => Promise<RunOutcome>;
}

/**
 * One peer-side session opened by the fake, keyed by the opaque reference it
 * was opened under. The recorded pair is the identity a resume must preserve:
 * `ensureLive` resolves this same entry and neither mints a new session nor a
 * new run, and `park` only flips {@link FakeEndpointSession.parked}.
 */
export interface FakeEndpointSession {
	/** The opaque reference the caller handed the peer; the table key. */
	readonly reference: string;
	/** The session's current run id; a resume preserves it. */
	runId: string;
	/** True while the peer-side session is suspended; `ensureLive` clears it. */
	parked: boolean;
	readonly createdAt: number;
}

/** A fake peer that keeps a run in flight until the test settles it. */
export class FakeRemoteEndpoint implements AgentEndpoint {
	/** The opaque reference this peer is addressed by; the remote arm of `AgentEndpointHandle`. */
	readonly handle: { kind: "remote"; reference: string } = { kind: "remote", reference: FAKE_REFERENCE };
	readonly #simulate: FakeRemoteEndpointSimulate;
	readonly #ircBus: IrcBus | undefined;
	readonly #events: EndpointEventStream;
	readonly #barrier = new ReplyDrainedBarrier();
	readonly #sessions = new Map<string, FakeEndpointSession>();
	#sessionsCreated = 0;
	#currentRunId: string | null = null;
	#currentStatus: EndpointSnapshot["status"] = "idle";
	#lastMessage: string | undefined;
	/** Decided outcome of the current run; absent while it has no verdict. First writer wins. */
	#verdict: RunOutcome | undefined;
	/** Deferred for the in-flight `run()`; absent once that run has a verdict. */
	#pending: PromiseWithResolvers<RunOutcome> | undefined;
	/**
	 * The peer's receive-side lease: renewed by inbound heartbeats, expired when
	 * a tick finds the window lapsed with no renewal. Live only as a fact — the
	 * expiry is evaluated on {@link FakeRemoteEndpoint.advanceLease}, never on a
	 * timer, so a test drives time instead of sleeping through it.
	 */
	#lease: LeaseState = createLeaseState();
	/** True once the current lease window was observed lapsed; cleared by the next renewal. */
	#leaseExpired = false;
	/**
	 * The peer's reply-drain fact for the current run. Ownership is released by
	 * the pair (terminal verdict + drained), never by the verdict alone, so the
	 * resume gate reads this flag and not the barrier.
	 */
	#repliesDrained = false;
	/** Reason every inbound delivery is refused with; `null` accepts frames. */
	#deliveryRefusal: string | null = null;
	/** True when the peer hands frames over but never sees the receipt come back. */
	#deliveryIndeterminate = false;
	/** Outcome a delivered frame reports; the peer's own hand-over semantics. */
	#deliveryOutcome: "injected" | "woken" | "revived" = "injected";
	/**
	 * Receipts already produced, keyed by `generation\0operationId`. Never
	 * evicted: the same operation must not be handed over twice, and a cached
	 * refusal must not become a retry.
	 */
	readonly #delivered = new Map<string, IrcDeliveryReceipt>();

	constructor(options: { simulate?: FakeRemoteEndpointSimulate; ircBus?: IrcBus } = {}) {
		this.#simulate = options.simulate ?? {};
		this.#ircBus = options.ircBus;
		this.#events = new EndpointEventStream(this.handle.kind, () => this.#snapshot());
	}

	/** Peer-side sessions this fake has opened, by `handle.reference`; `ensureLive` resolves against it. */
	get sessions(): ReadonlyMap<string, FakeEndpointSession> {
		return this.#sessions;
	}

	/** How many peer-side sessions the fake has opened; a resume must never raise it. */
	get sessionsCreatedCount(): number {
		return this.#sessionsCreated;
	}

	/** Inbound frames this peer took, in delivery order: the envelope verbatim plus the operation it arrived under. */
	readonly frames: { envelope: IrcInboundEnvelope; options: IrcDeliveryOptions }[] = [];
	/** How many times each `(generation, operationId)` was handed over; a replay must stay at one. */
	readonly deliveries = new Map<string, number>();

	/** Refuse every inbound delivery with this reason; `null` accepts them. */
	setDeliveryRefusal(reason: string | null): void {
		this.#deliveryRefusal = reason;
	}

	/** Make every unconfirmed inbound delivery report `indeterminate`; the state a lost receipt produces. */
	setDeliveryIndeterminate(indeterminate: boolean): void {
		this.#deliveryIndeterminate = indeterminate;
	}

	/** Outcome a delivered frame reports; set to `woken`/`revived` to model the peer's own hand-over. */
	setDeliveryOutcome(outcome: "injected" | "woken" | "revived"): void {
		this.#deliveryOutcome = outcome;
	}

	async prepare(): Promise<PrepareResult> {
		const prepare = this.#simulate.prepare;
		if (prepare) return prepare();
		return { role: { agent: "fake-remote", source: "remote" }, capabilities: ["fake_remote/v0"] };
	}

	/** Records the run and returns immediately; the ACK is not an outcome. */
	async start(assignment: string): Promise<RunAck> {
		const runId = crypto.randomUUID();
		this.#currentRunId = runId;
		this.#currentStatus = "running";
		this.#lastMessage = assignment.trim() || undefined;
		this.#verdict = undefined;
		this.#pending = undefined;
		this.#repliesDrained = false;
		this.#openSession(runId);
		const acceptedAt = Date.now();
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

	async run(runId: string): Promise<RunOutcome> {
		if (runId !== this.#currentRunId) {
			throw new Error(`FakeRemoteEndpoint.run: unknown run ${JSON.stringify(runId)}.`);
		}
		// Cancelled or transport-loss verdicts can land before the caller awaits
		// the run; the run already has its outcome, so report it.
		const decided = this.#verdict;
		if (decided) return decided;
		const deferred = Promise.withResolvers<RunOutcome>();
		this.#pending = deferred;
		const resolveOutcome = this.#simulate.runResolver;
		if (resolveOutcome) {
			void resolveOutcome().then(
				outcome => this.#settle(outcome),
				error => deferred.reject(error),
			);
		}
		return deferred.promise;
	}

	/**
	 * Settle the current run with a peer-reported outcome, mapped verbatim. A
	 * run id that is not the current one is refused: a verdict written onto the
	 * wrong run would make the three views disagree about which run ended.
	 */
	completeRun(outcome: RunOutcome): void {
		if (outcome.runId !== this.#currentRunId) {
			throw new Error(
				`FakeRemoteEndpoint.completeRun: outcome for ${JSON.stringify(outcome.runId)} does not match the current run (${this.#currentRunId ?? "none"}).`,
			);
		}
		this.#settle(outcome);
	}

	/** A cancelled run still reaches a verdict: the peer reports back before its transport closes. */
	async cancelRun(runId: string): Promise<void> {
		if (runId !== this.#currentRunId) {
			throw new Error(`FakeRemoteEndpoint.cancelRun: unknown run ${JSON.stringify(runId)}.`);
		}
		this.#settle({ status: "cancelled", runId }, "cancelled by caller");
	}

	/**
	 * Simulates losing the transport mid-run. The run settles with
	 * `execution-unknown` on every view instead of a failure verdict, and a
	 * resolver that arrives later cannot overwrite it. The peer-side session
	 * survives, so the same reference can be reopened — but only once its owner
	 * has let go: a lost connection confirms nothing about what the far side did
	 * with the work, so this reports neither cancellation nor a completed
	 * cleanup, and the run stays `still-owned` until the peer's own drain fact
	 * lands.
	 */
	abortTransport(): void {
		const runId = this.#currentRunId;
		if (runId === null) return;
		this.#settle({ status: "execution-unknown", runId, error: "transport aborted" }, "transport aborted");
	}

	/**
	 * Report the peer's run as reply-drained — the fact that lands after the
	 * terminal run. Until it does, `waitReplyDrained` stays blocked, which is
	 * what keeps "terminal" from being read as "stopped without replying", and
	 * the peer keeps owning the run, which is what keeps a resume out of it.
	 * Together with the terminal verdict this is the ownership release.
	 */
	emitReplyDrained(runId: string, facts?: ReplyDrainedFacts): void {
		if (runId !== this.#currentRunId) {
			throw new Error(
				`FakeRemoteEndpoint.emitReplyDrained: unknown run ${JSON.stringify(runId)} (current run: ${this.#currentRunId ?? "none"}).`,
			);
		}
		this.#barrier.markDrained(runId, facts);
		this.#repliesDrained = true;
		this.#events.emit({ type: "reply_drained", runId, ...facts });
	}

	/**
	 * Record one inbound heartbeat at `now`: the receive-side lease is renewed
	 * and the fact is published as a `heartbeat_received` event. Renewing is all
	 * it does — a live peer proves the connection, never a run's outcome, so the
	 * snapshot is left alone (which is why the event's `runId` is optional: a
	 * heartbeat can arrive between runs).
	 */
	receiveHeartbeat(now = Date.now()): void {
		this.#lease = tickLease(this.#lease, now);
		this.#leaseExpired = false;
		const runId = this.#currentRunId;
		this.#events.emit({ type: "heartbeat_received", ...(runId !== null ? { runId } : {}), timestamp: now });
	}

	/**
	 * Evaluate the receive-side lease at `now`. A window that lapsed with no
	 * inbound heartbeat is the disconnect path — the same semantics as
	 * {@link FakeRemoteEndpoint.abortTransport}, reached through silence rather
	 * than a torn pipe: the current run reads `execution-unknown`, nothing is
	 * cancelled and nothing is replayed, and ownership stays with the peer until
	 * its drain fact lands. The first tick that observes the lapse publishes the
	 * `lease_expired` event; later ticks over the same lapse are silent, and a
	 * renewal arms the next one.
	 */
	advanceLease(now: number): void {
		if (!isLeaseExpired(this.#lease, now) || this.#leaseExpired) return;
		this.#leaseExpired = true;
		const runId = this.#currentRunId;
		this.#events.emit({ type: "lease_expired", ...(runId !== null ? { runId } : {}), timestamp: now });
		if (runId === null) return;
		this.#settle({ status: "execution-unknown", runId, error: "receive lease expired" }, "receive lease expired");
	}

	async terminate(): Promise<void> {
		this.#pending = undefined;
		this.#verdict = undefined;
		this.#repliesDrained = false;
		this.#currentRunId = null;
		this.#currentStatus = "idle";
		this.#lastMessage = "terminated";
		this.#events.emit({ type: "status_changed", status: "idle", message: "terminated" });
	}

	async snapshot(): Promise<EndpointSnapshotResult> {
		return { revision: this.#events.revision, snapshot: this.#snapshot() };
	}

	subscribe(fromRevision?: number): AsyncIterable<EndpointEvent> {
		return this.#events.subscribe(fromRevision);
	}

	/**
	 * Deliver one inbound frame to this peer through the configured in-memory
	 * transport, recording it exactly as received.
	 *
	 * The receipt distinguishes the three states the contract allows: delivered
	 * (the transport took it), failed (this peer refuses it,
	 * {@link FakeRemoteEndpoint.setDeliveryRefusal}, or no
	 * {@link FakeRemoteEndpoint} transport was configured), and indeterminate
	 * (the transport never sees the receipt come back,
	 * {@link FakeRemoteEndpoint.setDeliveryIndeterminate}). Without a configured
	 * `ircBus` the answer is always an explicit failed
	 * `inbound IRC transport not configured` — never a faked delivered.
	 *
	 * A repeated `(generation, operationId)` — the sender retrying, a transport
	 * replaying — returns the first delivery's receipt and does not record or
	 * hand over the message again, mirroring the real boundary's dedup.
	 */
	async deliverIrc(envelope: IrcInboundEnvelope, options?: IrcDeliveryOptions): Promise<IrcDeliveryReceipt> {
		const generation = options?.generation ?? 0;
		const operationId = options?.operationId ?? envelope.id;
		const key = `${generation}\u0000${operationId}`;
		const injected = this.#delivered.get(key);
		if (injected) return injected;
		const receipt = await this.#deliverFrame(envelope, options, generation, operationId);
		this.#delivered.set(key, receipt);
		return receipt;
	}
	/** Count one handed-over operation so a test can assert a replay never doubled it. */
	#countDelivery(generation: number, operationId: string): void {
		const key = `${generation}\u0000${operationId}`;
		this.deliveries.set(key, (this.deliveries.get(key) ?? 0) + 1);
	}
	/**
	 * One first-time delivery: refused without touching the transport, otherwise
	 * handed to the configured bus through the shared inbound boundary and then
	 * reported (unconfirmed when the indeterminate switch is set).
	 */
	async #deliverFrame(
		envelope: IrcInboundEnvelope,
		options: IrcDeliveryOptions | undefined,
		generation: number,
		operationId: string,
	): Promise<IrcDeliveryReceipt> {
		if (this.#deliveryRefusal !== null) {
			return { status: "failed", to: envelope.to, error: this.#deliveryRefusal };
		}
		const bus = this.#ircBus;
		if (!bus) {
			return { status: "failed", to: envelope.to, error: "inbound IRC transport not configured" };
		}
		this.frames.push({ envelope, options: { ...options, generation, operationId } });
		this.#countDelivery(generation, operationId);
		if (this.#deliveryIndeterminate) {
			await deliverInboundEnvelope(bus, envelope, operationId, generation, options);
			return { status: "indeterminate", to: envelope.to, error: "fixed receipt never arrived" };
		}
		const result = await deliverInboundEnvelope(bus, envelope, operationId, generation, options);
		return toIrcDeliveryReceipt(result);
	}

	/** Terminal-and-drained wait for this run; see {@link ReplyDrainedBarrier.await}. */
	async waitReplyDrained(runId: string, opts?: { signal?: AbortSignal }): Promise<ReplyDrainedResult> {
		return this.#barrier.await(runId, opts?.signal);
	}

	/**
	 * Suspend the peer-side session in the in-memory table: the entry keeps its
	 * run identity and is only marked parked, and the acknowledgement names the
	 * opaque reference a later resume passes back.
	 *
	 * A refusal is a refusal of the *state*, not of the request: a run that is
	 * still in flight or still owes replies is one the peer still owns, and
	 * freezing it mid-flight would strand the owner's work under a session two
	 * callers believe is idle (D4). Those two cases answer `still-owned`, the
	 * same gate a resume reads.
	 */
	async park(runId: string): Promise<EndpointControlAck> {
		const session = this.#sessions.get(this.handle.reference);
		if (runId !== this.#currentRunId) {
			return {
				acknowledged: false,
				reason: `unknown run ${JSON.stringify(runId)} (current run: ${this.#currentRunId ?? "none"})`,
			};
		}
		if (!session) return { acknowledged: false, reason: "the peer holds no session to park" };
		const owned = this.#ownershipRefusal();
		if (owned) return { acknowledged: false, reason: owned };
		session.parked = true;
		return { acknowledged: true, resumeReference: session.reference };
	}

	/**
	 * Resume/keep-alive for an existing opaque reference: the same session
	 * entry is reused, its run identity preserved, its parked flag cleared, and
	 * nothing new is created. An unknown reference is refused outright — a
	 * resume must never open a new session.
	 *
	 * A reference the peer still owns is refused too, and that refusal is the
	 * point of the gate: reopening while the first execution is in flight, or
	 * while its cleanup is unconfirmed, would run the same logical session
	 * twice. Ownership is released by the terminal-plus-drained pair, so the
	 * refusal outlives the run's verdict — a disconnected or cancelled run whose
	 * replies have not drained is still owned.
	 */
	async ensureLive(reference: string): Promise<EndpointControlAck> {
		const session = this.#sessions.get(reference);
		if (!session) {
			return {
				acknowledged: false,
				reason: `unknown reference ${JSON.stringify(reference)}; resume never opens a new session`,
			};
		}
		const owned = this.#ownershipRefusal();
		if (owned) return { acknowledged: false, reason: owned };
		session.parked = false;
		return { acknowledged: true };
	}

	/**
	 * Not implemented: #8 defers the peer-scoped content channel to #13. A stub
	 * that cannot return content answers not-implemented rather than inventing
	 * bytes.
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
	 * The peer's ownership of its current run, as a refusal reason: present
	 * while the run is in flight, and present again after a terminal verdict
	 * until the replies drain. `undefined` once the owner has let go — the only
	 * state in which `park` and `ensureLive` proceed.
	 */
	#ownershipRefusal(): string | undefined {
		const runId = this.#currentRunId;
		if (runId === null) return undefined;
		if (this.#verdict === undefined) return `${ENDPOINT_STILL_OWNED_REFUSAL}: run ${runId} is in flight`;
		if (!this.#repliesDrained) {
			return `${ENDPOINT_STILL_OWNED_REFUSAL}: run ${runId} reached ${this.#verdict.status} but has not drained its replies`;
		}
		return undefined;
	}

	/** Open the peer session for `handle.reference` on first use; later runs reuse that session. */
	#openSession(runId: string): void {
		const existing = this.#sessions.get(this.handle.reference);
		if (existing) {
			existing.runId = runId;
			return;
		}
		this.#sessions.set(this.handle.reference, {
			reference: this.handle.reference,
			runId,
			parked: false,
			createdAt: Date.now(),
		});
		this.#sessionsCreated += 1;
	}

	/**
	 * Records the first verdict on the shared run state and hands it to the
	 * awaiting `run()`. Later writers — a resolver landing after a cancel or a
	 * transport loss — are dropped, so the three views cannot report two
	 * different endings for one run. The verdict is what makes the run terminal
	 * for the reply barrier; draining stays a separate fact.
	 */
	#settle(outcome: RunOutcome, message?: string): void {
		if (this.#verdict) return;
		this.#verdict = outcome;
		this.#currentStatus = outcome.status;
		if (message !== undefined) this.#lastMessage = message;
		this.#barrier.markTerminal(outcome.runId);
		this.#events.emit({ type: "run_outcome", runId: outcome.runId, outcome });
		const lastMessage = this.#lastMessage;
		this.#events.emit({
			type: "status_changed",
			runId: outcome.runId,
			status: outcome.status,
			...(lastMessage !== undefined ? { message: lastMessage } : {}),
		});
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.resolve(outcome);
	}

	#snapshot(): EndpointSnapshot {
		const snapshot: EndpointSnapshot = {
			runId: this.#currentRunId,
			status: this.#currentStatus,
			endpointKind: this.handle.kind,
		};
		if (this.#lastMessage !== undefined) snapshot.message = this.#lastMessage;
		return snapshot;
	}
}
