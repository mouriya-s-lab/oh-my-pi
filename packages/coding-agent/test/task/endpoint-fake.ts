/**
 * Test double for a *remote* endpoint.
 *
 * It exists to exercise the part of the contract a local endpoint cannot:
 * `execution-unknown`, the verdict only a lost transport produces. The fake
 * holds a run open until the test advances it, so a test can observe the gap
 * between the start ACK and the outcome — the ordering the contract has to
 * guarantee before the monitor migration (#8) can rely on it.
 *
 * Test-only: nothing under `src/` may import this module.
 */

import type {
	AgentEndpoint,
	AgentEndpointHandle,
	EndpointSnapshot,
	PrepareResult,
	RunAck,
	RunOutcome,
} from "@oh-my-pi/pi-coding-agent/task/endpoint";

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

/** A fake peer that keeps a run in flight until the test settles it. */
export class FakeRemoteEndpoint implements AgentEndpoint {
	readonly handle: AgentEndpointHandle = { kind: "remote", reference: "fake-remote" };
	readonly #simulate: FakeRemoteEndpointSimulate;
	#currentRunId: string | null = null;
	#currentStatus: EndpointSnapshot["status"] = "idle";
	#lastMessage: string | undefined;
	/** Decided outcome of the current run; absent while it has no verdict. First writer wins. */
	#verdict: RunOutcome | undefined;
	/** Deferred for the in-flight `run()`; absent once that run has a verdict. */
	#pending: PromiseWithResolvers<RunOutcome> | undefined;

	constructor(options: { simulate?: FakeRemoteEndpointSimulate } = {}) {
		this.#simulate = options.simulate ?? {};
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
		return { runId, acceptedAt: Date.now() };
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
	 * resolver that arrives later cannot overwrite it.
	 */
	abortTransport(): void {
		const runId = this.#currentRunId;
		if (runId === null) return;
		this.#settle({ status: "execution-unknown", runId, error: "transport aborted" }, "transport aborted");
	}

	async terminate(): Promise<void> {
		this.#pending = undefined;
		this.#verdict = undefined;
		this.#currentRunId = null;
		this.#currentStatus = "idle";
		this.#lastMessage = "terminated";
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
	 * Records the first verdict on the shared run state and hands it to the
	 * awaiting `run()`. Later writers — a resolver landing after a cancel or a
	 * transport loss — are dropped, so the three views cannot report two
	 * different endings for one run.
	 */
	#settle(outcome: RunOutcome, message?: string): void {
		if (this.#verdict) return;
		this.#verdict = outcome;
		this.#currentStatus = outcome.status;
		if (message !== undefined) this.#lastMessage = message;
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
