/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { AgentEndpoint } from "../task/endpoint";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/** Sidecar marker retained beside a child transcript after an explicit kill. */
const AGENT_TOMBSTONE_SUFFIX = ".tombstone";

export function getAgentTombstonePath(sessionFile: string): string {
	return `${sessionFile}${AGENT_TOMBSTONE_SUFFIX}`;
}

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 * - `execution-unknown`: observation ended without a trustworthy run outcome; the remote reference remains usable.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted" | "execution-unknown";

/** Terminal observation does not imply that the agent cannot be revived. */
export function isTerminalAgentStatus(status: AgentStatus): boolean {
	return status === "parked" || status === "aborted" || status === "execution-unknown";
}

export function isAgentUnknown(status: AgentStatus): boolean {
	return status === "execution-unknown";
}

// D2 dependency: local session ownership and opaque remote identity are disjoint.
export type AgentRefEndpoint =
	| { kind: "local"; session: AgentSession | null; sessionFile: string | null }
	| { kind: "remote"; reference: string; endpoint: AgentEndpoint | null };
/** Provenance of a displayed duration: active runtime, transcript span, or unavailable. */
type AgentDurationKind = "active" | "span" | "unknown";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`hub`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

/** Persisted per-agent totals reconstructed from the child session transcript. */
export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: AgentDurationKind;
	contextTokens?: number;
	contextWindow?: number;
}

/** Historical identity and telemetry that remain available after the live session is disposed. */
export interface AgentHistorySummary {
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	/** Whether the last resolved model was selected by retry fallback routing. */
	resolvedModelIsFallback?: boolean;
	metrics?: AgentMetricsSummary;
	readOnly?: boolean;
	/** Durable task output artifact, when the executor wrote one. */
	outputPath?: string;
	/** Captured isolated-worktree patch, when patch capture succeeded. */
	patchPath?: string;
	/** Isolated branch identity, when branch-mode capture succeeded. */
	branchName?: string;
}

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	endpoint: AgentRefEndpoint;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
}

export function getLocalSession(ref: AgentRef | null | undefined): AgentSession | null {
	return ref?.endpoint.kind === "local" ? ref.endpoint.session : null;
}

export function getLocalSessionFile(ref: AgentRef | null | undefined): string | null {
	return ref?.endpoint.kind === "local" ? ref.endpoint.sessionFile : null;
}

export type AgentRefExpectation = AgentRef | AgentSession;

/** Separator between a peer's native name and its coordinator scope in a canonical id. */
const MANAGED_PEER_ID_SEPARATOR = "@";

/**
 * The binding one managed connection declared in its `prepare` handshake.
 *
 * The root coordinator mints `ownerPeerId` for the connection's root peer and
 * lists the canonical ids the connection may speak for; a connection never
 * nominates its own scope. `generation` is the coordinator's ownership epoch:
 * a newer binding supersedes an older one (resume), and a frame still carrying
 * the older generation is refused as stale.
 *
 * Generations are unique across every connection one registry coordinates, not
 * merely within one owner: the inbound ledger deduplicates an operation by
 * `(generation, operationId)`, so two connections sharing a generation number
 * would share a dedup namespace and a frame replaying another connection's
 * operation id could be answered from its cache. The coordinator therefore
 * draws generations from one registry-wide monotonic counter, while stale
 * comparisons stay per-owner.
 */
export interface ManagedConnectionBinding {
	/** Canonical id the coordinator assigned to this connection's owner peer. */
	ownerPeerId: string;
	/** Ownership generation; a newer binding for the same owner supersedes this one. */
	generation: number;
	/** Canonical ids this connection may speak for (owner peer + its descendants). */
	allowedDescendants: readonly string[];
}

/**
 * One native↔canonical identity mapping owned by a managed connection.
 *
 * `canonicalId` is the only cross-connection routing key; `nativeId` is what
 * the owning runtime calls the peer internally (its own `Main` for a remote
 * root). Display names are never routing keys, so two remote runtimes whose
 * native roots are both `Main` resolve to distinct canonical ids.
 */
export interface ManagedPeerIdentity {
	canonicalId: string;
	nativeId: string;
	ownerPeerId: string;
	generation: number;
}

/** Why a managed frame's sender claim was refused. */
export type ManagedSendRefusal = "unbound" | "stale" | "revoked" | "spoofed";

/** Outcome of authorizing one managed frame's `from` against a connection binding. */
export type ManagedFrameAuthorization =
	| { authorized: true; canonicalId: string; identity?: ManagedPeerIdentity }
	| { authorized: false; reason: ManagedSendRefusal };

/** Route registration input for a peer reachable through a managed connection. */
export interface ManagedPeerRegistration {
	identity: ManagedPeerIdentity;
	/** Opaque endpoint reference backing this route (the peer's D2 handle). */
	reference: string;
	displayName: string;
	kind?: AgentKind;
	parentId?: string;
	status?: AgentStatus;
	activity?: string;
	/** Connected endpoint when the route is live; null while the connection is down. */
	endpoint?: AgentEndpoint | null;
	createdAt?: number;
	lastActivity?: number;
}

/** One root allocation: the canonical id plus the binding its connection carries. */
export interface ManagedRootAllocation {
	peerId: string;
	binding: ManagedConnectionBinding;
}

/** Declare one of this runtime's own peers under its canonical id (receiver side). */
export interface ManagedLocalAliasInput {
	identity: ManagedPeerIdentity;
	/** Connection binding to install alongside the identity (prepare handshake). */
	binding?: ManagedConnectionBinding;
}

/** Name a native descendant of a connected runtime; the coordinator mints its id. */
export interface AllocateManagedDescendantInput {
	ownerPeerId: string;
	generation: number;
	nativeId: string;
	/** Reuse a canonical id (resume); minted under the owner's scope when absent. */
	canonicalId?: string;
}

export interface AllocateManagedRootInput {
	/** Native root name the peer calls itself (a remote runtime's own `Main`). */
	nativeId: string;
	/** Coordinator scope disambiguating identical native names (host alias, connection label). */
	scope: string;
	/** Reuse a previously allocated canonical id (resume); minted when absent. */
	peerId?: string;
	/**
	 * Ownership generation to bind. Omit it and this registry issues the next
	 * unused one from its registry-wide counter; pin it only to echo a value the
	 * caller already holds (a resume), and the counter still moves past it.
	 */
	generation?: number;
}

/** Compose the coordinator's canonical id for a native peer name within a scope. */
export function managedPeerId(nativeId: string, scope: string): string {
	const nativeToken = sanitizePeerIdToken(nativeId);
	const scopeToken = sanitizePeerIdToken(scope);
	return `${nativeToken}${MANAGED_PEER_ID_SEPARATOR}${scopeToken}`;
}

function sanitizePeerIdToken(token: string): string {
	const cleaned = token
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[@#]/g, "-")
		.replace(/[^\w.-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 48) : "peer";
}

function managedNativeKey(ownerPeerId: string, nativeId: string): string {
	return `${ownerPeerId}\u0000${nativeId}`;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	endpoint: AgentRefEndpoint;
	status?: AgentStatus;
	/** Last persisted task summary, when restoring a historical agent. */
	activity?: string;
	/** Original registration timestamp, when known from persisted history. */
	createdAt?: number;
	/** Last transcript activity timestamp, when known from persisted history. */
	lastActivity?: number;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();
	/** Managed connection bindings, keyed by the canonical owner peer id. */
	readonly #managedBindings = new Map<string, ManagedConnectionBinding>();
	/** Canonical id → native identity mapping, the only cross-connection routing key. */
	readonly #managedIdentities = new Map<string, ManagedPeerIdentity>();
	/** `ownerPeerId\0nativeId` → canonical id, for mappings with a known native peer. */
	readonly #managedNativeIndex = new Map<string, string>();
	/** Owners with a revoked binding: a later unbound frame reports revoked, not unbound. */
	readonly #revokedManagedOwners = new Set<string>();
	/** Highest accepted ownership generation per owner; survives revocation so a revoked generation cannot rebind. */
	readonly #managedGenerationHighWater = new Map<string, number>();
	/** This runtime's own native id → the canonical id frames carry for it. */
	readonly #managedLocalAliases = new Map<string, string>();
	/** Canonical id → the local ref id this runtime delivers it through. */
	readonly #managedLocalRefIds = new Map<string, string>();
	/** Live transport per managed owner, applied to refs registered later. */
	readonly #managedEndpoints = new Map<string, { generation: number; endpoint: AgentEndpoint }>();
	/**
	 * Highest ownership generation this registry has issued or observed.
	 *
	 * One counter per registry, not per owner: operations are deduplicated by
	 * `(generation, operationId)` on the receiving side, so two connections that
	 * picked the same number would share that namespace and a replayed operation
	 * could collect the other connection's cached result. Drawing every
	 * generation from this monotonic sequence keeps the keys disjoint while
	 * stale checks stay comparisons within one owner.
	 */
	#managedGeneration = 0;

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || getLocalSession(ref) === expected;
	}

	#rejectStatusUpdate(id: string, status: AgentStatus, reason: string): false {
		logger.debug("Agent registry status update rejected", { id, status, reason });
		return false;
	}

	/**
	 * Mint the canonical id for a native peer name inside one coordinator scope.
	 *
	 * The coordinator — never a connection — names peers: two runtimes whose
	 * native roots are both `Main` mint distinct ids because their scopes differ,
	 * and a scope that collides with an already-taken id is suffixed rather than
	 * aliased. Display names never participate, so renaming a peer cannot reroute
	 * traffic.
	 */
	mintCanonicalPeerId(nativeId: string, scope: string): string {
		const base = managedPeerId(nativeId, scope);
		if (!this.#isPeerIdTaken(base)) return base;
		for (let suffix = 2; suffix < 1000; suffix++) {
			const candidate = `${base}-${suffix}`;
			if (!this.#isPeerIdTaken(candidate)) return candidate;
		}
		throw new Error(`Cannot mint a canonical peer id for "${nativeId}" in scope "${scope}".`);
	}

	#isPeerIdTaken(id: string): boolean {
		return this.#refs.has(id) || this.#managedIdentities.has(id) || this.#managedBindings.has(id);
	}

	/** Next unused ownership generation: the counter only ever moves forward. */
	#issueManagedGeneration(): number {
		this.#managedGeneration += 1;
		return this.#managedGeneration;
	}

	/** Lift the counter past a generation the caller pinned, so it stays unique. */
	#observeManagedGeneration(generation: number): void {
		if (generation > this.#managedGeneration) this.#managedGeneration = generation;
	}

	/**
	 * Allocate the canonical root peer for one managed connection and bind its
	 * ownership generation. The returned binding is what the connection carries
	 * in its `prepare` handshake — the connection echoes it, it never invents it.
	 * A resume that names its previous `peerId` keeps that id and bumps the
	 * generation, which is what marks the previous connection's frames stale.
	 */
	allocateManagedRoot(input: AllocateManagedRootInput): ManagedRootAllocation {
		const peerId = input.peerId ?? this.mintCanonicalPeerId(input.nativeId, input.scope);
		// A caller may pin the generation (a resume echoing one it already holds,
		// or a fixture): the counter is lifted past it so the next allocation is
		// still unique. Otherwise this registry issues the next unused number —
		// never `current + 1` per owner, which is how two connections end up
		// sharing a `(generation, operationId)` dedup namespace.
		const generation = input.generation ?? this.#issueManagedGeneration();
		const binding = this.bindManagedConnection({
			ownerPeerId: peerId,
			generation,
			allowedDescendants: this.#managedBindings.get(peerId)?.allowedDescendants ?? [],
		});
		if (!binding) {
			throw new Error(`Cannot allocate managed root "${peerId}": stale or revoked generation ${generation}.`);
		}
		this.mapManagedPeerIdentity(
			{ canonicalId: peerId, nativeId: input.nativeId, ownerPeerId: peerId, generation: binding.generation },
			{ grantRoute: true },
		);
		return { peerId, binding };
	}

	/**
	 * Store or refresh the binding for one connection. A binding for a newer
	 * generation wins; an older one is ignored so a delayed handshake cannot roll
	 * back an ownership revocation. The per-owner high-water mark survives
	 * revocation: a revoked generation cannot rebind at the same or an older
	 * number, only a strictly newer generation resumes the owner (and clears the
	 * revoked marker). A same-generation update of a still-live binding is kept
	 * so roster extension (grantManagedRoute via rebind) still applies.
	 */
	bindManagedConnection(binding: ManagedConnectionBinding): ManagedConnectionBinding | undefined {
		const highWater = this.#managedGenerationHighWater.get(binding.ownerPeerId);
		if (highWater !== undefined && binding.generation < highWater) return undefined;
		if (highWater !== undefined && binding.generation === highWater) {
			if (this.#revokedManagedOwners.has(binding.ownerPeerId)) return undefined;
			const live = this.#managedBindings.get(binding.ownerPeerId);
			if (!live || live.generation !== binding.generation) return undefined;
		}
		const current = this.#managedBindings.get(binding.ownerPeerId);
		if (current && current.generation > binding.generation) return undefined;
		const isNewHigh = highWater === undefined || binding.generation > highWater;
		const stored: ManagedConnectionBinding = {
			ownerPeerId: binding.ownerPeerId,
			generation: binding.generation,
			allowedDescendants: [...binding.allowedDescendants],
		};
		this.#managedBindings.set(binding.ownerPeerId, stored);
		this.#managedGenerationHighWater.set(binding.ownerPeerId, binding.generation);
		if (isNewHigh) this.#revokedManagedOwners.delete(binding.ownerPeerId);
		// Every binding — issued here or accepted from the coordinator — lifts the
		// counter past its generation, so a pinned or received number is never
		// handed out again to a different connection.
		this.#observeManagedGeneration(stored.generation);
		return stored;
	}

	getManagedConnectionBinding(ownerPeerId: string): ManagedConnectionBinding | undefined {
		return this.#managedBindings.get(ownerPeerId);
	}

	/**
	 * Record one native↔canonical identity. `grantRoute` additionally authorizes
	 * the canonical id as a sender for its connection, which is what a peer that
	 * registers itself (or is announced by its owner) needs before it can speak.
	 */
	mapManagedPeerIdentity(identity: ManagedPeerIdentity, opts?: { grantRoute?: boolean }): void {
		this.#managedIdentities.set(identity.canonicalId, identity);
		this.#managedNativeIndex.set(managedNativeKey(identity.ownerPeerId, identity.nativeId), identity.canonicalId);
		if (opts?.grantRoute) this.grantManagedRoute(identity.ownerPeerId, identity.canonicalId);
	}

	/** Extend a connection's allowed sender set with a coordinator-allocated id. */
	grantManagedRoute(ownerPeerId: string, canonicalId: string): void {
		const binding = this.#managedBindings.get(ownerPeerId);
		if (!binding) return;
		if (canonicalId === ownerPeerId || binding.allowedDescendants.includes(canonicalId)) return;
		this.#managedBindings.set(ownerPeerId, {
			ownerPeerId,
			generation: binding.generation,
			allowedDescendants: [...binding.allowedDescendants, canonicalId],
		});
	}

	managedPeerIdentity(canonicalId: string): ManagedPeerIdentity | undefined {
		return this.#managedIdentities.get(canonicalId);
	}

	managedPeerIdentityByNative(ownerPeerId: string, nativeId: string): ManagedPeerIdentity | undefined {
		const canonicalId = this.#managedNativeIndex.get(managedNativeKey(ownerPeerId, nativeId));
		return canonicalId === undefined ? undefined : this.#managedIdentities.get(canonicalId);
	}

	/** Canonical id a runtime must put on the wire for one of its native peers. */
	managedCanonicalForNative(ownerPeerId: string, nativeId: string): string | undefined {
		return this.#managedNativeIndex.get(managedNativeKey(ownerPeerId, nativeId));
	}

	/** Native name a receiving runtime addresses locally for a canonical id. */
	managedNativeForCanonical(canonicalId: string): string | undefined {
		return this.#managedIdentities.get(canonicalId)?.nativeId;
	}

	/**
	 * Authorize the `from` a managed frame claims against its connection binding.
	 *
	 * The binding, not the frame, decides: a sender must be the connection owner
	 * or an id the coordinator granted that connection (its bound
	 * allowedDescendants). An identity mapping alone never authorizes — a `from`
	 * mapped under the owner but outside the explicit owner/allowlist is refused
	 * as spoofed, as is one mapped to a different owner or an older generation,
	 * rather than resolved to whatever local peer happens to share the name.
	 */
	authorizeManagedSender(ownerPeerId: string, generation: number, from: string): ManagedFrameAuthorization {
		const binding = this.#managedBindings.get(ownerPeerId);
		if (!binding) {
			return { authorized: false, reason: this.#revokedManagedOwners.has(ownerPeerId) ? "revoked" : "unbound" };
		}
		if (generation !== binding.generation) return { authorized: false, reason: "stale" };
		const identity = this.#managedIdentities.get(from);
		if (from === binding.ownerPeerId || binding.allowedDescendants.includes(from)) {
			if (identity && (identity.ownerPeerId !== ownerPeerId || identity.generation !== generation)) {
				return { authorized: false, reason: "spoofed" };
			}
			return identity ? { authorized: true, canonicalId: from, identity } : { authorized: true, canonicalId: from };
		}
		return { authorized: false, reason: "spoofed" };
	}

	/**
	 * Register (or re-route) a peer reachable through a managed connection.
	 *
	 * The ref id is the canonical peer id, so routing keys are coordinator ids —
	 * never display names. Re-registering an existing canonical id re-points the
	 * route at the new connection generation and identity while preserving the
	 * ref's lifecycle status: a parked route stays parked until something
	 * deliberately resumes it.
	 */
	registerManagedPeer(input: ManagedPeerRegistration): AgentRef {
		const { identity } = input;
		this.mapManagedPeerIdentity(identity, { grantRoute: true });
		const existing = this.#refs.get(identity.canonicalId);
		if (existing) {
			// A local ref may never be re-pointed at a remote route.
			if (existing.endpoint.kind !== "remote") return existing;
			existing.endpoint.reference = input.reference;
			existing.endpoint.endpoint = input.endpoint ?? this.#attachedManagedEndpoint(identity.ownerPeerId, identity.generation) ?? null;
			existing.displayName = input.displayName;
			if (input.parentId !== undefined) existing.parentId = input.parentId;
			if (input.activity !== undefined) existing.activity = input.activity;
			this.#emit({ type: "metadata_changed", ref: existing });
			return existing;
		}
		return this.register({
			id: identity.canonicalId,
			displayName: input.displayName,
			kind: input.kind ?? "sub",
			parentId: input.parentId,
			endpoint: {
				kind: "remote",
				reference: input.reference,
				endpoint: input.endpoint ?? this.#attachedManagedEndpoint(identity.ownerPeerId, identity.generation) ?? null,
			},
			status: input.status ?? "running",
			activity: input.activity,
			createdAt: input.createdAt,
			lastActivity: input.lastActivity,
		});
	}

	/**
	 * Revoke a connection's routes and ownership generation.
	 *
	 * The whole generation goes at once: binding and identities are dropped, and
	 * every live route it owned becomes `execution-unknown` rather than claiming
	 * a stop the peer never reported. Parked and aborted refs are left exactly as
	 * they were — a parked peer stays parked, and its transcript stays readable —
	 * while a stale revocation (a generation the binding already superseded) is a
	 * no-op. Returns the live refs whose status this changed.
	 */
	revokeManagedConnection(ownerPeerId: string, generation?: number): AgentRef[] {
		const binding = this.#managedBindings.get(ownerPeerId);
		if (generation !== undefined && binding && binding.generation !== generation) return [];
		this.#managedBindings.delete(ownerPeerId);
		this.#revokedManagedOwners.add(ownerPeerId);
		// The transport dies with the connection: its attachment must not linger
		// and hand a revoked owner's frames to a session that no longer owns them.
		this.#managedEndpoints.delete(ownerPeerId);
		const touched: AgentRef[] = [];
		for (const [canonicalId, identity] of this.#managedIdentities) {
			if (identity.ownerPeerId !== ownerPeerId) continue;
			this.#managedIdentities.delete(canonicalId);
			this.#managedNativeIndex.delete(managedNativeKey(identity.ownerPeerId, identity.nativeId));
			// Drop the local alias too: once the connection is gone, continuing to
			// rewrite this runtime's own ids into its canonical ids would address a
			// peer that no longer has a route.
			if (this.#managedLocalAliases.get(identity.nativeId) === canonicalId) {
				this.#managedLocalAliases.delete(identity.nativeId);
			}
			this.#managedLocalRefIds.delete(canonicalId);
			const ref = this.#refs.get(canonicalId);
			if (!ref || ref.endpoint.kind !== "remote") continue;
			ref.endpoint.endpoint = null;
			if (ref.status === "running" || ref.status === "idle") {
				this.setStatus(canonicalId, "execution-unknown", ref);
				touched.push(ref);
			}
		}
		return touched;
	}

	/**
	 * Record that one of this runtime's own peers is addressed canonically by the
	 * rest of the domain: `nativeId` is the id its local refs and mailboxes use,
	 * `canonicalId` the id frames carry on the wire. Called for the runtime's own
	 * root (its `Main`) and for each of its descendants once the coordinator has
	 * named them, which is what keeps the whole native tree addressable through
	 * canonical ids instead of flattening it.
	 *
	 * The runtime that owns a peer is the only place where this mapping is a fact
	 * (its `Main` is really its `Main`), which is why the alias lives here rather
	 * than being inferred from a frame. No route is granted: the peer still has to
	 * be announced to the coordinator before the connection may speak for it.
	 */
	registerManagedLocalAlias(input: ManagedLocalAliasInput): ManagedPeerIdentity {
		const { identity } = input;
		this.#managedLocalAliases.set(identity.nativeId, identity.canonicalId);
		this.#managedLocalRefIds.set(identity.canonicalId, identity.nativeId);
		this.mapManagedPeerIdentity(identity);
		if (input.binding) this.bindManagedConnection(input.binding);
		return identity;
	}

	/**
	 * The canonical id a frame must carry for one of this runtime's own peers.
	 * Ids with no alias — every peer of a runtime that owns no managed
	 * connection, and any id already canonical — pass through unchanged, so a
	 * plain single-runtime send canonicalizes nothing.
	 */
	canonicalizeManagedPeerId(localId: string): string {
		return this.#managedLocalAliases.get(localId) ?? localId;
	}

	/** The local ref id this runtime delivers a canonical peer id through. */
	resolveManagedLocalRefId(canonicalId: string): string {
		return this.#managedLocalRefIds.get(canonicalId) ?? canonicalId;
	}

	/**
	 * Allocate the canonical id for a native child of a connected runtime.
	 *
	 * Only the connection's own binding generation may name peers, and the minted
	 * id is scoped by the owner's canonical id — so a remote runtime's internal
	 * names cannot collide with another runtime's, and the coordinator still owns
	 * allocation. Returns undefined when the owner is unbound or its generation
	 * is stale: an old connection never gets to name new peers.
	 */
	allocateManagedDescendant(input: AllocateManagedDescendantInput): ManagedPeerIdentity | undefined {
		const binding = this.#managedBindings.get(input.ownerPeerId);
		if (!binding || binding.generation !== input.generation) return undefined;
		const canonicalId = input.canonicalId ?? this.mintCanonicalPeerId(input.nativeId, input.ownerPeerId);
		const identity: ManagedPeerIdentity = {
			canonicalId,
			nativeId: input.nativeId,
			ownerPeerId: input.ownerPeerId,
			generation: input.generation,
		};
		this.mapManagedPeerIdentity(identity, { grantRoute: true });
		return identity;
	}

	/**
	 * The live transport for one owner's connection, when its generation matches.
	 * An attachment from a superseded generation is not a transport for a current
	 * peer, so it is never applied.
	 */
	#attachedManagedEndpoint(ownerPeerId: string, generation: number): AgentEndpoint | undefined {
		const attached = this.#managedEndpoints.get(ownerPeerId);
		return attached && attached.generation === generation ? attached.endpoint : undefined;
	}

	/**
	 * Attach the live transport for one managed connection.
	 *
	 * A coordinator registers a connection's routes (owner + descendants) before
	 * any transport exists, so those refs start with `endpoint: null`; the real
	 * connection is built afterwards and attaches itself here. Every ref the
	 * connection owns gets the endpoint, and so does every ref it registers
	 * later, so a peer announced after the transport came up is reachable
	 * immediately instead of staying null forever.
	 *
	 * Returns a detach handle that clears exactly the attachment it made
	 * (generation and endpoint both compared): a superseded connection's teardown
	 * can never detach its successor's transport. A stale or unbound owner is a
	 * no-op, and its handle is inert.
	 */
	attachManagedEndpoint(ownerPeerId: string, generation: number, endpoint: AgentEndpoint): () => void {
		const binding = this.#managedBindings.get(ownerPeerId);
		if (!binding || binding.generation !== generation) return () => {};
		this.#managedEndpoints.set(ownerPeerId, { generation, endpoint });
		for (const identity of this.#managedIdentities.values()) {
			if (identity.ownerPeerId !== ownerPeerId) continue;
			const ref = this.#refs.get(identity.canonicalId);
			if (ref?.endpoint.kind === "remote") ref.endpoint.endpoint = endpoint;
		}
		return () => {
			const current = this.#managedEndpoints.get(ownerPeerId);
			if (!current || current.generation !== generation || current.endpoint !== endpoint) return;
			this.#managedEndpoints.delete(ownerPeerId);
			for (const identity of this.#managedIdentities.values()) {
				if (identity.ownerPeerId !== ownerPeerId) continue;
				const ref = this.#refs.get(identity.canonicalId);
				if (ref?.endpoint.kind === "remote" && ref.endpoint.endpoint === endpoint) ref.endpoint.endpoint = null;
			}
		};
	}

	/** Canonical ids one managed connection owns, as the coordinator published them. */
	listManagedConnectionPeers(ownerPeerId: string): string[] {
		const ids: string[] = [];
		for (const identity of this.#managedIdentities.values()) {
			if (identity.ownerPeerId === ownerPeerId) ids.push(identity.canonicalId);
		}
		return ids;
	}

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			endpoint: input.endpoint,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: input.activity,
			history: input.history,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/**
	 * Register a new id only when it is absent, or reuse the exact detached
	 * `parked` ref a revival was authorized to revive. A missing, replaced, or
	 * terminal expected ref is a failed CAS: delayed revivers must never claim an
	 * id after its prior generation disappeared or was hard-killed.
	 */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.endpoint.kind === "local" && input.endpoint.kind === "local" &&
			current.status === "parked" && !getLocalSession(current) ? current : undefined;
	}

	/** Attach transcript-derived identity and telemetry without changing lifecycle state. */
	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref = this.#refs.get(id);
		if (!ref || (expectedSessionFile !== undefined && getLocalSessionFile(ref) !== expectedSessionFile)) return false;
		const definedHistory = Object.fromEntries(
			Object.entries(history).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (!this.#matchesExpected(ref, expected)) {
			return this.#rejectStatusUpdate(id, status, "session-ownership-changed");
		}
		// `aborted` is terminal: delayed progress/revival work from the killed
		// generation must never transition the tombstone back to a live status.
		if (ref.status === "aborted") {
			return status === "aborted" || this.#rejectStatusUpdate(id, status, "aborted-is-terminal");
		}
		if (ref.status === status) return true;
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		// Never attach a late-created session to a hard-killed tombstone. This
		// closes the race between a parked reviver claiming the ref and finishing
		// createAgentSession after an explicit kill.
		if (!ref || ref.endpoint.kind !== "local" || ref.status === "aborted" || !this.#matchesExpected(ref, expected)) {
			return false;
		}
		ref.endpoint.session = session;
		if (sessionFile !== undefined) ref.endpoint.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || ref.endpoint.kind !== "local" || !this.#matchesExpected(ref, expected)) return false;
		ref.endpoint.session = null;
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns live or execution-unknown agents except the caller. Advisor refs
	 * are observability-only transcripts, never peers, so they are excluded.
	 * Flat namespace: every other agent is visible.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => ref.id !== id && ref.kind !== "advisor" &&
				(ref.status === "running" || ref.status === "idle" || isAgentUnknown(ref.status)),
		);
	}

	/**
	 * Whether a ref's claimed running state is corroborated by its attached live session.
	 *
	 * A managed registered peer frame is authoritative: a `running` remote ref
	 * whose managed identity authorizes against its current binding (owner or
	 * bound allowlist, matching generation) is live even while its transport
	 * endpoint is still null, without requiring a fabricated AgentSession and
	 * without consulting a parent aggregate endpoint snapshot. Remote refs with
	 * no currently authorized managed identity keep the endpoint snapshot
	 * fallback; local behavior is unchanged.
	 */
	isRunning(ref: AgentRef): boolean {
		if (ref.status !== "running") return false;
		if (ref.endpoint.kind !== "remote") return getLocalSession(ref)?.isStreaming === true;
		const identity = this.#managedIdentities.get(ref.id);
		if (identity) {
			return this.authorizeManagedSender(identity.ownerPeerId, identity.generation, ref.id).authorized;
		}
		// D2 dependency: remote liveness comes from the endpoint, never a fabricated session.
		return ref.endpoint.endpoint?.asRosterSnapshot().status === "running";
	}

	/** Mirror a session's authoritative run-state notifications into its owned registry ref. */
	syncSessionStatus(id: string, session: AgentSession): () => void {
		const unsubscribe = session.subscribeRunState(status => {
			this.setStatus(id, status, session);
		});
		return unsubscribe;
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
