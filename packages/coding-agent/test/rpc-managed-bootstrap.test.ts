import { describe, expect, mock, test } from "bun:test";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, MAX_RPC_RESOURCE_CHUNK_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import {
	createRpcReadyFrame,
	type PendingExtensionRequest,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcShutdownCoordinator,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { MANAGED_NATIVE_AGENT_CAPABILITIES, type RpcResponse, type RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const makeDeps = (handleCommand: RpcInputFrameDeps["handleCommand"]) => {
	const outputs: unknown[] = [];
	const deps: RpcInputFrameDeps = {
		handleCommand,
		output: frame => outputs.push(frame),
		errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
		pendingExtensionRequests: new Map<string, PendingExtensionRequest>(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
	return { deps, outputs };
};

const runningState: RpcSessionState = {
	thinkingLevel: undefined,
	isStreaming: true,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "managed-test",
	autoCompactionEnabled: false,
	fastModeEnabled: false,
	fastModeActive: false,
	tokensPerSecond: null,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
};

describe("managed RPC bootstrap", () => {
	test("ready declares managed capabilities only when opted in, preserving legacy wire shape", () => {
		const legacy = createRpcReadyFrame(false);
		expect("nativeAgent" in legacy).toBe(false);
		expect(legacy).toEqual({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		});
		expect(JSON.stringify(legacy)).toBe(`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":${MAX_RPC_FRAME_BYTES},"maxReassembledFrameBytes":${MAX_RPC_REASSEMBLED_BYTES}}`);
		const managed = createRpcReadyFrame(true);
		expect(managed.nativeAgent?.protocolMajor).toBe(1);
		expect(managed.nativeAgent?.capabilities).toEqual(MANAGED_NATIVE_AGENT_CAPABILITIES);
		expect(managed.maxResourceChunkBytes).toBe(MAX_RPC_RESOURCE_CHUNK_BYTES);
	});


	test("managed controls respond during a blocked serial command while legacy get_state stays queued", async () => {
		const scenarios = [
			{ managed: true, type: "get_state" },
			{ managed: true, type: "abort" },
			{ managed: true, type: "abort_bash" },
			{ managed: false, type: "get_state" },
		] as const;
		for (const scenario of scenarios) {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let completed = false;
			const { deps, outputs } = makeDeps(async command => {
				if (command.type === "prompt") {
					started.resolve();
					await release.promise;
					completed = true;
					return { id: command.id, type: "response", command: "prompt", success: true };
				}
				if (command.type === "get_state") {
					return { id: command.id, type: "response", command: "get_state", success: true, data: runningState };
				}
				if (command.type === "abort" || command.type === "abort_bash") {
					return { id: command.id, type: "response", command: command.type, success: true };
				}
				throw new Error(`Unexpected command: ${command.type}`);
			});
			const dispatcher = new RpcInputDispatcher({ deps, managed: scenario.managed });
			dispatcher.dispatch({ id: "long", type: "prompt", message: "synthetic blocked command" });
			await started.promise;
			dispatcher.dispatch({ id: "control", type: scenario.type });
			await Promise.resolve();
			expect(completed).toBe(false);
			const controlResponse: RpcResponse = scenario.type === "get_state"
				? { id: "control", type: "response", command: "get_state", success: true, data: runningState }
				: { id: "control", type: "response", command: scenario.type, success: true };
			expect(outputs).toEqual(scenario.managed ? [controlResponse] : []);
			release.resolve();
			await dispatcher.drain();
			const promptResponse: RpcResponse = { id: "long", type: "response", command: "prompt", success: true };
			expect(outputs).toEqual(scenario.managed ? [controlResponse, promptResponse] : [promptResponse, controlResponse]);
		}
	});

	test("managed EOF signals cancellation before drain; legacy EOF waits for natural completion", async () => {
		for (const managed of [true, false]) {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const events: string[] = [];
			let cancelled = false;
			const { deps, outputs } = makeDeps(async command => {
				if (command.type === "abort") {
					cancelled = true;
					release.resolve();
					return { id: command.id, type: "response", command: "abort", success: true };
				}
				if (command.type !== "prompt") throw new Error(`Unexpected command: ${command.type}`);
				started.resolve();
				await release.promise;
				events.push(cancelled ? "cancelled" : "completed");
				return { id: command.id, type: "response", command: "prompt", success: true };
			});
			const dispatcher = new RpcInputDispatcher({ deps, managed });
			const runOnManagedEof = mock(() => {
				events.push("abort-signal");
				dispatcher.dispatch({ type: "abort" });
			});
			const coordinator = new RpcShutdownCoordinator({
				managed,
				runOnManagedEof,
				isShutdownRequested: () => false,
				performShutdown: async () => { throw new Error("EOF must not request extension shutdown"); },
			});
			dispatcher.dispatch({ id: "long", type: "prompt", message: "synthetic blocked command" });
			await started.promise;
			const draining = coordinator.handleEof(dispatcher).then(() => events.push("drained"));
			expect(events).toEqual(managed ? ["abort-signal"] : []);
			expect(runOnManagedEof).toHaveBeenCalledTimes(managed ? 1 : 0);
			if (!managed) {
				await Promise.resolve();
				expect(events).toEqual([]);
				expect(outputs).toEqual([]);
				release.resolve();
			}
			await draining;
			expect(events).toEqual(managed ? ["abort-signal", "cancelled", "drained"] : ["completed", "drained"]);
			expect(outputs).toContainEqual({ id: "long", type: "response", command: "prompt", success: true });
		}
	});

	test("managed parse, control validation, and execution errors preserve the complete correlation envelope", async () => {
		const envelope = { id: "original", correlationId: "original-correlation", scope: "run", generation: 4, operationId: "operation" };
		for (const scenario of [
			{ request: { type: 9 }, command: "parse", code: "protocol-incompatible" },
			{ request: { type: "cancel_run", runId: 9 }, command: "cancel_run", code: "protocol-incompatible" },
			{ request: { type: "bash", command: "unavailable" }, command: "bash", code: "remote-execution-failed" },
		]) {
			const { deps, outputs } = makeDeps(async () => { throw new Error("execution failed"); });
			const dispatcher = new RpcInputDispatcher({ deps, managed: true });
			dispatcher.dispatch({ ...scenario.request, ...envelope });
			await dispatcher.drain();
			expect(outputs).toEqual([expect.objectContaining({
				...envelope, type: "response", command: scenario.command, success: false,
				code: scenario.code, error: expect.any(String), message: expect.any(String),
			})]);
		}
	});
});
