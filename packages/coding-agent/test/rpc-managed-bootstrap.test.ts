import { describe, expect, mock, test } from "bun:test";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import {
	createRpcReadyFrame,
	type PendingExtensionRequest,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcShutdownCoordinator,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcResponse, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

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
		const managed = createRpcReadyFrame(true);
		expect(managed.nativeAgent?.protocolMajor).toBe(1);
		expect(managed.nativeAgent?.capabilities).toEqual(["managed-bootstrap/v0", "control-side-channel/v0"]);
	});

	test("client rejects missing or incompatible managed declarations without writing subsequent commands", async () => {
		for (const ready of [
			createRpcReadyFrame(false),
			{ ...createRpcReadyFrame(true), nativeAgent: { protocolMajor: 2, capabilities: [] } },
		]) {
			const exited = Promise.withResolvers<number>();
			const write = mock((_data: string | Uint8Array) => {});
			const kill = mock(() => {
				exited.resolve(0);
			});
			const child: RpcAgentProcess = {
				stdin: { write },
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`${JSON.stringify(ready)}\n`));
					},
				}),
				peekStderr: () => "",
				kill,
				exited: exited.promise,
			};
			using client = new RpcClient({ spawn: () => child, expectManagedBootstrap: true });
			await expect(client.start()).rejects.toThrow("remote did not declare a managed native-agent bootstrap");
			expect(write).not.toHaveBeenCalled();
			expect(kill).toHaveBeenCalledTimes(1);
		}
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
});
