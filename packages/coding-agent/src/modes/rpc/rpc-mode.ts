/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { once } from "node:events";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isRecord, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import {
	type BuiltSkillPromptMessage,
	buildSkillPromptMessage,
	parseSkillInvocation,
	type Skill,
} from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { type AgentEndpoint, ENDPOINT_STILL_OWNED_REFUSAL } from "../../task/endpoint";
import { LocalAgentEndpoint, type LocalTerminalResult } from "../../task/endpoint/local";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { createLeaseState, isLeaseExpired, negotiateLease, tickLease, type LeaseState } from "./lease";
import { buildRpcReadyFrame, type ManagedRpcBootstrap } from "./managed-bootstrap";
import {
	DEFAULT_RPC_FRAME_LIMITS,
	negotiateRpcFrameLimits,
	RpcFrameDecoder,
	RpcFrameEncoder,
} from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import { isRpcErrorCode, readRpcCorrelation } from "./rpc-types";
import type {
	RpcCommand,
	RpcCancelRunResult,
	RpcCorrelationFields,
	RpcErrorCode,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUISelectOptionDetail,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcManagedErrorResponse,
	RpcReadyFrame,
	RpcResponse,
	RpcResumeResult,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export interface RpcSkillInvocation {
	skill: Skill;
	args: string;
}

/**
 * Fast in-memory pre-check for a skill invocation: settings gate, text shape,
 * and skill lookup. Returns null when the message is not a runnable skill
 * command. Performs no I/O — safe to run on the RPC serial queue.
 */
export function resolveRpcSkillInvocation(session: RpcSkillCommandSession, text: string): RpcSkillInvocation | null {
	if (!session.skillsSettings?.enableSkillCommands) return null;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return null;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return null;
	return { skill, args: parsed.args };
}

/**
 * Slow half of a skill invocation: builds the skill prompt message (file I/O)
 * and dispatches it through the full prompt pipeline (usage preflight,
 * compaction checks, provider calls). Resolves once the turn is scheduled.
 * Must not run on the RPC serial queue's response path — register it with
 * watchAndReportLocalOnlyPromptResult and answer the command first.
 */
export async function runRpcSkillCommand(
	session: RpcSkillCommandSession,
	invocation: RpcSkillInvocation,
	streamingBehavior: "steer" | "followUp" = "steer",
	prebuilt?: BuiltSkillPromptMessage,
): Promise<boolean> {
	const built = prebuilt ?? (await buildSkillPromptMessage(invocation.skill, invocation.args, "user"));
	return session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
}

/**
 * Skill branch of the `prompt` command: resolves the invocation cheaply, then
 * registers the slow dispatch with watchAndReportLocalOnlyPromptResult and
 * returns immediately. The caller answers the command right away — building
 * the skill prompt and running the prompt pipeline (usage preflight,
 * compaction, provider calls) can outlast any client's prompt timeout under
 * provider stress; the plain-prompt path responds first for the same reason.
 */
export async function dispatchRpcSkillPrompt(input: {
	id: string | undefined;
	session: RpcSkillCommandSession;
	message: string;
	streamingBehavior: "steer" | "followUp" | undefined;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): Promise<RpcSkillCommandResult | null> {
	const invocation = resolveRpcSkillInvocation(input.session, input.message);
	if (!invocation) return null;
	// buildSkillPromptMessage is cheap file I/O and covers the failure the old
	// synchronous path reported immediately (a removed or unreadable SKILL.md);
	// keep that error contract by awaiting it before answering. The expensive
	// promptCustomMessage pipeline (usage preflight, compaction, provider
	// calls) is what moves behind the acknowledgement.
	const built = await buildSkillPromptMessage(invocation.skill, invocation.args, "user");
	watchAndReportLocalOnlyPromptResult({
		id: input.id,
		startPrompt: () => runRpcSkillCommand(input.session, invocation, input.streamingBehavior ?? "steer", built),
		output: input.output,
		onError: input.onError,
		extensionUserMessageTracker: input.extensionUserMessageTracker,
	});
	return { agentInvoked: true };
}

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	const invocation = resolveRpcSkillInvocation(session, text);
	if (!invocation) return false;
	await runRpcSkillCommand(session, invocation, streamingBehavior);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();
	readonly #onPromptTask: ((task: Promise<unknown>) => void) | undefined;
	readonly #beforePrompt: (() => void) | undefined;

	constructor(onPromptTask?: (task: Promise<unknown>) => void, beforePrompt?: () => void) {
		this.#onPromptTask = onPromptTask;
		this.#beforePrompt = beforePrompt;
	}

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			this.#beforePrompt?.();
			prompt = startPrompt();
			this.#onPromptTask?.(prompt);
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
	managed?: boolean;
	runOnCancelRun?: (runId: string) => Promise<RpcCancelRunResult>;
	runOnTerminate?: (peerId?: string) => Promise<void>;
	onControlFrame?: () => void;
	afterResponse?: (command: RpcCommand, response: RpcResponse) => Promise<void>;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

function managedErrorCode(value: unknown, fallback: RpcErrorCode = "remote-execution-failed"): RpcErrorCode {
	return isRpcErrorCode(value) ? value : fallback;
}

class ManagedRpcError extends Error {
	constructor(readonly code: RpcErrorCode, message: string) {
		super(message);
	}
}

function managedErrorResponse(
	request: unknown,
	command: string,
	message: string,
	code: RpcErrorCode,
): RpcManagedErrorResponse & RpcCorrelationFields {
	return { ...readRpcCorrelation(request), type: "response", command, success: false, error: message, message, code };
}

type RpcManagedControlCommand = Extract<RpcCommand, {
	type: "get_state" | "abort" | "abort_bash" | "heartbeat" | "cancel_run" | "terminate" | "park" | "resume";
}>;

function parseManagedControlCommand(value: unknown): RpcManagedControlCommand | undefined {
	if (!isRecord(value)) return undefined;
	const correlation = readRpcCorrelation(value);
	switch (value.type) {
		case "get_state":
		case "abort":
		case "abort_bash":
		case "heartbeat":
			return { ...correlation, type: value.type };
		case "cancel_run":
		case "park":
			if (typeof value.runId === "string") return { ...correlation, type: value.type, runId: value.runId };
			throw new ManagedRpcError("protocol-incompatible", "Invalid managed control command");
		case "terminate":
			if (value.peerId === undefined) return { ...correlation, type: "terminate" };
			if (typeof value.peerId === "string") return { ...correlation, type: "terminate", peerId: value.peerId };
			throw new ManagedRpcError("protocol-incompatible", "Invalid managed control command");
		case "resume":
			if (typeof value.reference !== "string" ||
				(value.expectedRunId !== undefined && typeof value.expectedRunId !== "string")) {
				throw new ManagedRpcError("protocol-incompatible", "Invalid managed control command");
			}
			return {
				...correlation, type: "resume", reference: value.reference,
				...(typeof value.expectedRunId === "string" ? { expectedRunId: value.expectedRunId } : {}),
			};
		default:
			return undefined;
	}
}

function correlateManagedResponse(response: RpcResponse, request: unknown): RpcResponse {
	if (response.success) return { ...response, ...readRpcCorrelation(request) };
	return {
		...response,
		...readRpcCorrelation(request),
		message: response.error,
		code: managedErrorCode(response.code),
	};
}

async function dispatchManagedCommand(command: RpcCommand, deps: RpcInputFrameDeps): Promise<void> {
	let response: RpcResponse;
	try {
		if (command.type === "cancel_run" && deps.runOnCancelRun) {
			response = { type: "response", command: "cancel_run", success: true, data: await deps.runOnCancelRun(command.runId) };
		} else if (command.type === "terminate" && deps.runOnTerminate) {
			await deps.runOnTerminate(command.peerId);
			response = { type: "response", command: "terminate", success: true, data: { acknowledged: true } };
		} else {
			response = await deps.handleCommand(command);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		response = managedErrorResponse(command, command.type, message,
			err instanceof ManagedRpcError ? err.code : "remote-execution-failed");
	}
	response = correlateManagedResponse(response, command);
	deps.output(response);
	await deps.afterResponse?.(command, response);
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (deps.managed && isRecord(parsed) && parsed.type === "response" &&
		parsed.command === "heartbeat" && parsed.success === true) {
		deps.onControlFrame?.();
		return true;
	}
	if (deps.managed) {
		let command: RpcManagedControlCommand | undefined;
		try {
			command = parseManagedControlCommand(parsed);
		} catch (failure) {
			const commandType = isRecord(parsed) && typeof parsed.type === "string" ? parsed.type : "parse";
			const message = failure instanceof Error ? failure.message : String(failure);
			deps.output(managedErrorResponse(parsed, commandType, message, "protocol-incompatible"));
			return true;
		}
		if (command) {
			deps.onControlFrame?.();
			const task = dispatchManagedCommand(command, deps);
			deps.trackBackgroundTask?.(task);
			return true;
		}
	}

	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Bash commands are dispatched in the background so the caller can keep reading
 * subsequent frames while a shell command is still running. This lets a client
 * send `abort_bash` while a long-running `bash` is in flight. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on non-`bash` commands propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	if (deps.managed) {
		const command = parsed as RpcCommand;
		const task = dispatchManagedCommand(command, deps);
		if (command.type === "bash") {
			deps.trackBackgroundTask?.(task);
			return undefined;
		}
		return task;
	}
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// `bash` can run for a long time. Dispatch it in the background so a
	// subsequent `abort_bash` frame can be read and handled without waiting
	// for the shell command to finish on its own. The response is emitted
	// when `handleCommand` resolves; clients correlate via `command.id`.
	if (command.type === "bash") {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, "bash", message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;
	readonly #managed: boolean;

	constructor(options: {
		deps: RpcInputFrameDeps;
		afterSerialCommand?: () => Promise<void>;
		managed?: boolean;
		runOnCancelRun?: (runId: string) => Promise<RpcCancelRunResult>;
		runOnTerminate?: (peerId?: string) => Promise<void>;
	}) {
		this.#deps = options.managed ? {
			...options.deps,
			managed: true,
			runOnCancelRun: options.runOnCancelRun ?? options.deps.runOnCancelRun,
			runOnTerminate: options.runOnTerminate ?? options.deps.runOnTerminate,
			trackBackgroundTask: task => {
				this.#track(task);
				options.deps.trackBackgroundTask?.(task);
			},
		} : options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
		this.#managed = options.managed === true;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (this.#managed && (!isRecord(parsed) || typeof parsed.type !== "string")) {
				this.#deps.output(managedErrorResponse(parsed, "parse", "Invalid RPC command object", "protocol-incompatible"));
				return;
			}
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			if (command.type === "bash") {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchCommand(command),
				() => this.#dispatchCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#track(task);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const parseMessage = `Failed to parse command: ${message}`;
			this.#deps.output(this.#managed
				? managedErrorResponse(parsed, "parse", parseMessage, "protocol-incompatible")
				: this.#deps.errorResponse(undefined, "parse", parseMessage));
		}
	}

	#track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.then(
			() => this.#tasks.delete(task),
			() => this.#tasks.delete(task),
		);
	}

	/** Await serial and managed control commands, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const response = this.#deps.errorResponse(command.id, command.type, message);
			this.#deps.output(this.#managed ? correlateManagedResponse(response, command) : response);
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;
	readonly #managed: boolean;
	readonly #runOnManagedEof: (() => void | Promise<void>) | undefined;

	constructor(options: {
		isShutdownRequested: () => boolean;
		performShutdown: () => Promise<void>;
		managed?: boolean;
		runOnManagedEof?: () => void | Promise<void>;
	}) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
		this.#managed = options.managed === true;
		this.#runOnManagedEof = options.runOnManagedEof;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Cancel managed work before draining; legacy EOF still only drains. */
	async handleEof(dispatcher: RpcInputDispatcher): Promise<void> {
		if (this.#managed) {
			await this.#runOnManagedEof?.();
			await withTimeout(
				Promise.all([dispatcher.drain(), this.drain()]),
				MANAGED_CLEANUP_TIMEOUT_MS,
				"Managed shutdown drain timed out",
			).catch(() => {});
			return;
		}
		await dispatcher.drain();
		await this.drain();
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			const drain = this.#managed
				? withTimeout(this.drain(), MANAGED_CLEANUP_TIMEOUT_MS, "Managed shutdown drain timed out").catch(() => {})
				: this.drain();
			this.#shutdown = drain.then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

/** Sends an RPC select request while retaining aligned option descriptions. */
export function requestRpcSelect(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const labels = new Array<string>(options.length);
	let optionDetails: RpcExtensionUISelectOptionDetail[] | undefined;
	for (let index = 0; index < options.length; index++) {
		const option = options[index]!;
		labels[index] = getExtensionUISelectOptionLabel(option);
		if (typeof option === "string") continue;
		const description = option.description?.trim();
		if (!description) continue;
		optionDetails ??= Array.from({ length: options.length }, () => ({}));
		optionDetails[index] = { description };
	}

	return requestRpcDialog(
		pendingRequests,
		output,
		dialogOptions,
		undefined,
		{
			method: "select",
			title,
			options: labels,
			...(optionDetails ? { optionDetails } : {}),
			timeout: dialogOptions?.timeout,
		},
		response => parseValueDialogResponse(response, dialogOptions),
	);
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			resolve(parseResponse(response));
		},
		reject,
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}
/** Construct the bootstrap declaration without adding any keys to legacy ready frames. */
export function createRpcReadyFrame(managed = false): RpcReadyFrame {
	if (!managed) return buildRpcReadyFrame(false);
	const lease = createLeaseState();
	return buildRpcReadyFrame(true, { heartbeatSeconds: lease.heartbeatSeconds, leaseSeconds: lease.leaseSeconds });
}

/** Resume the endpoint's existing session, never allocate a replacement session. */
export async function resumeManagedEndpoint(
	endpoint: AgentEndpoint,
	reference: string,
	expectedRunId?: string,
): Promise<RpcResumeResult> {
	const before = await endpoint.snapshot();
	if (expectedRunId !== undefined && before.snapshot.runId !== expectedRunId) {
		throw new ManagedRpcError("resource-unavailable", `Resume reference does not own run ${expectedRunId}`);
	}
	const acknowledgement = await endpoint.ensureLive(reference);
	if (!acknowledgement.acknowledged) {
		if (!acknowledgement.reason.startsWith(ENDPOINT_STILL_OWNED_REFUSAL)) {
			throw new ManagedRpcError("resource-unavailable", acknowledgement.reason);
		}
		return { status: "still-owned", detail: acknowledgement.reason };
	}
	const { snapshot } = await endpoint.snapshot();
	if (snapshot.runId === null) {
		throw new ManagedRpcError("resource-unavailable", "Resume reference has no existing run");
	}
	return { status: "reopened", snapshot, runId: snapshot.runId };
}

interface ManagedRpcRun {
	runId: string;
	command: "bash" | "prompt";
	endpoint: AgentEndpoint;
	terminal: PromiseWithResolvers<LocalTerminalResult>;
	abortController: AbortController;
	promptTasks?: Promise<unknown>[];
	outcome?: LocalTerminalResult;
	cleanup?: Promise<RpcCancelRunResult>;
}

const MANAGED_CLEANUP_TIMEOUT_MS = 3_000;

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	subagentEventBus?: EventBus,
	input: ReadableStream<Uint8Array> = claimRpcInput(),
	options: { managed?: boolean; bootstrap?: ManagedRpcBootstrap } = {},
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	const frameDecoder = new RpcFrameDecoder();
	let managedFrameLimits = options.bootstrap?.frameLimits ?? DEFAULT_RPC_FRAME_LIMITS;
	if (options.bootstrap) {
		frameEncoder.setProtocolVersion(options.bootstrap.protocolVersion);
		frameEncoder.setLimits(managedFrameLimits);
		frameDecoder.setLimits(managedFrameLimits);
	}
	if (options.managed) frameEncoder.setManagedEnvelope(true);
	// Ordered stdout writer honoring backpressure: chunked v2 frames are produced
	// lazily by the encoder and written one physical line at a time, so a near-limit
	// logical frame never materializes its full base64 transport in memory.
	let stdoutQueue: Promise<void> = Promise.resolve();
	const writeFrames = (frames: Iterable<string>) => {
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			// stdout gone (host exited) — nothing left to deliver; keep the queue alive.
			.catch(() => {});
	};
	if (!options.bootstrap) writeFrames(frameEncoder.encodeFrames(createRpcReadyFrame(options.managed)));
	const flushStdout = async (): Promise<void> => {
		await stdoutQueue;
		if (process.stdout.destroyed) return;
		const drained = Promise.withResolvers<void>();
		// A successful write() only means "below highWaterMark", not delivered.
		// Its callback is the barrier before acknowledging drained replies or exiting.
		process.stdout.write("", () => drained.resolve());
		await drained.promise;
	};
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeFrames(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && "command" in obj && obj.command === "negotiate_protocol" &&
			"success" in obj && obj.success === true) {
			frameEncoder.setProtocolVersion(2);
			if (options.managed) {
				frameEncoder.setLimits(managedFrameLimits);
				frameDecoder.setLimits(managedFrameLimits);
			}
		}
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		if (options.managed) {
			return {
				id, type: "response", command, success: false, error: message, message,
				code: managedErrorCode(code, command === "parse" || command === "negotiate_protocol"
					? "protocol-incompatible" : "remote-execution-failed"),
			};
		}
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	};

	let currentModelRun: ManagedRpcRun | undefined;
	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker(options.managed ? task => {
		currentModelRun?.promptTasks?.push(task);
	} : undefined, options.managed ? () => {
		if (managedClosing || currentModelRun?.abortController.signal.aborted) {
			throw new ManagedRpcError("user-cancelled", "Managed prompt was cancelled before execution");
		}
	} : undefined);

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = subagentEventBus ? new RpcSubagentRegistry(subagentEventBus, output) : undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };
	const managedRuns = new Map<string, ManagedRpcRun>();
	const managedCommandRuns = new WeakMap<RpcCommand, ManagedRpcRun>();
	const resumeEndpoints = new Map<string, AgentEndpoint>();
	let managedClosing = false;
	let managedLease: LeaseState | undefined;
	let leaseTimer: NodeJS.Timeout | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	const stopManagedTimers = (): void => {
		clearInterval(leaseTimer);
		clearInterval(heartbeatTimer);
		leaseTimer = undefined;
		heartbeatTimer = undefined;
	};
	let managedDisposal: Promise<boolean> | undefined;
	const disposeRpcSession = async (): Promise<boolean> => {
		if (!options.managed) {
			await session.dispose();
			return true;
		}
		managedDisposal ??= withTimeout(session.dispose(), MANAGED_CLEANUP_TIMEOUT_MS,
			"Managed session disposal timed out").then(() => true, failure => {
				output(error(undefined, "terminate", failure instanceof Error ? failure.message : String(failure), "timeout"));
				return false;
			});
		return managedDisposal;
	};
	const cancelOwnedJobs = async (signal: AbortSignal): Promise<void> => {
		const manager = session.asyncJobManager;
		const ownerId = session.getAgentId();
		if (!manager || !ownerId) return;
		const jobs = manager.getAllJobs({ ownerId });
		manager.acknowledgeDeliveries(jobs.map(job => job.id));
		manager.cancelAll({ ownerId }, USER_INTERRUPT_LABEL);
		const result = await manager.waitForOwnerJobsAndReplies(ownerId, signal);
		if (result.status !== "drained") throw new ManagedRpcError("timeout", "Owned job replies did not drain");
	};
	const beginManagedRun = async (command: RpcCommand, kind: "bash" | "prompt"): Promise<ManagedRpcRun> => {
		if (managedClosing) throw new ManagedRpcError("connection-lost", "Managed peer is shutting down");
		if (kind === "prompt" && [...managedRuns.values()].some(run =>
			run.command === "prompt" && run.endpoint.asHandleSnapshot().status === "running")) {
			throw new ManagedRpcError("resource-unavailable", "A model run still owns the session");
		}
		const terminal = Promise.withResolvers<LocalTerminalResult>();
		const abortController = new AbortController();
		const endpoint = new LocalAgentEndpoint({
			session,
			agent: session.getAgentId() ?? session.sessionId,
			managed: true,
			awaitTerminal: () => terminal.promise,
			cancelRun: async () => {
				abortController.abort();
				if (kind === "prompt") {
					const owned = cancelOwnedJobs(AbortSignal.timeout(MANAGED_CLEANUP_TIMEOUT_MS));
					await session.abort({ reason: USER_INTERRUPT_LABEL, preserveBash: true });
					await owned;
				}
			},
			terminate: () => session.dispose(),
		});
		const ack = await endpoint.start(kind);
		const run: ManagedRpcRun = { runId: ack.runId, command: kind, endpoint, terminal, abortController };
		managedRuns.set(run.runId, run);
		managedCommandRuns.set(command, run);
		void endpoint.run(run.runId);
		if (managedClosing) {
			abortController.abort();
			terminal.resolve({ status: "cancelled" });
			throw new ManagedRpcError("connection-lost", "Managed peer closed before execution started");
		}
		output({ type: "managed_run_start", runId: run.runId, command: kind, ...readRpcCorrelation(command) });
		return run;
	};
	const finishManagedRun = async (run: ManagedRpcRun, outcome: LocalTerminalResult): Promise<void> => {
		run.outcome = outcome;
		await flushStdout();
		run.terminal.resolve(outcome);
		await run.endpoint.waitReplyDrained(run.runId);
		output({ type: "managed_run_end", runId: run.runId, status: outcome.status, replyDrained: true });
	};
	const runOnCancelRun = async (runId: string): Promise<RpcCancelRunResult> => {
		const run = managedRuns.get(runId);
		if (!run) throw new ManagedRpcError("resource-unavailable", `Unknown managed run: ${runId}`);
		if (run.cleanup) return run.cleanup;
		output({ type: "managed_lifecycle", phase: "cancel_run", runId });
		const cleanup = async (): Promise<RpcCancelRunResult> => {
			const abort = new AbortController();
			try {
				await withTimeout((async () => {
					await run.endpoint.cancelRun(runId);
					const drained = await run.endpoint.waitReplyDrained(runId, { signal: abort.signal });
					if (drained.status !== "drained") throw new ManagedRpcError("timeout", `Reply cleanup timed out for ${runId}`);
					await flushStdout();
				})(), MANAGED_CLEANUP_TIMEOUT_MS, `Cancellation cleanup timed out for ${runId}`);
				return { status: "cancelled", replyDrained: true };
			} catch (failure) {
				return { status: "cleanup-unconfirmed", detail: failure instanceof Error ? failure.message : String(failure) };
			} finally {
				abort.abort();
			}
		};
		run.cleanup = cleanup();
		return run.cleanup;
	};
	const closeManagedWork = async (reason: "eof" | "lease" | "terminate"): Promise<boolean> => {
		managedClosing = true;
		stopManagedTimers();
		pendingExtensionRequests.rejectAll("Managed peer is shutting down");
		hostToolBridge.close("Managed peer is shutting down");
		hostUriBridge.clear("Managed peer is shutting down");
		const active = [...managedRuns.values()].filter(run => run.endpoint.asHandleSnapshot().status === "running");
		// Invoke every cancellation before waiting for any one cleanup.
		const cancellations = active.map(run => runOnCancelRun(run.runId));
		const owned = cancelOwnedJobs(AbortSignal.timeout(MANAGED_CLEANUP_TIMEOUT_MS)).then(() => true, failure => {
			output(error(undefined, "cancel_run", failure instanceof Error ? failure.message : String(failure), "timeout"));
			return false;
		});
		const results = await Promise.all(cancellations);
		const ownedDrained = await owned;
		for (let index = 0; index < results.length; index++) {
			output({ type: "managed_lifecycle", phase: "cleanup", reason, runId: active[index].runId, ...results[index] });
		}
		if (reason === "lease") {
			for (const run of managedRuns.values()) {
				const ack = await run.endpoint.park(run.runId);
				output({ type: "managed_lifecycle", phase: "park", reason, runId: run.runId, ...ack });
			}
		}
		output({ type: "managed_lifecycle", phase: "drain", reason });
		return ownedDrained && results.every(result => result.status === "cancelled");
	};
	const runOnTerminate = async (peerId?: string): Promise<void> => {
		if (peerId !== undefined && peerId !== session.getAgentId() && peerId !== session.sessionId) {
			throw new ManagedRpcError("resource-unavailable", `Unknown managed peer: ${peerId}`);
		}
		const cleaned = await closeManagedWork("terminate");
		const disposed = await disposeRpcSession();
		shutdownState.requested = true;
		if (!cleaned || !disposed) throw new ManagedRpcError("timeout", "Managed termination cleanup is unconfirmed");
	};

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcSelect(this.pendingRequests, this.output, title, options, dialogOptions);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		mode: "rpc",
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({
				type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error,
				...(options.managed ? { message: err.error, code: "remote-execution-failed" } : {}),
			});
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
	});

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		await session.refreshSkills();
		session.setSlashCommands(
			await loadSlashCommands({
				cwd,
				extensionRoots: session.effectiveExtensionRoots,
			}),
		);
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		if (options.managed && managedClosing && command.type !== "get_state" && command.type !== "heartbeat") {
			throw new ManagedRpcError("connection-lost", "Managed peer is shutting down");
		}

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
				if (options.managed) {
					managedFrameLimits = negotiateRpcFrameLimits(command, DEFAULT_RPC_FRAME_LIMITS);
					return success(id, "negotiate_protocol", { protocolVersion: 2, ...managedFrameLimits });
				}
				return success(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			case "prepare": {
				if (!options.managed) return error(undefined, command.type, `Unknown command: ${command.type}`);
				for (const field of ["cwd", "profile", "agent"] as const) {
					if (command[field] === undefined) continue;
					if (!options.bootstrap || command[field] !== options.bootstrap.prepare[field]) {
						throw new ManagedRpcError("protocol-incompatible",
							`Managed prepare cannot change ${field} after session initialization`);
					}
				}
				const proposed = createLeaseState();
				const negotiated = negotiateLease({
					heartbeatSeconds: command.heartbeatSeconds ?? proposed.heartbeatSeconds,
					leaseSeconds: command.leaseSeconds ?? proposed.leaseSeconds,
				}, proposed);
				managedLease = createLeaseState(Date.now(), negotiated);
				stopManagedTimers();
				heartbeatTimer = setInterval(() => output({ type: "heartbeat" }), negotiated.heartbeatSeconds * 1_000);
				leaseTimer = setInterval(() => {
					if (!managedLease || managedClosing || !isLeaseExpired(managedLease)) return;
					stopManagedTimers();
					output(error(undefined, "heartbeat", "Managed receive lease expired", "connection-lost"));
					void (async () => {
						await closeManagedWork("lease");
						await shutdownCoordinator.handleEof(inputDispatcher);
						await disposeRpcSession();
						await flushStdout();
						process.exit(0);
					})();
				}, Math.min(negotiated.heartbeatSeconds * 1_000, 250));
				return success(id, "prepare", { ...negotiated, ...options.bootstrap?.preparedContext });
			}

			case "heartbeat": {
				if (!options.managed) return error(undefined, command.type, `Unknown command: ${command.type}`);
				return success(id, "heartbeat");
			}

			case "cancel_run":
			case "terminate":
				return error(options.managed ? id : undefined, command.type, `Unknown command: ${command.type}`);

			case "park": {
				if (!options.managed) return error(undefined, command.type, `Unknown command: ${command.type}`);
				const run = managedRuns.get(command.runId);
				if (!run) throw new ManagedRpcError("resource-unavailable", `Unknown managed run: ${command.runId}`);
				const acknowledgement = await run.endpoint.park(command.runId);
				if (acknowledgement.acknowledged && acknowledgement.resumeReference) {
					resumeEndpoints.set(acknowledgement.resumeReference, run.endpoint);
				}
				return success(id, "park", acknowledgement);
			}

			case "resume": {
				if (!options.managed) return error(undefined, command.type, `Unknown command: ${command.type}`);
				const endpoint = resumeEndpoints.get(command.reference);
				if (!endpoint) throw new ManagedRpcError("resource-unavailable", `Unknown resume reference: ${command.reference}`);
				if ([...managedRuns.values()].some(run => run.endpoint.asHandleSnapshot().status === "running")) {
					return success(id, "resume", { status: "still-owned", detail: "The existing session still owns active work" });
				}
				return success(id, "resume", await resumeManagedEndpoint(endpoint, command.reference, command.expectedRunId));
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				if (options.managed) {
					currentModelRun = await beginManagedRun(command, "prompt");
					currentModelRun.promptTasks = [];
				}
				const skillResult = await dispatchRpcSkillPrompt({
					id,
					session,
					message: command.message,
					streamingBehavior: command.streamingBehavior,
					output,
					onError: promptError => output(options.managed
						? correlateManagedResponse(error(id, "prompt", promptError.message), command)
						: error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
				});
				if (skillResult) {
					return success(id, "prompt", skillResult);
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: text => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: reloadPluginState,
					runCommandInBackground: task => shutdownCoordinator.track(task()),
					notifyTitleChanged: async () => {
						output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () => session.prompt(builtinResult.prompt, { images: command.images }),
							output,
							onError: promptError => output(options.managed
								? correlateManagedResponse(error(id, "prompt", promptError.message), command)
								: error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
						});
						return success(id, "prompt");
					}
					// A consumed builtin is normally local-only, but some (e.g.
					// `/retry`) schedule an agent turn whose events stream after
					// this response. Report that so the host does not finalize the
					// request as non-agent work while the agent is running.
					return success(id, "prompt", { agentInvoked: builtinResult.agentInvoked === true });
				}

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: () =>
						session.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
						}),
					output,
					onError: promptError => output(options.managed
						? correlateManagedResponse(error(id, "prompt", promptError.message), command)
						: error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
				});
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				if (options.managed) {
					for (const run of managedRuns.values()) {
						if (run.command === "prompt" && run.endpoint.asHandleSnapshot().status === "running") {
							await runOnCancelRun(run.runId);
						}
					}
					currentModelRun = await beginManagedRun(command, "prompt");
					currentModelRun.promptTasks = [];
					const task = session.prompt(command.message, { images: command.images });
					currentModelRun.promptTasks.push(task);
					task.catch(failure => output(correlateManagedResponse(
						error(id, "abort_and_prompt", failure instanceof Error ? failure.message : String(failure)), command)));
					return success(id, "abort_and_prompt");
				}
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				return success(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
				};
				if (options.managed) state.managedRuns = [...managedRuns.values()].map(run => run.endpoint.asHandleSnapshot());
				return success(id, "get_state", state);
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return success(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				let models = session.getAvailableModels();
				let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					// Model not in the current catalog. Wait for in-flight
					// background discovery before declaring it missing: on cold
					// start, discovery-backed providers (proxy / ollama / etc.)
					// populate seconds after session ready. Models already in
					// the bundled catalog skip this await entirely so the RPC
					// queue is not stalled behind unrelated discovery.
					await session.modelRegistry.awaitBackgroundRefresh();
					models = session.getAvailableModels();
					model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				}
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				if (options.managed) {
					const run = await beginManagedRun(command, "bash");
					const result = await session.executeBash(command.command, chunk => {
						output({ type: "bash_output", runId: run.runId, chunk, ...readRpcCorrelation(command) });
					}, { signal: run.abortController.signal });
					run.outcome = { status: result.cancelled ? "cancelled" : result.exitCode === 0 ? "completed" : "failed" };
					return success(id, "bash", result);
				}
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
				try {
					return success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_messages_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(options.managed ? id : undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`,
					options.managed ? "protocol-incompatible" : undefined);
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		managed: options.managed,
		runOnManagedEof: async () => {
			if (!managedClosing) await closeManagedWork("eof");
		},
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await disposeRpcSession();
			stopManagedTimers();
			await flushStdout();
			process.exit(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
		onControlFrame: () => {
			if (managedLease && !managedClosing) managedLease = tickLease(managedLease);
		},
		afterResponse: async (command, response) => {
			const run = managedCommandRuns.get(command);
			if (!run) return;
			if (run.command === "bash" || !response.success) {
				await finishManagedRun(run, run.outcome ?? {
					status: run.abortController.signal.aborted ? "cancelled" : "failed",
					...(!response.success ? { error: response.error } : {}),
				});
				return;
			}
			const task = (async () => {
				try {
					await Promise.all(run.promptTasks ?? []);
					await session.waitForIdle();
					const ownerId = session.getAgentId();
					if (ownerId) await session.asyncJobManager?.waitForOwnerJobsAndReplies(ownerId);
					await finishManagedRun(run, { status: run.abortController.signal.aborted ? "cancelled" : "completed" });
				} catch (failure) {
					await finishManagedRun(run, {
						status: run.abortController.signal.aborted ? "cancelled" : "failed",
						error: failure instanceof Error ? failure.message : String(failure),
					});
				}
			})();
			shutdownCoordinator.track(task);
		},
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		managed: options.managed,
		runOnCancelRun,
		runOnTerminate,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it. Frames are read
	// line-by-line by readRpcInputFrames so a single malformed line is reported
	// as an error frame and the loop keeps running instead of throwing out of
	// the reader and killing the whole process (issue #5194).
	await readRpcInputFrames(
		input ?? Bun.stdin.stream(),
		parsed => {
			if (!options.managed) {
				inputDispatcher.dispatch(parsed);
				return;
			}
			try {
				const decoded = frameDecoder.push(parsed);
				if (decoded !== undefined) inputDispatcher.dispatch(decoded);
			} catch (failure) {
				output(correlateManagedResponse(error(undefined, "parse",
					failure instanceof Error ? failure.message : String(failure), "protocol-incompatible"), parsed));
			}
		},
		message => output(error(undefined, "parse", message)),
	);

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await shutdownCoordinator.handleEof(inputDispatcher);
	subagentRegistry?.dispose();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately.
	await disposeRpcSession();
	stopManagedTimers();
	await flushStdout();
	process.exit(0);
}
