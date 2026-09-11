import { describe, expect, test } from "bun:test";
import {
	RpcClient,
	RpcClientError,
	type RpcAgentProcess,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	DEFAULT_RPC_FRAME_LIMITS,
	negotiateRpcFrameLimits,
	RpcFrameDecoder,
	RpcFrameEncoder,
	type RpcFrameLimits,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { createRpcReadyFrame, resumeManagedEndpoint } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { MANAGED_NATIVE_AGENT_CAPABILITIES, readRpcCorrelation } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { FakeRemoteEndpoint } from "./task/endpoint-fake";

/** In-memory byte transport: every test drives the real client's JSONL reader and writer. */
class ManagedPeer implements RpcAgentProcess {
	readonly writes: string[] = [];
	readonly commands: RpcCommand[] = [];
	readonly #exit = Promise.withResolvers<number>();
	readonly exited = this.#exit.promise;
	readonly #decoder = new RpcFrameDecoder();
	readonly #encoder = new RpcFrameEncoder();
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	#closed = false;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stdin = {
		write: (data: string | Uint8Array) => {
			const line = typeof data === "string" ? data : new TextDecoder().decode(data);
			this.writes.push(line);
			const parsed: unknown = JSON.parse(line);
			const decoded = this.#decoder.push(parsed);
			if (!decoded) return;
			const command = decoded as RpcCommand;
			this.commands.push(command);
			void this.#dispatch(command);
		},
	};

	constructor(
		readonly ready: object = createRpcReadyFrame(true),
		readonly limits: RpcFrameLimits = DEFAULT_RPC_FRAME_LIMITS,
		readonly handle: (command: RpcCommand, peer: ManagedPeer) => Promise<void> = async () => {},
	) {
		this.stdout = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
				controller.enqueue(new TextEncoder().encode(`${JSON.stringify(ready)}\n`));
			},
			cancel: () => {
				this.#closed = true;
			},
		});
	}

	async #dispatch(command: RpcCommand): Promise<void> {
		if (command.type === "negotiate_protocol") {
			const limits = negotiateRpcFrameLimits(command, this.limits);
			this.respond(command, {
				type: "response", command: "negotiate_protocol", success: true,
				data: { protocolVersion: 2, ...limits },
			});
			this.#decoder.setLimits(limits);
			this.#encoder.setLimits(limits);
			this.#encoder.setProtocolVersion(2);
			return;
		}
		if (command.type === "prepare") {
			this.respond(command, {
				type: "response", command: "prepare", success: true,
				data: { heartbeatSeconds: command.heartbeatSeconds ?? 10, leaseSeconds: command.leaseSeconds ?? 30,
					ircBinding: command.ircBinding, coordinatorBinding: command.coordinatorBinding },
			});
			return;
		}
		if (command.type === "heartbeat") {
			this.respond(command, { type: "response", command: "heartbeat", success: true });
			return;
		}
		await this.handle(command, this);
	}

	respond(command: RpcCommand, response: RpcResponse): void {
		this.emit({
			...response,
			...readRpcCorrelation(command),
		});
	}

	emit(response: object): void {
		if (this.#closed) return;
		for (const line of this.#encoder.encodeFrames(response)) {
			this.#controller.enqueue(new TextEncoder().encode(line));
		}
	}

	peekStderr(): string { return ""; }
	kill(): void {
		// Process exit is independent of stdout: rejecting ready cancels the
		// reader before RpcClient reaps this fake process.
		this.#exit.resolve(0);
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.close();
	}
}

describe("managed native-agent negotiation", () => {
	test("row 1: old ready declarations reject with protocol-incompatible before any write", async () => {
		for (const ready of [
			createRpcReadyFrame(false),
			{ ...createRpcReadyFrame(true), nativeAgent: { protocolMajor: 1 } },
			{ ...createRpcReadyFrame(true), nativeAgent: { protocolMajor: 1, capabilities: ["managed-bootstrap/v0"] } },
			{ ...createRpcReadyFrame(true), nativeAgent: { ...createRpcReadyFrame(true).nativeAgent, protocolMajor: 2 } },
			{ ...createRpcReadyFrame(true), nativeAgent: { protocolMajor: 1, capabilities: { ...MANAGED_NATIVE_AGENT_CAPABILITIES, heartbeat: 0 } } },
			{ ...createRpcReadyFrame(true), nativeAgent: { protocolMajor: 1, capabilities: { ...MANAGED_NATIVE_AGENT_CAPABILITIES, heartbeat: true } } },
			// https://github.com/mouriya-s-lab/oh-my-pi/issues/11 makes bidirectional IRC mandatory.
			{ ...createRpcReadyFrame(true), nativeAgent: { protocolMajor: 1, capabilities: { ...MANAGED_NATIVE_AGENT_CAPABILITIES, ircBidirectional: 0 } } },
		]) {
			const peer = new ManagedPeer(ready);
			using client = new RpcClient({ spawn: () => peer, expectManagedBootstrap: true });
			await expect(client.start()).rejects.toMatchObject({ name: "RpcClientError", code: "protocol-incompatible" });
			expect(peer.writes).toEqual([]);
			await expect(peer.exited).resolves.toBe(0);
		}
	});

	test("row 2: remote error frames preserve authorization, protocol, and execution failure variants", async () => {
		const codes = ["authorization-denied", "protocol-incompatible", "remote-execution-failed"] as const;
		let index = 0;
		const peer = new ManagedPeer(undefined, undefined, async (command, transport) => {
			const code = codes[index++];
			if (!code) throw new Error("Unexpected command");
			transport.respond(command, {
				type: "response", command: command.type, success: false, code, error: "peer refused", message: "peer refused",
			});
		});
		using client = new RpcClient({ spawn: () => peer, expectManagedBootstrap: true });
		await client.start();
		const observed: string[] = [];
		for (const code of codes) {
			try {
				await client.prompt("must not be mistaken for an accepted prompt");
				throw new Error("Expected managed rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(RpcClientError);
				if (!(error instanceof RpcClientError)) throw error;
				expect(error.code).toBe(code);
				observed.push(error.code);
			}
		}
		expect(observed).toEqual([...codes]);
	});

	test("default prepare advertises the mandatory 10/30 second wire contract", async () => {
		const peer = new ManagedPeer();
		using client = new RpcClient({ spawn: () => peer, expectManagedBootstrap: true });
		await client.start();
		const prepare = peer.commands.find(command => command.type === "prepare");
		expect(prepare).toMatchObject({ type: "prepare", heartbeatSeconds: 10, leaseSeconds: 30 });
		expect(client.getManagedLifecycle()).toEqual({ status: "active", heartbeatSeconds: 10, leaseSeconds: 30 });
	});

	test("wrong correlation never falls back to matching id; correct correlation wins over a different id", async () => {
		const peer = new ManagedPeer(undefined, undefined, async (command, transport) => {
			if (command.type !== "cancel_run") throw new Error("Unexpected command");
			transport.emit({
				type: "response", command: "cancel_run", success: true, id: command.id,
				correlationId: "wrong-correlation", data: { status: "cleanup-unconfirmed", detail: "wrong response" },
			});
			transport.emit({
				type: "response", command: "cancel_run", success: true, id: "wrong-id",
				correlationId: command.correlationId, data: { status: "cancelled", replyDrained: true },
			});
		});
		using client = new RpcClient({ spawn: () => peer, expectManagedBootstrap: true });
		await client.start();
		await expect(client.cancelRun("run", { scope: "run", generation: 7, operationId: "cancel-once" }))
			.resolves.toEqual({ status: "cancelled", replyDrained: true });
		const command = peer.commands.find(command => command.type === "cancel_run");
		expect(command).toMatchObject({ scope: "run", generation: 7, operationId: "cancel-once" });
		expect(command?.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(new Set(peer.commands.map(command => command.correlationId)).size).toBe(peer.commands.length);
	});

	test("three independent minimum limits bound client chunks and reject oversized logical requests", async () => {
		const local: RpcFrameLimits = { maxFrameBytes: 2048, maxReassembledFrameBytes: 16384, maxResourceChunkBytes: 1024 };
		const remote: RpcFrameLimits = { maxFrameBytes: 4096, maxReassembledFrameBytes: 8192, maxResourceChunkBytes: 512 };
		const received: string[] = [];
		const peer = new ManagedPeer(createRpcReadyFrame(true), remote, async (command, transport) => {
			if (command.type !== "prompt") throw new Error("Unexpected command");
			received.push(command.message);
			transport.respond(command, { type: "response", command: "prompt", success: true });
		});
		using client = new RpcClient({ spawn: () => peer, expectManagedBootstrap: true, managedFrameLimits: local });
		await client.start();
		const start = peer.writes.length;
		const message = "bounded chunk ".repeat(350);
		await client.prompt(message);
		expect(received).toEqual([message]);
		const chunks = peer.writes.slice(start);
		expect(chunks.length).toBeGreaterThan(1);
		for (const line of chunks) {
			expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
			const chunk: { type: string; data: string } = JSON.parse(line);
			expect(chunk.type).toBe("rpc_chunk");
			expect(Buffer.from(chunk.data, "base64").byteLength).toBeLessThanOrEqual(512);
		}
		await expect(client.prompt("x".repeat(9000))).rejects.toMatchObject({ code: "protocol-incompatible" });
		expect(received).toEqual([message]);
	});

	test("row 6: resume refuses ownership until drained, then reopens the same opaque reference and run", async () => {
		const endpoint = new FakeRemoteEndpoint();
		const run = await endpoint.start("retain this remote run");
		const peer = new ManagedPeer(undefined, undefined, async (command, transport) => {
			if (command.type === "park") {
				transport.respond(command, { type: "response", command: "park", success: true, data: await endpoint.park(command.runId) });
				return;
			}
			if (command.type !== "resume") throw new Error("Unexpected command");
			transport.respond(command, {
				type: "response", command: "resume", success: true,
				data: await resumeManagedEndpoint(endpoint, command.reference, command.expectedRunId),
			});
		});
		using client = new RpcClient({ spawn: () => peer, expectManagedBootstrap: true });
		await client.start();
		const reference = endpoint.handle.reference;
		await expect(client.park(run.runId)).resolves.toMatchObject({ acknowledged: false });
		await expect(client.resume(reference, run.runId)).resolves.toMatchObject({ status: "still-owned" });
		endpoint.completeRun({ status: "completed", runId: run.runId, text: "finished" });
		await expect(client.resume(reference, run.runId)).resolves.toMatchObject({ status: "still-owned" });
		endpoint.emitReplyDrained(run.runId);
		const parked = await client.park(run.runId);
		expect(parked).toEqual({ acknowledged: true, resumeReference: reference });
		const reopened = await client.resume(reference, run.runId);
		expect(reopened).toMatchObject({ status: "reopened", runId: run.runId, snapshot: { runId: run.runId, status: "completed" } });
		expect(endpoint.sessions.get(reference)).toMatchObject({ reference, runId: run.runId, parked: false });
		expect(endpoint.sessionsCreatedCount).toBe(1);
	});
});
