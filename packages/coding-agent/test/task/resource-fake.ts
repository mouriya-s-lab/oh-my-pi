/**
 * Fake remote resource table + fake UI adapter (#13 test seam).
 *
 * `endpoint-fake.ts` delegates its `readResource`/`respondUi` here so
 * resource-dispatch, view-no-wake, ui-bridge, and result-ref-first tests share
 * one in-memory peer: text keyed by `(kind, ref)` with per-entry availability,
 * plus a scripted UI answer. Cross-peer reads (query `peerId` not matching the
 * stored entry's owner) are refused as `forbidden/cross-peer-forbidden`.
 */

import {
	hashResourceBytes,
	textToResourceBytes,
	type ResourceReadQuery,
	type ResourceRef,
	type UiRequest,
	type UiResponse,
} from "@oh-my-pi/pi-coding-agent/task/resource";
import type { ResourceReadResult } from "@oh-my-pi/pi-coding-agent/task/endpoint";

export interface FakeResourceSetup {
	kind: ResourceRef["kind"];
	ref: string;
	peerId: string;
	sessionId?: string;
	mediaType?: string;
	text: string;
	displayPath?: string;
	availability?: ResourceRef["availability"];
}

function tableKey(kind: string, ref: string): string {
	return `${kind}\0${ref}`;
}

export class FakeResourceTable {
	readonly #entries = new Map<string, { ref: ResourceRef; text: string }>();
	#uiScript: UiResponse | undefined;
	#uiNoAdapter = false;
	#uiDisconnected = false;
	#uiCalls: UiRequest[] = [];

	get uiCalls(): readonly UiRequest[] {
		return this.#uiCalls;
	}

	set(entry: FakeResourceSetup): void {
		const ref: ResourceRef = {
			kind: entry.kind,
			peerId: entry.peerId,
			sessionId: entry.sessionId ?? `session-${entry.peerId}`,
			mediaType: entry.mediaType ?? "text/markdown",
			availability: entry.availability ?? "available",
			...(entry.displayPath === undefined ? {} : { displayPath: entry.displayPath }),
			byteLength: new TextEncoder().encode(entry.text).byteLength,
		};
		this.#entries.set(tableKey(entry.kind, entry.ref), { ref, text: entry.text });
	}

	setAvailability(kind: ResourceRef["kind"], ref: string, availability: ResourceRef["availability"]): void {
		const entry = this.#entries.get(tableKey(kind, ref));
		if (!entry) return;
		this.#entries.set(tableKey(kind, ref), { ref: { ...entry.ref, availability }, text: entry.text });
	}

	/** Script the next UI answer; cleared after one `respondUi`. */
	scriptUi(response: UiResponse): void {
		this.#uiScript = response;
	}

	setNoUi(noUi: boolean): void {
		this.#uiNoAdapter = noUi;
	}

	setDisconnected(disconnected: boolean): void {
		this.#uiDisconnected = disconnected;
	}

	async read(query: ResourceReadQuery): Promise<ResourceReadResult> {
		const entry = this.#entries.get(tableKey(query.kind, query.ref));
		if (!entry) return { status: "unavailable", reason: `unknown resource ${JSON.stringify(query.ref)}` };
		if (query.peerId !== entry.ref.peerId) {
			return { status: "forbidden", code: "cross-peer-forbidden" };
		}
		const availability = entry.ref.availability;
		if (availability === "forbidden") return { status: "forbidden", code: "cross-peer-forbidden" };
		if (availability === "expired") return { status: "expired" };
		if (availability === "unavailable") {
			return { status: "unavailable", reason: `resource ${JSON.stringify(query.ref)} unavailable` };
		}
		if (query.probe === true) return { status: "available", ref: entry.ref };
		const bytes = textToResourceBytes(entry.text);
		const offset = Math.max(0, query.offset ?? 0);
		const length = query.length ?? bytes.byteLength - offset;
		const slice = bytes.slice(offset, offset + Math.max(0, length));
		const final = offset + slice.byteLength >= bytes.byteLength;
		return {
			status: "chunk",
			chunk: { ref: entry.ref, offset, bytes: slice, hash: hashResourceBytes(slice), final },
		};
	}

	async answer(request: UiRequest): Promise<UiResponse> {
		this.#uiCalls.push(request);
		if (this.#uiDisconnected) return { requestId: request.requestId, kind: "unavailable", reason: "disconnected" };
		if (this.#uiNoAdapter) return { requestId: request.requestId, kind: "unavailable", reason: "no-ui" };
		const scripted = this.#uiScript;
		this.#uiScript = undefined;
		if (scripted) return { ...scripted, requestId: request.requestId };
		return { requestId: request.requestId, kind: "response", value: true };
	}
}
