import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@oh-my-pi/pi-utils";
import { readRpcCorrelation, type RpcChunkFrame, type RpcErrorCode, type RpcFrameLimits } from "./rpc-types";

export type { RpcFrameLimits };

/** Maximum UTF-8 size of one newline-delimited RPC frame, including the newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled by protocol v2. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Maximum payload bytes one protocol v2 resource chunk may carry. */
export const MAX_RPC_RESOURCE_CHUNK_BYTES = 256 * 1024;

/**
 * The limits every legacy peer already speaks. They are what an encoder or
 * decoder uses before `setLimits`, so a connection that negotiates nothing
 * serializes exactly the frames it always did.
 */
export const DEFAULT_RPC_FRAME_LIMITS: RpcFrameLimits = {
	maxFrameBytes: MAX_RPC_FRAME_BYTES,
	maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
	maxResourceChunkBytes: MAX_RPC_RESOURCE_CHUNK_BYTES,
};

/**
 * Bytes reserved for a chunk frame's own envelope — field names, index/count/
 * byteLength digits, the base64 quotes and the newline — so the payload budget
 * stays inside {@link RpcFrameLimits.maxFrameBytes} once base64 and JSON have
 * added their overhead.
 */
const CHUNK_FRAME_HEADROOM_BYTES = 1024;

/** The managed error a frame that cannot fit the negotiated limits is reported as. */
const FRAME_OVERFLOW_ERROR: RpcErrorCode = "protocol-incompatible";

export type RpcProtocolVersion = 1 | 2;

/** Positive finite numbers only; anything else is treated as "not proposed". */
function positiveLimit(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Fill in every field of a (possibly partial) limit set; malformed entries fall back to the defaults. */
function normalizeFrameLimits(value: Partial<RpcFrameLimits>): RpcFrameLimits {
	return {
		maxFrameBytes: positiveLimit(value.maxFrameBytes) ?? MAX_RPC_FRAME_BYTES,
		maxReassembledFrameBytes: positiveLimit(value.maxReassembledFrameBytes) ?? MAX_RPC_REASSEMBLED_BYTES,
		maxResourceChunkBytes: positiveLimit(value.maxResourceChunkBytes) ?? MAX_RPC_RESOURCE_CHUNK_BYTES,
	};
}

/**
 * Take the smaller value per field: a frame is only ever sent when both ends
 * can carry it. An unspecified or non-positive client proposal keeps the
 * server's value, so a peer that negotiates nothing lands on the defaults.
 */
export function negotiateRpcFrameLimits(client: Partial<RpcFrameLimits>, server: RpcFrameLimits): RpcFrameLimits {
	const mine = normalizeFrameLimits(client);
	const theirs = normalizeFrameLimits(server);
	return {
		maxFrameBytes: Math.min(mine.maxFrameBytes, theirs.maxFrameBytes),
		maxReassembledFrameBytes: Math.min(mine.maxReassembledFrameBytes, theirs.maxReassembledFrameBytes),
		maxResourceChunkBytes: Math.min(mine.maxResourceChunkBytes, theirs.maxResourceChunkBytes),
	};
}

/**
 * Payload bytes one chunk may carry: the negotiated resource-chunk cap, further
 * reduced so its base64 expansion plus the chunk envelope still fits a physical
 * frame. At the defaults this is exactly the historical 256 KiB chunk.
 */
function chunkPayloadBytes(limits: RpcFrameLimits): number {
	const base64Budget = Math.floor(((limits.maxFrameBytes - CHUNK_FRAME_HEADROOM_BYTES) * 3) / 4);
	return Math.max(1, Math.min(limits.maxResourceChunkBytes, base64Budget));
}

/**
 * A frame that violated the negotiated framing contract — malformed chunk
 * metadata, a payload over the chunk budget, a sequence that does not add up.
 *
 * It is a distinct type because the two failures it separates have different
 * handling: a broken *frame* is a protocol violation the caller reports and
 * stops on, while a broken *stream* is a lost connection. Both ends map this to
 * `protocol-incompatible` rather than to a transport verdict.
 */
export class RpcFrameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcFrameError";
	}
}

/** Everything the serializers need beyond the frame itself. */
interface RpcFrameEncodeContext {
	limits: RpcFrameLimits;
	/** Legacy bytes by default; managed adds codes and complete correlation to error frames. */
	managed: boolean;
}

interface PendingRpcChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Buffer[];
	receivedBytes: number;
}

interface ShrinkPass {
	stringCap: number;
	arrayLimit: number;
	objectLimit: number;
}

const SHRINK_PASSES: readonly ShrinkPass[] = [
	{ stringCap: 256 * 1024, arrayLimit: 512, objectLimit: 512 },
	{ stringCap: 64 * 1024, arrayLimit: 256, objectLimit: 256 },
	{ stringCap: 16 * 1024, arrayLimit: 128, objectLimit: 128 },
	{ stringCap: 4 * 1024, arrayLimit: 64, objectLimit: 64 },
	{ stringCap: 1024, arrayLimit: 32, objectLimit: 32 },
	{ stringCap: 256, arrayLimit: 8, objectLimit: 16 },
	{ stringCap: 64, arrayLimit: 1, objectLimit: 8 },
];

const STRING_ELISION_RESERVE = 80;
const METADATA_STRING_CAP = 1024;

function serializedFrameBytes(json: string): number {
	return Buffer.byteLength(json, "utf8") + 1;
}

function shrinkString(value: string, cap: number): string {
	if (value.length <= cap) return value;
	const headLength = Math.max(0, cap - STRING_ELISION_RESERVE);
	return `${value.slice(0, headLength)}\n…[${value.length - headLength} chars elided for RPC frame]`;
}

function shrinkValue(value: unknown, pass: ShrinkPass): unknown {
	if (typeof value === "string") return shrinkString(value, pass.stringCap);
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, pass.arrayLimit);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const output: unknown[] = new Array(keep + (keep < value.length ? 1 : 0));
		for (let index = 0; index < keep; index++) output[index] = shrinkValue(value[index], pass);
		if (keep < value.length) output[keep] = `…[${value.length - keep} items elided for RPC frame]`;
		return output;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		const keep = Math.min(entries.length, pass.objectLimit);
		const output: Record<string, unknown> = {};
		for (let index = 0; index < keep; index++) {
			const [key, item] = entries[index];
			output[key] = shrinkValue(item, pass);
		}
		if (keep < entries.length) output.rpcFrameElidedKeys = entries.length - keep;
		return output;
	}
	return value;
}

function jsonSnapshot(value: unknown): unknown {
	const json = JSON.stringify(value);
	return json === undefined ? undefined : JSON.parse(json);
}

function encodedMessageSnapshot(encoded: string): { message: unknown } | undefined {
	const frame = JSON.parse(encoded);
	return isRecord(frame) && frame.type === "message_end" && Object.hasOwn(frame, "message")
		? { message: frame.message }
		: undefined;
}

/**
 * Emit protocol v2 chunk frames for one pre-serialized logical frame, one physical
 * JSONL line at a time so callers can write with backpressure instead of holding the
 * whole ~4/3-sized base64 transport in memory. The reassembly ceiling is enforced on
 * `Buffer.byteLength` BEFORE any full-payload allocation.
 */
function* encodeChunkedRpcFrames(
	frame: object,
	json: string,
	chunkId: string,
	context: RpcFrameEncodeContext,
): Generator<string> {
	const { limits } = context;
	const byteLength = Buffer.byteLength(json, "utf8");
	if (byteLength > limits.maxReassembledFrameBytes) {
		yield `${JSON.stringify(overflowFrame(frame, context))}\n`;
		return;
	}
	const payloadBytes = chunkPayloadBytes(limits);
	const bytes = Buffer.from(json, "utf8");
	const count = Math.ceil(byteLength / payloadBytes);
	for (let index = 0; index < count; index++) {
		const chunk: RpcChunkFrame = {
			type: "rpc_chunk",
			chunkId,
			index,
			count,
			byteLength,
			data: bytes.subarray(index * payloadBytes, (index + 1) * payloadBytes).toString("base64"),
		};
		const line = `${JSON.stringify(chunk)}\n`;
		if (serializedFrameBytes(line.slice(0, -1)) > limits.maxFrameBytes)
			throw new RpcFrameError("RPC chunk exceeded the transport limit");
		yield line;
	}
}

function isRpcChunkFrame(value: unknown): value is RpcChunkFrame {
	return isRecord(value) && value.type === "rpc_chunk";
}

function decodeBase64(data: unknown): Buffer {
	if (
		typeof data !== "string" ||
		data.length === 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	)
		throw new RpcFrameError("invalid rpc chunk data");
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new RpcFrameError("invalid rpc chunk data");
	return bytes;
}

/** Reassemble protocol v2 chunk frames after each JSONL line has been parsed. */
export class RpcFrameDecoder {
	#pending?: PendingRpcChunks;
	#limits: RpcFrameLimits = DEFAULT_RPC_FRAME_LIMITS;

	/**
	 * Apply the negotiated frame limits. They bound the chunk sequences parsed
	 * after this call — chunk count, per-chunk payload and the reassembled total
	 * — and never re-interpret a frame that is already assembled.
	 */
	setLimits(limits: RpcFrameLimits): void {
		this.#limits = limits;
	}

	push(value: unknown): object | undefined {
		if (!isRpcChunkFrame(value)) {
			if (this.#pending) throw new RpcFrameError("rpc chunk sequence interrupted");
			if (!isRecord(value)) throw new RpcFrameError("rpc frame must be an object");
			return value;
		}
		const limits = this.#limits;
		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 2 ||
			// A chunk carries at most `payloadBytes`, so a sequence cannot declare more
			// chunks than the frame's length needs — the same bound the fixed-budget
			// decoder enforced (256 at the defaults), now tracking the negotiated budget.
			count > Math.ceil(byteLength / chunkPayloadBytes(limits)) ||
			index >= count ||
			byteLength < limits.maxFrameBytes ||
			byteLength > limits.maxReassembledFrameBytes
		)
			throw new RpcFrameError("invalid rpc chunk metadata");
		const bytes = decodeBase64(value.data);
		if (bytes.byteLength > chunkPayloadBytes(limits))
			throw new RpcFrameError("rpc chunk payload exceeds the transport limit");

		if (!this.#pending) {
			if (index !== 0) throw new RpcFrameError("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		)
			throw new RpcFrameError("rpc chunk sequence mismatch");
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength)
			throw new RpcFrameError("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength)
			throw new RpcFrameError("rpc chunk sequence length mismatch");

		this.#pending = undefined;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		const frame: unknown = JSON.parse(decoded);
		if (!isRecord(frame)) throw new RpcFrameError("rpc frame must be an object");
		return frame;
	}
}

function compactTerminalFrame(
	frame: object,
	streamedMessageCount: number,
	streamedMessages?: readonly unknown[],
): object {
	if (!isRecord(frame) || frame.type !== "agent_end" || !Array.isArray(frame.messages)) return frame;
	let streamed = Number.isSafeInteger(streamedMessageCount)
		? Math.min(Math.max(0, streamedMessageCount), frame.messages.length)
		: 0;
	if (streamedMessages) {
		streamed = 0;
		const limit = Math.min(streamedMessages.length, frame.messages.length);
		while (
			streamed < limit &&
			isDeepStrictEqual(streamedMessages[streamed], jsonSnapshot(frame.messages[streamed]))
		) {
			streamed++;
		}
	}
	return {
		...frame,
		messages: frame.messages.slice(streamed),
		messageCount: frame.messages.length,
	};
}

/**
 * The legacy overflow frame, byte-for-byte what an unstructured peer already
 * receives: no error code, metadata truncated to a diagnostic cap.
 */
function legacyOverflowFrame(frame: object): object {
	if (!isRecord(frame)) return { type: "rpc_frame_error", error: "RPC frame exceeded the transport limit" };
	if (frame.type === "response") {
		return {
			id: typeof frame.id === "string" ? shrinkString(frame.id, METADATA_STRING_CAP) : undefined,
			type: "response",
			command: typeof frame.command === "string" ? shrinkString(frame.command, METADATA_STRING_CAP) : "unknown",
			success: false,
			error: "RPC response exceeded the transport limit",
		};
	}
	if (frame.type === "agent_end") {
		return {
			type: "agent_end",
			messages: [],
			messageCount: typeof frame.messageCount === "number" ? frame.messageCount : 0,
		};
	}
	return {
		type: "rpc_frame_error",
		originalType: typeof frame.type === "string" ? shrinkString(frame.type, METADATA_STRING_CAP) : undefined,
		error: "RPC frame exceeded the transport limit",
	};
}

/**
 * What a peer receives when an envelope cannot be encoded at all. Legacy keeps
 * the historical uncoded, truncated frame; managed reports it as a real error:
 * `error` + `message` share the human-readable text, `code` names the taxonomy
 * entry, and every correlation field arrives complete, so the client can still
 * attribute the failure to the request that caused it. Truncating or dropping
 * an identifier here is what turns a failed large reply into a timeout.
 */
function overflowFrame(frame: object, context: RpcFrameEncodeContext): object {
	if (!context.managed) return legacyOverflowFrame(frame);
	const { correlationId, scope, generation, operationId, id } = readRpcCorrelation(frame);
	const correlation = {
		...(id === undefined ? {} : { id }),
		...(correlationId === undefined ? {} : { correlationId }),
		...(scope === undefined ? {} : { scope }),
		...(generation === undefined ? {} : { generation }),
		...(operationId === undefined ? {} : { operationId }),
	};
	const error = "RPC frame exceeded the negotiated transport limit";
	if (isRecord(frame) && frame.type === "response") {
		return {
			...correlation,
			type: "response",
			command: typeof frame.command === "string" ? frame.command : "unknown",
			success: false,
			error,
			message: error,
			code: FRAME_OVERFLOW_ERROR,
		};
	}
	return {
		...correlation,
		type: "rpc_frame_error",
		originalType: isRecord(frame) && typeof frame.type === "string" ? frame.type : undefined,
		error,
		message: error,
		code: FRAME_OVERFLOW_ERROR,
	};
}

function encodeRpcFrameFromJson(
	frame: object,
	json: string,
	streamedMessageCount: number,
	streamedMessages: readonly unknown[] | undefined,
	context: RpcFrameEncodeContext,
): string {
	const { limits } = context;
	if (serializedFrameBytes(json) <= limits.maxFrameBytes) return `${json}\n`;
	if (isRecord(frame) && frame.type === "response") {
		return `${JSON.stringify(overflowFrame(frame, context))}\n`;
	}

	const compacted = compactTerminalFrame(frame, streamedMessageCount, streamedMessages);
	json = JSON.stringify(compacted);
	if (serializedFrameBytes(json) <= limits.maxFrameBytes) return `${json}\n`;

	for (const pass of SHRINK_PASSES) {
		json = JSON.stringify(shrinkValue(compacted, pass));
		if (serializedFrameBytes(json) <= limits.maxFrameBytes) return `${json}\n`;
	}

	return `${JSON.stringify(overflowFrame(compacted, context))}\n`;
}

/** Serialize a complete JSONL frame while enforcing the transport byte ceiling. */
export function encodeRpcFrame(frame: object, streamedMessageCount = 0, streamedMessages?: readonly unknown[]): string {
	return encodeRpcFrameFromJson(frame, JSON.stringify(frame), streamedMessageCount, streamedMessages, {
		limits: DEFAULT_RPC_FRAME_LIMITS,
		managed: false,
	});
}

/** Stateful encoder that tracks which messages a client has already received. */
export class RpcFrameEncoder {
	#streamedMessages: unknown[] = [];
	#protocolVersion: RpcProtocolVersion = 1;
	#chunkCounter = 0;
	#limits: RpcFrameLimits = DEFAULT_RPC_FRAME_LIMITS;
	#managed = false;

	setProtocolVersion(version: number): void {
		if (version !== 1 && version !== 2) throw new Error(`Unsupported RPC protocol version: ${version}`);
		this.#protocolVersion = version;
	}

	/**
	 * Apply the negotiated frame limits. They govern the frames this encoder
	 * produces from now on: chunk payload sizing, the per-physical-frame ceiling
	 * and the reassembled ceiling. An iterable already returned by
	 * {@link RpcFrameEncoder.encodeFrames} keeps the chunk layout it was built
	 * with — negotiation never re-chunks work that is already queued.
	 */
	setLimits(limits: RpcFrameLimits): void {
		this.#limits = limits;
	}

	/**
	 * Choose what an unencodable envelope is reported as. Off (the default) is
	 * the legacy frame, byte-for-byte; on adds the managed error shape — code,
	 * message and the complete correlation envelope — for peers that speak the
	 * managed protocol.
	 */
	setManagedEnvelope(enabled: boolean): void {
		this.#managed = enabled;
	}

	/**
	 * Encode one logical frame into physical JSONL lines. Encoder bookkeeping runs
	 * eagerly; only chunk emission is lazy, so a chunked result can be streamed to
	 * stdout with backpressure without holding the whole transport in memory. The
	 * returned iterable MUST be fully consumed exactly once.
	 */
	encodeFrames(frame: object): Iterable<string> {
		if (isRecord(frame) && frame.type === "agent_start") this.#streamedMessages = [];
		const json = JSON.stringify(frame);
		const context: RpcFrameEncodeContext = { limits: this.#limits, managed: this.#managed };
		let frames: Iterable<string>;
		let singleFrame: string | undefined;
		if (this.#protocolVersion === 2 && serializedFrameBytes(json) > this.#limits.maxFrameBytes) {
			const compacted = compactTerminalFrame(frame, this.#streamedMessages.length, this.#streamedMessages);
			// Reuse the original serialization when compaction was a no-op.
			const compactedJson = compacted === frame ? json : JSON.stringify(compacted);
			if (serializedFrameBytes(compactedJson) > this.#limits.maxFrameBytes) {
				frames = encodeChunkedRpcFrames(compacted, compactedJson, `rpc-${++this.#chunkCounter}`, context);
			} else {
				singleFrame = `${compactedJson}\n`;
				frames = [singleFrame];
			}
		} else {
			singleFrame = encodeRpcFrameFromJson(
				frame,
				json,
				this.#streamedMessages.length,
				this.#streamedMessages,
				context,
			);
			frames = [singleFrame];
		}
		if (!isRecord(frame)) return frames;
		if (frame.type === "message_end") {
			const snapshot =
				this.#protocolVersion === 2 && Object.hasOwn(frame, "message")
					? (encodedMessageSnapshot(json) ?? { message: jsonSnapshot(frame.message) })
					: singleFrame !== undefined
						? encodedMessageSnapshot(singleFrame)
						: undefined;
			if (snapshot) this.#streamedMessages.push(snapshot.message);
		} else if (frame.type === "agent_end" && frame.willContinue !== true) this.#streamedMessages = [];
		return frames;
	}

	encode(frame: object): string {
		let encoded = "";
		for (const line of this.encodeFrames(frame)) encoded += line;
		return encoded;
	}
}
