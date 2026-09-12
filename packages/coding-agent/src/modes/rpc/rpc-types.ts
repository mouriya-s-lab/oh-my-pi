/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
// Subpath import on purpose: the managed bootstrap loads this module before the
// profile `.env` is applied, so it must stay off the `@oh-my-pi/pi-utils` barrel
// (which eagerly imports `./env`). `type-guards` is dependency-free.
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { IrcEnvelope } from "../../irc/bus";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { FileEntry } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { EndpointControlAck, EndpointSnapshot } from "../../task/endpoint";
import type { ParamsError, RunContract } from "../../task/params";
import type { TodoPhase } from "../../tools/todo";
import type { RpcMessagesPage } from "./rpc-messages";

// ============================================================================
// Managed protocol envelope (RFC #1 §8 D4/D5)
// ============================================================================

/** Which conversation a managed request or response belongs to. */
export type RpcCorrelationScope = "peer" | "run" | "resource" | "control";

/**
 * Managed correlation envelope, intersected into every command and response.
 *
 * Every field is optional because a legacy peer sends none of them and a
 * managed peer mints its own identifiers. Whoever answers echoes exactly what
 * it received — the protocol never fabricates an identifier for a frame that
 * arrived without one — so a client that reads `correlationId` back knows the
 * frame belongs to its request even when `id` was reused.
 */
export interface RpcCorrelationFields {
	/** Client-minted correlation id; a UUID is preferred over matching `id`. */
	correlationId?: string;
	scope?: RpcCorrelationScope;
	/** Connection ownership generation; managed IRC rejects stale generations. */
	generation?: number;
	operationId?: string;
}

/** The managed error taxonomy (D4). Every managed failure carries exactly one of these codes. */
export type RpcErrorCode =
	| "authorization-denied"
	| "config-missing"
	| "protocol-incompatible"
	| "remote-execution-failed"
	| "user-cancelled"
	| "timeout"
	| "connection-lost"
	| "resource-unavailable";

const RPC_ERROR_CODES = new Set<string>([
	"authorization-denied",
	"config-missing",
	"protocol-incompatible",
	"remote-execution-failed",
	"user-cancelled",
	"timeout",
	"connection-lost",
	"resource-unavailable",
]);

/** Narrow an untrusted `code` to the managed taxonomy; a legacy free-form code fails it. */
export function isRpcErrorCode(value: unknown): value is RpcErrorCode {
	return typeof value === "string" && RPC_ERROR_CODES.has(value);
}

/**
 * Read the correlation envelope (and the legacy `id`) off an untrusted frame.
 *
 * The single reader both ends use to echo what they received: an answer carries
 * exactly the identifiers that arrived — none invented, none dropped — so a
 * client matching on `correlationId` never sees a frame that lost its owner.
 * Malformed fields are omitted rather than passed through.
 */
export function readRpcCorrelation(value: unknown): RpcCorrelationFields & { id?: string } {
	if (!isRecord(value)) return {};
	return {
		...(typeof value.id === "string" ? { id: value.id } : {}),
		...(typeof value.correlationId === "string" ? { correlationId: value.correlationId } : {}),
		...(value.scope === "peer" || value.scope === "run" || value.scope === "resource" || value.scope === "control"
			? { scope: value.scope }
			: {}),
		...(typeof value.generation === "number" && Number.isFinite(value.generation)
			? { generation: value.generation }
			: {}),
		...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
	};
}

/**
 * Frame-size limits negotiated once per connection (D4). Each end advertises
 * its own values and both ends run the smaller value per field, so a frame is
 * only ever sent when both ends can carry it.
 */
export interface RpcFrameLimits {
	/** Maximum UTF-8 size of one newline-delimited physical frame, newline included. */
	maxFrameBytes: number;
	/** Maximum UTF-8 size of one logical frame reassembled from `rpc_chunk` frames. */
	maxReassembledFrameBytes: number;
	/** Maximum payload bytes one resource chunk may carry. */
	maxResourceChunkBytes: number;
}

/**
 * Managed bootstrap context a peer applies before it builds any session state.
 *
 * The client sends these on `prepare` and the server echoes exactly the fields
 * it applied, so "the request was sent" and "the request took effect" stay
 * distinguishable. A field the request carried but the answer omitted means
 * the peer ignored it; a client treats that as protocol-incompatible instead of
 * assuming relocation happened.
 */
export interface RpcPrepareOptions {
	/** Remote working directory to enter; absolute and existing on the peer host. */
	cwd?: string;
	/** Profile to activate through the peer's profile mechanism. */
	profile?: string;
	/** Agent definition the peer resolved for the session. */
	agent?: string;
	/** Canonical remote identity and its explicitly authorized descendants. */
	ircBinding?: ManagedIrcBinding;
	/** Coordinator sender scope, independent of the remote runtime's identity. */
	coordinatorBinding?: ManagedIrcBinding;
}

/**
 * `prepare` acknowledgement: the negotiated lease pair plus the bootstrap
 * context the peer actually applied. The applied fields echo what the peer
 * resolved, which may be a canonical form of the request (normalized profile
 * name, canonical directory path), including defaults the peer selected when
 * optional request fields were omitted. The client never fabricates them.
 */
export interface RpcPrepareResult extends RpcPrepareOptions {
	heartbeatSeconds: number;
	leaseSeconds: number;
}

/** One managed capability flag; a declaration enumerates the whole set (D5). */
export type NativeAgentCapability =
	| "sessionControl"
	| "peerRoster"
	| "replyQuiescence"
	| "outputContract"
	| "workpoolBinding"
	| "heartbeat"
	| "lease"
	| "resumeOwnership"
	| "errorTaxonomy"
	| "ircBidirectional"
	| "resultResource"
	| "interactionUi"
	| "isolatedWorkspace"
	| "hostCallbacks";

/**
 * The complete capability set a managed build declares.
 *
 * Flags are numeric — `1` implemented, `0` not — because the set is wire data a
 * peer parses without trusting JSON truthiness: `0` is present and explicit,
 * and only those two values are ever valid.
 *
 * Every flag is present, so a reader never confuses "not implemented" with
 * "field missing". The ten flags this slice's protocol major requires are
 * pinned to the literal `1`: a declaration that reports `0` for one of them is
 * not a weaker peer, it is a peer that cannot speak this protocol, and the type
 * system and {@link isNativeAgentCapabilitySet} both refuse it. The four
 * channel flags owned by later slices are `0 | 1`.
 */
export interface NativeAgentCapabilitySet {
	readonly sessionControl: 1;
	readonly peerRoster: 1;
	readonly ircBidirectional: 1;
	readonly replyQuiescence: 1;
	readonly resultResource: 0 | 1;
	readonly interactionUi: 0 | 1;
	readonly outputContract: 1;
	readonly workpoolBinding: 1;
	readonly isolatedWorkspace: 0 | 1;
	readonly hostCallbacks: 0 | 1;
	readonly heartbeat: 1;
	readonly lease: 1;
	readonly resumeOwnership: 1;
	readonly errorTaxonomy: 1;
}

/**
 * The capability set this slice's managed build declares: the one source of
 * truth for the flags, so the ready frame a server emits and the flags a client
 * requires can never drift apart. A receiver checks the flag it needs and stops
 * when it is `0`, so an unimplemented channel is never mistaken for an
 * available one.
 */
export const MANAGED_NATIVE_AGENT_CAPABILITIES: NativeAgentCapabilitySet = {
	sessionControl: 1,
	peerRoster: 1,
	replyQuiescence: 1,
	outputContract: 1,
	workpoolBinding: 1,
	heartbeat: 1,
	lease: 1,
	resumeOwnership: 1,
	errorTaxonomy: 1,
	ircBidirectional: 1,
	// Deferred to their owning slices; declared `0` rather than omitted, so a peer
	// reads them as "not available" instead of "unknown".
	resultResource: 0,
	interactionUi: 0,
	isolatedWorkspace: 0,
	hostCallbacks: 0,
};

/** Flags protocol major 1 requires: a declaration reporting `0` for any of these is refused. */
const REQUIRED_NATIVE_AGENT_CAPABILITIES = [
	"sessionControl",
	"peerRoster",
	"ircBidirectional",
	"replyQuiescence",
	"outputContract",
	"workpoolBinding",
	"heartbeat",
	"lease",
	"resumeOwnership",
	"errorTaxonomy",
] as const;

/** Channel flags owned by later slices; both `0` and `1` are valid declarations. */
const OPTIONAL_NATIVE_AGENT_CAPABILITIES = [
	"resultResource",
	"interactionUi",
	"isolatedWorkspace",
	"hostCallbacks",
] as const;

/**
 * Accept a declaration's capability set only when it can actually be one: every
 * flag present, each strictly `0` or `1`, and every required flag `1`.
 *
 * A missing flag, a boolean, or an out-of-range value fails — but so does a
 * `0` on a required flag, which is the case that matters. Such a peer is not
 * partially capable of protocol major 1; it cannot run it, and admitting it
 * would turn "stop at the handshake" into a failure discovered mid-run.
 */
export function isNativeAgentCapabilitySet(value: unknown): value is NativeAgentCapabilitySet {
	if (!isRecord(value)) return false;
	for (const capability of REQUIRED_NATIVE_AGENT_CAPABILITIES) {
		if (value[capability] !== 1) return false;
	}
	for (const capability of OPTIONAL_NATIVE_AGENT_CAPABILITIES) {
		const flag = value[capability];
		if (flag !== 0 && flag !== 1) return false;
	}
	return true;
}

/** An authenticated connection scope, never a display-name authority. */
export interface ManagedIrcBinding {
	ownerPeerId: string;
	generation: number;
	allowedDescendants: string[];
}

export function parseManagedIrcBinding(value: unknown): ManagedIrcBinding | undefined {
	if (!isRecord(value) || typeof value.ownerPeerId !== "string" || !value.ownerPeerId ||
		value.ownerPeerId.includes("\0") || typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) || value.generation < 0 ||
		!Array.isArray(value.allowedDescendants) ||
		!value.allowedDescendants.every((id: unknown) => typeof id === "string" && id.length > 0 && !id.includes("\0"))) return undefined;
	return { ownerPeerId: value.ownerPeerId, generation: value.generation, allowedDescendants: [...value.allowedDescendants] };
}

export interface ManagedIrcDeliveryOptions {
	operationId: string;
	generation: number;
	expectsReply?: boolean;
	suppressRelay?: boolean;
	wake?: boolean;
}

export type ManagedControlOrUi =
	| Extract<RpcCommand, { type: "get_state" | "abort" | "abort_bash" | "heartbeat" | "cancel_run" | "terminate" | "park" | "resume" }>
	| RpcExtensionUIResponse
	| RpcHostToolResult
	| RpcHostToolUpdate
	| RpcHostUriResult;

export type ManagedIrcFrame =
	| { kind: "peer_registration_request"; nativeId: string; parentId: string; displayName: string; roles: readonly string[]; generation: number }
	| { kind: "peer_registered"; canonicalId: string; parentId?: string; displayName: string; roles: readonly string[]; generation: number }
	| { kind: "peer_deregistered"; canonicalId: string; generation: number }
	| { kind: "peer_state_changed"; canonicalId: string; state: "running" | "idle" | "parked" | "execution-unknown"; generation: number; runId?: string; runStatusRevision?: number }
	| { kind: "irc_delivery"; envelope: IrcEnvelope; operationId: string; expectsReply?: boolean; suppressRelay?: boolean; wake?: boolean }
	| { kind: "irc_receipt"; operationId: string; outcome: "injected" | "woken" | "revived" | "failed" | "indeterminate"; reason?: string }
	| { kind: "reply_drained_barrier"; runId: string; runStatusRevision: number; outboundWatermark: number; peerId?: string }
	| { kind: "control_or_ui"; payload: ManagedControlOrUi };

export type ManagedPeerFrame = Extract<ManagedIrcFrame, { kind: "peer_registered" | "peer_deregistered" | "peer_state_changed" }>;
export type ManagedPeerRegistrationRequest = Extract<ManagedIrcFrame, { kind: "peer_registration_request" }>;
export type ReplyDrainedBarrier = Extract<ManagedIrcFrame, { kind: "reply_drained_barrier" }>;
export type ManagedIrcWireFrame = RpcCorrelationFields & {
	id?: string;
	type: "managed_irc";
	generation: number;
	frame: ManagedIrcFrame;
};

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

type RpcCommandVariants =
	// Protocol
	| {
			id?: string;
			type: "negotiate_protocol";
			protocolVersion: number;
			/** Managed peers propose their own frame limits; legacy peers omit all three fields. */
			maxFrameBytes?: number;
			maxReassembledFrameBytes?: number;
			maxResourceChunkBytes?: number;
	  }

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "start"; message: string; contract?: RunContract }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }

	// Managed control (D4): heartbeat, cancel, terminate, park and resume bypass
	// the serialized command queue so a long run cannot block them.
	| {
			id?: string;
			type: "prepare";
			heartbeatSeconds?: number;
			leaseSeconds?: number;
			/** Bootstrap context to apply; omitted by a legacy client and by a client needing no relocation. */
			cwd?: string;
			profile?: string;
			agent?: string;
			ircBinding?: ManagedIrcBinding;
			coordinatorBinding?: ManagedIrcBinding;
	  }
	| { id?: string; type: "heartbeat" }
	| { id?: string; type: "cancel_run"; runId: string }
	| { id?: string; type: "terminate"; peerId?: string }
	| { id?: string; type: "park"; runId: string }
	| { id?: string; type: "resume"; reference: string; expectedRunId?: string };

/**
 * Every command may carry the managed correlation envelope; a legacy client
 * omits it entirely, and an answer echoes back exactly the fields received.
 */
export type RpcCommand = RpcCommandVariants & RpcCorrelationFields;

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** Managed-only current run views; absent from legacy state frames. */
	managedRuns?: EndpointSnapshot[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface NativeAgentReadyDeclaration {
	/** Native-agent protocol major (see RFC #1 §8 D5). This slice ships major = 1. */
	protocolMajor: 1;
	/** Capabilities implemented in this build, enumerated in full. */
	capabilities: NativeAgentCapabilitySet;
	/**
	 * Application version, advisory only: diagnostics and logs. Compatibility is
	 * decided by `protocolMajor` plus the capability set, never by this string.
	 */
	applicationVersion?: string;
	/** Lease durations this build proposes; `prepare` confirms the exact pair. */
	proposed?: { heartbeatSeconds: number; leaseSeconds: number };
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
	/**
	 * Managed-bootstrap-only, like {@link RpcReadyFrame.nativeAgent}: emitted when
	 * the server declares the managed capability set, absent for legacy
	 * `--mode rpc`, so the legacy ready frame keeps its exact byte shape.
	 */
	maxResourceChunkBytes?: number;
	/** Managed-bootstrap-only. Absent for legacy `--mode rpc`. */
	nativeAgent?: NativeAgentReadyDeclaration;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

/**
 * The managed error response: `message` and `code` are both required, and `code`
 * is always one of the eight {@link RpcErrorCode} entries. A managed client can
 * therefore classify a failure by code alone instead of parsing prose, and
 * "unclassified failure" is a shape the protocol cannot produce.
 *
 * Legacy servers keep the looser variant at the end of {@link RpcResponse}: it
 * carries `error` only, with an optional free-form `code`.
 */
export type RpcManagedErrorResponse = {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string;
	message: string;
	code: RpcErrorCode;
	paramsError?: ParamsError;
};

/**
 * Verdict of `cancel_run`: `cancelled` means the run's work was cancelled and
 * its replies drained; `cleanup-unconfirmed` is an explicit failure to confirm
 * cleanup within the grace window, never a slow success.
 */
export type RpcCancelRunResult =
	| { status: "cancelled"; replyDrained: true }
	| { status: "cleanup-unconfirmed"; detail: string };

/**
 * Verdict of `resume`: `still-owned` refuses to open a second logical session
 * while the previous owner is alive or its cleanup is unfinished; `reopened`
 * hands back the same run's snapshot.
 */
export type RpcResumeResult =
	| { status: "still-owned"; detail: string }
	| { status: "reopened"; snapshot: EndpointSnapshot; runId: string };

// Success responses with data
type RpcResponseVariants =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: {
				protocolVersion: 2;
				/** Frame limits the server agreed to; absent for a peer that proposed none. */
				maxFrameBytes?: number;
				maxReassembledFrameBytes?: number;
				maxResourceChunkBytes?: number;
			};
	  }

	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "start"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }

	// Managed control (D4)
	| { id?: string; type: "response"; command: "managed_irc"; success: true; data: { accepted: true; operationId?: string } }
	| {
			id?: string;
			type: "response";
			command: "prepare";
			success: true;
			data: RpcPrepareResult;
	  }
	| { id?: string; type: "response"; command: "heartbeat"; success: true }
	| { id?: string; type: "response"; command: "cancel_run"; success: true; data: RpcCancelRunResult }
	| { id?: string; type: "response"; command: "terminate"; success: true; data: { acknowledged: true } }
	| { id?: string; type: "response"; command: "park"; success: true; data: EndpointControlAck }
	| { id?: string; type: "response"; command: "resume"; success: true; data: RpcResumeResult }

	// Error response (any command can fail). `error` remains the legacy
	// human-readable field; `message` repeats it for managed peers, and `code` is
	// optional because a legacy server may send a free-form reason while a
	// managed server always sends an {@link RpcErrorCode}.
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			message?: string;
			code?: string;
			paramsError?: ParamsError;
	  }

	// Managed error (any command, when the peer speaks the managed protocol)
	| RpcManagedErrorResponse;

/**
 * Every response may carry the managed correlation envelope, echoed from the
 * request that caused it; a server never mints identifiers of its own.
 */
export type RpcResponse = RpcResponseVariants & RpcCorrelationFields;

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame;

// ============================================================================
// Managed Run Events (stdout)
// ============================================================================

/**
 * One boundary of a managed run, exactly as the server emits it: the start
 * frame opening a run and the terminal frame closing one.
 *
 * `runId` is the server-minted identifier the peer's endpoint returned; the
 * client forwards it verbatim and never mints or rewrites one, so a consumer
 * addressing a run by this id reaches the same run the server tracks. The start
 * frame echoes the correlation envelope of the command that caused the run,
 * mirrored by {@link readRpcCorrelation} like every other managed frame.
 *
 * Terminal status does not drain IRC replies. Managed peers emit `false` with
 * the terminal revision, then a separate reply_drained_barrier after outbound
 * receipts settle. `true` remains readable for older non-IRC event consumers.
 */
export type RpcManagedRunEvent =
	| ({
			type: "managed_run_start";
			runId: string;
			command: "bash" | "prompt";
	  } & RpcCorrelationFields & { id?: string })
	| {
			type: "managed_run_end";
			runId: string;
			status: "completed" | "failed" | "cancelled";
			replyDrained: boolean;
			runStatusRevision?: number;
			remoteArtifacts?: { repoRef: string; branch?: string; patchRef?: string };
			paramsError?: ParamsError;
	  };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================
/** Positional presentation metadata for an RPC select option. */
export interface RpcExtensionUISelectOptionDetail {
	description?: string;
}

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			optionDetails?: RpcExtensionUISelectOptionDetail[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
