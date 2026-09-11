/**
 * Profile-safe managed startup. This module is imported before the CLI command
 * graph: do not import the pi-utils barrel, env, settings, session, or RPC mode.
 * The existing framed channel is handed over, not reopened, after prepare has
 * selected the remote context. Its ACK belongs to the initialized runner.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getActiveProfile,
	getProjectDir,
	normalizeProfileName,
	setProfile,
	setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { flagConsumesValue } from "../../cli/flag-tables";
import {
	DEFAULT_RPC_FRAME_LIMITS,
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	MAX_RPC_RESOURCE_CHUNK_BYTES,
	negotiateRpcFrameLimits,
	RpcFrameDecoder,
	RpcFrameEncoder,
	type RpcFrameLimits,
	type RpcProtocolVersion,
} from "./rpc-frame";
import { claimRpcInput } from "./rpc-input";
import {
	MANAGED_NATIVE_AGENT_CAPABILITIES,
	readRpcCorrelation,
	type RpcCommand,
	type RpcErrorCode,
	type RpcManagedErrorResponse,
	type RpcPrepareOptions,
	type RpcReadyFrame,
	type RpcResponse,
} from "./rpc-types";

export interface ManagedRpcBootstrap {
	readonly input: ReadableStream<Uint8Array>;
	readonly protocolVersion: RpcProtocolVersion;
	readonly frameLimits: RpcFrameLimits;
	readonly prepare: Extract<RpcCommand, { type: "prepare" }>;
	/** Updated by remote role resolution before the runner acknowledges prepare. */
	readonly preparedContext: RpcPrepareOptions;
	fail(code: RpcErrorCode, message: string): Promise<void>;
}

type ManagedBootstrapOutput =
	| RpcReadyFrame
	| RpcManagedErrorResponse
	| Extract<RpcResponse, { command: "negotiate_protocol"; success: true }>;

let activeBootstrap: ManagedRpcBootstrap | undefined;

export function getManagedRpcBootstrap(): ManagedRpcBootstrap | undefined {
	return activeBootstrap;
}

/** Shared ready layout; a pre-profile sender may omit the advisory lease proposal. */
export function buildRpcReadyFrame(
	managed = false,
	proposed?: { heartbeatSeconds: number; leaseSeconds: number },
): RpcReadyFrame {
	const frame: RpcReadyFrame = {
		type: "ready",
		protocolVersion: 1,
		supportedProtocolVersions: [1, 2],
		maxFrameBytes: MAX_RPC_FRAME_BYTES,
		maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
	};
	if (managed) {
		frame.maxResourceChunkBytes = MAX_RPC_RESOURCE_CHUNK_BYTES;
		frame.nativeAgent = {
			protocolMajor: 1,
			capabilities: MANAGED_NATIVE_AGENT_CAPABILITIES,
			...(proposed ? { proposed } : {}),
		};
	}
	return frame;
}

/** Honor argv value boundaries so a prompt/model value cannot opt into managed IO. */
export function requestsManagedRpcBootstrap(argv: readonly string[]): boolean {
	let managed = false;
	let mode: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--") break;
		if (arg === "--rpc-subagent") {
			managed = true;
			continue;
		}
		if (arg === "--mode") mode = argv[index + 1];
		if (flagConsumesValue(arg, argv[index + 1])) index++;
	}
	return managed && mode === "rpc";
}

class BootstrapError extends Error {
	constructor(readonly code: RpcErrorCode, message: string) {
		super(message);
	}
}

function parsePrepare(value: Record<string, unknown>): Extract<RpcCommand, { type: "prepare" }> {
	const prepare: Extract<RpcCommand, { type: "prepare" }> = { ...readRpcCorrelation(value), type: "prepare" };
	for (const field of ["cwd", "profile", "agent"] as const) {
		const text = value[field];
		if (text === undefined) continue;
		if (typeof text !== "string" || text.includes("\0") || (field !== "profile" && !text.trim())) {
			throw new BootstrapError("protocol-incompatible", `Invalid managed prepare ${field}`);
		}
		prepare[field] = text;
	}
	for (const field of ["heartbeatSeconds", "leaseSeconds"] as const) {
		const seconds = value[field];
		if (seconds === undefined) continue;
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
			throw new BootstrapError("protocol-incompatible", `Invalid managed prepare ${field}`);
		}
		prepare[field] = seconds;
	}
	return prepare;
}

async function applyPreparedContext(prepare: RpcPrepareOptions): Promise<RpcPrepareOptions> {
	let profile: string | undefined;
	if (prepare.profile !== undefined) {
		try {
			profile = normalizeProfileName(prepare.profile);
		} catch (error) {
			throw new BootstrapError("config-missing", error instanceof Error ? error.message : String(error));
		}
	}
	if (prepare.cwd !== undefined) {
		if (!path.isAbsolute(prepare.cwd)) throw new BootstrapError("config-missing", "Managed prepare cwd must be absolute");
		try {
			if (!(await fs.stat(prepare.cwd)).isDirectory()) throw new Error("not a directory");
			setProjectDir(prepare.cwd);
		} catch (error) {
			throw new BootstrapError("config-missing", `Cannot use managed cwd ${prepare.cwd}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (prepare.profile !== undefined) setProfile(profile);
	return {
		cwd: getProjectDir(),
		profile: getActiveProfile() ?? "default",
		...(prepare.agent !== undefined ? { agent: prepare.agent } : {}),
	};
}

/**
 * Own ready/negotiate before profile-scoped imports. Keep the suspended line
 * iterator and replay prepare through negotiated framing: buffered subsequent
 * commands are neither discarded nor allowed to run before initialization.
 */
export async function beginManagedRpcBootstrap(
	input: ReadableStream<Uint8Array> = claimRpcInput(),
): Promise<ManagedRpcBootstrap | undefined> {
	activeBootstrap = undefined;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	const lines = readLines(input, controller.signal);
	const encoder = new RpcFrameEncoder();
	const decoder = new RpcFrameDecoder();
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();
	encoder.setManagedEnvelope(true);
	let protocolVersion: RpcProtocolVersion = 1;
	let frameLimits = DEFAULT_RPC_FRAME_LIMITS;
	let handedOff = false;
	const output = async (frame: ManagedBootstrapOutput): Promise<void> => {
		for (const line of encoder.encodeFrames(frame)) {
			const written = Promise.withResolvers<void>();
			process.stdout.write(line, error => error ? written.reject(error) : written.resolve());
			await written.promise;
		}
	};
	const fail = async (request: unknown, command: string, code: RpcErrorCode, message: string): Promise<void> => {
		const frame: RpcManagedErrorResponse = {
			...readRpcCorrelation(request), type: "response", command, success: false, error: message, message, code,
		};
		await output(frame);
	};
	try {
		await output(buildRpcReadyFrame(true));
		for (;;) {
			const next = await lines.next();
			if (next.done) {
				if (controller.signal.aborted) await fail(undefined, "prepare", "timeout", "Managed bootstrap timed out waiting for prepare");
				return undefined;
			}
			const text = textDecoder.decode(next.value).trim();
			if (!text) continue;
			let request: unknown;
			try {
				const physical: unknown = JSON.parse(text);
				if (isRecord(physical) && physical.type === "rpc_chunk" && protocolVersion !== 2) {
					throw new BootstrapError("protocol-incompatible", "RPC chunk received before negotiation");
				}
				request = decoder.push(physical);
				if (request === undefined) continue;
				if (!isRecord(request)) throw new BootstrapError("protocol-incompatible", "Invalid managed bootstrap frame");
				if (request.type === "negotiate_protocol") {
					if (request.protocolVersion !== 2) throw new BootstrapError("protocol-incompatible", "Managed bootstrap requires protocol version 2");
					const proposed: Partial<RpcFrameLimits> = {};
					for (const field of ["maxFrameBytes", "maxReassembledFrameBytes", "maxResourceChunkBytes"] as const) {
						const value = request[field];
						if (value === undefined) continue;
						if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
							throw new BootstrapError("protocol-incompatible", `Invalid ${field}`);
						}
						proposed[field] = value;
					}
					frameLimits = negotiateRpcFrameLimits(proposed, DEFAULT_RPC_FRAME_LIMITS);
					await output({ ...readRpcCorrelation(request), type: "response", command: "negotiate_protocol", success: true,
						data: { protocolVersion: 2, ...frameLimits } });
					protocolVersion = 2;
					encoder.setProtocolVersion(2);
					encoder.setLimits(frameLimits);
					decoder.setLimits(frameLimits);
					continue;
				}
				if (request.type !== "prepare") {
					throw new BootstrapError("protocol-incompatible", "Managed bootstrap requires prepare before session commands");
				}
				const prepare = parsePrepare(request);
				const preparedContext = await applyPreparedContext(prepare);
				const replay = encoder.encodeFrames(prepare)[Symbol.iterator]();
				const remaining = new ReadableStream<Uint8Array>({
					async pull(sink) {
						const prefix = replay.next();
						if (!prefix.done) {
							sink.enqueue(textEncoder.encode(prefix.value));
							return;
						}
						const line = await lines.next();
						if (line.done) { sink.close(); return; }
						const bytes = new Uint8Array(line.value.byteLength + 1);
						bytes.set(line.value);
						bytes[bytes.length - 1] = 10;
						sink.enqueue(bytes);
					},
					async cancel() { await lines.return(undefined); },
				});
				const bootstrap: ManagedRpcBootstrap = {
					input: remaining, protocolVersion, frameLimits, prepare, preparedContext,
					async fail(code, message) {
						activeBootstrap = undefined;
						try {
							await fail(prepare, "prepare", code, message);
						} finally {
							await remaining.cancel();
						}
					},
				};
				activeBootstrap = bootstrap;
				handedOff = true;
				return bootstrap;
			} catch (error) {
				const command = isRecord(request) && typeof request.type === "string" ? request.type : "parse";
				await fail(request, command, error instanceof BootstrapError ? error.code : "protocol-incompatible",
					error instanceof Error ? error.message : String(error));
				if (command === "prepare") return undefined;
			}
		}
	} finally {
		clearTimeout(timeout);
		if (!handedOff) await lines.return(undefined);
	}
}
