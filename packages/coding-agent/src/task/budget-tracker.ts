import { ParamsError, type RunContract } from "./params";

export type RunBounds = Pick<RunContract, "budget" | "timeout" | "depth" | "spawns">;

/** A caller-owned ledger; reuse it across endpoints and follow-ups, never key by host. */
export class RunBoundsLedger {
	readonly #limits: RunBounds;
	readonly #parent?: RunBoundsLedger;
	readonly #deadline?: number;
	#tokens = 0;
	#spawns = 0;

	constructor(limits: RunBounds = {}, parent?: RunBoundsLedger) {
		this.#limits = { ...limits };
		this.#parent = parent;
		if (limits.timeout !== undefined) this.#deadline = Date.now() + limits.timeout * 1000;
	}

	check(): ParamsError | undefined {
		for (let ledger: RunBoundsLedger | undefined = this; ledger; ledger = ledger.#parent) {
			if (ledger.#deadline !== undefined && Date.now() >= ledger.#deadline) return new ParamsError("conflict-with-remote-policy", "Cumulative delegation timeout exhausted", "timeout");
			if (ledger.#limits.budget !== undefined && ledger.#tokens >= ledger.#limits.budget) return new ParamsError("conflict-with-remote-policy", "Cumulative delegation budget exhausted", "budget");
		}
		return undefined;
	}

	/** Reservations commit only after every ancestor accepts; follow-ups are not new spawns. */
	reserve(options: { depth?: number; spawn?: boolean } = {}): ParamsError | undefined {
		const error = this.check();
		if (error) return error;
		const depth = options.depth ?? 0;
		const spawn = options.spawn ?? true;
		if (!Number.isSafeInteger(depth) || depth < 0) return new ParamsError("invalid-shape", "depth must be a non-negative integer", "depth");
		for (let ledger: RunBoundsLedger | undefined = this; ledger; ledger = ledger.#parent) {
			if (ledger.#limits.depth !== undefined && depth > ledger.#limits.depth) return new ParamsError("conflict-with-remote-policy", "Delegation depth exceeds caller limit", "depth");
			if (spawn && ledger.#limits.spawns !== undefined && ledger.#spawns >= ledger.#limits.spawns) return new ParamsError("conflict-with-remote-policy", "Cumulative delegation spawn limit exhausted", "spawns");
		}
		if (spawn) for (let ledger: RunBoundsLedger | undefined = this; ledger; ledger = ledger.#parent) ledger.#spawns++;
		return undefined;
	}

	recordUsage(tokens: number): ParamsError | undefined {
		if (!Number.isFinite(tokens) || tokens < 0) return new ParamsError("invalid-shape", "Usage must be a finite non-negative token count", "budget");
		for (let ledger: RunBoundsLedger | undefined = this; ledger; ledger = ledger.#parent) ledger.#tokens += tokens;
		return this.check();
	}

	remainingTimeoutMs(): number | undefined {
		let remaining: number | undefined;
		const now = Date.now();
		for (let ledger: RunBoundsLedger | undefined = this; ledger; ledger = ledger.#parent) {
			if (ledger.#deadline !== undefined) remaining = Math.min(remaining ?? Infinity, Math.max(0, ledger.#deadline - now));
		}
		return remaining;
	}
}
