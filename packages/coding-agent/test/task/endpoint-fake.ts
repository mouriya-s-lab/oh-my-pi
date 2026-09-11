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
 * Test-only: nothing under `src/` may import this module.
 */

import {
	type AgentEndpoint,
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
} from "@oh-my-pi/pi-coding-agent/task/endpoint";
import { ReplyDrainedBarrier, type ReplyDrainedResult } from "@oh-my-pi/pi-coding-agent/task/reply-drained";

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

	constructor(options: { simulate?: FakeRemoteEndpointSimulate } = {}) {
		this.#simulate = options.simulate ?? {};
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
	 * survives, so the same reference can be resumed.
	 */
	abortTransport(): void {
		const runId = this.#currentRunId;
		if (runId === null) return;
		this.#settle({ status: "execution-unknown", runId, error: "transport aborted" }, "transport aborted");
	}

	/**
	 * Report the peer's run as reply-drained — the fact that lands after the
	 * terminal run. Until it does, `waitReplyDrained` stays blocked, which is
	 * what keeps "terminal" from being read as "stopped without replying".
	 */
	emitReplyDrained(runId: string): void {
		if (runId !== this.#currentRunId) {
			throw new Error(
				`FakeRemoteEndpoint.emitReplyDrained: unknown run ${JSON.stringify(runId)} (current run: ${this.#currentRunId ?? "none"}).`,
			);
		}
		this.#barrier.markDrained(runId);
		this.#events.emit({ type: "reply_drained", runId });
	}

	async terminate(): Promise<void> {
		this.#pending = undefined;
		this.#verdict = undefined;
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
	 * Not implemented: #8 defers the inbound routing to #11. The answer is a
	 * resolved not-implemented receipt naming the owning slice; a fake that
	 * cannot deliver must not borrow the local bus receipt either.
	 */
	async deliverIrc(_envelope: IrcInboundEnvelope): Promise<IrcDeliveryReceipt> {
		return { status: "not-implemented", detail: IRC_TRANSPORT_DEFERRED };
	}

	/** Terminal-and-drained wait for this run; see {@link ReplyDrainedBarrier.await}. */
	async waitReplyDrained(runId: string, opts?: { signal?: AbortSignal }): Promise<ReplyDrainedResult> {
		return this.#barrier.await(runId, opts?.signal);
	}

	/**
	 * Suspends the peer-side session in the in-memory table: the entry keeps its
	 * run identity and is only marked parked. The busy / reply-obligation
	 * refusal rules belong to the managed protocol (#9); this fake models the
	 * identity-preserving suspension those rules gate.
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
		session.parked = true;
		return { acknowledged: true };
	}

	/**
	 * Resume/keep-alive for an existing opaque reference: the same session
	 * entry is reused, its run identity preserved, its parked flag cleared, and
	 * nothing new is created. An unknown reference is refused outright — a
	 * resume must never open a new session.
	 */
	async ensureLive(reference: string): Promise<EndpointControlAck> {
		const session = this.#sessions.get(reference);
		if (!session) {
			return {
				acknowledged: false,
				reason: `unknown reference ${JSON.stringify(reference)}; resume never opens a new session`,
			};
		}
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
