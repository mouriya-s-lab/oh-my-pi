/**
 * Local (in-process) implementation of {@link AgentEndpoint}.
 *
 * The adapter is passive by design. The caller already created the
 * `AgentSession` and keeps driving it through the existing executor path; this
 * class only records which run is current and translates the session's
 * terminal event into a {@link RunOutcome}. It takes no locks, does no I/O, and
 * has no side effects beyond delegating to the hooks it was given — so wiring
 * it in cannot change local execution. The executor-side migration that
 * instantiates one per spawn is #8, together with widening `AsyncJob.status`.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import type {
	AgentEndpoint,
	AgentEndpointHandle,
	EndpointSnapshot,
	PrepareResult,
	RunAck,
	RunOutcome,
} from "../endpoint";
import type { StructuredSubagentOutput } from "../types";

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
	/** Resolves with the current run's terminal verdict. */
	awaitTerminal: (signal?: AbortSignal) => Promise<LocalTerminalResult>;
	/** Cancels the current run. The endpoint delegates; it never touches the session. */
	cancelRun: (runId: string) => Promise<void>;
	/** Releases the session's resources on `terminate()`. */
	terminate: () => Promise<void>;
}

/**
 * Wraps one live `AgentSession` in the four-method endpoint contract.
 *
 * `start()` allocates the run id and records the intent — kicking off the
 * actual session run stays with the executor that owns the session. `run()`
 * waits for the terminal event through the caller's hook and records its
 * verdict on the endpoint's shared run state.
 */
export class LocalAgentEndpoint implements AgentEndpoint {
	readonly handle: AgentEndpointHandle;
	readonly #agent: string;
	readonly #awaitTerminal: (signal?: AbortSignal) => Promise<LocalTerminalResult>;
	readonly #cancelHook: (runId: string) => Promise<void>;
	readonly #terminateHook: () => Promise<void>;
	#currentRunId: string | null = null;
	#currentStatus: EndpointSnapshot["status"] = "idle";
	#lastMessage: string | undefined;

	constructor(options: LocalAgentEndpointOptions) {
		this.handle = { kind: "local", session: options.session };
		this.#agent = options.agent;
		this.#awaitTerminal = options.awaitTerminal;
		this.#cancelHook = options.cancelRun;
		this.#terminateHook = options.terminate;
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
		this.#currentRunId = runId;
		this.#currentStatus = "running";
		this.#lastMessage = assignment.trim() || undefined;
		return { runId, acceptedAt: Date.now() };
	}

	/** Waits for the session's terminal event and records its verdict on the shared run state. */
	async run(runId: string, signal?: AbortSignal): Promise<RunOutcome> {
		this.#assertCurrent(runId, "run");
		const terminal = await this.#awaitTerminal(signal);
		this.#currentStatus = terminal.status;
		const outcome: RunOutcome = { status: terminal.status, runId };
		if (terminal.text !== undefined) outcome.text = terminal.text;
		if (terminal.error !== undefined) outcome.error = terminal.error;
		if (terminal.usage !== undefined) outcome.usage = terminal.usage;
		if (terminal.structured !== undefined) outcome.structured = terminal.structured;
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

	asJobSnapshot(): EndpointSnapshot {
		return this.#snapshot();
	}

	asHandleSnapshot(): EndpointSnapshot {
		return this.#snapshot();
	}

	asRosterSnapshot(): EndpointSnapshot {
		return this.#snapshot();
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
