/**
 * Reply-drained barrier: a run is finished only when it is terminal *and* owes
 * no more replies (RFC #1 §6.5, R5).
 *
 * The two facts arrive independently — a run's terminal outcome usually
 * precedes its last outbound reply by a delivery round trip — so neither may be
 * inferred from the other. A caller that folds "terminal" into "stopped
 * without replying" strands an awaited `hub` send; a caller that folds "already
 * replied" into "terminal" reports a verdict the run never produced. This
 * barrier keeps both facts per run id and releases a waiter only when the pair
 * is complete. Facts a caller needs beside the verdict — which status revision
 * made the run terminal, how much outbound a peer confirmed — travel with it,
 * recorded per run.
 *
 * Local runs auto-drain (their replies are in-process); a remote run drains
 * when its peer's barrier frame lands (#9/#11). Nothing here performs I/O.
 */

/**
 * Whether a drain wait completed on its own facts or because its caller's
 * signal aborted the wait.
 */
export type ReplyDrainedStatus = "drained" | "aborted";

/**
 * Facts the barrier carries beside a drain verdict. Each one is recorded for
 * the run it names and nowhere else: `runStatusRevision` is the revision of the
 * status event that made that run terminal, `outboundWatermark` the sender's
 * outbound count at the moment its replies drained. Both are optional — a local
 * run has no outbound channel, and a fact nobody observed is omitted rather
 * than defaulted, so a reader can tell "no revision" from "revision 0".
 */
export interface ReplyDrainedFacts {
	runStatusRevision?: number;
	outboundWatermark?: number;
}

/**
 * Result of {@link ReplyDrainedBarrier.await}. `aborted` describes the waiting
 * call, never the run: the run may still be in flight, and an aborted wait has
 * learnt nothing new about it. A drained result carries the facts recorded for
 * that run, so the verdict and the terminal revision a caller reports come from
 * one state instead of two racy reads.
 */
export type ReplyDrainedResult = ({ status: "drained" } & ReplyDrainedFacts) | { status: "aborted" };

/** Facts and live waiters for one run id. */
interface DrainState {
	terminal: boolean;
	drained: boolean;
	waiters: Set<DrainWaiter>;
	runStatusRevision?: number;
	outboundWatermark?: number;
}

/** One `await()` call: its own result, plus the abort wiring that must be undone on settle. */
interface DrainWaiter {
	deferred: PromiseWithResolvers<ReplyDrainedResult>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/**
 * Tracks "terminal" and "reply-drained" per run and hands both facts to
 * waiters. Facts and waiters are keyed by run id, so several runs of one
 * endpoint (a resumed session's successive runs, a roster's overlapping runs)
 * never leak into each other.
 */
export class ReplyDrainedBarrier {
	readonly #runs = new Map<string, DrainState>();

	/**
	 * Record that `runId` reached a terminal verdict. Independent of draining:
	 * a terminal run with replies still in flight keeps its waiters blocked
	 * until {@link markDrained}.
	 */
	markTerminal(runId: string, facts?: ReplyDrainedFacts): void {
		const state = this.#state(runId);
		if (facts?.runStatusRevision !== undefined) state.runStatusRevision = facts.runStatusRevision;
		if (facts?.outboundWatermark !== undefined) state.outboundWatermark = facts.outboundWatermark;
		if (state.terminal) return;
		state.terminal = true;
		this.#release(state);
	}

	/** Record that `runId` owes no further replies (delivered or definitively failed); `facts` are recorded the same way. */
	markDrained(runId: string, facts?: ReplyDrainedFacts): void {
		const state = this.#state(runId);
		if (facts?.runStatusRevision !== undefined) state.runStatusRevision = facts.runStatusRevision;
		if (facts?.outboundWatermark !== undefined) state.outboundWatermark = facts.outboundWatermark;
		if (state.drained) return;
		state.drained = true;
		this.#release(state);
	}

	/**
	 * Wait until `runId` is both terminal and drained. Each call registers an
	 * independent waiter with its own deferred, so aborting one wait resolves
	 * only that waiter and never poisons the others or the recorded facts.
	 * Passing no signal means waiting for the pair; a run that never reaches
	 * one of the two states keeps the caller waiting by design.
	 */
	await(runId: string, signal?: AbortSignal): Promise<ReplyDrainedResult> {
		const state = this.#state(runId);
		if (state.terminal && state.drained) return Promise.resolve(this.#drained(state));
		if (signal?.aborted) return Promise.resolve({ status: "aborted" });
		const waiter: DrainWaiter = { deferred: Promise.withResolvers<ReplyDrainedResult>() };
		if (signal) {
			const onAbort = (): void => {
				if (!state.waiters.delete(waiter)) return;
				signal.removeEventListener("abort", onAbort);
				waiter.deferred.resolve({ status: "aborted" });
			};
			waiter.signal = signal;
			waiter.onAbort = onAbort;
			signal.addEventListener("abort", onAbort, { once: true });
		}
		state.waiters.add(waiter);
		return waiter.deferred.promise;
	}

	#state(runId: string): DrainState {
		let state = this.#runs.get(runId);
		if (!state) {
			state = { terminal: false, drained: false, waiters: new Set() };
			this.#runs.set(runId, state);
		}
		return state;
	}

	/** The drained result for one run, carrying exactly the facts recorded for it. */
	#drained(state: DrainState): ReplyDrainedResult {
		return {
			status: "drained",
			...(state.runStatusRevision !== undefined ? { runStatusRevision: state.runStatusRevision } : {}),
			...(state.outboundWatermark !== undefined ? { outboundWatermark: state.outboundWatermark } : {}),
		};
	}

	/**
	 * Release every waiter of a fully-drained run. The facts stay behind so a
	 * late {@link await} still resolves immediately; waiters that were already
	 * aborted are no longer in the set and are left untouched.
	 */
	#release(state: DrainState): void {
		if (!state.terminal || !state.drained || state.waiters.size === 0) return;
		const waiters = [...state.waiters];
		state.waiters.clear();
		for (const waiter of waiters) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.deferred.resolve(this.#drained(state));
		}
	}
}
