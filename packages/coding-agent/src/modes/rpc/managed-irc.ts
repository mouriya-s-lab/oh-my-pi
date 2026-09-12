import { randomUUID } from "node:crypto";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { DeliveryResult, IrcEnvelope } from "../../irc/bus";
import { type AgentRef, type AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { isRpcHostToolResult, isRpcHostToolUpdate } from "./host-tools";
import { isRpcHostUriResult } from "./host-uris";
import { parseManagedIrcBinding, readRpcCorrelation } from "./rpc-types";
import type {
	ManagedControlOrUi,
	ManagedIrcBinding,
	ManagedIrcDeliveryOptions,
	ManagedIrcFrame,
	ManagedIrcWireFrame,
	ManagedPeerFrame,
	ManagedPeerRegistrationRequest,
	ReplyDrainedBarrier,
	RpcErrorCode,
	RpcResponse,
} from "./rpc-types";

export type ManagedPeerRegistration = Extract<ManagedPeerFrame, { kind: "peer_registered" }>;
export interface ManagedIrcSendOptions {
	operationId: string;
	targetPeerId: string;
	generation?: number;
	expectsReply?: boolean;
	suppressRelay?: boolean;
	wake?: boolean;
	timeoutMs?: number;
}

export type IrcInboundListener = (
	envelope: IrcEnvelope,
	options: ManagedIrcDeliveryOptions,
) => Promise<DeliveryResult> | DeliveryResult;

export class ManagedIrcError extends Error {
	constructor(readonly code: RpcErrorCode, message: string) {
		super(message);
		this.name = "ManagedIrcError";
	}
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function revision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function envelope(value: unknown): value is IrcEnvelope {
	return isRecord(value) && validId(value.id) && validId(value.from) && validId(value.to) &&
		typeof value.body === "string" && typeof value.ts === "number" && Number.isFinite(value.ts) &&
		(value.replyTo === undefined || validId(value.replyTo)) &&
		(value.wakeRelay === undefined || typeof value.wakeRelay === "boolean");
}

function controlOrUi(value: unknown): value is ManagedControlOrUi {
	if (!isRecord(value)) return false;
	if (isRpcHostToolResult(value) || isRpcHostToolUpdate(value) || isRpcHostUriResult(value)) return true;
	switch (value.type) {
		case "get_state": case "abort": case "abort_bash": case "heartbeat": return true;
		case "cancel_run": case "park": return validId(value.runId);
		case "terminate": return value.peerId === undefined || validId(value.peerId);
		case "resume": return validId(value.reference) && (value.expectedRunId === undefined || validId(value.expectedRunId));
		case "extension_ui_response":
			return validId(value.id) && ("value" in value || typeof value.confirmed === "boolean" ||
				(value.cancelled === true && (value.timedOut === undefined || typeof value.timedOut === "boolean")) ||
				(value.unavailable === true && (value.reason === "no-ui" || value.reason === "disconnected")));
		default: return false;
	}
}

/** Parse at the transport boundary without rebuilding or changing the IRC envelope. */
export function parseManagedIrcWireFrame(value: unknown): ManagedIrcWireFrame {
	const invalid = (): never => { throw new ManagedIrcError("protocol-incompatible", "Malformed managed IRC frame"); };
	if (!isRecord(value) || value.type !== "managed_irc" || !revision(value.generation) || !isRecord(value.frame)) return invalid();
	const correlation = readRpcCorrelation(value);
	for (const key of ["id", "correlationId", "scope", "operationId", "generation"] as const) {
		if (value[key] !== correlation[key]) return invalid();
	}
	const frame = value.frame;
	let parsed: ManagedIrcFrame;
	switch (frame.kind) {
		case "irc_delivery":
			if (!envelope(frame.envelope) || !validId(frame.operationId)) return invalid();
			for (const key of ["expectsReply", "suppressRelay", "wake"] as const) {
				if (frame[key] !== undefined && typeof frame[key] !== "boolean") return invalid();
			}
			parsed = { kind: frame.kind, envelope: frame.envelope, operationId: frame.operationId,
				...(typeof frame.expectsReply === "boolean" ? { expectsReply: frame.expectsReply } : {}),
				...(typeof frame.suppressRelay === "boolean" ? { suppressRelay: frame.suppressRelay } : {}),
				...(typeof frame.wake === "boolean" ? { wake: frame.wake } : {}) };
			break;
		case "irc_receipt": {
			const outcome = frame.outcome;
			if (!validId(frame.operationId) || (outcome !== "injected" && outcome !== "woken" && outcome !== "revived" &&
				outcome !== "failed" && outcome !== "indeterminate") || (frame.reason !== undefined && typeof frame.reason !== "string")) return invalid();
			parsed = { kind: frame.kind, operationId: frame.operationId, outcome,
				...(typeof frame.reason === "string" ? { reason: frame.reason } : {}) };
			break;
		}
		case "peer_registration_request":
			if (!validId(frame.nativeId) || !validId(frame.parentId) || !revision(frame.generation) ||
				typeof frame.displayName !== "string" || !Array.isArray(frame.roles) || !frame.roles.every(validId)) return invalid();
			parsed = { kind: frame.kind, nativeId: frame.nativeId, parentId: frame.parentId,
				displayName: frame.displayName, roles: [...frame.roles], generation: frame.generation };
			break;
		case "peer_registered": {
			if (!validId(frame.canonicalId) || !revision(frame.generation) || (frame.parentId !== undefined && !validId(frame.parentId)) ||
				typeof frame.displayName !== "string" || !Array.isArray(frame.roles) || !frame.roles.every(validId)) return invalid();
			parsed = { kind: frame.kind, canonicalId: frame.canonicalId, generation: frame.generation,
				displayName: frame.displayName, roles: [...frame.roles], ...(typeof frame.parentId === "string" ? { parentId: frame.parentId } : {}) };
			break;
		}
		case "peer_deregistered":
			if (!validId(frame.canonicalId) || !revision(frame.generation)) return invalid();
			parsed = { kind: frame.kind, canonicalId: frame.canonicalId, generation: frame.generation };
			break;
		case "peer_state_changed": {
			const state = frame.state;
			if (!validId(frame.canonicalId) || !revision(frame.generation) ||
				(state !== "running" && state !== "idle" && state !== "parked" && state !== "execution-unknown")) return invalid();
			if ((frame.runId !== undefined && !validId(frame.runId)) ||
				(frame.runStatusRevision !== undefined && (!validId(frame.runId) || !revision(frame.runStatusRevision)))) return invalid();
			parsed = { kind: frame.kind, canonicalId: frame.canonicalId, generation: frame.generation, state,
				...(typeof frame.runId === "string" ? { runId: frame.runId } : {}),
				...(typeof frame.runStatusRevision === "number" ? { runStatusRevision: frame.runStatusRevision } : {}) };
			break;
		}
		case "reply_drained_barrier":
			if (!validId(frame.runId) || !revision(frame.runStatusRevision) || !revision(frame.outboundWatermark) ||
				(frame.peerId !== undefined && !validId(frame.peerId))) return invalid();
			parsed = { kind: frame.kind, runId: frame.runId, runStatusRevision: frame.runStatusRevision, outboundWatermark: frame.outboundWatermark,
				...(typeof frame.peerId === "string" ? { peerId: frame.peerId } : {}) };
			break;
		case "control_or_ui":
			if (!controlOrUi(frame.payload)) return invalid();
			parsed = { kind: frame.kind, payload: frame.payload };
			break;
		default: return invalid();
	}
	if ((parsed.kind === "irc_delivery" || parsed.kind === "irc_receipt") &&
		value.operationId !== undefined && value.operationId !== parsed.operationId) return invalid();
	return { ...correlation, type: "managed_irc", generation: value.generation, frame: parsed };
}

interface PendingDelivery {
	from: string;
	to: string;
	correlationId: string;
	promise: Promise<DeliveryResult>;
	resolve: (result: DeliveryResult) => void;
	timer: NodeJS.Timeout;
}

interface PendingRegistration {
	parentId: string;
	deferred: PromiseWithResolvers<ManagedPeerRegistration>;
	timer: NodeJS.Timeout;
}

interface ManagedIrcOutboundProgress {
	watermark: number;
	indeterminate: boolean;
}

type ManagedIrcObservedRun =
	| { runId: string; state: "running" }
	| { runId: string; state: "terminal"; runStatusRevision: number };

export interface ManagedIrcChannelOptions {
	output: (frame: ManagedIrcWireFrame | RpcResponse) => void;
	inbound: IrcInboundListener;
	onPeerFrame?: (frame: ManagedPeerFrame) => void;
	onReplyDrainedBarrier?: (frame: ReplyDrainedBarrier) => void;
	onControlOrUi?: (frame: ManagedControlOrUi) => void;
	onRegistrationRequest?: (request: ManagedPeerRegistrationRequest) => Promise<ManagedPeerRegistration> | ManagedPeerRegistration;
	/** Only a server receiving its authenticated coordinator's roster may grant new peers. */
	allowPeerRegistration?: boolean;
}

/** Symmetric, independently scheduled channel shared by the real client and server. */
export class ManagedIrcChannel {
	readonly #options: ManagedIrcChannelOptions;
	#binding: ManagedIrcBinding | undefined;
	#allowed = new Set<string>();
	#revoked = new Set<string>();
	#closed = false;
	#pending = new Map<string, PendingDelivery>();
	#inbound = new Map<string, Promise<DeliveryResult>>();
	#completedOutbound = new Map<string, Promise<DeliveryResult>>();
	#outboundWatermark = 0;
	#indeterminate = false;
	#outboundBySender = new Map<string, ManagedIrcOutboundProgress>();
	#registrations = new Map<string, PendingRegistration>();
	#registrationGrants = new Map<string, Promise<ManagedPeerRegistration>>();
	#observedRuns = new Map<string, Map<string, ManagedIrcObservedRun>>();

	constructor(options: ManagedIrcChannelOptions) { this.#options = options; }

	bind(binding: ManagedIrcBinding): void {
		const parsed = parseManagedIrcBinding(binding);
		if (!parsed) throw new ManagedIrcError("protocol-incompatible", "Invalid IRC binding");
		if (this.#closed || (this.#binding && (this.#binding.ownerPeerId !== parsed.ownerPeerId || this.#binding.generation !== parsed.generation))) {
			throw new ManagedIrcError("authorization-denied", "IRC connection binding cannot be replaced");
		}
		this.#binding = parsed;
		this.#allowed = new Set([parsed.ownerPeerId, ...parsed.allowedDescendants].filter(id => !this.#revoked.has(id)));
	}

	get binding(): ManagedIrcBinding | undefined { return this.#binding; }

	revoke(peerId: string): void {
		this.#revoked.add(peerId);
		this.#allowed.delete(peerId);
		this.#observedRuns.delete(peerId);
		if (peerId === this.#binding?.ownerPeerId) this.close("IRC owner revoked");
	}

	#authorize(wire: ManagedIrcWireFrame): void {
		if (this.#closed || !this.#binding || wire.generation !== this.#binding.generation) {
			throw new ManagedIrcError("authorization-denied", "Unbound, stale, or revoked IRC connection");
		}
		const frame = wire.frame;
		if (frame.kind === "peer_registration_request" &&
			(frame.generation !== wire.generation || !validId(wire.correlationId) ||
				!this.#allowed.has(frame.parentId) || !this.#options.onRegistrationRequest)) {
			throw new ManagedIrcError("authorization-denied", "Registration parent is outside the connection scope");
		}
		if (frame.kind === "peer_registered" && wire.correlationId) {
			const pending = this.#registrations.get(wire.correlationId);
			if (pending && pending.parentId === frame.parentId && frame.generation === wire.generation) return;
		}
		if (frame.kind === "peer_registered" && this.#options.allowPeerRegistration &&
			frame.generation === wire.generation && frame.parentId && this.#allowed.has(frame.parentId) &&
			!this.#revoked.has(frame.canonicalId) && !this.#allowed.has(frame.canonicalId)) {
			this.#allowed.add(frame.canonicalId);
			this.#binding = { ...this.#binding, allowedDescendants: [...this.#binding.allowedDescendants, frame.canonicalId] };
		}
		if (frame.kind === "irc_delivery" && !this.#allowed.has(frame.envelope.from)) {
			throw new ManagedIrcError("authorization-denied", "IRC sender is outside the connection scope");
		}
		if (frame.kind === "reply_drained_barrier" && frame.peerId !== undefined && !this.#allowed.has(frame.peerId)) {
			throw new ManagedIrcError("authorization-denied", "Reply barrier peer is outside the connection scope");
		}
		if (frame.kind === "peer_registered" || frame.kind === "peer_state_changed" || frame.kind === "peer_deregistered") {
			if (frame.generation !== wire.generation || !this.#allowed.has(frame.canonicalId) ||
				(frame.kind === "peer_registered" && frame.canonicalId !== this.#binding.ownerPeerId &&
					(!frame.parentId || !this.#allowed.has(frame.parentId)))) {
				throw new ManagedIrcError("authorization-denied", "Peer update is outside the bound ancestry");
			}
		}
	}

	async handleFrame(wire: ManagedIrcWireFrame): Promise<void> {
		try {
			this.#authorize(wire);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#options.output({ ...readRpcCorrelation(wire), type: "response", command: "managed_irc", success: false,
				error: message, message, code: "authorization-denied" });
			return;
		}
		const frame = wire.frame;
		if (frame.kind === "peer_registered" && wire.correlationId) {
			const pending = this.#registrations.get(wire.correlationId);
			if (pending) {
				clearTimeout(pending.timer);
				this.#registrations.delete(wire.correlationId);
				pending.deferred.resolve(frame);
				return;
			}
		}
		if (frame.kind === "irc_receipt") {
			const key = `${wire.generation}:${frame.operationId}`;
			const pending = this.#pending.get(key);
			if (!pending || wire.correlationId !== pending.correlationId) return;
			this.#settle(key, { to: pending.to, outcome: frame.outcome, ...(frame.reason === undefined ? {} : { error: frame.reason }) });
			return;
		}
		this.#options.output({ ...readRpcCorrelation(wire), type: "response", command: "managed_irc", success: true,
			data: { accepted: true, ...(frame.kind === "irc_delivery" ? { operationId: frame.operationId } : {}) } });
		switch (frame.kind) {
			case "peer_registration_request": {
				const register = this.#options.onRegistrationRequest;
				if (!register) throw new ManagedIrcError("authorization-denied", "Connection cannot allocate peers");
				const key = `${wire.generation}:${wire.operationId ?? wire.correlationId}`;
				let grant = this.#registrationGrants.get(key);
				if (!grant) {
					grant = Promise.resolve().then(() => register(frame));
					this.#registrationGrants.set(key, grant);
				}
				const registered = await grant;
				this.#allowed.add(registered.canonicalId);
				if (this.#binding && !this.#binding.allowedDescendants.includes(registered.canonicalId)) {
					this.#binding = { ...this.#binding, allowedDescendants: [...this.#binding.allowedDescendants, registered.canonicalId] };
				}
				this.#options.output({ ...readRpcCorrelation(wire), type: "managed_irc", generation: wire.generation, frame: registered });
				return;
			}
			case "irc_delivery": {
				const key = `${wire.generation}:${frame.operationId}`;
				let result = this.#inbound.get(key);
				if (!result) {
					result = Promise.resolve().then(() => this.#options.inbound(frame.envelope, {
						operationId: frame.operationId, generation: wire.generation,
						expectsReply: frame.expectsReply, suppressRelay: frame.suppressRelay, wake: frame.wake,
					})).catch((error: unknown): DeliveryResult => ({ to: frame.envelope.to, outcome: "failed",
						error: error instanceof Error ? error.message : String(error) }));
					this.#inbound.set(key, result);
				}
				const receipt = await result;
				if (!this.#closed) this.#options.output({ ...readRpcCorrelation(wire), type: "managed_irc", generation: wire.generation,
					frame: { kind: "irc_receipt", operationId: frame.operationId, outcome: receipt.outcome,
						...(receipt.error === undefined ? {} : { reason: receipt.error }) } });
				return;
			}
			case "peer_registered": case "peer_state_changed": case "peer_deregistered":
				if (frame.kind === "peer_state_changed") this.observePeerState(frame);
				this.#options.onPeerFrame?.(frame);
				if (frame.kind === "peer_deregistered") this.revoke(frame.canonicalId);
				return;
			case "reply_drained_barrier": {
				const peerId = frame.peerId ?? this.#binding?.ownerPeerId;
				const runs = peerId === undefined ? undefined : this.#observedRuns.get(peerId);
				const observed = runs?.get(frame.runId);
				if (observed?.state === "terminal" && observed.runStatusRevision === frame.runStatusRevision) {
					runs?.delete(frame.runId);
					this.#options.onReplyDrainedBarrier?.(frame);
				}
				return;
			}
			case "control_or_ui": this.#options.onControlOrUi?.(frame.payload); return;
		}
	}

	/** Owner managed-run events and descendant peer frames share the same barrier fence. */
	observePeerState(frame: Extract<ManagedPeerFrame, { kind: "peer_state_changed" }>): void {
		if (!frame.runId) return;
		const runs = this.#observedRuns.get(frame.canonicalId) ?? new Map<string, ManagedIrcObservedRun>();
		if (frame.state === "running") {
			if (!runs.has(frame.runId)) runs.set(frame.runId, { runId: frame.runId, state: "running" });
			this.#observedRuns.set(frame.canonicalId, runs);
		} else if (runs.has(frame.runId) && frame.runStatusRevision !== undefined) {
			runs.set(frame.runId, { runId: frame.runId, state: "terminal", runStatusRevision: frame.runStatusRevision });
		}
	}

	/** Command acknowledgement is not delivery. Only a matching receipt settles success. */
	handleResponse(response: RpcResponse): boolean {
		if (response.command !== "managed_irc") return false;
		if (response.success) return true;
		if (response.correlationId && !response.success) {
			const pending = this.#registrations.get(response.correlationId);
			if (pending && response.generation === this.#binding?.generation) {
				clearTimeout(pending.timer);
				this.#registrations.delete(response.correlationId);
				pending.deferred.reject(new ManagedIrcError(response.code === "authorization-denied" ? response.code : "remote-execution-failed", response.error));
			}
		}
		if (response.generation === undefined || response.operationId === undefined) return true;
		const key = `${response.generation}:${response.operationId}`;
		const pending = this.#pending.get(key);
		if (pending && pending.correlationId === response.correlationId) {
			this.#settle(key, { to: pending.to, outcome: "failed", error: response.code ?? response.error });
		}
		return true;
	}

	deliverIrc(message: IrcEnvelope, options: ManagedIrcSendOptions): Promise<DeliveryResult> {
		const binding = this.#binding;
		if (this.#closed || !binding) return Promise.resolve({ to: options.targetPeerId, outcome: "failed", error: "authorization-denied" });
		if (options.generation !== undefined && options.generation !== binding.generation) {
			return Promise.resolve({ to: options.targetPeerId, outcome: "failed", error: "authorization-denied" });
		}
		if (options.targetPeerId !== message.to || !validId(options.operationId)) {
			return Promise.resolve({ to: options.targetPeerId, outcome: "failed", error: "protocol-incompatible" });
		}
		const key = `${binding.generation}:${options.operationId}`;
		const existing = this.#completedOutbound.get(key);
		if (existing) return existing;
		const deferred = Promise.withResolvers<DeliveryResult>();
		const correlationId = randomUUID();
		const timer = setTimeout(() => this.#settle(key, { to: message.to, outcome: "indeterminate", error: "IRC delivery receipt timed out" }), options.timeoutMs ?? 30_000);
		timer.unref?.();
		this.#pending.set(key, { from: message.from, to: message.to, correlationId, timer, promise: deferred.promise, resolve: deferred.resolve });
		this.#completedOutbound.set(key, deferred.promise);
		this.#outboundWatermark++;
		const progress = this.#outboundBySender.get(message.from) ?? { watermark: 0, indeterminate: false };
		progress.watermark++;
		this.#outboundBySender.set(message.from, progress);
		try {
			this.#options.output({ type: "managed_irc", generation: binding.generation, correlationId, operationId: options.operationId, scope: "peer",
				frame: { kind: "irc_delivery", envelope: message, operationId: options.operationId,
					...(options.expectsReply === undefined ? {} : { expectsReply: options.expectsReply }),
					...(options.suppressRelay === undefined ? {} : { suppressRelay: options.suppressRelay }),
					...(options.wake === undefined ? {} : { wake: options.wake }) } });
		} catch (error) {
			this.#settle(key, { to: message.to, outcome: "indeterminate", error: error instanceof Error ? error.message : String(error) });
		}
		return deferred.promise;
	}

	#settle(key: string, result: DeliveryResult): void {
		const pending = this.#pending.get(key);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.#pending.delete(key);
		if (result.outcome === "indeterminate") {
			this.#indeterminate = true;
			const progress = this.#outboundBySender.get(pending.from);
			if (progress) progress.indeterminate = true;
		}
		pending.resolve(result);
	}

	requestPeerRegistration(input: Omit<ManagedPeerRegistrationRequest, "kind" | "generation">): Promise<ManagedPeerRegistration> {
		if (!this.#binding || this.#closed) return Promise.reject(new ManagedIrcError("authorization-denied", "IRC connection is not bound"));
		const correlationId = randomUUID();
		const deferred = Promise.withResolvers<ManagedPeerRegistration>();
		const timer = setTimeout(() => {
			this.#registrations.delete(correlationId);
			deferred.reject(new ManagedIrcError("timeout", "Canonical peer registration timed out"));
		}, 30_000);
		timer.unref?.();
		this.#registrations.set(correlationId, { parentId: input.parentId, deferred, timer });
		try {
			this.#options.output({ type: "managed_irc", generation: this.#binding.generation, correlationId,
				operationId: correlationId, scope: "peer",
				frame: { kind: "peer_registration_request", generation: this.#binding.generation, ...input } });
		} catch (error) {
			clearTimeout(timer);
			this.#registrations.delete(correlationId);
			deferred.reject(error);
		}
		return deferred.promise;
	}

	emit(frame: ManagedIrcFrame): void {
		if (!this.#binding || this.#closed) throw new ManagedIrcError("authorization-denied", "IRC connection is not bound");
		this.#options.output({ type: "managed_irc", generation: this.#binding.generation, frame });
	}

	async waitForOutbound(peerId?: string): Promise<number> {
		for (;;) {
			const pending = [...this.#pending.values()].filter(delivery => peerId === undefined || delivery.from === peerId);
			if (pending.length === 0) break;
			await Promise.all(pending.map(delivery => delivery.promise));
		}
		const progress = peerId === undefined ? undefined : this.#outboundBySender.get(peerId);
		if (peerId === undefined ? this.#indeterminate || this.#closed : progress?.indeterminate) {
			throw new ManagedIrcError("connection-lost", "IRC outbound drain is unconfirmed");
		}
		return peerId === undefined ? this.#outboundWatermark : progress?.watermark ?? 0;
	}

	get outboundBySender(): ReadonlyMap<string, Readonly<ManagedIrcOutboundProgress>> {
		return this.#outboundBySender;
	}

	close(reason = "IRC connection closed"): void {
		this.#closed = true;
		for (const [key, pending] of this.#pending) this.#settle(key, { to: pending.to, outcome: "indeterminate", error: reason });
		for (const pending of this.#registrations.values()) {
			clearTimeout(pending.timer);
			pending.deferred.reject(new ManagedIrcError("connection-lost", reason));
		}
		this.#registrations.clear();
		this.#allowed.clear();
		this.#observedRuns.clear();
	}
}

export type ManagedIrcObservation = Extract<ManagedPeerFrame, { kind: "peer_state_changed" }> | ReplyDrainedBarrier;
type ManagedIrcObservationListener = (sourceOwnerPeerId: string, frame: ManagedIrcObservation) => void;

interface ManagedIrcSessionIdentity {
	canonicalId: string;
	generation: number;
}

interface ManagedIrcSessionObserverOptions {
	identify: (ref: AgentRef) => Promise<ManagedIrcSessionIdentity>;
	publish: (frame: ManagedIrcObservation) => void;
	waitForOutbound: (peerId: string) => Promise<number>;
	track: (task: Promise<void>) => void;
}

interface ObservedIrcSession {
	session: AgentSession;
	identity: Promise<ManagedIrcSessionIdentity>;
	unsubscribe: () => void;
	pending: Set<Promise<void>>;
}

/** Observe real session transitions without creating cancellable managed runs. */
export class ManagedIrcSessionObserver {
	readonly #options: ManagedIrcSessionObserverOptions;
	#sessions = new Map<string, ObservedIrcSession>();
	#revisions = new Map<string, number>();

	constructor(options: ManagedIrcSessionObserverOptions) { this.#options = options; }

	#nextRevision(peerId: string): number {
		const revision = (this.#revisions.get(peerId) ?? 0) + 1;
		this.#revisions.set(peerId, revision);
		return revision;
	}

	observe(ref: AgentRef): void {
		const session = ref.endpoint.kind === "local" ? ref.endpoint.session : null;
		if (this.#sessions.get(ref.id)?.session === session) return;
		this.remove(ref.id);
		if (!session) return;
		const identity = this.#options.identify(ref);
		const pending = new Set<Promise<void>>();
		const track = (task: Promise<void>): void => {
			pending.add(task);
			this.#options.track(task.finally(() => pending.delete(task)));
		};
		let activeRunId: string | undefined;
		const start = (): void => {
			if (activeRunId) return;
			const runId = Snowflake.next();
			activeRunId = runId;
			const runStatusRevision = this.#nextRevision(ref.id);
			track(identity.then(({ canonicalId, generation }) => {
				this.#options.publish({ kind: "peer_state_changed", canonicalId, generation,
					state: "running", runId, runStatusRevision });
			}));
		};
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_start") start();
			else if (event.type === "agent_end" && event.isTerminal !== false && activeRunId) {
				const runId = activeRunId;
				activeRunId = undefined;
				const runStatusRevision = this.#nextRevision(ref.id);
				track(identity.then(async ({ canonicalId, generation }) => {
					this.#options.publish({ kind: "peer_state_changed", canonicalId, generation,
						state: "idle", runId, runStatusRevision });
					await session.waitForIrcReplies();
					const outboundWatermark = await this.#options.waitForOutbound(canonicalId);
					this.#options.publish({ kind: "reply_drained_barrier", peerId: canonicalId,
						runId, runStatusRevision, outboundWatermark });
				}));
			}
		});
		this.#sessions.set(ref.id, { session, identity, unsubscribe, pending });
		// Attaching a live session must not lose the run that started before subscription.
		if (session.isStreaming) start();
		else track(identity.then(() => {}));
	}

	async drainAndRemove(peerId: string): Promise<void> {
		const observed = this.#sessions.get(peerId);
		if (!observed) return;
		await observed.session.waitForIrcReplies();
		await Promise.all(observed.pending);
		const { canonicalId } = await observed.identity;
		await this.#options.waitForOutbound(canonicalId);
		if (this.#sessions.get(peerId) === observed) this.remove(peerId);
	}

	remove(peerId: string): void {
		this.#sessions.get(peerId)?.unsubscribe();
		this.#sessions.delete(peerId);
	}

	close(): void {
		for (const observed of this.#sessions.values()) observed.unsubscribe();
		this.#sessions.clear();
	}
}

interface LatestManagedIrcObservation {
	sourceOwnerPeerId: string;
	runId: string;
	state?: Extract<ManagedPeerFrame, { kind: "peer_state_changed" }>;
	terminal?: Extract<ManagedPeerFrame, { kind: "peer_state_changed" }>;
	barrier?: ReplyDrainedBarrier;
}

/** Coordinator-local fanout. Receiving servers never publish received observations. */
export class ManagedIrcObservationRelay {
	static #registries = new WeakMap<AgentRegistry, ManagedIrcObservationRelay>();
	#listeners = new Set<ManagedIrcObservationListener>();
	#latest = new Map<string, LatestManagedIrcObservation>();
	readonly #registry: AgentRegistry;
	#channels = new Set<ManagedIrcChannel>();
	#retiredOutbound = new Map<string, ManagedIrcOutboundProgress>();
	#localObserver: ManagedIrcSessionObserver | undefined;
	#localOwnerPeerId: string | undefined;
	#localRegistryUnsubscribe: (() => void) | undefined;

	constructor(registry: AgentRegistry) { this.#registry = registry; }

	static forRegistry(registry: AgentRegistry): ManagedIrcObservationRelay {
		let relay = this.#registries.get(registry);
		if (!relay) {
			relay = new ManagedIrcObservationRelay(registry);
			this.#registries.set(registry, relay);
		}
		return relay;
	}

	registerChannel(channel: ManagedIrcChannel): () => void {
		this.#channels.add(channel);
		return () => {
			if (!this.#channels.delete(channel)) return;
			for (const [peerId, progress] of channel.outboundBySender) {
				const retired = this.#retiredOutbound.get(peerId) ?? { watermark: 0, indeterminate: false };
				retired.watermark += progress.watermark;
				retired.indeterminate ||= progress.indeterminate;
				this.#retiredOutbound.set(peerId, retired);
			}
		};
	}

	async #waitForOutbound(peerId: string): Promise<number> {
		const retired = this.#retiredOutbound.get(peerId);
		if (retired?.indeterminate) throw new ManagedIrcError("connection-lost", "Retired IRC delivery remains indeterminate");
		// Capture both halves before awaiting: a channel retiring during the drain is counted once.
		const retiredWatermark = retired?.watermark ?? 0;
		const active = [...this.#channels];
		const watermarks = await Promise.all(active.map(channel => channel.waitForOutbound(peerId)));
		return watermarks.reduce((total, watermark) => total + watermark, retiredWatermark);
	}

	/** Install once, after the coordinator has assigned its own canonical identity. */
	observeLocalPeers(ownerPeerId: string): void {
		if (this.#localOwnerPeerId === ownerPeerId) return;
		this.#localRegistryUnsubscribe?.();
		this.#localObserver?.close();
		this.#localOwnerPeerId = ownerPeerId;
		const registry = this.#registry;
		const observer = new ManagedIrcSessionObserver({
			identify: async ref => {
				const canonicalId = registry.canonicalizeManagedPeerId(ref.id);
				let identity = registry.managedPeerIdentity(canonicalId);
				if (!identity) {
					const binding = registry.getManagedConnectionBinding(ownerPeerId);
					if (!binding) throw new ManagedIrcError("authorization-denied", "Coordinator identity is unbound");
					identity = registry.managedPeerIdentityByNative(ownerPeerId, ref.id) ??
						registry.allocateManagedDescendant({ ownerPeerId, generation: binding.generation, nativeId: ref.id });
					if (!identity) throw new ManagedIrcError("authorization-denied", "Local peer identity allocation was refused");
					registry.registerManagedLocalAlias({ identity });
				}
				return { canonicalId: identity.canonicalId, generation: identity.generation };
			},
			publish: frame => this.publish(ownerPeerId, frame),
			waitForOutbound: peerId => this.#waitForOutbound(peerId),
			track: task => { void task.catch(error => logger.error("Managed IRC local observation failed", {
				ownerPeerId, error: error instanceof Error ? error.message : String(error),
			})); },
		});
		this.#localObserver = observer;
		this.#localRegistryUnsubscribe = registry.onChange(event => {
			if (event.ref.endpoint.kind !== "local") return;
			if (event.type === "removed") {
				observer.remove(event.ref.id);
				this.removePeer(registry.canonicalizeManagedPeerId(event.ref.id));
			} else observer.observe(event.ref);
		});
		for (const ref of registry.list()) if (ref.endpoint.kind === "local") observer.observe(ref);
	}

	subscribe(listener: ManagedIrcObservationListener): () => void {
		this.#listeners.add(listener);
		for (const latest of this.#latest.values()) {
			if (latest.state) listener(latest.sourceOwnerPeerId, latest.state);
			if (latest.terminal) listener(latest.sourceOwnerPeerId, latest.terminal);
			if (latest.barrier) listener(latest.sourceOwnerPeerId, latest.barrier);
		}
		return () => this.#listeners.delete(listener);
	}

	publish(sourceOwnerPeerId: string, frame: ManagedIrcObservation): void {
		const peerId = frame.kind === "peer_state_changed" ? frame.canonicalId : frame.peerId;
		if (peerId && frame.runId) {
			const previous = this.#latest.get(peerId);
			if (frame.kind === "reply_drained_barrier" && previous && previous.runId !== frame.runId) return;
			const latest: LatestManagedIrcObservation = previous?.runId === frame.runId ?
				previous : { sourceOwnerPeerId, runId: frame.runId };
			if (frame.kind === "peer_state_changed") {
				if (frame.state === "running") {
					latest.state = frame;
					latest.terminal = undefined;
					latest.barrier = undefined;
				} else latest.terminal = frame;
			} else latest.barrier = frame;
			this.#latest.set(peerId, latest);
		}
		for (const listener of this.#listeners) listener(sourceOwnerPeerId, frame);
	}

	removePeer(peerId: string): void {
		this.#latest.delete(peerId);
	}

	removeSource(sourceOwnerPeerId: string): void {
		for (const [peerId, latest] of this.#latest) {
			if (latest.sourceOwnerPeerId === sourceOwnerPeerId) this.#latest.delete(peerId);
		}
	}
}
