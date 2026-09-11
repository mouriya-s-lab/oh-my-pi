/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 *
 * **One message, one identity.** A message is an envelope whose `id`/`ts` are
 * minted exactly once, by the sending runtime, when the envelope is built
 * ({@link IrcBus.send} / {@link IrcBus.createEnvelope}). Everything that
 * handles that envelope afterwards — a route, an endpoint, an inbound delivery
 * boundary — carries it verbatim; nothing regenerates `id`/`ts`, because that
 * is how one message becomes two (RFC #1 §6.2). Operational facts travel
 * *beside* the envelope in {@link IrcDeliveryOptions}: the operation id that a
 * receive runtime deduplicates by, and the delivery switches (`expectsReply`,
 * `suppressRelay`, `wake`) that describe the hand-over rather than the message.
 *
 * **Receiving is not sending.** {@link IrcBus.injectInbound} is the receive
 * boundary: it hands an already-identified envelope to the peer the sender
 * addressed, and it never mints a new message to do it. That peer is this runtime's own when it holds
 * the peer's session, and otherwise the same transport a send would pick — the
 * peer's `AgentEndpoint` or its registered {@link IrcOutboundRoute} — because a
 * coordinator relaying between two peers it connects must forward the very
 * envelope it received, not a copy of it (RFC #1 §6.2). Only a *known*
 * registered peer is ever relayed to: an id this runtime does not hold has no
 * route to send back out — in particular not the connection the frame arrived
 * on, which would echo it towards its own sender.
 */

import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, type AgentRef, getLocalSession, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { CustomMessage } from "../session/messages";
import { toDeliveryResult } from "./inbound";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/**
	 * Automated wake-turn relay of a woken subagent's stop output (task executor
	 * `relayWakeTurnOutput`). Relays are answers, never wake sources: the
	 * recipient's own wake-turn relay must skip them or two idle peers
	 * ping-pong forever.
	 */
	wakeRelay?: boolean;
}

/**
 * One IRC message as it travels between peers, under the identity its sender
 * minted. The alias exists so transport-facing code can talk about envelopes
 * without implying a second message shape.
 */
export type IrcEnvelope = IrcMessage;

export interface IrcDeliveryReceipt {
	to: string;
	/**
	 * How the message reached the recipient, or why it did not:
	 * `injected` (waiter/aside/queued mailbox), `woken` (a wake turn started),
	 * `revived` (a parked peer was brought back), `failed` (nothing was
	 * handed over), `indeterminate` (a frame was handed to a transport that
	 * could not confirm it — the delivery is neither known nor known-failed).
	 */
	outcome: "injected" | "woken" | "revived" | "failed" | "indeterminate";
	error?: string;
}

/** Result of one delivery attempt; the name transport callers use. */
export type DeliveryResult = IrcDeliveryReceipt;

/**
 * Operational facts that ride beside an envelope. None of them is part of the
 * message: they neither alter its identity nor survive into its body.
 */
export interface IrcDeliveryOptions {
	/**
	 * Operation id for duplicate suppression on the receiving runtime; defaults
	 * to the envelope's own id, which is the identity a sender repeats when it
	 * re-sends the same message.
	 */
	operationId?: string;
	/** Receive-side connection generation the operation belongs to (dedup scope). */
	generation?: number;
	/**
	 * The caller is blocked on an answer (`send await:true`): a mid-turn
	 * recipient that cannot reach a step boundary generates an ephemeral
	 * side-channel auto-reply instead of stranding the sender until timeout.
	 */
	expectsReply?: boolean;
	/**
	 * Skip the display-only main-UI relay for this leg. Set by broadcast
	 * fan-out when the same broadcast also targets the main agent directly:
	 * the main agent then already sees the body as its own incoming card, so
	 * relaying the sibling legs would duplicate it.
	 */
	suppressRelay?: boolean;
	/**
	 * `false` forbids revival: a recipient that would have to be brought back
	 * (parked, or gated by the lifecycle) is left exactly as it is and the
	 * message waits in its mailbox. A parked peer stays parked — this is what
	 * keeps a broadcast from waking the parked set.
	 */
	wake?: boolean;
}

/**
 * One outbound transport for peers this runtime cannot reach locally.
 *
 * A route owns framing, correlation and its own connection generation; it
 * receives the envelope verbatim and must not regenerate `id`/`ts`. It is
 * registered against the canonical peer id it delivers to, so the bus can pick
 * it without knowing which connection carries the peer.
 */
export interface IrcOutboundRoute {
	deliver(envelope: IrcEnvelope, options: IrcDeliveryOptions): Promise<DeliveryResult>;
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Facts observed while parking a waiter, plus its cancel handle. */
interface IrcParked {
	promise: Promise<IrcMessage | null>;
	cancel: () => void;
}

/** Options {@link IrcBus.waitReply} needs to park before it sends. */
export interface IrcWaitReplyOptions {
	/** Peer whose inbox the reply lands in (the sender of the awaited message). */
	senderId: string;
	/** `<= 0` waits forever, matching {@link IrcBus.wait}. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** See {@link IrcBus.wait}: a caller needing a strictly future reply disables the drain. */
	drainPending?: boolean;
	/** Peer whose stop should end the wait without a reply, when it also stops owing replies. */
	awaitTarget?: { registry: AgentRegistry; target: string };
	/** The send to run once the waiter is parked. */
	send: () => Promise<DeliveryResult>;
}

/**
 * Rejection reason for a `send await:true` whose awaited peer reached a
 * terminal stop (ended its turn, parked, was aborted, or unregistered)
 * without ever replying. Distinct from a plain timeout so the sender can
 * surface "they stopped" instead of stranding the caller on the full
 * `irc.timeoutMs` window.
 */
export class IrcAwaitTargetStopped extends Error {
	constructor(target: string) {
		super(`Awaited peer "${target}" stopped without replying.`);
		this.name = "IrcAwaitTargetStopped";
	}
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	/** Timestamp of the latest successful send per `from` → `to`; see {@link sentSince}. */
	readonly #lastSent = new Map<string, Map<string, number>>();
	/** Transports for peers this runtime cannot reach locally, keyed by canonical target id. */
	readonly #routes = new Map<string, IrcOutboundRoute>();
	/**
	 * Inbound operations already injected, keyed by `generation\0operationId`.
	 * A replayed operation returns the promise its first injection is running —
	 * or the receipt that injection settled with — so one operation can never
	 * inject twice inside one generation. Entries are never evicted: forgetting
	 * one would turn a duplicate frame into a second delivery, and forgetting a
	 * cached failure would turn a retry into a re-injection.
	 */
	readonly #inbound = new Map<string, Promise<DeliveryResult>>();
	/** Canonical owner id of the managed connection this runtime speaks for, when it is one. */
	#ownerPeerId: string | undefined;
	/** Native id this runtime calls its own root; the local arm of the owner mapping. */
	#nativeRootId = MAIN_AGENT_ID;
	/** Canonical ids granted to this runtime's native ids, keyed by the native id. */
	readonly #grants = new Map<string, string>();
	/** Grants this runtime is still waiting on, keyed by the native id awaiting one. */
	readonly #pendingIdentities = new Map<string, Promise<string>>();
	/**
	 * Managed runs observed over this runtime's connections, keyed by canonical
	 * peer id: the run executing there now and whether its replies have drained.
	 * A remote waiter's verdict comes from here — a run must drain before the
	 * peer can read as stopped — and never from an endpoint snapshot, which can
	 * still describe the peer's previous run.
	 */
	readonly #remoteRuns = new Map<string, { currentRunId: string | null; currentRunDrained: boolean }>();
	/** Observers of {@link #remoteRuns} transitions, notified with the peer key that changed. */
	readonly #remoteRunListeners = new Set<(peerKey: string) => void>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	/**
	 * Fire-and-forget delivery of a new message. Mints the envelope's identity
	 * once (this is the only place a `send` does that) and hands it to
	 * {@link IrcBus.sendEnvelope}.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * (or a `wake:false` delivery to a peer that would have needed a revival)
	 * is buffered for the recipient to drain later.
	 */
	async send(msg: Omit<IrcMessage, "id" | "ts">, opts?: IrcDeliveryOptions): Promise<DeliveryResult> {
		for (const nativeId of [msg.from, msg.to]) {
			// Keep native delivery in the same tick so ensureLive can cancel a
			// pre-detach park. Only a pending canonical grant requires yielding.
			if (!this.#pendingIdentities.has(nativeId)) continue;
			const refusal = await this.#awaitIdentity(nativeId);
			// One address without a granted identity fails this delivery only:
			// no envelope is minted and nothing goes on the wire, while a
			// broadcast still gets the other targets' own receipts.
			if (refusal) return { to: msg.to, outcome: "failed", error: refusal };
		}
		return this.sendEnvelope(this.createEnvelope(msg), opts);
	}

	/**
	 * Mint the identity of one outbound message without sending it: the caller
	 * gets the envelope it may hand to a waiter, a route, or a transport before
	 * anything is delivered. The addresses are canonicalized here, at
	 * construction — never on receipt, where the sender's identity is verbatim.
	 */
	createEnvelope(msg: Omit<IrcMessage, "id" | "ts">): IrcEnvelope {
		return {
			...msg,
			from: this.#canonicalize(msg.from),
			to: this.#canonicalize(msg.to),
			id: Snowflake.next(),
			ts: Date.now(),
		};
	}

	/**
	 * Deliver one already-identified envelope. The caller owns the identity: it
	 * is neither re-minted nor re-addressed here, so a transport that forwards
	 * a message cannot fork it into a second one.
	 */
	async sendEnvelope(envelope: IrcEnvelope, opts?: IrcDeliveryOptions): Promise<DeliveryResult> {
		const result = await this.#deliver(envelope, opts);
		if (result.outcome !== "failed" && result.outcome !== "indeterminate") {
			let sent = this.#lastSent.get(envelope.from);
			if (!sent) {
				sent = new Map();
				this.#lastSent.set(envelope.from, sent);
			}
			sent.set(envelope.to, envelope.ts);
		}
		return result;
	}

	/**
	 * Register the outbound transport for one canonical peer id, returning the
	 * unregister handle. Replacement is allowed (a reconnected connection
	 * supersedes the old route); the bus resolves a route per delivery, so an
	 * unregistered route simply stops being used.
	 */
	registerOutboundRoute(targetPeerId: string, route: IrcOutboundRoute): () => void {
		const previous = this.#routes.get(targetPeerId);
		this.#routes.set(targetPeerId, route);
		return () => {
			if (this.#routes.get(targetPeerId) === route) this.#routes.delete(targetPeerId);
			if (previous && this.#routes.get(targetPeerId) === undefined) this.#routes.set(targetPeerId, previous);
		};
	}

	/**
	 * Declare which managed connection this runtime speaks for: `ownerPeerId` is
	 * the canonical id the coordinator assigned to `nativeRootId` (this
	 * runtime's own root). It is the scope local ids are normalized through —
	 * a local `Main` and the canonical id an inbound frame addresses as its
	 * recipient become the same key, so mailboxes, waiters and replies cannot
	 * split across two identities.
	 */
	registerIdentity(ownerPeerId: string, nativeRootId: string = MAIN_AGENT_ID): void {
		this.#ownerPeerId = ownerPeerId;
		this.#nativeRootId = nativeRootId;
	}

	/**
	 * Register the canonical id this runtime is waiting to be granted for one of
	 * its own native ids. A mint that carries the id waits for the grant here
	 * ({@link IrcBus.send}), so a runtime that has not been addressed yet cannot
	 * put a native id on the wire, nor mint a second identity for one peer.
	 * Registering again replaces the pending grant: a renegotiation carries the
	 * new answer, not the old one.
	 */
	registerPendingIdentity(nativeId: string, canonicalId: Promise<string>): void {
		// A grant that is refused or disconnected before any mint awaits it must
		// not surface as an unhandled rejection: this observer consumes only that
		// failure seat, and a later mint awaiting the promise still sees it.
		void canonicalId.catch(() => {});
		this.#grants.delete(nativeId);
		this.#pendingIdentities.set(nativeId, canonicalId);
	}

	/**
	 * Record that a run started on a remote peer, as its connection's
	 * `managed_run_start` reports. A remote waiter settles "stopped without
	 * replying" only once the run it is watching has drained, so the start is
	 * what makes the peer's execution observable — a parked peer that no run has
	 * started yet is not a stopped one.
	 */
	markRemoteRunStarted(peerId: string, runId: string): void {
		const key = this.#canonicalize(peerId);
		const state = this.#remoteRuns.get(key);
		if (!state) {
			this.#remoteRuns.set(key, { currentRunId: runId, currentRunDrained: false });
			this.#notifyRemoteRun(key);
			return;
		}
		// A different id is the peer's next execution and starts undrained. The
		// same id is a replayed frame, never a second execution, so it leaves a
		// drain already observed in place.
		if (state.currentRunId === runId) return;
		state.currentRunId = runId;
		state.currentRunDrained = false;
		this.#notifyRemoteRun(key);
	}

	/**
	 * Record a remote run's reply drain, as its connection's
	 * `reply_drained_barrier` reports. Only the peer's current run counts: a
	 * barrier for any other run is a stale frame, and stale frames decide
	 * nothing.
	 */
	markRemoteReplyDrained(peerId: string, runId: string): void {
		const key = this.#canonicalize(peerId);
		const state = this.#remoteRuns.get(key);
		if (!state || state.currentRunId !== runId || state.currentRunDrained) return;
		state.currentRunDrained = true;
		this.#notifyRemoteRun(key);
	}

	/**
	 * Receive boundary: deliver one inbound frame's envelope to a peer of this
	 * runtime, at most once per `(generation, operationId)`.
	 *
	 * A repeat — the sender retrying, a transport replaying — returns the same
	 * promise the first delivery is running, or the receipt it settled with, and
	 * therefore cannot inject the message a second time. The envelope is
	 * delivered verbatim: `id`/`ts`/`from`/`to`/`replyTo` are the sender's, and
	 * this boundary never sends anything, so a received message can never become
	 * a new one.
	 */
	async injectInbound(
		envelope: IrcEnvelope,
		opts: IrcDeliveryOptions & { operationId: string; generation: number },
	): Promise<DeliveryResult> {
		const key = `${opts.generation}\u0000${opts.operationId}`;
		const injected = this.#inbound.get(key);
		if (injected) return injected;
		const delivery = Promise.resolve()
			.then(() => this.#deliver(envelope, opts))
			.catch((error: unknown): DeliveryResult => ({
				to: envelope.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			}));
		this.#inbound.set(key, delivery);
		return delivery;
	}


	/**
	 * Park the from-filtered waiter for `senderId`, then run the send, then
	 * report both. Registration happens before the send goes out, so a
	 * recipient that answers immediately cannot race the waiter into its
	 * mailbox; matching stays by `from` (never by `replyTo`), and the waiter
	 * lives in this runtime either way.
	 *
	 * The reply is `null` when the send itself did not land (nothing was
	 * delivered, so nothing can be awaited) or when the wait timed out. A wait
	 * that is interrupted or that observes the target stopping rejects, exactly
	 * as {@link IrcBus.wait} does — the caller sees the same reasons it would
	 * have seen waiting by hand.
	 */
	async waitReply(
		from: string,
		opts: IrcWaitReplyOptions,
	): Promise<{ receipt: DeliveryResult; reply: IrcMessage | null }> {
		const parked = this.#park(
			opts.senderId,
			{ from },
			opts.timeoutMs ?? 0,
			opts.signal,
			{ drainPending: opts.drainPending, awaitTarget: opts.awaitTarget },
			true,
		);
		let receipt: DeliveryResult;
		try {
			receipt = await opts.send();
		} catch (error) {
			parked.cancel();
			throw error;
		}
		if (receipt.outcome === "failed" || receipt.outcome === "indeterminate") {
			parked.cancel();
			return { receipt, reply: null };
		}
		return { receipt, reply: await parked.promise };
	}

	/**
	 * Whether `from` successfully sent `to` anything at or after `sinceTs`.
	 * The wake-turn relay uses it to skip agents that already answered their
	 * waker themselves. An `indeterminate` delivery is not counted: it neither
	 * proves the peer saw the message nor proves they did not.
	 */
	sentSince(from: string, to: string, sinceTs: number): boolean {
		const ts = this.#lastSent.get(this.#canonicalize(from))?.get(this.#canonicalize(to));
		return ts !== undefined && ts >= sinceTs;
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: {
			drainPending?: boolean;
			liveness?: { registry: AgentRegistry; senderId: string };
			awaitTarget?: { registry: AgentRegistry; target: string };
		},
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		// #park drains already-pending mail first (unless `drainPending: false`),
		// so a message waiting in the mailbox satisfies the wait without parking
		// a waiter.
		return this.#park(agentId, filter, timeoutMs, signal, options).promise;
	}

	/** Drain (or peek) pending messages for `agentId`. */
	inbox(agentId: string, opts?: { peek?: boolean }): IrcMessage[] {
		const key = this.#stableKey(agentId);
		const mailbox = this.#mailboxes.get(key);
		if (!mailbox || mailbox.length === 0) return [];
		if (opts?.peek) return [...mailbox];
		this.#mailboxes.delete(key);
		return mailbox;
	}

	/**
	 * Consume the OLDEST pending message for `agentId` (optionally restricted
	 * to `from`), leaving the rest of the mailbox intact. This is the exact
	 * atomic step `wait` performs on entry, exposed for callers that must not
	 * block: peeking with `inbox` and consuming afterwards would open a window
	 * for a concurrent consumer of the same mailbox to take the message in
	 * between, and a plain `inbox` drain would swallow the whole backlog.
	 */
	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, from);
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(this.#stableKey(agentId))?.length ?? 0;
	}

	/**
	 * The canonical id one address routes by: a native id this runtime owns is
	 * mapped through the coordinator's allocation, everything else is already a
	 * routing key. Idempotent, so canonicalizing twice is canonicalizing once.
	 */
	#canonicalize(id: string): string {
		const owner = this.#ownerPeerId;
		if (owner === undefined || id === owner) return id;
		const granted = this.#grants.get(id);
		if (granted !== undefined) return granted;
		return this.#registry.managedCanonicalForNative(owner, id) ?? id;
	}
	/**
	 * Stable mailbox/waiter key for one id: the resolved local ref's native id
	 * when this runtime holds the peer locally, otherwise the canonical id.
	 * A native child parked before its grant and the canonical reply that grant
	 * later produces resolve to the same native key, so a waiter parked under
	 * the native id still matches a reply addressed to the canonical one. The
	 * envelope itself is untouched — only the local queue index is stable.
	 */
	#stableKey(id: string): string {
		const ref = this.#resolveRef(id, id);
		if (ref && ref.endpoint.kind === "local") return ref.id;
		return this.#canonicalize(id);
	}

	/**
	 * Wait for the grant a native id is registered as awaiting, then record the
	 * canonical id it was given so every later mint addresses the peer by it.
	 * Returns the refusal reason when the grant never arrived: the caller fails
	 * that one delivery rather than minting an envelope that would carry a
	 * native id on the wire. The pending entry stays registered, so every later
	 * mint is refused the same way until a new grant replaces it.
	 */
	async #awaitIdentity(nativeId: string): Promise<string | undefined> {
		const pending = this.#pendingIdentities.get(nativeId);
		if (!pending) return undefined;
		let granted: string;
		try {
			granted = await pending;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return `Agent "${nativeId}" has no granted identity on this connection: ${reason}`;
		}
		this.#grants.set(nativeId, granted);
		if (this.#pendingIdentities.get(nativeId) === pending) this.#pendingIdentities.delete(nativeId);
		return undefined;
	}

	/** Tell the remote-run observers that one peer's observed state changed. */
	#notifyRemoteRun(peerKey: string): void {
		for (const listener of this.#remoteRunListeners) listener(peerKey);
	}

	/** The live ref for a canonical id, resolving a local native id as a last step. */
	#resolveRef(key: string, rawId: string): AgentRef | undefined {
		const direct = this.#registry.get(key) ?? this.#registry.get(rawId);
		if (direct) return direct;
		const owner = this.#ownerPeerId;
		if (owner === undefined) return undefined;
		// Only identities this runtime's own connection owns may resolve to a
		// local session: another runtime's `Main@host` must never fall back to
		// this runtime's `Main`.
		const identity = this.#registry.managedPeerIdentity(key);
		if (identity && identity.ownerPeerId === owner) {
			const ref = this.#registry.get(identity.nativeId);
			if (ref) return ref;
		}
		if (key === owner) return this.#registry.get(this.#nativeRootId);
		return undefined;
	}

	/** A refusal that holds for every transport: the peer is gone or is not messageable at all. */
	#refusal(to: string, ref: AgentRef): DeliveryResult | undefined {
		if (ref.status === "aborted") {
			return {
				to,
				outcome: "failed",
				error: `Agent "${to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${to}.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to,
				outcome: "failed",
				error: `Agent "${to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}
		return undefined;
	}

	/**
	 * Pick the transport for one outbound envelope. A local ref goes through the
	 * in-process pipeline; a peer reached through a connection goes through its
	 * registered route; a peer this runtime holds an endpoint for goes through
	 * that endpoint. Nothing falls back to a local injection.
	 */
	async #deliver(envelope: IrcEnvelope, opts?: IrcDeliveryOptions): Promise<DeliveryResult> {
		const canonical = this.#canonicalize(envelope.to);
		const ref = this.#resolveRef(canonical, envelope.to);
		if (!ref) {
			// No registered peer, so no route is consulted — not by canonical id and
			// not by the raw one: a route belongs to a peer this runtime knows, and
			// selecting one for an unknown id could send the frame back out the very
			// connection it arrived on.
			return {
				to: envelope.to,
				outcome: "failed",
				error: `Unknown agent "${envelope.to}" — check \`irc list\` for live peers.`,
			};
		}
		const refusal = this.#refusal(envelope.to, ref);
		if (refusal) return refusal;
		if (ref.endpoint.kind === "remote") {
			// Ingress generation scopes this bus's deduplication, not the next hop.
			// The selected transport fences delivery against its own bound generation.
			const outboundOptions: IrcDeliveryOptions = {
				operationId: opts?.operationId ?? envelope.id,
				expectsReply: opts?.expectsReply,
				suppressRelay: opts?.suppressRelay,
				wake: opts?.wake,
			};
			const endpoint = ref.endpoint.endpoint;
			if (!endpoint) {
				const route = this.#routes.get(canonical);
				if (route) return route.deliver(envelope, outboundOptions);
				return {
					to: envelope.to,
					outcome: "failed",
					error: `Agent "${envelope.to}" is remote and its transport is not connected.`,
				};
			}
			const receipt = await endpoint.deliverIrc(envelope, outboundOptions);
			return toDeliveryResult(receipt);
		}
		return this.#deliverLocal(envelope, ref.id, ref, opts);
	}

	/**
	 * The in-process pipeline, unchanged in every observable respect: lifecycle
	 * revival for a parked/gated recipient, a pending waiter winning over the
	 * session, otherwise the recipient session's own busy/idle/plan delivery.
	 * Only two things are new — the recipient queues use the stable local key
	 * (the local ref's native id, so a waiter parked before a grant still meets
	 * a reply addressed to the granted canonical id), and `wake: false` turns a
	 * would-be revival into a mailbox queue instead.
	 */
	async #deliverLocal(
		envelope: IrcEnvelope,
		key: string,
		ref: AgentRef,
		opts?: IrcDeliveryOptions,
	): Promise<DeliveryResult> {
		// A `parked` recipient always needs the lifecycle to revive it — this is
		// read from *this* bus's registry, so it holds for any registry. The
		// mid-park / adopted checks below query the lifecycle's own state, which
		// only describes the registry it manages: consult them only when the
		// lifecycle owns this bus's registry, otherwise a custom-registry bus
		// (fallen back to the global manager) would gate a live recipient on
		// unrelated global park state. Main/non-adopted live peers skip the gate,
		// and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const gated =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(key) || lifecycle.has(key)));

		if (gated && opts?.wake === false) {
			// Revival is forbidden for this leg: the peer keeps its state and the
			// message waits in its mailbox instead. This is what lets a broadcast
			// reach a parked peer's inbox without waking the parked set.
			this.#enqueue(envelope, key);
			return { to: envelope.to, outcome: "injected" };
		}

		const priorSession = getLocalSession(ref);
		let revived = false;
		if (gated) {
			try {
				const live = await lifecycle.ensureLive(key);
				if (live.kind !== "local") {
					return {
						to: envelope.to,
						outcome: "failed",
						error: `Agent "${envelope.to}" was revived by a remote runtime; this bus cannot deliver to it.`,
					};
				}
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || live.session !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: envelope.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(key, envelope.from);
		if (waiter) {
			waiter.resolve(envelope);
			if (!opts?.suppressRelay) this.#relayToMainUi(envelope);
			return { to: envelope.to, outcome: revived ? "revived" : "injected" };
		}

		const session = getLocalSession(this.#registry.get(key) ?? ref);
		if (!session) {
			return { to: envelope.to, outcome: "failed", error: `Agent "${envelope.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(envelope, { expectsReply: opts?.expectsReply });
			if (!opts?.suppressRelay) this.#relayToMainUi(envelope);
			return { to: envelope.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(envelope, key);
			return {
				to: envelope.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Park a waiter and hand back its promise plus a cancel handle.
	 *
	 * Registration is synchronous up to the waiter entering the queue, which is
	 * what lets {@link IrcBus.waitReply} guarantee "waiter first, then send".
	 */
	#park(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal: AbortSignal | undefined,
		options: {
			drainPending?: boolean;
			liveness?: { registry: AgentRegistry; senderId: string };
			awaitTarget?: { registry: AgentRegistry; target: string };
		} = {},
		skipDrain = false,
	): IrcParked {
		const key = this.#stableKey(agentId);
		if (!skipDrain && options.drainPending !== false) {
			const pending = this.#takeFromMailbox(key, filter.from);
			if (pending) return { promise: Promise.resolve(pending), cancel: () => {} };
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;
		let unsubscribeAwaitTarget: (() => void) | undefined;

		const liveness = options.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(key, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
			unsubscribeAwaitTarget?.();
		};

		const waiter: IrcWaiter = {
			// The from-filter stays raw here and is canonicalized at matching time:
			// a pending grant may resolve after this waiter parks, so only a
			// dynamic comparison sees the native id and its later canonical alias
			// as the same peer.
			from: filter.from,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => {
				settled = true;
				cleanup();
			},
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(key);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(key, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasRunningSender = (from?: string): boolean =>
				registry
					.listVisibleTo(senderId)
					.some(ref => registry.isRunning(ref) && (!from || this.#canonicalize(ref.id) === this.#canonicalize(from)));
			const check = filter.from ? () => hasRunningSender(filter.from) : () => hasRunningSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		// `send await:true`: settle the sender promptly once the awaited peer
		// reaches a terminal stop without replying, instead of stranding it on
		// the full timeout. Unlike `liveness`, this tolerates a peer that is
		// idle/parked when the send lands (the send is about to wake or revive
		// it): it only aborts once the peer has actually been observed running
		// and then stopped, or is unambiguously gone (unregistered / aborted).
		// A real reply resolves the waiter first (the recipient sends it mid-turn,
		// before the turn-end idle transition), so cleanup tears this down.
		const awaitTarget = options.awaitTarget;
		if (awaitTarget) {
			const { registry, target } = awaitTarget;
			const targetKey = this.#canonicalize(target);
			let subscribedSession: AgentSession | null = null;
			let unsubscribeSession: (() => void) | undefined;
			let active = true;
			// A remote peer has no local session to subscribe to: its stop is
			// observed on the registry, and its verdict is only final once the run
			// has drained its replies — a terminal run with replies still in
			// flight is exactly the case that must not read as "stopped without
			// replying" (RFC #1 §6.5).
			/** The run a remote waiter is currently watching drain, if any. */
			let watchedRemoteRunId: string | null = null;
			const settleStopped = (): void => settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
			/**
			 * Judge a remote peer's run from what its connection observed, never
			 * from an endpoint snapshot: that snapshot can still describe the
			 * peer's previous execution. A run already drained when this waiter
			 * registered belongs to that previous execution and decides nothing;
			 * a run still in flight does, and a newer run supersedes the one being
			 * watched. The verdict is only final once the run being watched has
			 * drained its replies.
			 */
			const syncRemoteRun = (): void => {
				const state = this.#remoteRuns.get(targetKey);
				if (!state) return;
				const currentRunId = state.currentRunId;
				if (currentRunId === null) return;
				if (watchedRemoteRunId !== currentRunId) {
					// A run that had already drained before this waiter registered
					// is the peer's previous execution: it decides nothing, and
					// watching it would stop a wait the new send has not answered.
					if (watchedRemoteRunId === null && state.currentRunDrained) return;
					watchedRemoteRunId = currentRunId;
				}
				if (!state.currentRunDrained) return;
				settleStopped();
			};
			// The peer's terminal `agent_end` is the authoritative "stopped" signal.
			// It is emitted only after the peer's prompt fully unwinds (see
			// AgentSession#flushPendingAgentEnd) and supersedes scheduled
			// continuations. A side-channel auto-reply may outlive that main turn,
			// though, so wait for it before declaring the peer stopped: its bus send
			// resolves this waiter first; an empty/failed reply then falls through to
			// the clean stopped result.
			const onSessionEvent = (event: AgentSessionEvent): void => {
				if (event.type !== "agent_end" || event.isTerminal === false) return;
				const session = subscribedSession;
				if (!session) {
					settleStopped();
					return;
				}
				void session.waitForIrcReplies().then(() => {
					if (!active || getLocalSession(this.#resolveRef(targetKey, target)) !== session) return;
					settleStopped();
				});
			};
			const sync = (): void => {
				const ref = this.#resolveRef(targetKey, target);
				// D2 dependency: loss of observation ends this wait without claiming
				// the peer stopped.
				if (ref?.status === "execution-unknown") {
					settle({ kind: "abort", error: new Error(`Awaited peer "${target}" has execution-unknown status.`) });
					return;
				}
				// Gone or hard-aborted: no reply will ever come.
				if (!ref || ref.status === "aborted") {
					settleStopped();
					return;
				}
				// A remote peer runs elsewhere: its session cannot be subscribed to,
				// so its stop is read from the runs its connection reports and
				// confirmed by that run's reply-drained barrier instead of a local
				// `agent_end`. Parked is a legal starting state here — the send is
				// about to revive it — and never a stopped-without-reply fact.
				if (ref.endpoint.kind === "remote") {
					syncRemoteRun();
					return;
				}
				// Follow the live session across a park→revive rebuild; tolerate a
				// parked peer with no session yet (the send is about to revive it).
				const session = getLocalSession(ref);
				if (session && session !== subscribedSession) {
					unsubscribeSession?.();
					subscribedSession = session;
					unsubscribeSession = session.subscribe(onSessionEvent);
				}
			};
			const unsubscribeChange = registry.onChange(sync);
			const onRemoteRun = (peerKey: string): void => {
				if (!active) return;
				if (peerKey === targetKey) sync();
			};
			this.#remoteRunListeners.add(onRemoteRun);
			unsubscribeAwaitTarget = () => {
				active = false;
				this.#remoteRunListeners.delete(onRemoteRun);
				unsubscribeChange();
				unsubscribeSession?.();
			};
			sync();
		}

		return {
			promise,
			cancel: () => waiter.cancel(),
		};
	}

	#enqueue(message: IrcMessage, key: string): void {
		let mailbox = this.#mailboxes.get(key);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(key, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: key,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const sender = this.#canonicalize(from);
		const index = waiters.findIndex(waiter => !waiter.from || this.#canonicalize(waiter.from) === sender);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const key = this.#stableKey(agentId);
		const mailbox = this.#mailboxes.get(key);
		if (!mailbox) return undefined;
		const sender = from === undefined ? undefined : this.#canonicalize(from);
		const index = sender === undefined ? 0 : mailbox.findIndex(msg => this.#canonicalize(msg.from) === sender);
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(key);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		const mainKey = this.#canonicalize(MAIN_AGENT_ID);
		if (this.#canonicalize(message.to) === mainKey || this.#canonicalize(message.from) === mainKey) return;
		const mainSession = getLocalSession(this.#registry.get(mainKey) ?? this.#registry.get(MAIN_AGENT_ID));
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
