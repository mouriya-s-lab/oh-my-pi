/**
 * Peer-scoped resource channel (#13).
 *
 * A `ResourceRef` is opaque: `reference` semantics live on the owning peer,
 * `displayPath` is UI display ONLY and must never be opened locally. Any
 * attempt to open a remote `displayPath` with `fs`/`Bun.file` is a
 * `ResourceOwnershipError` with `code: "remote-path-not-local"`, never ENOENT.
 * Cross-peer reads (a `peerId` that does not match the connection's bound
 * owner peer) are refused as `{ status: "forbidden", code:
 * "cross-peer-forbidden" }` and surface as the same error class.
 */
import { createHash } from "node:crypto";

export interface ResourceRef {
	readonly kind: "result" | "history" | "attachment" | "structured";
	readonly peerId: string;
	readonly sessionId: string;
	readonly mediaType: string;
	readonly availability: "available" | "unavailable" | "expired" | "forbidden";
	readonly displayPath?: string;
	readonly byteLength?: number;
	readonly checksum?: string;
}

export interface ResourceChunk {
	readonly ref: ResourceRef;
	readonly offset: number;
	readonly bytes: Uint8Array;
	readonly hash: string;
	readonly final: boolean;
}

export class ResourceOwnershipError extends Error {
	constructor(
		readonly code: "remote-path-not-local" | "cross-peer-forbidden",
		message: string,
	) {
		super(message);
		this.name = "ResourceOwnershipError";
	}
}

/** Query an endpoint answers via {@link AgentEndpoint.readResource}. */
export interface ResourceReadQuery {
	readonly kind: ResourceRef["kind"];
	readonly ref: string;
	readonly peerId: string;
	readonly offset?: number;
	readonly length?: number;
	readonly probe?: boolean;
}

/** One UI request a peer raises; an absent answer is a cancel, never approval. */
export interface UiRequest {
	readonly requestId: string;
	readonly kind: "select" | "confirm" | "input" | "editor" | "notify";
	readonly title?: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly placeholder?: string;
	readonly prefill?: string;
	readonly timeoutMs?: number;
}

/** Answer to a {@link UiRequest}; `unavailable` distinguishes no-adapter from disconnect. */
export type UiResponse =
	| { readonly requestId: string; readonly kind: "response"; readonly value: unknown }
	| { readonly requestId: string; readonly kind: "cancelled" }
	| { readonly requestId: string; readonly kind: "unavailable"; readonly reason: "no-ui" | "disconnected" };

/** Bounded UI round-trip budget (~30s); callers may override per request. */
export const UI_BRIDGE_TIMEOUT_MS = 30_000;

/**
 * Throw `ResourceOwnershipError { code: "remote-path-not-local" }` when `ref`
 * names a remote display path that must never be opened locally. Local refs
 * (peerId `"local"` with a non-`/remote/` path) pass through.
 */
export function assertLocalDisplayPath(ref: ResourceRef): void {
	const displayPath = ref.displayPath;
	if (displayPath === undefined) return;
	if (displayPath.startsWith("/remote/") || ref.peerId !== "local") {
		throw new ResourceOwnershipError(
			"remote-path-not-local",
			`Remote resource display path is not locally openable: ${displayPath}`,
		);
	}
}

/** Throw for a bare remote display path without a full ref (URI/test helper). */
export function assertLocalDisplayPathString(displayPath: string, peerId = "remote"): void {
	if (displayPath.startsWith("/remote/") || peerId !== "local") {
		throw new ResourceOwnershipError(
			"remote-path-not-local",
			`Remote resource display path is not locally openable: ${displayPath}`,
		);
	}
}

/** sha256 hex of raw resource bytes; chunk integrity check. */
export function hashResourceBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Encode text as resource bytes. */
export function textToResourceBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Decode resource bytes as UTF-8 text. */
export function resourceBytesToText(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** Build a single final chunk carrying the full payload. */
export function singleResourceChunk(ref: ResourceRef, text: string, offset = 0): ResourceChunk {
	const bytes = textToResourceBytes(text);
	return { ref, offset, bytes, hash: hashResourceBytes(bytes), final: true };
}
