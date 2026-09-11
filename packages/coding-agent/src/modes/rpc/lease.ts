/**
 * Managed heartbeat and receive-lease clock (RFC #1 §8 D4).
 *
 * The managed protocol watches a connection from both ends. Each end sends a
 * heartbeat and each end renews *its own* receive clock on any valid control
 * frame it accepts; a clock that goes a full lease window without a renewal
 * means the peer is gone, and its owner acts on that exactly as it acts on a
 * dropped transport — never as a completed run.
 *
 * The clock is pure state plus pure functions: nothing here schedules timers,
 * reads a socket or owns a run, so a caller can drive it from an interval, from
 * the frame loop, or from a test with a hand-supplied `now`.
 *
 * Durations come from three places, in order: an explicit proposal (what
 * `prepare` sends and confirms), then the test-only environment overrides, then
 * the design defaults. `DEFAULT_HEARTBEAT_SECONDS` and `DEFAULT_LEASE_SECONDS`
 * are protocol design parameters, not measurements of any running system.
 */
import { $envpos } from "@oh-my-pi/pi-utils";

/** Design default: how often a managed peer sends a heartbeat. */
export const DEFAULT_HEARTBEAT_SECONDS = 10;

/** Design default: how long a receive clock may go un-renewed before the peer counts as gone. */
export const DEFAULT_LEASE_SECONDS = 30;

/**
 * Test-only overrides, read when a caller proposes no duration. They let a test
 * shrink the clock instead of waiting out the real seconds; because an explicit
 * proposal always wins, a value confirmed by `prepare` is never overridden.
 */
const LEASE_SECONDS_ENV = "PI_MANAGED_LEASE_SECONDS";
const HEARTBEAT_SECONDS_ENV = "PI_MANAGED_HEARTBEAT_SECONDS";

/** Durations a caller proposes; each field is optional and falls back per field. */
export interface LeaseDurations {
	heartbeatSeconds?: number;
	leaseSeconds?: number;
}

/**
 * One end's receive clock: the windows that bound it and the timestamp of the
 * last accepted heartbeat. Any valid control frame renews it, not only an
 * explicit `heartbeat` command.
 */
export interface LeaseState {
	heartbeatSeconds: number;
	leaseSeconds: number;
	/** Epoch ms of the last accepted heartbeat, stamped locally on receipt. */
	lastHeartbeatAt: number;
}

/** The windows both ends will enforce, as `prepare` reports them. */
export interface NegotiatedLease {
	heartbeatSeconds: number;
	leaseSeconds: number;
}

/** A proposal only counts when it is a positive, finite number of seconds. */
function positiveSeconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Build a receive clock. `durations` wins per field; an omitted or non-positive
 * field takes the test-only override when one is set, otherwise the design
 * default.
 */
export function createLeaseState(now = Date.now(), durations: LeaseDurations = {}): LeaseState {
	return {
		heartbeatSeconds:
			positiveSeconds(durations.heartbeatSeconds) ?? $envpos(HEARTBEAT_SECONDS_ENV, DEFAULT_HEARTBEAT_SECONDS),
		leaseSeconds: positiveSeconds(durations.leaseSeconds) ?? $envpos(LEASE_SECONDS_ENV, DEFAULT_LEASE_SECONDS),
		lastHeartbeatAt: now,
	};
}

/** Renew the clock on an accepted heartbeat; see {@link LeaseState.lastHeartbeatAt}. */
export function tickLease(state: LeaseState, now = Date.now()): LeaseState {
	return { ...state, lastHeartbeatAt: now };
}

/**
 * True once the clock has gone strictly longer than one lease since the last
 * heartbeat. A heartbeat exactly on the boundary is not yet expired, so a peer
 * that answers at the deadline is late rather than lost.
 */
export function isLeaseExpired(state: LeaseState, now = Date.now()): boolean {
	return now - state.lastHeartbeatAt > state.leaseSeconds * 1000;
}

/**
 * Agree on the window one field names: the stricter of the two proposals.
 *
 * - both propose a usable value → the smaller one wins, so either side may ask
 *   for a tighter watchdog;
 * - one side is silent or malformed → the other side's value stands, so silence
 *   means "no preference" rather than "reset to the default";
 * - neither proposes anything → the design default.
 */
function agreeSeconds(client: unknown, server: unknown, fallback: number): number {
	const proposed = positiveSeconds(client);
	const accepted = positiveSeconds(server);
	if (proposed === undefined) return accepted ?? fallback;
	if (accepted === undefined) return proposed;
	return Math.min(proposed, accepted);
}

/**
 * Agree on the windows both ends enforce, per field. Inputs are duration
 * proposals — a full {@link LeaseState} or a bare `{heartbeatSeconds,
 * leaseSeconds}` offer both fit — and a non-positive or non-finite value is
 * discarded rather than inherited, so a malformed offer can never disable the
 * lease or stretch a window past what the other side will watch.
 */
export function negotiateLease(client: LeaseDurations, server: LeaseDurations): NegotiatedLease {
	return {
		heartbeatSeconds: agreeSeconds(client.heartbeatSeconds, server.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS),
		leaseSeconds: agreeSeconds(client.leaseSeconds, server.leaseSeconds, DEFAULT_LEASE_SECONDS),
	};
}
