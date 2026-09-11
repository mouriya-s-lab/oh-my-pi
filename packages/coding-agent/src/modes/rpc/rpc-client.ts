/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { randomUUID } from "node:crypto";
import { isPromise } from "node:util/types";
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import type { BashResult } from "../../exec/bash-executor";
import { IrcBus, type DeliveryResult, type IrcEnvelope } from "../../irc/bus";
import { deliverInboundEnvelope } from "../../irc/inbound";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { EndpointControlAck } from "../../task/endpoint";
import { createLeaseState, isLeaseExpired, type LeaseState, negotiateLease, tickLease } from "./lease";
import {
	ManagedIrcChannel, ManagedIrcObservationRelay, type ManagedIrcObservation,
	type IrcInboundListener, type ManagedIrcSendOptions, parseManagedIrcWireFrame,
} from "./managed-irc";
import {
	DEFAULT_RPC_FRAME_LIMITS,
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	negotiateRpcFrameLimits,
	RpcFrameDecoder,
	RpcFrameEncoder,
	type RpcFrameLimits,
	type RpcProtocolVersion,
} from "./rpc-frame";
import {
	RPC_MESSAGES_PAGE_BUSY_ERROR,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	type RpcMessagesPage,
	type RpcMessagesPageOptions,
} from "./rpc-messages";
import { isNativeAgentCapabilitySet, isRpcErrorCode, parseManagedIrcBinding, readRpcCorrelation } from "./rpc-types";
import type {
	ManagedIrcBinding,
	ManagedIrcWireFrame,
	ManagedPeerFrame,
	ReplyDrainedBarrier,
	NativeAgentCapabilitySet,
	RpcAvailableCommandsUpdateFrame,
	RpcAvailableSlashCommand,
	RpcCancelRunResult,
	RpcCorrelationFields,
	RpcErrorCode,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcManagedRunEvent,
	RpcPrepareOptions,
	RpcPrepareResult,
	RpcResponse,
	RpcResumeResult,
	RpcSessionState,
	RpcSubagentEventFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

/** Process transport consumed by {@link RpcClient}. */
export interface RpcAgentProcess {
	stdin: {
		write(data: string | Uint8Array): unknown;
	};
	stdout: ReadableStream<Uint8Array>;
	peekStderr(): string;
	kill(signal?: Parameters<ptree.ChildProcess["kill"]>[0], graceMs?: number): void;
	exited: Promise<number>;
}

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: `dist/cli.js`). */
	cliPath?: string;
	/**
	 * Agent launcher override. An argv prefix receives the normal RPC/model args
	 * appended; a builder receives those args and returns the complete argv.
	 * Builders support transports such as SSH that must quote the final argv.
	 * Ignored when {@link spawn} is provided.
	 */
	command?: string[] | ((agentArgs: string[]) => string[]);
	/**
	 * Spawn the RPC agent over a custom transport instead of a local child process.
	 * Takes precedence over {@link command}.
	 */
	spawn?: (agentArgs: string[]) => RpcAgentProcess | Promise<RpcAgentProcess>;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Session directory for the agent */
	sessionDir?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Grace period before escalating process termination (default: process utility default, 1000ms) */
	terminationGraceMs?: number;
	/** Custom tools owned by the embedding host and exposed over the RPC transport */
	customTools?: RpcClientCustomTool[];
	/**
	 * Require the complete major-1 native-agent capability contract. Incompatible
	 * ready frames reject before any write. This validates the handshake the
	 * embedding host arranged; it does not add CLI arguments. Default: false.
	 */
	expectManagedBootstrap?: boolean;
	/** Local managed transport ceilings; negotiated independently with the peer. */
	managedFrameLimits?: RpcFrameLimits;
	/** Proposed managed heartbeat and receive-side lease durations, in seconds. */
	managedLease?: { heartbeatSeconds?: number; leaseSeconds?: number };
	/**
	 * Bootstrap context the peer applies during the automatic `prepare` that
	 * follows protocol negotiation: remote working directory, profile, and
	 * agent. The peer echoes the values it actually applied; read them back
	 * with {@link RpcClient.getPreparedContext}, which reports only confirmed
	 * fields. Ignored outside managed mode.
	 */
	prepare?: RpcPrepareOptions;
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export type RpcEventListener = (event: AgentEvent) => void;
export type RpcSessionEventListener = (event: AgentSessionEvent) => void;
export type RpcSubagentLifecycleListener = (payload: RpcSubagentLifecycleFrame["payload"]) => void;
export type RpcSubagentProgressListener = (payload: RpcSubagentProgressFrame["payload"]) => void;
export type RpcSubagentEventListener = (payload: RpcSubagentEventFrame["payload"]) => void;
export type RpcAvailableCommandsUpdateListener = (commands: RpcAvailableSlashCommand[]) => void;
export type RpcManagedRunEventListener = (event: RpcManagedRunEvent) => void;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_stream_update",
	"tool_execution_end",
]);

const sessionEventTypes = new Set<AgentSessionEvent["type"]>([
	...agentEventTypes,
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"model_changed",
	"goal_updated",
]);

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) {
		return typeof value.error === "string";
	}
	return true;
}

function supportsRpcProtocolV2(value: Record<string, unknown>): boolean {
	return (
		value.type === "ready" &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.includes(2) &&
		value.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		value.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
	);
}


function declaresManagedNativeAgentBootstrap(value: Record<string, unknown>): boolean {
	const nativeAgent = value.nativeAgent;
	return isRecord(nativeAgent) && nativeAgent.protocolMajor === 1 && isNativeAgentCapabilitySet(nativeAgent.capabilities);
}

function readManagedFrameLimits(value: Record<string, unknown>): RpcFrameLimits {
	const { maxFrameBytes, maxReassembledFrameBytes, maxResourceChunkBytes } = value;
	if (
		typeof maxFrameBytes !== "number" || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0 ||
		typeof maxReassembledFrameBytes !== "number" || !Number.isSafeInteger(maxReassembledFrameBytes) || maxReassembledFrameBytes <= 0 ||
		typeof maxResourceChunkBytes !== "number" || !Number.isSafeInteger(maxResourceChunkBytes) || maxResourceChunkBytes <= 0
	) throw new RpcClientError("protocol-incompatible", "Managed peer omitted valid frame limits");
	return { maxFrameBytes, maxReassembledFrameBytes, maxResourceChunkBytes };
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return agentEventTypes.has(type as AgentEvent["type"]);
}

function isAgentSessionEvent(value: unknown): value is AgentSessionEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return sessionEventTypes.has(type as AgentSessionEvent["type"]);
}

function isRpcSubagentLifecycleFrame(value: unknown): value is RpcSubagentLifecycleFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_lifecycle" && isRecord(value.payload);
}

function isRpcSubagentProgressFrame(value: unknown): value is RpcSubagentProgressFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_progress" && isRecord(value.payload);
}

function isRpcSubagentEventFrame(value: unknown): value is RpcSubagentEventFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_event" && isRecord(value.payload);
}

function isRpcAvailableCommandsUpdateFrame(value: unknown): value is RpcAvailableCommandsUpdateFrame {
	if (!isRecord(value)) return false;
	return value.type === "available_commands_update" && Array.isArray(value.commands);
}

/** True for the two managed run boundary frames; unrelated frames are left to the legacy routing. */
function isManagedRunEventFrame(
	value: unknown,
): value is { type: "managed_run_start" | "managed_run_end" } & Record<string, unknown> {
	if (!isRecord(value)) return false;
	return value.type === "managed_run_start" || value.type === "managed_run_end";
}

/**
 * Parse a managed run boundary frame, or reject it.
 *
 * There is no permissive middle: a boundary is either complete and consistent
 * or it is malformed. A start must name its run and one of the two permitted
 * commands; a terminal boundary carries a terminal status independently of its
 * replies. Only the separate managed IRC barrier establishes reply quiescence.
 *
 * The optional correlation envelope is read with {@link readRpcCorrelation},
 * the same reader every other frame uses, so malformed correlation fields are
 * dropped rather than surfaced and no identifier is ever invented here.
 */
function parseManagedRunEvent(value: Record<string, unknown>): RpcManagedRunEvent | undefined {
	const runId = value.runId;
	if (typeof runId !== "string" || runId.length === 0) return undefined;
	if (value.type === "managed_run_start") {
		const command = value.command;
		if (command !== "bash" && command !== "prompt") return undefined;
		return { type: "managed_run_start", runId, command, ...readRpcCorrelation(value) };
	}
	if (value.type === "managed_run_end") {
		const status = value.status;
		if (status !== "completed" && status !== "failed" && status !== "cancelled") return undefined;
		if (typeof value.replyDrained !== "boolean") return undefined;
		if (value.runStatusRevision !== undefined &&
			(typeof value.runStatusRevision !== "number" || !Number.isSafeInteger(value.runStatusRevision) || value.runStatusRevision < 0)) return undefined;
		if (value.replyDrained === false && typeof value.runStatusRevision !== "number") return undefined;
		return { type: "managed_run_end", runId, status, replyDrained: value.replyDrained,
			...(typeof value.runStatusRevision === "number" ? { runStatusRevision: value.runStatusRevision } : {}) };
	}
	return undefined;
}

/**
 * Read the applied bootstrap context off a `prepare` answer.
 *
 * Every field the request carried must come back as a non-empty string, but
 * the value is not compared for equality: the peer reports what it resolved
 * (a normalized profile name, a canonical directory path, the agent definition
 * name it selected), and an equal-looking string is not the contract. An
 * omitted requested field is: it means the peer did not apply the request.
 */
function readPreparedContext(data: Record<string, unknown>, requested: RpcPrepareOptions): RpcPrepareOptions {
	const context: RpcPrepareOptions = {};
	for (const field of ["cwd", "profile", "agent"] as const) {
		const applied = data[field];
		if (applied === undefined) {
			if (requested[field] !== undefined)
				throw new RpcClientError(
					"protocol-incompatible",
					`Managed peer did not apply the requested prepare ${field}`,
					"prepare",
				);
			continue;
		}
		if (typeof applied !== "string" || applied.length === 0)
			throw new RpcClientError("protocol-incompatible", `Managed peer reported an invalid prepared ${field}`, "prepare");
		context[field] = applied;
	}
	for (const field of ["ircBinding", "coordinatorBinding"] as const) {
		if (data[field] === undefined && requested[field] === undefined) continue;
		const binding = parseManagedIrcBinding(data[field]);
		const expected = requested[field];
		if (!binding || !expected || binding.ownerPeerId !== expected.ownerPeerId || binding.generation !== expected.generation ||
			binding.allowedDescendants.length !== expected.allowedDescendants.length ||
			binding.allowedDescendants.some(id => !expected.allowedDescendants.includes(id))) {
			throw new RpcClientError("authorization-denied", `Managed prepare did not confirm ${field}`, "prepare");
		}
		context[field] = binding;
	}
	return context;
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
		};
	}
	return result;
}

/** Failed RPC command; `code` mirrors the server's machine-readable error code when present. */
export class RpcCommandError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "RpcCommandError";
	}
}

/** Managed failures remain distinct from legacy RPC command errors. */
class ManagedRpcError<Code extends RpcErrorCode = RpcErrorCode> extends Error {
	constructor(
		readonly code: Code,
		message: string,
		readonly command?: string,
	) {
		super(message);
		this.name = "RpcClientError";
	}
}

export type RpcClientError = {
	[Code in RpcErrorCode]: ManagedRpcError<Code>;
}[RpcErrorCode];
export const RpcClientError = ManagedRpcError;

export type RpcManagedLifecycle =
	| { status: "inactive" }
	| { status: "active"; heartbeatSeconds: number; leaseSeconds: number }
	| { status: "execution-unknown"; error: RpcClientError }
	| { status: "stopped" };

export type RpcManagedLifecycleListener = (lifecycle: RpcManagedLifecycle) => void;

/** True when a high-level `getMessages()` drain should discard partial pages and fall back to `get_messages`. */
function isPageFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof RpcCommandError && (error.code === "session_busy" || error.code === "stale_cursor"))
		return true;
	return error.message === RPC_MESSAGES_PAGE_BUSY_ERROR || error.message === RPC_MESSAGES_PAGE_STALE_ERROR;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	#process: RpcAgentProcess | null = null;
	#reaping: Promise<void> | null = null;
	#eventListeners: RpcEventListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#subagentLifecycleListeners = new Set<RpcSubagentLifecycleListener>();
	#subagentProgressListeners = new Set<RpcSubagentProgressListener>();
	#subagentEventListeners = new Set<RpcSubagentEventListener>();
	#availableCommandsUpdateListeners = new Set<RpcAvailableCommandsUpdateListener>();
	#managedRunListeners = new Set<RpcManagedRunEventListener>();
	#pendingRequests: Map<string, { id: string; resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#protocolVersion: RpcProtocolVersion = 1;
	#extensionUiListeners: Set<(req: RpcExtensionUIRequest) => void> = new Set();
	#abortController = new AbortController();
	#managedLifecycle: RpcManagedLifecycle = { status: "inactive" };
	#managedLifecycleListeners = new Set<RpcManagedLifecycleListener>();
	#lease: LeaseState | undefined;
	#heartbeatTimer: NodeJS.Timeout | undefined;
	#leaseTimer: NodeJS.Timeout | undefined;
	#managedFailure: ((error: Error) => Promise<void>) | undefined;
	#managedEncoder = new RpcFrameEncoder();
	#frameLimits: RpcFrameLimits | undefined;
	#peerLease: { heartbeatSeconds?: number; leaseSeconds?: number } | undefined;
	/** Bootstrap context the peer confirmed applying; reset per connection. */
	#preparedContext: RpcPrepareOptions | undefined;
	/** Capability flags read from the peer's own ready declaration. */
	#nativeAgentCapabilities: NativeAgentCapabilitySet | undefined;
	#irc: ManagedIrcChannel;
	#ircInboundListener: IrcInboundListener | undefined;
	#managedPeerListeners = new Set<(frame: ManagedPeerFrame) => void>();
	#replyDrainedListeners = new Set<(frame: ReplyDrainedBarrier) => void>();
	#ircRoutes = new Map<string, () => void>();
	#coordinatorPeers = new Set<string>();
	#ircRosterUnsubscribe: (() => void) | undefined;
	#ircObservationUnsubscribe: (() => void) | undefined;
	#ircOutboundUnregister: (() => void) | undefined;

	constructor(private options: RpcClientOptions = {}) {
		this.#customTools = [...(options.customTools ?? [])];
		this.#irc = this.#createIrcChannel();
	}

	#createIrcChannel(): ManagedIrcChannel {
		return new ManagedIrcChannel({
			output: frame => this.#writeFrame(frame, error => this.#closeIrc(error.message)),
			inbound: (envelope, options) => this.#ircInboundListener
				? this.#ircInboundListener(envelope, options)
				: deliverInboundEnvelope(IrcBus.global(), envelope, options.operationId, options.generation, options),
			onPeerFrame: frame => {
				const registry = AgentRegistry.global();
				const binding = this.#irc.binding;
				if (!binding) return;
				if (frame.kind === "peer_state_changed" && frame.state === "running" && frame.runId) {
					IrcBus.global().markRemoteRunStarted(frame.canonicalId, frame.runId);
				}
				if (frame.kind === "peer_state_changed") registry.setStatus(frame.canonicalId, frame.state);
				else if (frame.kind === "peer_deregistered") registry.unregister(frame.canonicalId);
				else registry.registerManagedPeer({
					identity: { canonicalId: frame.canonicalId,
						nativeId: registry.managedPeerIdentity(frame.canonicalId)?.nativeId ??
							(frame.canonicalId === binding.ownerPeerId ? MAIN_AGENT_ID : frame.canonicalId),
						ownerPeerId: binding.ownerPeerId, generation: frame.generation },
					reference: `rpc:${frame.canonicalId}`, displayName: frame.displayName, parentId: frame.parentId, status: "idle",
				});
				if (frame.kind === "peer_registered") this.#registerIrcRoute(frame.canonicalId);
				if (frame.kind === "peer_deregistered") {
					this.#ircRoutes.get(frame.canonicalId)?.();
					this.#ircRoutes.delete(frame.canonicalId);
					if (frame.canonicalId === binding.ownerPeerId) this.#closeIrc("Managed peer deregistered");
				}
				const relay = ManagedIrcObservationRelay.forRegistry(registry);
				if (frame.kind === "peer_deregistered") relay.removePeer(frame.canonicalId);
				else if (frame.kind === "peer_state_changed" && frame.runId) relay.publish(binding.ownerPeerId, frame);
				for (const listener of this.#managedPeerListeners) listener(frame);
			},
			onReplyDrainedBarrier: frame => {
				const peerId = frame.peerId ?? this.#irc.binding?.ownerPeerId;
				if (peerId) IrcBus.global().markRemoteReplyDrained(peerId, frame.runId);
				const ownerPeerId = this.#irc.binding?.ownerPeerId;
				if (peerId && ownerPeerId) ManagedIrcObservationRelay.forRegistry(AgentRegistry.global()).publish(ownerPeerId, { ...frame, peerId });
				for (const listener of this.#replyDrainedListeners) listener(frame);
			},
			onControlOrUi: frame => this.#handleLine(frame),
			onRegistrationRequest: request => {
				const registry = AgentRegistry.global();
				const binding = this.#irc.binding;
				if (!binding || !registry.authorizeManagedSender(binding.ownerPeerId, request.generation, request.parentId).authorized) {
					throw new RpcClientError("authorization-denied", "Peer registration has an unauthorized parent", "managed_irc");
				}
				const identity = registry.managedPeerIdentityByNative(binding.ownerPeerId, request.nativeId) ??
					registry.allocateManagedDescendant({ ownerPeerId: binding.ownerPeerId, generation: request.generation, nativeId: request.nativeId });
				if (!identity || identity.generation !== request.generation || identity.canonicalId === binding.ownerPeerId) {
					throw new RpcClientError("authorization-denied", "Peer registration ownership is stale", "managed_irc");
				}
				registry.registerManagedPeer({ identity, reference: `rpc:${identity.canonicalId}`, displayName: request.displayName,
					parentId: request.parentId, status: "idle" });
				this.#registerIrcRoute(identity.canonicalId);
				return { kind: "peer_registered", canonicalId: identity.canonicalId, parentId: request.parentId,
					displayName: request.displayName, roles: request.roles, generation: request.generation };
			},
		});
	}

	#registerIrcRoute(peerId: string): void {
		if (this.#ircRoutes.has(peerId)) return;
		this.#ircRoutes.set(peerId, IrcBus.global().registerOutboundRoute(peerId, {
			deliver: (envelope, options) => this.deliverIrc(envelope, {
				operationId: options.operationId ?? envelope.id, targetPeerId: envelope.to,
				expectsReply: options.expectsReply, suppressRelay: options.suppressRelay, wake: options.wake,
			}),
		}));
	}

	#publishCoordinatorPeer(peerId: string, removed = false): void {
		const coordinator = this.#preparedContext?.coordinatorBinding;
		const binding = this.#irc.binding;
		if (!coordinator || !binding) return;
		const registry = AgentRegistry.global();
		const canonicalId = registry.canonicalizeManagedPeerId(peerId);
		if (canonicalId === coordinator.ownerPeerId || registry.managedPeerIdentity(canonicalId)?.ownerPeerId === binding.ownerPeerId) return;
		if (removed) {
			if (!this.#coordinatorPeers.delete(canonicalId)) return;
			this.#irc.emit({ kind: "peer_deregistered", canonicalId, generation: binding.generation });
			return;
		}
		const ref = registry.get(peerId) ?? registry.get(registry.resolveManagedLocalRefId(canonicalId));
		if (!ref) return;
		if (!this.#coordinatorPeers.has(canonicalId)) {
			this.#coordinatorPeers.add(canonicalId);
			const parentId = ref.parentId && ref.parentId !== ref.id ?
				registry.canonicalizeManagedPeerId(ref.parentId) : coordinator.ownerPeerId;
			if (parentId !== coordinator.ownerPeerId) this.#publishCoordinatorPeer(ref.parentId ?? parentId);
			this.#irc.emit({ kind: "peer_registered", canonicalId,
				parentId: this.#coordinatorPeers.has(parentId) ? parentId : coordinator.ownerPeerId,
				displayName: ref.displayName, roles: [ref.kind], generation: binding.generation });
		}
		if (ref.status === "aborted") {
			this.#coordinatorPeers.delete(canonicalId);
			this.#irc.emit({ kind: "peer_deregistered", canonicalId, generation: binding.generation });
		} else this.#irc.emit({ kind: "peer_state_changed", canonicalId, state: ref.status, generation: binding.generation });
	}

	#forwardIrcObservation(sourceOwnerPeerId: string, frame: ManagedIrcObservation): void {
		const binding = this.#irc.binding;
		if (!binding || binding.ownerPeerId === sourceOwnerPeerId) return;
		const peerId = frame.kind === "peer_state_changed" ? frame.canonicalId : frame.peerId;
		if (!peerId) return;
		try {
			if (!this.#syncIrcBinding()) return;
			this.#publishCoordinatorPeer(peerId);
			if (!this.#coordinatorPeers.has(peerId)) return;
			this.#irc.emit(frame.kind === "peer_state_changed" ? { ...frame, generation: binding.generation } : frame);
		} catch (failure) {
			void this.#managedFailure?.(new RpcClientError("connection-lost",
				failure instanceof Error ? failure.message : String(failure), "managed_irc"));
		}
	}

	#closeIrc(reason: string): void {
		this.#irc.close(reason);
		this.#ircOutboundUnregister?.();
		this.#ircOutboundUnregister = undefined;
		this.#ircRosterUnsubscribe?.();
		this.#ircRosterUnsubscribe = undefined;
		this.#ircObservationUnsubscribe?.();
		this.#ircObservationUnsubscribe = undefined;
		this.#coordinatorPeers.clear();
		for (const unregister of this.#ircRoutes.values()) unregister();
		this.#ircRoutes.clear();
		const binding = this.#irc.binding;
		if (binding) {
			const registry = AgentRegistry.global();
			const current = registry.getManagedConnectionBinding(binding.ownerPeerId);
			if (!current || current.generation === binding.generation) {
				ManagedIrcObservationRelay.forRegistry(registry).removeSource(binding.ownerPeerId);
			}
			AgentRegistry.global().revokeManagedConnection(binding.ownerPeerId, binding.generation);
		}
	}

	/**
	 * Start the RPC agent process.
	 *
	 * Safe to call again after {@link stop} on the same instance: a fresh
	 * {@link AbortController} is minted for each start, and any failure after
	 * the child spawn kills the child and clears internal state so callers may
	 * retry without leaking processes.
	 */
	async start(): Promise<void> {
		await this.#reaping;
		if (this.#process) {
			throw new Error("Client already started");
		}

		// Mint a fresh controller so a previous stop()'s abort does not
		// short-circuit the new stdout reader (issue #4079).
		this.#abortController = new AbortController();
		this.#protocolVersion = 1;
		this.#clearManagedTimers();
		this.#managedLifecycle = { status: "inactive" };
		this.#managedEncoder = new RpcFrameEncoder();
		this.#frameLimits = undefined;
		this.#peerLease = undefined;
		this.#preparedContext = undefined;
		this.#nativeAgentCapabilities = undefined;
		this.#irc = this.#createIrcChannel();

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}
		const child = this.options.spawn
			? await this.options.spawn(args)
			: ptree.spawn(
					typeof this.options.command === "function"
						? this.options.command(args)
						: [...(this.options.command ?? ["bun", cliPath]), ...args],
					{
						cwd: this.options.cwd,
						env: { ...Bun.env, ...this.options.env },
						stdin: "pipe",
					},
				);
		this.#process = child;

		// Wait for the "ready" signal or process exit
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<RpcFrameLimits | undefined>();
		let readySettled = false;
		let protocolV2Supported = false;
		let protocolV2Enabled = false;
		const frameDecoder = new RpcFrameDecoder();

		const reapAfterOutputFailure = async (error: Error) => {
			if (this.#process !== child) return;

			if (this.options.expectManagedBootstrap) {
				this.#clearManagedTimers();
				if (this.#managedLifecycle.status === "active") {
					const lost = new RpcClientError("connection-lost", error.message);
					this.#setManagedLifecycle({ status: "execution-unknown", error: lost });
					if (!(error instanceof RpcClientError)) error = lost;
				}
			}
			this.#process = null;
			this.#closeIrc(error.message);
			this.#abortController.abort(error);
			const pendingRequests = Array.from(this.#pendingRequests.values());
			this.#pendingRequests.clear();
			for (const pendingCall of this.#pendingHostToolCalls.values()) pendingCall.controller.abort(error);
			this.#pendingHostToolCalls.clear();
			if (this.options.expectManagedBootstrap) {
				for (const request of pendingRequests) request.reject(error);
			}

			try {
				child.kill(undefined, this.options.terminationGraceMs);
			} catch {
				// The process may already have exited.
			}
			await this.#waitForExit(child);
			if (!this.options.expectManagedBootstrap) {
				for (const request of pendingRequests) request.reject(error);
			}
		};
		this.#managedFailure = reapAfterOutputFailure;

		// Process lines in background, intercepting the ready signal.
		const lines = readJsonl(child.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") {
					readySettled = true;
					let proposedLimits: RpcFrameLimits | undefined;
					if (this.options.expectManagedBootstrap && !declaresManagedNativeAgentBootstrap(line)) {
						// Reject and stop reading so no later frame or response is processed;
						// the startup failure path in start() reaps the child before any
						// protocol negotiation or custom-tool write.
						readyReject(new RpcClientError("protocol-incompatible", "remote did not declare a managed native-agent bootstrap with the full capability contract"));
						return;
					}
					if (isRecord(line.nativeAgent) && isNativeAgentCapabilitySet(line.nativeAgent.capabilities))
						this.#nativeAgentCapabilities = { ...line.nativeAgent.capabilities };
					if (this.options.expectManagedBootstrap) {
						try {
							if (!Array.isArray(line.supportedProtocolVersions) || !line.supportedProtocolVersions.includes(2))
								throw new RpcClientError("protocol-incompatible", "Managed peer does not support chunked protocol v2");
							proposedLimits = negotiateRpcFrameLimits(
								this.options.managedFrameLimits ?? DEFAULT_RPC_FRAME_LIMITS,
								readManagedFrameLimits(line),
							);
							if (isRecord(line.nativeAgent) && isRecord(line.nativeAgent.proposed)) {
								const { heartbeatSeconds, leaseSeconds } = line.nativeAgent.proposed;
								if (
									typeof heartbeatSeconds !== "number" || !Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0 ||
									typeof leaseSeconds !== "number" || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0
								) throw new RpcClientError("protocol-incompatible", "Invalid managed lease proposal");
								this.#peerLease = { heartbeatSeconds, leaseSeconds };
							}
							protocolV2Supported = true;
						} catch (error) {
							readyReject(error);
							return;
						}
					} else {
						protocolV2Supported = supportsRpcProtocolV2(line);
					}
					readyResolve(proposedLimits);
					continue;
				}
				if (isRecord(line) && line.type === "rpc_chunk" && !protocolV2Enabled)
					throw new Error("RPC chunk received before protocol negotiation");
				let decoded: object | undefined;
				try {
					decoded = frameDecoder.push(line);
				} catch (cause) {
					if (!this.options.expectManagedBootstrap) throw cause;
					throw new RpcClientError("protocol-incompatible", cause instanceof Error ? cause.message : String(cause));
				}
				if (decoded) this.#handleLine(decoded);
			}
			// A closed stdout is terminal even if the child remains alive. Startup
			// failures are reaped by the readyPromise catch below; established
			// workers are reaped here so pending requests cannot hang indefinitely.
			if (!readySettled) {
				// Stdout can close before the exit reaper finishes draining stderr.
				// child.exited settles only after the stderr tail is complete (for
				// nonzero exits), so give it a bounded head start: the exit watcher
				// below was registered first and rejects with the real stderr text
				// instead of an empty "Stderr:" (flaked under full-suite load).
				await Promise.race([child.exited.catch(() => {}), Bun.sleep(250)]);
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent output stream ended before ready. Stderr: ${child.peekStderr()}`));
				return;
			}
			const exitResult = await Promise.race([
				child.exited.then(
					exitCode => ({ exitCode }),
					cause => ({ cause }),
				),
				Bun.sleep(100).then(() => null),
			]);
			const error =
				exitResult === null
					? new Error(`Agent output stream ended unexpectedly. Stderr: ${child.peekStderr()}`)
					: "exitCode" in exitResult
						? new Error(`Agent process exited with code ${exitResult.exitCode}. Stderr: ${child.peekStderr()}`)
						: new Error(`Agent output stream ended. Stderr: ${child.peekStderr()}`, {
								cause: exitResult.cause,
							});
			await reapAfterOutputFailure(error);
		})().catch(async (cause: unknown) => {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (!readySettled) {
				readySettled = true;
				readyReject(error);
				return;
			}
			await reapAfterOutputFailure(this.options.expectManagedBootstrap && error instanceof RpcClientError
				? error
				: new Error(`Agent output reader failed: ${error.message}`, { cause: error }));
		});

		// Also race against process exit (in case stdout closes before we read it)
		void child.exited.then(
			(exitCode: number) => {
				if (readySettled) {
					if (this.options.expectManagedBootstrap && this.#managedLifecycle.status === "active")
						void reapAfterOutputFailure(new RpcClientError("connection-lost", `Agent process exited with code ${exitCode}`));
					return;
				}
				readySettled = true;
				readyReject(new Error(`Agent process exited with code ${exitCode}. Stderr: ${child.peekStderr()}`));
			},
			(err: Error) => {
				// Killed or reaped without an exit code (e.g. stop() during
				// startup); surface it instead of leaking an unhandled rejection.
				if (readySettled) {
					if (this.options.expectManagedBootstrap && this.#managedLifecycle.status === "active")
						void reapAfterOutputFailure(new RpcClientError("connection-lost", err.message));
					return;
				}
				readySettled = true;
				readyReject(new Error(`Agent process exited before ready. Stderr: ${child.peekStderr()}`, { cause: err }));
			},
		);

		// Timeout to prevent hanging forever
		const readyTimeout = this.#startTimeout(30000, () => {
			if (readySettled) return;
			readySettled = true;
			readyReject(this.options.expectManagedBootstrap
				? new RpcClientError("timeout", "Timeout waiting for agent to become ready")
				: new Error(`Timeout waiting for agent to become ready. Stderr: ${child.peekStderr()}`));
		});

		try {
			const proposedLimits = await readyPromise;
			this.#frameLimits = proposedLimits;
			if (protocolV2Supported) {
				protocolV2Enabled = true;
				const response = await this.#send({
					type: "negotiate_protocol", protocolVersion: 2,
					...(this.options.expectManagedBootstrap ? proposedLimits : {}),
				});
				if (
					!response.success ||
					response.command !== "negotiate_protocol" ||
					!isRecord(response.data) ||
					response.data.protocolVersion !== 2
				)
					throw this.options.expectManagedBootstrap
						? new RpcClientError("protocol-incompatible", "RPC protocol v2 negotiation failed")
						: new Error("RPC protocol v2 negotiation failed");
				this.#protocolVersion = 2;
				if (this.options.expectManagedBootstrap && proposedLimits) {
					const accepted = readManagedFrameLimits(response.data);
					if (
						accepted.maxFrameBytes > proposedLimits.maxFrameBytes ||
						accepted.maxReassembledFrameBytes > proposedLimits.maxReassembledFrameBytes ||
						accepted.maxResourceChunkBytes > proposedLimits.maxResourceChunkBytes
					) throw new RpcClientError("protocol-incompatible", "Peer exceeded proposed frame limits");
					this.#frameLimits = negotiateRpcFrameLimits(proposedLimits, accepted);
					frameDecoder.setLimits(this.#frameLimits);
					this.#managedEncoder.setLimits(this.#frameLimits);
					this.#managedEncoder.setProtocolVersion(2);
					this.#managedEncoder.setManagedEnvelope(true);
				}
			}
			if (this.options.expectManagedBootstrap) await this.prepare();
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} catch (cause) {
			// Startup failed after spawning the child. Reap it before returning
			// so a retry cannot inherit a live worker or its session lock.
			const error = cause instanceof Error ? cause : new Error(String(cause));
			const failure = this.options.expectManagedBootstrap && !(error instanceof RpcClientError)
				? new RpcClientError("connection-lost", error.message)
				: error;
			await reapAfterOutputFailure(failure);
			throw this.options.expectManagedBootstrap ? failure : cause;
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop(): Promise<void> {
		if (!this.#process) return this.#reaping ?? Promise.resolve();

		this.#clearManagedTimers();
		if (this.options.expectManagedBootstrap) this.#setManagedLifecycle({ status: "stopped" });
		const error = this.options.expectManagedBootstrap
			? new RpcClientError("user-cancelled", "Client stopped")
			: new Error("Client stopped");
		const child = this.#process;
		child.kill(undefined, this.options.terminationGraceMs);
		this.#abortController.abort(error);
		this.#process = null;
		this.#closeIrc(error.message);
		for (const request of this.#pendingRequests.values()) request.reject(error);
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort(error);
		}
		this.#pendingHostToolCalls.clear();
		return this.#waitForExit(child);
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		void this.stop();
	}

	#waitForExit(child: RpcAgentProcess): Promise<void> {
		const reaping = child.exited.then(
			() => {},
			() => {},
		);
		this.#reaping = reaping;
		void reaping.then(() => {
			if (this.#reaping === reaping) this.#reaping = null;
		});
		return reaping;
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to all top-level session events, including non-core session state events.
	 */
	onSessionEvent(listener: RpcSessionEventListener): () => void {
		this.#sessionEventListeners.push(listener);
		return () => {
			const index = this.#sessionEventListeners.indexOf(listener);
			if (index !== -1) {
				this.#sessionEventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to subagent lifecycle frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentLifecycle(listener: RpcSubagentLifecycleListener): () => void {
		this.#subagentLifecycleListeners.add(listener);
		return () => this.#subagentLifecycleListeners.delete(listener);
	}

	/**
	 * Subscribe to aggregated subagent progress frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentProgress(listener: RpcSubagentProgressListener): () => void {
		this.#subagentProgressListeners.add(listener);
		return () => this.#subagentProgressListeners.delete(listener);
	}

	/**
	 * Subscribe to raw subagent session events. Call setSubagentSubscription(\"events\") to enable them server-side.
	 */
	onSubagentEvent(listener: RpcSubagentEventListener): () => void {
		this.#subagentEventListeners.add(listener);
		return () => this.#subagentEventListeners.delete(listener);
	}

	/**
	 * Subscribe to slash-command availability updates emitted by the RPC server.
	 */
	onAvailableCommandsUpdate(listener: RpcAvailableCommandsUpdateListener): () => void {
		this.#availableCommandsUpdateListeners.add(listener);
		return () => this.#availableCommandsUpdateListeners.delete(listener);
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	getManagedLifecycle(): RpcManagedLifecycle {
		return this.#managedLifecycle;
	}

	onManagedLifecycle(listener: RpcManagedLifecycleListener): () => void {
		this.#managedLifecycleListeners.add(listener);
		return () => this.#managedLifecycleListeners.delete(listener);
	}

	/**
	 * Bootstrap context the peer acknowledged applying.
	 *
	 * Only fields the peer echoed are present, so a defined result is never a
	 * local echo of {@link RpcClientOptions.prepare}: a requested field the peer
	 * ignored fails the prepare that carried it. Reset on every start; a fresh
	 * connection reports `undefined` until its prepare is acknowledged.
	 */
	getPreparedContext(): RpcPrepareOptions | undefined {
		return this.#preparedContext;
	}

	/**
	 * Capability flags read from the peer's own ready declaration and validated
	 * during the handshake. This is what the peer says it implements; the local
	 * build's constant is never substituted for it.
	 */
	getNativeAgentCapabilities(): NativeAgentCapabilitySet | undefined {
		return this.#nativeAgentCapabilities;
	}

	/**
	 * Subscribe to managed run boundaries emitted by the server.
	 *
	 * Each event carries the server-minted run id and the facts the server
	 * wrote; the client forwards them verbatim and mints nothing, so a consumer
	 * addresses runs by the same identifiers the peer tracks.
	 */
	onManagedRunEvent(listener: RpcManagedRunEventListener): () => void {
		this.#managedRunListeners.add(listener);
		return () => this.#managedRunListeners.delete(listener);
	}

	getIrcBinding(): ManagedIrcBinding | undefined {
		return this.#irc.binding;
	}

	deliverIrc(envelope: IrcEnvelope, options: ManagedIrcSendOptions): Promise<DeliveryResult> {
		if (!this.#syncIrcBinding()) return Promise.resolve({ to: envelope.to, outcome: "failed", error: "authorization-denied" });
		this.#publishCoordinatorPeer(envelope.from);
		return this.#irc.deliverIrc(envelope, options);
	}

	onIrcInbound(listener: IrcInboundListener): () => void {
		if (this.#ircInboundListener) throw new Error("An IRC inbound delivery handler is already registered");
		this.#ircInboundListener = listener;
		return () => { if (this.#ircInboundListener === listener) this.#ircInboundListener = undefined; };
	}

	onManagedPeerFrame(listener: (frame: ManagedPeerFrame) => void): () => void {
		this.#managedPeerListeners.add(listener);
		return () => this.#managedPeerListeners.delete(listener);
	}

	onReplyDrainedBarrier(listener: (frame: ReplyDrainedBarrier) => void): () => void {
		this.#replyDrainedListeners.add(listener);
		return () => this.#replyDrainedListeners.delete(listener);
	}

	#syncIrcBinding(): boolean {
		const bound = this.#irc.binding;
		if (!bound) return false;
		const current = AgentRegistry.global().getManagedConnectionBinding(bound.ownerPeerId);
		if (!current || current.generation !== bound.generation) {
			this.#closeIrc("IRC ownership revoked or superseded");
			return false;
		}
		this.#irc.bind({ ...current, allowedDescendants: [...current.allowedDescendants] });
		return true;
	}

	#setManagedLifecycle(lifecycle: RpcManagedLifecycle): void {
		this.#managedLifecycle = lifecycle;
		for (const listener of this.#managedLifecycleListeners) listener(lifecycle);
	}

	#clearManagedTimers(): void {
		clearInterval(this.#heartbeatTimer);
		clearInterval(this.#leaseTimer);
		this.#heartbeatTimer = undefined;
		this.#leaseTimer = undefined;
		this.#lease = undefined;
	}

	#renewManagedLease(): void {
		if (this.#lease) this.#lease = tickLease(this.#lease);
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Negotiate the managed lease pair and apply the bootstrap context.
	 *
	 * The command carries {@link RpcClientOptions.prepare} so the peer can
	 * relocate the session before it builds one, and the answer echoes back the
	 * context the peer actually applied. A requested field the answer omits is
	 * not a weaker confirmation but a missing one: the peer ignored the
	 * request, so the lease is never activated and the connection fails as
	 * protocol-incompatible instead of running in the wrong place.
	 */
	async prepare(
		proposed: { heartbeatSeconds?: number; leaseSeconds?: number } = {},
		metadata: RpcCorrelationFields = {},
	): Promise<RpcPrepareResult> {
		const registry = AgentRegistry.global();
		const configured = this.options.prepare ?? {};
		const established = this.#preparedContext?.ircBinding;
		const allocation = established ? registry.getManagedConnectionBinding(established.ownerPeerId) ?? established :
			configured.ircBinding ?? registry.allocateManagedRoot({ nativeId: MAIN_AGENT_ID, scope: randomUUID() }).binding;
		const ircBinding: ManagedIrcBinding = { ...allocation, allowedDescendants: [...allocation.allowedDescendants] };
		const generation = ircBinding.generation;
		let rootId = registry.canonicalizeManagedPeerId(MAIN_AGENT_ID);
		if (configured.coordinatorBinding === undefined && rootId === MAIN_AGENT_ID) {
			const root = registry.allocateManagedRoot({ nativeId: MAIN_AGENT_ID, scope: `coordinator-${randomUUID()}` });
			rootId = root.peerId;
			registry.registerManagedLocalAlias({ identity: { canonicalId: rootId, nativeId: MAIN_AGENT_ID,
				ownerPeerId: rootId, generation: root.binding.generation }, binding: root.binding });
		}
		const observationRelay = ManagedIrcObservationRelay.forRegistry(registry);
		observationRelay.observeLocalPeers(configured.coordinatorBinding?.ownerPeerId ?? rootId);
		const coordinatorBinding = configured.coordinatorBinding ?? {
			ownerPeerId: rootId, generation,
			allowedDescendants: registry.list().map(ref => registry.canonicalizeManagedPeerId(ref.id))
				.filter(id => id !== rootId && id !== ircBinding.ownerPeerId &&
					registry.managedPeerIdentity(id)?.ownerPeerId !== ircBinding.ownerPeerId),
		};
		if (coordinatorBinding.generation !== ircBinding.generation) {
			throw new RpcClientError("authorization-denied", "Directional IRC bindings must share the connection generation", "prepare");
		}
		if (configured.coordinatorBinding === undefined) IrcBus.global().registerIdentity(rootId, MAIN_AGENT_ID);
		const context: RpcPrepareOptions = { ...configured, ircBinding, coordinatorBinding };
		const offered = negotiateLease(
			createLeaseState(Date.now(), { ...this.options.managedLease, ...proposed }),
			createLeaseState(Date.now(), this.#peerLease),
		);
		const response = await this.#send({
			...metadata, type: "prepare", ...offered,
			...(context.cwd === undefined ? {} : { cwd: context.cwd }),
			...(context.profile === undefined ? {} : { profile: context.profile }),
			...(context.agent === undefined ? {} : { agent: context.agent }),
			ircBinding: context.ircBinding,
			coordinatorBinding: context.coordinatorBinding,
		});
		const data = this.#getData<unknown>(response);
		if (!isRecord(data)) throw new RpcClientError("protocol-incompatible", "Managed prepare answer carried no data", "prepare");
		const heartbeatSeconds = data.heartbeatSeconds;
		const leaseSeconds = data.leaseSeconds;
		if (
			typeof heartbeatSeconds !== "number" || !Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0 ||
			typeof leaseSeconds !== "number" || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0 ||
			heartbeatSeconds > offered.heartbeatSeconds || leaseSeconds > offered.leaseSeconds
		) throw new RpcClientError("protocol-incompatible", "Invalid managed lease negotiation", "prepare");
		const applied = readPreparedContext(data, context);
		this.#preparedContext = { ...this.#preparedContext, ...applied };
		if (applied.ircBinding) {
			if (!registry.bindManagedConnection(applied.ircBinding)) {
				throw new RpcClientError("authorization-denied", "IRC ownership generation is stale or revoked", "prepare");
			}
			this.#irc.bind(applied.ircBinding);
			registry.registerManagedPeer({
				identity: { canonicalId: applied.ircBinding.ownerPeerId, nativeId: MAIN_AGENT_ID,
					ownerPeerId: applied.ircBinding.ownerPeerId, generation: applied.ircBinding.generation },
				reference: `rpc:${applied.ircBinding.ownerPeerId}`, displayName: MAIN_AGENT_ID,
				parentId: coordinatorBinding.ownerPeerId, status: "idle",
			});
			this.#registerIrcRoute(applied.ircBinding.ownerPeerId);
			for (const id of applied.ircBinding.allowedDescendants) this.#registerIrcRoute(id);
		}
		this.#coordinatorPeers = new Set([coordinatorBinding.ownerPeerId, ...coordinatorBinding.allowedDescendants]);
		this.#ircOutboundUnregister ??= observationRelay.registerChannel(this.#irc);
		this.#ircRosterUnsubscribe ??= registry.onChange(event => {
			this.#publishCoordinatorPeer(event.ref.id, event.type === "removed");
		});
		this.#ircObservationUnsubscribe ??= observationRelay.subscribe(
			(sourceOwnerPeerId, frame) => this.#forwardIrcObservation(sourceOwnerPeerId, frame),
		);
		this.#clearManagedTimers();
		this.#lease = createLeaseState(Date.now(), { heartbeatSeconds, leaseSeconds });
		this.#setManagedLifecycle({ status: "active", heartbeatSeconds, leaseSeconds });
		this.#heartbeatTimer = setInterval(() => {
			void this.#send({ type: "heartbeat", scope: "control" }).catch(error => {
				if (error instanceof RpcClientError && error.code === "connection-lost")
					void this.#managedFailure?.(error);
			});
		}, heartbeatSeconds * 1000);
		this.#leaseTimer = setInterval(() => {
			if (this.#lease && isLeaseExpired(this.#lease))
				void this.#managedFailure?.(new RpcClientError("connection-lost", "Managed receive lease expired"));
		}, Math.min(heartbeatSeconds, leaseSeconds) * 1000);
		this.#heartbeatTimer.unref();
		this.#leaseTimer.unref();
		return { heartbeatSeconds, leaseSeconds, ...applied };
	}

	async cancelRun(runId: string, metadata: RpcCorrelationFields = {}): Promise<RpcCancelRunResult> {
		return this.#getData(await this.#send({ ...metadata, type: "cancel_run", runId }));
	}

	async terminate(peerId?: string, metadata: RpcCorrelationFields = {}): Promise<{ acknowledged: true }> {
		const result = this.#getData<{ acknowledged: true }>(
			await this.#send({ ...metadata, type: "terminate", ...(peerId === undefined ? {} : { peerId }) }),
		);
		this.#closeIrc("Managed peer terminated");
		this.#clearManagedTimers();
		this.#setManagedLifecycle({ status: "stopped" });
		return result;
	}

	async park(runId: string, metadata: RpcCorrelationFields = {}): Promise<EndpointControlAck> {
		return this.#getData(await this.#send({ ...metadata, type: "park", runId }));
	}

	async resume(reference: string, expectedRunId?: string, metadata: RpcCorrelationFields = {}): Promise<RpcResumeResult> {
		return this.#getData(await this.#send({
			...metadata, type: "resume", reference, ...(expectedRunId === undefined ? {} : { expectedRunId }),
		}));
	}

	async ensureLive(reference: string): Promise<EndpointControlAck> {
		const result = await this.resume(reference);
		return result.status === "reopened"
			? { acknowledged: true }
			: { acknowledged: false, reason: result.detail };
	}

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		const state = this.#getData<RpcSessionState>(response);
		return {
			...state,
			fastModeEnabled: state.fastModeEnabled === true,
			fastModeActive: state.fastModeActive === true,
			tokensPerSecond:
				typeof state.tokensPerSecond === "number" && Number.isFinite(state.tokensPerSecond)
					? state.tokensPerSecond
					: null,
		};
	}

	/**
	 * Enable or disable fast mode for the active model family.
	 */
	async setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
		const response = await this.#send({ type: "set_fast_mode", enabled });
		return this.#getData(response);
	}

	/**
	 * Configure subagent frames emitted by the RPC server. Servers default to "off".
	 * "progress" emits lifecycle/progress frames; "events" additionally emits raw subagent session events.
	 */
	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<RpcSubagentSubscriptionLevel> {
		const response = await this.#send({ type: "set_subagent_subscription", level });
		return this.#getData<{ level: RpcSubagentSubscriptionLevel }>(response).level;
	}

	/**
	 * Return the RPC server's current subagent snapshot.
	 */
	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#getData<{ subagents: RpcSubagentSnapshot[] }>(response).subagents;
	}

	/**
	 * Read persisted transcript entries for a tracked subagent session.
	 */
	async getSubagentMessages(selector: {
		subagentId?: string;
		sessionFile?: string;
		fromByte?: number;
	}): Promise<RpcSubagentMessagesResult> {
		const response = await this.#send({
			type: "get_subagent_messages",
			subagentId: selector.subagentId,
			sessionFile: selector.sessionFile,
			fromByte: selector.fromByte,
		});
		return this.#getData<RpcSubagentMessagesResult>(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model" });
		return this.#getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Get list of available slash commands.
	 */
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		const response = await this.#send({ type: "get_available_commands" });
		return this.#getData<{ commands: RpcAvailableSlashCommand[] }>(response).commands;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	/**
	 * Hand off session context to a new session.
	 */
	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		const response = await this.#send({ type: "handoff", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#getData(response);
	}

	/**
	 * Branch from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	/**
	 * Get messages available for branching.
	 */
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	/**
	 * Get one stable, byte-bounded message page.
	 */
	async getMessagesPage(options: RpcMessagesPageOptions = {}): Promise<RpcMessagesPage> {
		const response = await this.#send({ type: "get_messages_page", ...options });
		return this.#getData<RpcMessagesPage>(response);
	}

	/** Get all messages, draining stable pages when protocol v2 is available. */
	async getMessages(): Promise<AgentMessage[]> {
		if (this.#protocolVersion === 2) {
			try {
				const messages: AgentMessage[] = [];
				const seenCursors = new Set<string>();
				let totalMessages: number | undefined;
				let cursor: string | undefined;
				do {
					const page = await this.getMessagesPage({ cursor, limit: 256 });
					if (
						!Number.isSafeInteger(page.totalMessages) ||
						page.totalMessages < 0 ||
						(totalMessages !== undefined && page.totalMessages !== totalMessages)
					)
						throw new Error("RPC message pagination returned an inconsistent total");
					totalMessages = page.totalMessages;
					messages.push(...page.messages);
					cursor = page.nextCursor;
					if (cursor && seenCursors.has(cursor)) throw new Error("RPC message pagination repeated a cursor");
					if (cursor) seenCursors.add(cursor);
				} while (cursor);
				if (messages.length !== totalMessages)
					throw new Error("RPC message pagination ended before the advertised total");
				return messages;
			} catch (error) {
				if (!isPageFallbackError(error)) throw error;
			}
		}
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get list of OAuth providers available for login, with their current authentication status.
	 */
	async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{
			providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
		}>(response).providers;
	}

	/**
	 * Trigger OAuth login for the given provider.
	 * The server will emit an `open_url` extension_ui_request for the auth URL.
	 * Providers that require pasted-code completion may then emit an `input`
	 * extension_ui_request; pass `onManualCodeInput` to satisfy it.
	 * Resolves when login completes or rejects on failure.
	 *
	 * @param onOpenUrl Called when the server emits the auth URL. The host must
	 *   open `url` in a browser. When the flow's callback server hosts a
	 *   `/launch` redirect, `launchUrl` is a short loopback URL that 302s to
	 *   `url` — hosts SHOULD surface it as the truncation-safe copy target so
	 *   terminal viewport clipping cannot corrupt trailing OAuth query
	 *   parameters (e.g. `code_challenge_method=S256`).
	 */
	async login(
		providerId: string,
		options?: {
			onOpenUrl?: (url: string, instructions?: string, launchUrl?: string) => void;
			onManualCodeInput?: (prompt: { title: string; placeholder?: string }) => string | Promise<string>;
		},
	): Promise<{ providerId: string }> {
		const { onManualCodeInput, onOpenUrl } = options ?? {};
		const listener =
			onOpenUrl || onManualCodeInput
				? (req: RpcExtensionUIRequest) => {
						if (req.method === "open_url") {
							onOpenUrl?.(req.url, req.instructions, req.launchUrl);
							return;
						}
						if (req.method !== "input" || !onManualCodeInput) return;
						void Promise.resolve(onManualCodeInput({ title: req.title, placeholder: req.placeholder }))
							.then(value => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									value,
								});
							})
							.catch(() => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									cancelled: true,
								});
							});
					}
				: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
	}

	/**
	 * Replace the host-owned custom tools exposed to the RPC session.
	 * Changes take effect before the next model call.
	 */
	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#process) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
			loadMode: tool.loadMode,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves on a terminal agent_end; omitted isTerminal retains legacy semantics.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		// D2: scheduling-pause agent_end frames do not settle RPC waiters.
		const unsubscribe = this.onSessionEvent(event => {
			if (event.type === "agent_end" && event.isTerminal !== false) {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onSessionEvent(event => {
			// D2: collect core events only, excluding nonterminal completion frames.
			if (!isAgentEvent(event) || (event.type === "agent_end" && event.isTerminal === false)) return;
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	#handleLine(data: unknown): void {
		if (this.options.expectManagedBootstrap && isRecord(data) && data.type === "managed_irc") {
			const wire = parseManagedIrcWireFrame(data);
			this.#syncIrcBinding();
			this.#renewManagedLease();
			void this.#irc.handleFrame(wire).catch(error => {
				void this.#managedFailure?.(new RpcClientError("remote-execution-failed", String(error), "managed_irc"));
			});
			return;
		}
		if (this.options.expectManagedBootstrap && isRecord(data) && data.type === "heartbeat") {
			if (this.#managedLifecycle.status === "execution-unknown") return;
			const correlation = readRpcCorrelation(data);
			if (
				data.id !== correlation.id || data.correlationId !== correlation.correlationId ||
				data.scope !== correlation.scope || data.generation !== correlation.generation ||
				data.operationId !== correlation.operationId
			) return;
			this.#renewManagedLease();
			this.#writeFrame({ type: "response", command: "heartbeat", success: true, ...correlation });
			return;
		}
		// Check if it's a response to a pending request
		if (isRpcResponse(data)) {
			if (this.options.expectManagedBootstrap && this.#irc.handleResponse(data)) return;
			if (this.options.expectManagedBootstrap) {
				if (data.correlationId !== undefined && typeof data.correlationId !== "string") return;
				if (!data.success && (!isRpcErrorCode(data.code) || typeof data.message !== "string"))
					throw new RpcClientError("protocol-incompatible", "Managed error response omitted a valid code or message", data.command);
				if (!data.success && data.command === "heartbeat" && data.code === "connection-lost" &&
					data.id === undefined && data.correlationId === undefined) {
					const error = new RpcClientError("connection-lost", data.message ?? data.error, data.command);
					this.#clearManagedTimers();
					this.#setManagedLifecycle({ status: "execution-unknown", error });
					for (const pending of this.#pendingRequests.values()) pending.reject(error);
					this.#closeIrc(error.message);
					this.#pendingRequests.clear();
					// The peer announced cancellation, not completed cleanup. Keep
					// reading until its drain/park closes stdout; do not kill it here.
					return;
				}
				this.#renewManagedLease();
			}
			let id = data.id;
			if (this.options.expectManagedBootstrap) {
				id = data.correlationId;
				if (id === undefined && data.id !== undefined) {
					for (const [key, pending] of this.#pendingRequests) {
						if (pending.id !== data.id) continue;
						id = key;
						break;
					}
				}
			}
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
		}

		if (isManagedRunEventFrame(data)) {
			if (this.options.expectManagedBootstrap) {
				const event = parseManagedRunEvent(data);
				if (!event)
					throw new RpcClientError("protocol-incompatible", "Malformed managed run frame", data.type);
				const ownerPeerId = this.#irc.binding?.ownerPeerId;
				if (ownerPeerId && !this.#syncIrcBinding()) return;
				if (ownerPeerId && event.type === "managed_run_start") IrcBus.global().markRemoteRunStarted(ownerPeerId, event.runId);
				if (ownerPeerId) {
					const binding = this.#irc.binding;
					if (binding) {
						const observation: Extract<ManagedPeerFrame, { kind: "peer_state_changed" }> = {
							kind: "peer_state_changed", canonicalId: ownerPeerId, generation: binding.generation,
							state: event.type === "managed_run_start" ? "running" : "idle", runId: event.runId,
							...(event.type === "managed_run_end" && event.runStatusRevision !== undefined ?
								{ runStatusRevision: event.runStatusRevision } : {}),
						};
						this.#irc.observePeerState(observation);
						ManagedIrcObservationRelay.forRegistry(AgentRegistry.global()).publish(ownerPeerId, observation);
					}
				}
				for (const listener of this.#managedRunListeners) listener(event);
			}
			return;
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		if (isRpcSubagentLifecycleFrame(data)) {
			for (const listener of this.#subagentLifecycleListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentProgressFrame(data)) {
			for (const listener of this.#subagentProgressListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentEventFrame(data)) {
			for (const listener of this.#subagentEventListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcAvailableCommandsUpdateFrame(data)) {
			for (const listener of this.#availableCommandsUpdateListeners) {
				listener(data.commands);
			}
			return;
		}

		if (!isAgentSessionEvent(data)) return;

		for (const listener of this.#sessionEventListeners) {
			listener(data);
		}

		if (!isAgentEvent(data)) return;

		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#send(command: RpcCommandBody, timeoutMs = 30_000): Promise<RpcResponse> {
		if (this.options.expectManagedBootstrap && this.#managedLifecycle.status === "execution-unknown")
			throw this.#managedLifecycle.error;
		if (!this.#process?.stdin) {
			if (this.options.expectManagedBootstrap)
				throw new RpcClientError("connection-lost", "Client not started", command.type);
			throw new Error("Client not started");
		}

		const id = `req_${++this.#requestId}`;
		const correlationId = this.options.expectManagedBootstrap ? (command.correlationId ?? randomUUID()) : undefined;
		const key = correlationId ?? id;
		const fullCommand = {
			...command, id, ...(correlationId === undefined ? {} : { correlationId }),
		} as RpcCommand;
		if (this.#frameLimits && Buffer.byteLength(JSON.stringify(fullCommand), "utf8") + 1 > this.#frameLimits.maxReassembledFrameBytes)
			throw new RpcClientError("protocol-incompatible", "Managed command exceeds the negotiated logical frame limit", command.type);
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			this.#pendingRequests.delete(key);
			settled = true;
			reject(
				this.options.expectManagedBootstrap
					? new RpcClientError("timeout", `Timeout waiting for response to ${command.type}`, command.type)
					: new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});

		this.#pendingRequests.set(key, {
			id,
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				if (this.options.expectManagedBootstrap && !response.success) {
					reject(new RpcClientError(
						isRpcErrorCode(response.code) ? response.code : "protocol-incompatible",
						response.message ?? response.error, response.command,
					));
					return;
				}
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});

		const onWriteError = (err: Error) => {
			this.#pendingRequests.delete(key);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(this.options.expectManagedBootstrap
				? new RpcClientError("connection-lost", err.message, command.type)
				: err);
			if (this.options.expectManagedBootstrap) void this.#managedFailure?.(err);
		};
		if (this.options.expectManagedBootstrap) {
			try {
				this.#writeFrame(fullCommand, onWriteError);
			} catch (cause) {
				onWriteError(cause instanceof Error ? cause : new Error(String(cause)));
			}
		} else {
			this.#writeFrame(fullCommand, onWriteError);
		}
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#writeFrame(
		frame: RpcCommand | RpcResponse | RpcExtensionUIResponse | RpcHostToolResult | RpcHostToolUpdate | ManagedIrcWireFrame,
		onError?: (error: Error) => void,
	): void {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}
		const stdin = this.#process.stdin;
		if (this.options.expectManagedBootstrap) {
			for (const line of this.#managedEncoder.encodeFrames(frame)) stdin.write(line);
		} else {
			stdin.write(`${JSON.stringify(frame)}\n`);
		}
		if (!("flush" in stdin)) return;
		const sink = stdin as FileSink;
		const flushResult = sink.flush();
		if (isPromise(flushResult)) {
			flushResult.catch((err: Error) => {
				onError?.(err);
			});
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new RpcCommandError(errorResponse.error, errorResponse.command, errorResponse.code);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
