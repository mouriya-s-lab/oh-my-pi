/**
 * Shared in-memory harness for the issue #11 bidirectional IRC acceptance rows.
 *
 * One real {@link RpcClient} (the local coordinator's runtime) is joined to one
 * fixture server by a byte loopback: every frame the client writes is parsed by
 * the real `RpcFrameDecoder` and handed to the real managed
 * {@link RpcInputDispatcher}, whose `onManagedIrcFrame` dependency drives the
 * production {@link ManagedIrcChannel}. Server frames are encoded by the real
 * `RpcFrameEncoder` and reach the client through its real JSONL reader, so the
 * rows observe decoder- and frame-level facts instead of a test-local protocol.
 *
 * Both runtimes own a real {@link IrcBus} over their own {@link AgentRegistry};
 * peers are registered with recording sessions, the local coordinator reaches
 * the remote runtime through the production {@link SshBackendEndpoint} adapter
 * over a non-SSH transport fixture, and every frame either direction lands in
 * {@link LoopbackTranscript} for PR evidence.
 */

import { IrcBus, type DeliveryResult, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type IrcInboundListener, ManagedIrcChannel } from "@oh-my-pi/pi-coding-agent/modes/rpc/managed-irc";
import {
	DEFAULT_RPC_FRAME_LIMITS,
	negotiateRpcFrameLimits,
	RpcFrameDecoder,
	RpcFrameEncoder,
	type RpcFrameLimits,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	createRpcReadyFrame,
	RpcInputDispatcher,
	type PendingExtensionRequest,
	type RpcInputFrameDeps,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	parseManagedIrcBinding,
	type ManagedIrcBinding,
	type ManagedPeerFrame,
	type ReplyDrainedBarrier,
	type RpcCommand,
	type RpcResponse,
	type RpcSessionState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type AgentKind, type AgentStatus } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { PrepareResult } from "@oh-my-pi/pi-coding-agent/task/endpoint";
import { isRecord, withTimeout } from "@oh-my-pi/pi-utils";
import { SshBackendEndpoint } from "../../../../fork-features/ssh-remote-backend/endpoint";
import type { SshBackendTransport } from "../../../../fork-features/ssh-remote-backend/transport";

/** Native name both runtimes use for their own root; routing never keys on it. */
export const NATIVE_ROOT = "Main";
/** Coordinator scopes that keep the two native roots apart. */
export const LOCAL_SCOPE = "local";
export const REMOTE_SCOPE = "remote";

/** One frame observed on the loopback, in the direction it travelled. */
export interface LoopbackFrame {
	direction: "client->server" | "server->client";
	frame: unknown;
}

/**
 * Ordered frame log for the rows. {@link LoopbackTranscript.print} renders the
 * compact, stable transcript the parent quotes in PR evidence; it only writes
 * when `IRC_ACCEPTANCE_TRANSCRIPT=1` is set, so normal runs stay quiet.
 */
export class LoopbackTranscript {
	readonly frames: LoopbackFrame[] = [];

	record(direction: LoopbackFrame["direction"], frame: unknown): void {
		this.frames.push({ direction, frame });
		if (direction === "server->client" && isDeniedManagedIrcResponse(frame)) {
			this.denied.push({ code: typeof frame.code === "string" ? frame.code : undefined, frame });
		}
		for (const waiter of [...this.#frameWaiters]) waiter();
	}

	/** Managed `authorization-denied` responses observed, newest last. */
	readonly denied: { code: string | undefined; frame: unknown }[] = [];
	readonly #frameWaiters = new Set<() => void>();

	/** Await an observed frame with a bounded deadline; optionally include existing frames. */
	waitForFrame(predicate: (entry: LoopbackFrame) => boolean, after = this.frames.length, timeoutMs = 2_000): Promise<LoopbackFrame> {
		const deferred = Promise.withResolvers<LoopbackFrame>();
		const cleanup = (): void => { this.#frameWaiters.delete(check); };
		const check = (): void => {
			const entry = this.frames.slice(after).find(predicate);
			if (!entry) return;
			cleanup();
			deferred.resolve(entry);
		};
		const result = withTimeout(deferred.promise, timeoutMs, "Timed out awaiting loopback frame").finally(cleanup);
		this.#frameWaiters.add(check);
		check();
		return result;
	}

	nextDenied(): Promise<{ code: string | undefined; frame: unknown }> {
		return this.waitForFrame(entry => entry.direction === "server->client" && isDeniedManagedIrcResponse(entry.frame))
			.then(({ frame }) => ({ code: isRecord(frame) && typeof frame.code === "string" ? frame.code : undefined, frame }));
	}

	/** Frame-kind sequence, e.g. `client->server:managed_irc/irc_delivery`. */
	kinds(): string[] {
		return this.frames.map(entry => `${entry.direction}:${describeLoopbackFrame(entry.frame)}`);
	}

	lines(): string[] {
		return this.frames.map((entry, index) => `${index + 1}. ${entry.direction} ${describeLoopbackFrame(entry.frame)}`);
	}

	print(label: string): void {
		if (Bun.env.IRC_ACCEPTANCE_TRANSCRIPT !== "1") return;
		process.stdout.write(`\n[irc transcript] ${label}\n${this.lines().join("\n")}\n`);
	}
}

/** Whether a server frame is the managed refusal of one IRC wire frame. */
export function isDeniedManagedIrcResponse(frame: unknown): frame is { code?: string } {
	if (!isRecord(frame)) return false;
	return frame.type === "response" && frame.command === "managed_irc" && frame.success === false;
}

/** The inner `kind` of a managed IRC wire frame, or `undefined` for anything else. */
export function managedIrcFrameKind(frame: unknown): string | undefined {
	if (!isRecord(frame) || frame.type !== "managed_irc" || !isRecord(frame.frame)) return undefined;
	return typeof frame.frame.kind === "string" ? frame.frame.kind : undefined;
}

/** The IRC envelope carried by an `irc_delivery` wire frame. */
export function deliveredEnvelope(frame: unknown): IrcMessage | undefined {
	if (!isRecord(frame) || managedIrcFrameKind(frame) !== "irc_delivery" || !isRecord(frame.frame)) return undefined;
	const envelope = frame.frame.envelope;
	if (!isRecord(envelope)) return undefined;
	return envelope as unknown as IrcMessage;
}

/** Inner discriminant of a managed IRC frame, read for transcript display only. */
function innerKind(frame: Record<string, unknown>): string {
	const inner = frame.frame;
	if (!isRecord(inner)) return "?";
	const kind = inner.kind ?? inner.type;
	return typeof kind === "string" ? kind : "?";
}

function envelopeField(envelope: unknown, key: keyof IrcMessage): string {
	if (!isRecord(envelope)) return "?";
	const value = envelope[key];
	return value === undefined ? "-" : String(value);
}

/** Compact, stable description of one frame for transcripts. */
export function describeLoopbackFrame(frame: unknown): string {
	if (!isRecord(frame)) return JSON.stringify(frame);
	const type = frame.type;
	if (type === "managed_irc") {
		const inner = frame.frame;
		const kind = innerKind(frame);
		const detail =
			isRecord(inner) && kind === "irc_delivery"
				? `id=${envelopeField(inner.envelope, "id")} ts=${envelopeField(inner.envelope, "ts")} from=${envelopeField(inner.envelope, "from")} to=${envelopeField(inner.envelope, "to")} op=${String(inner.operationId)}`
				: isRecord(inner) && kind === "irc_receipt"
					? `op=${String(inner.operationId)} outcome=${String(inner.outcome)}`
					: isRecord(inner) && kind === "reply_drained_barrier"
						? `run=${String(inner.runId)} runStatusRevision=${String(inner.runStatusRevision)} outboundWatermark=${String(inner.outboundWatermark)}`
						: isRecord(inner) && kind === "peer_registered"
							? `canonicalId=${String(inner.canonicalId)}`
							: "";
		return `managed_irc/${kind}${detail ? ` ${detail}` : ""}`;
	}
	if (type === "response" && frame.command === "managed_irc") {
		const operationId = isRecord(frame.data) ? frame.data.operationId : undefined;
		return `response/managed_irc ${frame.success === true ? "accepted" : `denied(${String(frame.code)})`}${operationId === undefined ? "" : ` op=${String(operationId)}`}`;
	}
	if (type === "response") return `response/${String(frame.command)} ${frame.success === true ? "ok" : "error"}`;
	if (type === "managed_run_start" || type === "managed_run_end") {
		return `${type} ${String(frame.runId)} ${String(frame.status ?? "")}`.trim();
	}
	return String(type);
}

/** A recording stand-in for one live `AgentSession` registered in a runtime. */
export class RecordingIrcSession {
	readonly delivered: IrcMessage[] = [];
	readonly relayed: CustomMessage[] = [];
	/** What `deliverIrcMessage` reports to the bus (busy aside vs idle wake). */
	outcome: "injected" | "woken" = "injected";
	/** When set, the next delivery throws instead of recording. */
	failWith: Error | null = null;
	/** When set, a delivery waits on it before recording (a peer still working). */
	gate: Promise<void> | null = null;
	isStreaming = true;
	onDeliver: ((message: IrcMessage) => void) | undefined;
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
	readonly #replies = Promise.withResolvers<void>();

	constructor() {
		this.#replies.resolve();
	}

	async deliverIrcMessage(message: IrcMessage): Promise<"injected" | "woken"> {
		if (this.failWith) {
			const failure = this.failWith;
			this.failWith = null;
			throw failure;
		}
		if (this.gate) await this.gate;
		this.delivered.push(message);
		this.onDeliver?.(message);
		return this.outcome;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	waitForIrcReplies(): Promise<void> {
		return this.#replies.promise;
	}

	trackIrcReply(): void {}

	emitIrcRelayObservation(record: CustomMessage): void {
		this.relayed.push(record);
	}

	drainPendingIrcInboxMessages(): IrcMessage[] {
		return [];
	}

	/** Emit the session's terminal `agent_end` to subscribers (the bus waiter's stop signal). */
	endTurn(): void {
		const event = { type: "agent_end", messages: [], isTerminal: true } as unknown as AgentSessionEvent;
		for (const listener of [...this.#listeners]) listener(event);
	}

	readonly asSession = this as unknown as AgentSession;
}

/**
 * One runtime: its registry, bus and recorded sessions.
 *
 * The local runtime is built on the process globals, because the production
 * `RpcClient` publishes its peer refs and IRC routes into `AgentRegistry.global()`
 * and `IrcBus.global()`; the remote runtime gets private ones so two runtimes can
 * exist in one test process without sharing a roster.
 */
export class IrcRuntime {
	readonly registry: AgentRegistry;
	readonly bus: IrcBus;
	readonly sessions = new Map<string, RecordingIrcSession>();

	constructor(registry: AgentRegistry = new AgentRegistry(), bus?: IrcBus) {
		this.registry = registry;
		this.bus = bus ?? new IrcBus(registry);
	}

	registerLocalPeer(options: {
		id: string;
		kind: AgentKind;
		parentId?: string;
		status?: AgentStatus;
		displayName?: string;
	}): RecordingIrcSession {
		const session = new RecordingIrcSession();
		this.sessions.set(options.id, session);
		this.registry.register({
			id: options.id,
			displayName: options.displayName ?? options.id,
			kind: options.kind,
			parentId: options.parentId,
			status: options.status ?? "running",
			endpoint: { kind: "local", session: session.asSession, sessionFile: null },
		});
		return session;
	}

	registerRemoteRoute(options: { id: string; displayName: string; reference: string; status?: AgentStatus; kind?: AgentKind }): void {
		this.registry.register({
			id: options.id,
			displayName: options.displayName,
			kind: options.kind ?? "sub",
			status: options.status ?? "running",
			endpoint: { kind: "remote", reference: options.reference, endpoint: null },
		});
	}

	sessionFor(id: string): RecordingIrcSession {
		const session = this.sessions.get(id);
		if (!session) throw new Error(`No recording session for ${id}`);
		return session;
	}
}

const IDLE_STATE: RpcSessionState = {
	thinkingLevel: undefined,
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "irc-fixture",
	autoCompactionEnabled: false,
	fastModeEnabled: false,
	fastModeActive: false,
	tokensPerSecond: null,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
};

export interface LoopbackServerOptions {
	/** Where an accepted inbound envelope is delivered (the peer runtime's bus). */
	inbound: IrcInboundListener;
	onPeerFrame?: (frame: ManagedPeerFrame) => void;
	onReplyDrainedBarrier?: (frame: ReplyDrainedBarrier) => void;
	/** Server frame limits advertised in the ready frame; the client negotiates against them. */
	limits?: RpcFrameLimits;
	/** Leave the channel unbound: every inbound frame must be refused as authorization-denied. */
	unbound?: boolean;
	/** Announce a `managed_run_start` after each accepted `prompt`. */
	autoStartRuns?: boolean;
}

/**
 * The remote runtime's end of one managed connection: a real
 * {@link RpcInputDispatcher} in managed mode whose `onManagedIrcFrame`
 * dependency runs the production {@link ManagedIrcChannel}, plus the bootstrap
 * responses a real RPC-mode server sends before any session work.
 */
export class LoopbackManagedServer {
	readonly channel: ManagedIrcChannel;
	readonly dispatcher: RpcInputDispatcher;
	readonly process: RpcAgentProcess;
	/** Every command the client sent, in order. */
	readonly commands: RpcCommand[] = [];
	readonly transcript: LoopbackTranscript;
	readonly limits: RpcFrameLimits;
	/** Bootstrap commands the fixture answered itself, for assertions. */
	readonly prepared: RpcCommand[] = [];
	/** Run ids this fixture announced, newest last. */
	readonly runIds: string[] = [];
	/** Drop inbound delivery frames without acknowledging them (an unreachable peer). */
	dropDeliveries = false;
	readonly #encoder = new RpcFrameEncoder();
	readonly #decoder = new RpcFrameDecoder();
	readonly #exit = Promise.withResolvers<number>();
	readonly #tracked = new Set<Promise<void>>();
	readonly #options: LoopbackServerOptions;
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#closed = false;
	#runCounter = 0;
	#bindWhenPrepared: boolean;

	constructor(options: LoopbackServerOptions, transcript: LoopbackTranscript) {
		this.#options = options;
		this.transcript = transcript;
		this.limits = options.limits ?? DEFAULT_RPC_FRAME_LIMITS;
		this.#bindWhenPrepared = options.unbound !== true;
		this.channel = new ManagedIrcChannel({
			allowPeerRegistration: true,
			output: frame => this.emit(frame),
			inbound: (envelope, delivery) => options.inbound(envelope, delivery),
			onPeerFrame: options.onPeerFrame,
			onReplyDrainedBarrier: options.onReplyDrainedBarrier,
		});
		const deps: RpcInputFrameDeps = {
			handleCommand: command => this.#handleCommand(command),
			output: frame => this.emit(frame),
			errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
			pendingExtensionRequests: new Map<string, PendingExtensionRequest>(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
			managed: true,
			onManagedIrcFrame: frame => this.channel.handleFrame(frame),
			onManagedIrcResponse: response => { this.channel.handleResponse(response); },
			trackBackgroundTask: task => this.#track(task),
		};
		this.dispatcher = new RpcInputDispatcher({ deps, managed: true });

		const stdout = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
				controller.enqueue(new TextEncoder().encode(`${JSON.stringify(createRpcReadyFrame(true))}\n`));
			},
			cancel: () => {
				this.#closed = true;
			},
		});
		this.process = {
			stdin: { write: data => this.receive(data) },
			stdout,
			peekStderr: () => "",
			kill: () => this.close(),
			exited: this.#exit.promise,
		};
	}

	#track(task: Promise<void>): void {
		this.#tracked.add(task);
		void task.then(
			() => this.#tracked.delete(task),
			() => this.#tracked.delete(task),
		);
	}

	/** Wait for every background (IRC/control) task the dispatcher started. */
	async drain(): Promise<void> {
		while (this.#tracked.size > 0) {
			await Promise.allSettled([...this.#tracked]);
		}
		await this.dispatcher.drain();
	}

	/** Accept one client write: real JSONL framing, real dispatcher routing. */
	receive(data: string | Uint8Array): void {
		const text = typeof data === "string" ? data : new TextDecoder().decode(data);
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			const parsed: unknown = JSON.parse(line);
			const decoded = this.#decoder.push(parsed);
			if (decoded === undefined) continue;
			this.transcript.record("client->server", decoded);
			if (isRecord(decoded) && typeof decoded.type === "string") {
				this.commands.push(decoded as unknown as RpcCommand);
				if (this.#bindWhenPrepared && decoded.type === "prepare") {
					this.#bindWhenPrepared = false;
					const binding = parseManagedIrcBinding(decoded.coordinatorBinding);
					if (binding) this.channel.bind(binding);
				}
			}
			if (this.dropDeliveries && isRecord(decoded) && decoded.type === "managed_irc" && innerKind(decoded) === "irc_delivery") {
				continue;
			}
			this.dispatcher.dispatch(decoded);
		}
	}

	/** Write a raw JSON frame into the server's input path, bypassing the client. */
	receiveRaw(frame: object): void {
		this.receive(`${JSON.stringify(frame)}\n`);
	}

	/** One managed IRC wire frame addressed to this server, as a peer would write it. */
	managedWire(generation: number, frame: object): object {
		return { type: "managed_irc", generation, frame };
	}

	/** Await every dispatcher task started so far, so tests observe settled effects. */
	async settle(): Promise<void> {
		do {
			await this.drain();
			await Bun.sleep(0);
		} while (this.#tracked.size > 0);
	}

	/** Encode one server frame and hand it to the client's reader. */
	emit(frame: object): void {
		this.transcript.record("server->client", frame);
		if (this.#closed || !this.#controller) return;
		for (const line of this.#encoder.encodeFrames(frame)) {
			this.#controller.enqueue(new TextEncoder().encode(line));
		}
	}

	/** Announce a run boundary the way the real server does. */
	emitRunStart(runId: string): void {
		this.emit({ type: "managed_run_start", runId, command: "prompt" });
	}

	emitRunEnd(
		runId: string,
		status: "completed" | "failed" | "cancelled",
		runStatusRevision = 1,
		replyDrained = false,
	): void {
		this.emit({ type: "managed_run_end", runId, status, runStatusRevision, replyDrained });
	}

	/** The peer's independent reply-drained barrier, with both watermark facts. */
	emitReplyDrainedBarrier(runId: string, runStatusRevision: number, outboundWatermark: number, peerId?: string): void {
		this.emit({
			type: "managed_irc",
			generation: this.channel.binding?.generation ?? 0,
			frame: { kind: "reply_drained_barrier", runId, runStatusRevision, outboundWatermark,
				...(peerId === undefined ? {} : { peerId }) },
		});
	}

	/** One peer-registration frame from the peer runtime's roster. */
	emitPeerRegistered(canonicalId: string, displayName: string): void {
		this.emit({
			type: "managed_irc",
			generation: this.channel.binding?.generation ?? 0,
			frame: { kind: "peer_registered", canonicalId, displayName, roles: [], generation: this.channel.binding?.generation ?? 0 },
		});
	}

	async #handleCommand(command: RpcCommand): Promise<RpcResponse> {
		switch (command.type) {
			case "negotiate_protocol": {
				const limits = negotiateRpcFrameLimits(command, this.limits);
				this.#decoder.setLimits(limits);
				this.#encoder.setLimits(limits);
				this.#encoder.setProtocolVersion(2);
				this.#encoder.setManagedEnvelope(true);
				return { type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2, ...limits } };
			}
			case "prepare": {
				this.prepared.push(command);
				return {
					type: "response",
					command: "prepare",
					success: true,
					data: {
						heartbeatSeconds: command.heartbeatSeconds ?? 10,
						leaseSeconds: command.leaseSeconds ?? 30,
						...(command.ircBinding === undefined ? {} : { ircBinding: command.ircBinding }),
						...(command.coordinatorBinding === undefined ? {} : { coordinatorBinding: command.coordinatorBinding }),
					},
				};
			}
			case "heartbeat":
				return { type: "response", command: "heartbeat", success: true };
			case "get_state":
				return { type: "response", command: "get_state", success: true, data: IDLE_STATE };
			case "prompt": {
				const runId = `run:${++this.#runCounter}`;
				this.runIds.push(runId);
				if (this.#options.autoStartRuns !== false) {
					queueMicrotask(() => this.emitRunStart(runId));
				}
				return { type: "response", command: "prompt", success: true };
			}
			default:
				return { type: "response", command: command.type, success: false, error: `unexpected ${command.type}` };
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#exit.resolve(0);
		try {
			this.#controller?.close();
		} catch {
			// Already closed by the reader's cancel path.
		}
	}
}

/** Non-SSH `SshBackendTransport` fixture: the production adapter over the real client. */
export class LoopbackTransportFixture implements SshBackendTransport {
	readonly client: RpcClient;
	readonly exited: Promise<number>;
	readonly #exit = Promise.withResolvers<number>();
	readonly #close: () => Promise<void>;

	constructor(client: RpcClient, close: () => Promise<void>) {
		this.client = client;
		this.exited = this.#exit.promise;
		this.#close = close;
	}

	async close(): Promise<void> {
		await this.#close();
		this.#exit.resolve(0);
	}

	async endInput(): Promise<number> {
		return this.exited;
	}
}

export interface IrcAcceptanceHarnessOptions {
	/** Announce a run-start frame after each accepted `prompt` (row 4). */
	autoStartRuns?: boolean;
	/** Keep the server channel unbound so every inbound frame is refused. */
	unboundServer?: boolean;
	/** Drop inbound deliveries without acknowledging them. */
	dropDeliveries?: boolean;
}

/**
 * One composed in-memory collaboration domain: a local coordinator runtime
 * with its real `RpcClient`, and a remote runtime whose RPC-mode side is the
 * fixture dispatcher. Both roots are allocated by the coordinator's registry,
 * so canonical ids, generations and the Main-vs-Main collision come from the
 * production identity model instead of test constants.
 */
export class IrcAcceptanceHarness {
	readonly local: IrcRuntime;
	readonly remote: IrcRuntime;
	readonly transcript: LoopbackTranscript;
	readonly server: LoopbackManagedServer;
	readonly client: RpcClient;
	/** Production remote-endpoint adapter the local bus reaches the peer through. */
	readonly remoteEndpoint: SshBackendEndpoint;
	/** Canonical root ids; both runtimes call their own root `Main`. */
	readonly localRoot: string;
	readonly remoteRoot: string;
	readonly localChild: string;
	readonly remoteChild: string;
	readonly ircBinding: ManagedIrcBinding;
	readonly coordinatorBinding: ManagedIrcBinding;
	/** Peer-registration frames the client accepted. */
	readonly peerFrames: ManagedPeerFrame[] = [];
	/** Reply-drained barriers the client received. */
	readonly barriers: ReplyDrainedBarrier[] = [];
	/** Envelopes the peer runtime's bus received through the inbound boundary. */
	readonly inboundRecords: { envelope: IrcMessage; operationId: string; generation: number }[] = [];
	readonly #transport: LoopbackTransportFixture;
	readonly #attachments: IrcAcceptanceHarness[] = [];
	readonly #coordinatorRoutes = new Map<string, () => void>();

	constructor(
		options: IrcAcceptanceHarnessOptions,
		local: IrcRuntime,
		remote: IrcRuntime,
		attachment?: { scope: string; localRoot: string; localChild: string },
	) {
		this.local = local;
		this.remote = remote;
		this.transcript = new LoopbackTranscript();
		// One connection owns one generation: both directional bindings of the
		// handshake carry the same number, and production refuses the frame set
		// when they differ ("directional IRC binding generations differ"). The
		// number is the connection generation, which is not the local root's own
		// allocation generation — a root's identity generation tracks its
		// ownership, while this one identifies the connection those two roots
		// are bound by. It is taken from the peer side's allocation and echoed on
		// the coordinator side.
		const localAllocation = attachment ? undefined : local.registry.allocateManagedRoot({ nativeId: NATIVE_ROOT, scope: LOCAL_SCOPE });
		const remoteAllocation = local.registry.allocateManagedRoot({ nativeId: NATIVE_ROOT, scope: attachment?.scope ?? REMOTE_SCOPE });
		const generation = remoteAllocation.binding.generation;
		this.localRoot = attachment?.localRoot ?? localAllocation!.peerId;
		this.remoteRoot = remoteAllocation.peerId;
		this.localChild = attachment?.localChild ?? `${this.localRoot}:child`;
		this.remoteChild = `${remoteAllocation.peerId}:child`;
		this.ircBinding = {
			ownerPeerId: remoteAllocation.binding.ownerPeerId,
			generation,
			allowedDescendants: [...remoteAllocation.binding.allowedDescendants, this.remoteChild],
		};
		this.coordinatorBinding = {
			ownerPeerId: this.localRoot,
			generation,
			allowedDescendants: [...new Set([this.localChild, ...local.registry.list().map(ref => ref.id)])]
				.filter(id => id !== this.localRoot && id !== this.remoteRoot),
		};
		// Each runtime names its own root `Main` and knows the canonical id that
		// name resolves to; nothing else is shared between the two buses.
		local.bus.registerIdentity(this.localRoot, NATIVE_ROOT);
		remote.bus.registerIdentity(this.remoteRoot, NATIVE_ROOT);

		// The coordinator owns the domain: each side is authorized to speak for its
		// own root and descendants, and each maps the other's native `Main`.
		local.registry.mapManagedPeerIdentity({
			canonicalId: this.remoteRoot,
			nativeId: NATIVE_ROOT,
			ownerPeerId: this.remoteRoot,
			generation: this.ircBinding.generation,
		});
		local.registry.grantManagedRoute(this.localRoot, this.localChild);
		local.registry.grantManagedRoute(this.remoteRoot, this.remoteChild);
		remote.registry.mapManagedPeerIdentity({
			canonicalId: this.localRoot,
			nativeId: NATIVE_ROOT,
			ownerPeerId: this.localRoot,
			generation: this.coordinatorBinding.generation,
		});
		remote.registry.mapManagedPeerIdentity({
			canonicalId: this.remoteRoot,
			nativeId: NATIVE_ROOT,
			ownerPeerId: this.remoteRoot,
			generation: this.ircBinding.generation,
		});
		remote.registry.bindManagedConnection(this.ircBinding);
		remote.registry.bindManagedConnection(this.coordinatorBinding);
		const registerCoordinatorPeer = (canonicalId: string, displayName: string, parentId?: string): void => {
			remote.registry.registerManagedPeer({
				identity: { canonicalId, nativeId: canonicalId,
					ownerPeerId: this.coordinatorBinding.ownerPeerId, generation: this.coordinatorBinding.generation },
				reference: `rpc:${canonicalId}`, displayName, parentId, status: "idle",
			});
			if (this.#coordinatorRoutes.has(canonicalId)) return;
			this.#coordinatorRoutes.set(canonicalId, remote.bus.registerOutboundRoute(canonicalId, {
				deliver: (envelope, delivery) => this.server.channel.deliverIrc(envelope, {
					operationId: delivery.operationId ?? envelope.id, targetPeerId: envelope.to,
					expectsReply: delivery.expectsReply, suppressRelay: delivery.suppressRelay, wake: delivery.wake,
				}),
			}));
		};

		this.server = new LoopbackManagedServer(
			{
				inbound: (envelope, delivery) => {
					this.inboundRecords.push({ envelope, operationId: delivery.operationId, generation: delivery.generation });
					return remote.bus.injectInbound(envelope, delivery);
				},
				onReplyDrainedBarrier: frame => {
					this.barriers.push(frame);
					remote.bus.markRemoteReplyDrained(frame.peerId ?? this.coordinatorBinding.ownerPeerId, frame.runId);
				},
				onPeerFrame: frame => {
					this.peerFrames.push(frame);
					switch (frame.kind) {
						case "peer_state_changed":
							if (frame.state === "running" && frame.runId) {
								remote.bus.markRemoteRunStarted(frame.canonicalId, frame.runId);
							}
							remote.registry.setStatus(frame.canonicalId, frame.state);
							break;
						case "peer_registered":
							registerCoordinatorPeer(frame.canonicalId, frame.displayName, frame.parentId);
							break;
						case "peer_deregistered":
							remote.registry.unregister(frame.canonicalId);
							this.#coordinatorRoutes.get(frame.canonicalId)?.();
							this.#coordinatorRoutes.delete(frame.canonicalId);
							break;
					}
				},
				unbound: options.unboundServer,
				autoStartRuns: options.autoStartRuns,
			},
			this.transcript,
		);
		for (const id of [this.coordinatorBinding.ownerPeerId, ...this.coordinatorBinding.allowedDescendants]) {
			registerCoordinatorPeer(id, id);
		}
		this.server.dropDeliveries = options.dropDeliveries ?? false;
		this.client = new RpcClient({
			spawn: () => this.server.process,
			expectManagedBootstrap: true,
			prepare: { ircBinding: this.ircBinding, coordinatorBinding: this.coordinatorBinding },
		});
		this.#transport = new LoopbackTransportFixture(this.client, async () => {
			await this.client.stop();
			this.server.close();
		});
		this.remoteEndpoint = new SshBackendEndpoint(
			this.#transport,
			{ role: { agent: "task", source: "remote" }, capabilities: ["agent_session/v0"] } satisfies PrepareResult,
			`remote:${this.remoteRoot}`,
		);
	}

	/** Build the harness and complete the real managed handshake. */
	static async start(options: IrcAcceptanceHarnessOptions = {}): Promise<IrcAcceptanceHarness> {
		// The coordinator side of a managed connection is the process itself: the
		// production `RpcClient` publishes peer refs and IRC routes into the global
		// registry and bus, so the local runtime must be those globals (fresh per
		// harness) for the composition to be the production one.
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const harness = new IrcAcceptanceHarness(
			options,
			new IrcRuntime(AgentRegistry.global(), IrcBus.global()),
			new IrcRuntime(),
		);
		await harness.client.start();
		return harness;
	}

	/** Add another real connection to this coordinator without replacing process globals. */
	async attachRemote(scope: string): Promise<IrcAcceptanceHarness> {
		const attached = new IrcAcceptanceHarness({}, this.local, new IrcRuntime(), {
			scope, localRoot: this.localRoot, localChild: this.localChild,
		});
		this.#attachments.push(attached);
		await attached.client.start();
		attached.registerPeers();
		attached.attachLocalInbound();
		attached.connectRemoteEndpoint();
		return attached;
	}

	/** The local runtime's production inbound route: peer frames land in the local bus. */
	attachLocalInbound(): void {
		this.client.onIrcInbound((envelope, delivery) => this.local.bus.injectInbound(envelope, delivery));
	}

	/** Register both roots and their descendants on both sides' rosters. */
	registerPeers(): void {
		if (!this.local.sessions.has(this.localRoot)) {
			this.local.registerLocalPeer({ id: this.localRoot, kind: "main", displayName: MAIN_AGENT_ID });
			this.local.registerLocalPeer({ id: this.localChild, kind: "sub", parentId: this.localRoot, displayName: "local-child" });
		}
		this.local.registerRemoteRoute({ id: this.remoteRoot, displayName: MAIN_AGENT_ID, reference: this.remoteRoot });
		this.local.registerRemoteRoute({ id: this.remoteChild, displayName: "remote-child", reference: this.remoteChild });
		this.remote.registerLocalPeer({ id: this.remoteRoot, kind: "main", displayName: MAIN_AGENT_ID });
		this.remote.registerLocalPeer({ id: this.remoteChild, kind: "sub", parentId: this.remoteRoot, displayName: "remote-child" });
	}

	/** Point the local runtime's remote routes at the production SSH endpoint adapter. */
	connectRemoteEndpoint(): void {
		for (const id of [this.remoteRoot, this.remoteChild]) {
			const ref = this.local.registry.get(id);
			if (ref && ref.endpoint.kind === "remote") ref.endpoint.endpoint = this.remoteEndpoint;
		}
	}

	/** Deliver one outbound frame from the peer runtime to the coordinator. */
	sendFromRemote(
		message: Omit<IrcMessage, "id" | "ts"> & { id?: string; ts?: number },
		options: { operationId?: string; timeoutMs?: number } = {},
	): Promise<DeliveryResult> {
		const envelope: IrcMessage = {
			id: message.id ?? `msg:${randomToken()}`,
			ts: message.ts ?? Date.now(),
			...message,
		};
		return this.server.channel.deliverIrc(envelope, {
			operationId: options.operationId ?? envelope.id,
			targetPeerId: envelope.to,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		});
	}

	async stop(): Promise<void> {
		for (const attached of this.#attachments) await attached.stop();
		this.server.channel.close();
		for (const unregister of this.#coordinatorRoutes.values()) unregister();
		this.#coordinatorRoutes.clear();
		await this.#transport.close();
	}
}

function randomToken(): string {
	return Math.random().toString(36).slice(2, 10);
}
