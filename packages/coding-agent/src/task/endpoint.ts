/**
 * Agent endpoint contract (RFC #1 §8 D1) — stage-1 skeleton for issue #3.
 *
 * An endpoint is the minimal handle a `task` spawn needs regardless of where
 * it executes: the four-method contract (`prepare` / `start` / `run` /
 * `cancelRun`) plus teardown (`terminate`), and three read views over the same
 * run state. It exists so the monitor (`AsyncJobManager`), the registry
 * (`AgentRegistry`), and the Hub job renderers can eventually read one
 * transport-agnostic surface instead of branching on "local vs remote".
 *
 * Two invariants this module protects on its own:
 *
 * 1. **Local behaviour is bit-for-bit preserved.** `LocalAgentEndpoint` is a
 *    passive adapter over an already-created `AgentSession`; nothing in this
 *    module creates a session, spawns a process, or opens a connection, and no
 *    existing execution path is rerouted through it in this slice.
 * 2. **`execution-unknown` is a transport verdict, not a failure verdict.** It
 *    means the run reached a state the endpoint can no longer observe (peer
 *    gone, connection dropped, SSH session lost) — not that the run failed.
 *    Only remote endpoints can report it; a local run always reaches one of
 *    `completed` / `failed` / `cancelled`.
 *
 * Not yet integrated: the monitor, the agent registry, and the `hub` job/list
 * renderers still read `AsyncJob.status` / `AgentStatus` directly, and
 * `AsyncJob.status` is not widened to {@link RunOutcomeStatus} here. Both land
 * with the monitor/registry migration under #8.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";
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
 * the one new state this slice introduces, and it is deliberately *not* an
 * alias for `failed` — see the module doc.
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
 * plain string list in this slice (one stable token per feature); the
 * negotiated capability set and the `prepare`/`start` gate in front of a spawn
 * land with #7.
 */
export interface PrepareResult {
	role: { agent: string; source: "local" | "remote" };
	capabilities: string[];
}

/**
 * Shared minimum view of one endpoint's current run state. The three
 * `as*Snapshot()` readers on {@link AgentEndpoint} return this same shape in
 * this slice, so a job row, a handle badge, and a roster line cannot disagree
 * about the same run. Display-only wording belongs to the wrapping surface,
 * never here.
 */
export interface EndpointSnapshot {
	/** Current run, or `null` before `start()` / after `terminate()`. */
	runId: string | null;
	/** `idle` before a run, `running` while it is in flight, then the run's terminal status. */
	status: "idle" | "running" | RunOutcomeStatus;
	endpointKind: AgentEndpointKind;
	message?: string;
}

/**
 * Where a spawn actually runs.
 *
 * Lifecycle: `prepare()` (optional pre-flight) → `start()` (immediate ACK) →
 * `run()` (the only outcome) → `cancelRun()`/`terminate()` as needed.
 *
 * Deliberately absent from this v0 surface — *unsettled*, not forgotten, and
 * nothing may assume their presence until the owning slice lands:
 *
 * - `deliverIrc`, `replyQuiescence` — cross-host message delivery and the
 *   "has the peer stopped talking" question: #9.
 * - `park`, `ensureLive` — suspending a run and reviving a peer: #8.
 * - `readResource` — fetching a remote transcript/artifact through the
 *   endpoint instead of the local filesystem: #11.
 * - `respondUi` — routing an interactive UI question to the run's owner: #13.
 * - `snapshot`, `subscribe` — live progress streaming; the three static
 *   `as*Snapshot()` views below are the subset this slice freezes.
 */
export interface AgentEndpoint {
	/** The session or peer reference this endpoint was built around. */
	readonly handle: AgentEndpointHandle;
	prepare(): Promise<PrepareResult>;
	start(assignment: string): Promise<RunAck>;
	run(runId: string, signal?: AbortSignal): Promise<RunOutcome>;
	cancelRun(runId: string): Promise<void>;
	terminate(): Promise<void>;
	/** Monitor-facing view (`hub jobs` rows become consumers of this in #8). */
	asJobSnapshot(): EndpointSnapshot;
	/** Handle-facing view (`hub list` rows become consumers of this in #8). */
	asHandleSnapshot(): EndpointSnapshot;
	/** Roster-facing view (agent roster lines become consumers of this in #8). */
	asRosterSnapshot(): EndpointSnapshot;
}
