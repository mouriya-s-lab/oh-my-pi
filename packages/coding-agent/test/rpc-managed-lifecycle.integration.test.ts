import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient, RpcClientError, type RpcAgentProcess, type RpcManagedLifecycle } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { readRpcCorrelation, type RpcCommand, type RpcCorrelationFields } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isRecord, readJsonl, withTimeout } from "@oh-my-pi/pi-utils";
import type { FileSink, Subprocess } from "bun";

const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
const baseArgs = ["--mode", "rpc", "--no-session", "--provider", "anthropic", "--model", "claude-sonnet-4-5"];

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const result = await read();
		if (result !== undefined) return result;
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function waitForMarker(file: string): Promise<void> {
	await waitFor(async () => await Bun.file(file).exists() ? true : undefined, file);
}

type LifecycleRpcResponse = RpcCorrelationFields & {
	id?: string;
	type: "response";
	command: string;
} & (
	| { success: true; data?: unknown }
	| { success: false; error: string }
);

function responseFor(frames: unknown[], id: string): LifecycleRpcResponse | undefined {
	const frame = frames.find(value => isRecord(value) && value.type === "response" && value.id === id);
	if (!isRecord(frame) || typeof frame.command !== "string") return undefined;
	const envelope = readRpcCorrelation(frame);
	if (frame.success === false && typeof frame.error === "string") {
		return { ...envelope, type: "response", command: frame.command, success: false, error: frame.error };
	}
	if (frame.success === true) {
		return {
			...envelope, type: "response", command: frame.command, success: true,
			...("data" in frame ? { data: frame.data } : {}),
		};
	}
	return undefined;
}

function runFor(frames: unknown[], id: string): string | undefined {
	const frame = frames.find(value => isRecord(value) && value.type === "managed_run_start" && value.id === id);
	return isRecord(frame) && typeof frame.runId === "string" ? frame.runId : undefined;
}

function bashCancelled(response: LifecycleRpcResponse): boolean {
	if (!response.success || response.command !== "bash" || !isRecord(response.data) ||
		typeof response.data.cancelled !== "boolean") {
		throw new Error(`Expected bash response: ${JSON.stringify(response)}`);
	}
	return response.data.cancelled;
}

interface LocalRpcProcess {
	child: Subprocess<"pipe", "pipe", "pipe">;
	commands: RpcCommand[];
	frames: unknown[];
	wire: unknown[];
	stdoutDone: Promise<void>;
	stderr: Promise<string>;
	argv: string[];
	send(command: RpcCommand): Promise<void>;
	response(id: string): Promise<LifecycleRpcResponse>;
	exit(): Promise<number>;
}

/** Child-only environment: operator profiles, extensions, credentials and shell rc files must not affect this fixture. */
async function isolatedRpcEnvironment(cwd: string, overrides: Record<string, string>): Promise<Record<string, string>> {
	const home = path.join(cwd, "home");
	const directories = {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
	};
	await Promise.all([...new Set(Object.values(directories))].map(directory => fs.mkdir(directory, { recursive: true })));
	const inherited: Record<string, string> = {};
	for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
		const value = Bun.env[name];
		if (value !== undefined) inherited[name] = value;
	}
	return {
		...inherited,
		...directories,
		PI_NO_TITLE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_NOTIFICATIONS: "off",
		...overrides,
	};
}

async function spawnRpc(cwd: string, managed: boolean, env: Record<string, string> = {}): Promise<LocalRpcProcess> {
	const argv = [process.execPath, cliPath, ...baseArgs, ...(managed ? ["--rpc-subagent"] : [])];
	const child = Bun.spawn(argv, {
		cwd,
		env: await isolatedRpcEnvironment(cwd, env),
		stdin: "pipe", stdout: "pipe", stderr: "pipe",
	});
	const commands: RpcCommand[] = [];
	const frames: unknown[] = [];
	const wire: unknown[] = [];
	const decoder = new RpcFrameDecoder();
	const stderr = new Response(child.stderr).text();
	const stdoutDone = (async () => {
		for await (const physical of readJsonl<unknown>(child.stdout)) {
			wire.push(physical);
			const logical = decoder.push(physical);
			if (logical !== undefined) frames.push(logical);
		}
	})();
	return {
		child, commands, frames, wire, stdoutDone, stderr, argv,
		async send(command) {
			commands.push(command);
			child.stdin.write(`${JSON.stringify(command)}\n`);
			await child.stdin.flush();
		},
		response: id => waitFor(() => responseFor(frames, id), `response ${id}`),
		async exit() {
			const code = await withTimeout(child.exited, 15_000, "RPC did not shut down");
			await stdoutDone;
			return code;
		},
	};
}

async function disposeRpc(rpc: LocalRpcProcess): Promise<void> {
	if (rpc.child.exitCode === null) rpc.child.kill();
	await rpc.child.exited;
	await rpc.stdoutDone;
}

function shellMarkers(dir: string, name: string, seconds: number): { started: string; finished: string; command: string } {
	const started = path.join(dir, `${name}.started`);
	const finished = path.join(dir, `${name}.finished`);
	return {
		started, finished,
		command: `printf started > '${started}'; printf '${name}:started\\n'; sleep ${seconds}; printf finished > '${finished}'; printf '${name}:finished\\n'`,
	};
}

describe("managed RPC local process lifecycle", () => {
	test("row 3: state and targeted cancellation overtake sleep without cancelling a companion run", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-managed-control-"));
		const rpc = await spawnRpc(cwd, true);
		const slow = shellMarkers(cwd, "slow", 5);
		const companion = shellMarkers(cwd, "companion", 1);
		try {
			await rpc.send({ id: "prepare", type: "prepare" });
			await rpc.response("prepare");
			await rpc.send({ id: "slow", type: "bash", command: slow.command });
			await waitForMarker(slow.started);
			const startedAt = Date.now();
			const runId = await waitFor(() => runFor(rpc.frames, "slow"), "slow run id");
			await rpc.send({ id: "companion", type: "bash", command: companion.command });
			await waitForMarker(companion.started);
			await rpc.send({ id: "state", type: "get_state", correlationId: "state-correlation", scope: "control", generation: 7, operationId: "state-operation" });
			const state = await rpc.response("state");
			expect(state.success).toBe(true);
			expect(state.correlationId).toBe("state-correlation");
			expect(state.scope).toBe("control");
			expect(state.generation).toBe(7);
			expect(state.operationId).toBe("state-operation");
			expect(responseFor(rpc.frames, "slow")).toBeUndefined();
			await rpc.send({ id: "cancel", type: "cancel_run", runId, correlationId: "cancel-correlation", scope: "run" });
			const cancelled = await rpc.response("cancel");
			expect(cancelled).toMatchObject({ success: true, correlationId: "cancel-correlation", data: { status: "cancelled", replyDrained: true } });
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			expect(bashCancelled(await rpc.response("slow"))).toBe(true);
			expect(await Bun.file(slow.finished).exists()).toBe(false);
			expect(bashCancelled(await rpc.response("companion"))).toBe(false);
			expect(await Bun.file(companion.finished).text()).toBe("finished");
			await rpc.send({ id: "park", type: "park", runId });
			const parked = await rpc.response("park");
			if (!parked.success || parked.command !== "park" || !isRecord(parked.data) ||
				parked.data.acknowledged !== true || typeof parked.data.resumeReference !== "string") {
				throw new Error(`Expected a resumable park acknowledgement: ${JSON.stringify(parked)}`);
			}
			await rpc.send({ id: "resume", type: "resume", reference: parked.data.resumeReference, expectedRunId: runId });
			expect(await rpc.response("resume")).toMatchObject({ success: true, data: { status: "reopened", runId, snapshot: { runId } } });
			await rpc.send({ id: "resumed-state", type: "get_state" });
			const resumedState = await rpc.response("resumed-state");
			if (!state.success || state.command !== "get_state" || !isRecord(state.data) ||
				typeof state.data.sessionId !== "string" || !resumedState.success || resumedState.command !== "get_state" ||
				!isRecord(resumedState.data) || typeof resumedState.data.sessionId !== "string") {
				throw new Error("Expected session state before and after resume");
			}
			expect(resumedState.data.sessionId).toBe(state.data.sessionId);
			// This acknowledgement must be written after cleanup and before process.exit.
			await rpc.send({ id: "terminate", type: "terminate", correlationId: "terminate-correlation" });
			expect(await rpc.response("terminate")).toMatchObject({ success: true, correlationId: "terminate-correlation", data: { acknowledged: true } });
			expect(await rpc.exit()).toBe(0);
			console.log(JSON.stringify({ row: 3, argv: rpc.argv, commands: rpc.commands, wire: rpc.wire, elapsedMs: Date.now() - startedAt, stderr: await rpc.stderr }));
		} finally {
			await disposeRpc(rpc);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 40_000);

	test("row 4: EOF drains legacy work naturally but cancels every managed run before drain", async () => {
		for (const managed of [false, true]) {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-managed-eof-"));
			const rpc = await spawnRpc(cwd, managed);
			const marker = shellMarkers(cwd, "eof", 3);
			try {
				if (managed) {
					await rpc.send({ id: "prepare", type: "prepare" });
					await rpc.response("prepare");
				}
				await rpc.send({ id: "eof-bash", type: "bash", command: marker.command });
				await waitForMarker(marker.started);
				const started = await Bun.file(marker.started).text();
				rpc.child.stdin.end();
				const exitCode = await rpc.exit();
				const result = await rpc.response("eof-bash");
				expect(exitCode).toBe(0);
				expect(started).toBe("started");
				expect(bashCancelled(result)).toBe(managed);
				const finished = await Bun.file(marker.finished).exists();
				expect(finished).toBe(!managed);
				if (managed) {
					const runId = runFor(rpc.frames, "eof-bash");
					const cancellation = rpc.frames.findIndex(frame => isRecord(frame) && frame.type === "managed_lifecycle" && frame.phase === "cancel_run" && frame.runId === runId);
					const drain = rpc.frames.findIndex(frame => isRecord(frame) && frame.type === "managed_lifecycle" && frame.phase === "drain" && frame.reason === "eof");
					expect(cancellation).toBeGreaterThanOrEqual(0);
					expect(drain).toBeGreaterThan(cancellation);
				}
				console.log(JSON.stringify({ row: 4, managed, argv: rpc.argv, commands: rpc.commands, started, finished, cancelled: bashCancelled(result), exitCode, wire: rpc.wire, stderr: await rpc.stderr }));
			} finally {
				await disposeRpc(rpc);
				await fs.rm(cwd, { recursive: true, force: true });
			}
		}
	}, 50_000);

	test("row 5: withheld received heartbeat expires the real server lease and reports execution-unknown", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-managed-lease-"));
		// Test-only compressed timing; production defaults remain heartbeat=10s, lease=30s.
		const env = { PI_MANAGED_LEASE_SECONDS: "2", PI_MANAGED_HEARTBEAT_SECONDS: "1" };
		const childEnv = await isolatedRpcEnvironment(cwd, env);
		const wire: unknown[] = [];
		const commands: unknown[] = [];
		const suppressed: unknown[] = [];
		const lifecycle: RpcManagedLifecycle[] = [];
		let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
		let stdoutDone: Promise<void> = Promise.resolve();
		let stderr = "";
		let stderrDone: Promise<void> = Promise.resolve();
		let stdin: FileSink | undefined;
		const argv = [process.execPath, cliPath, ...baseArgs, "--rpc-subagent"];
		const slow = shellMarkers(cwd, "lease-one", 8);
		const second = shellMarkers(cwd, "lease-two", 8);
		using client = new RpcClient({
			expectManagedBootstrap: true,
			spawn: (): RpcAgentProcess => {
				const proc = Bun.spawn(argv, { cwd, env: childEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
				child = proc;
				stdin = proc.stdin;
				const [clientStream, observerStream] = proc.stdout.tee();
				const decoder = new RpcFrameDecoder();
				stdoutDone = (async () => {
					for await (const frame of readJsonl<unknown>(observerStream)) {
						const decoded = decoder.push(frame);
						if (decoded !== undefined) wire.push(decoded);
					}
				})();
				stderrDone = new Response(proc.stderr).text().then(text => { stderr = text; });
				return {
					stdin: {
						write(data) {
							const text = typeof data === "string" ? data : new TextDecoder().decode(data);
							const frame: unknown = JSON.parse(text);
							if (isRecord(frame) && (frame.type === "heartbeat" ||
								(frame.type === "response" && frame.command === "heartbeat"))) {
								suppressed.push(frame);
								return text.length;
							}
							commands.push(frame);
							return proc.stdin.write(data);
						},
					},
					stdout: clientStream,
					peekStderr: () => stderr,
					kill: () => { if (proc.exitCode === null) proc.kill(); },
					exited: proc.exited,
				};
			},
		});
		const unsubscribe = client.onManagedLifecycle(state => lifecycle.push(state));
		try {
			await client.start();
			expect(client.getManagedLifecycle()).toMatchObject({ status: "active", heartbeatSeconds: 1, leaseSeconds: 2 });
			if (!stdin || !child) throw new Error("RpcClient did not spawn the local process");
			const processHandle = child;
			for (const [id, command] of [["lease-one", slow.command], ["lease-two", second.command]]) {
				const request: RpcCommand = { id, type: "bash", command };
				commands.push(request);
				stdin.write(`${JSON.stringify(request)}\n`);
			}
			await stdin.flush();
			await Promise.all([waitForMarker(slow.started), waitForMarker(second.started)]);
			// No fabricated frames/process: only outgoing client heartbeat bytes are suppressed.
			await Bun.sleep(3_100);
			const exitCode = await withTimeout(processHandle.exited, 15_000, "Lease expiry did not stop RPC");
			await stdoutDone;
			await stderrDone;
			const unknown = await waitFor(() => {
				const state = client.getManagedLifecycle();
				return state.status === "execution-unknown" ? state : undefined;
			}, "managed connection loss");
			expect(unknown.error).toBeInstanceOf(RpcClientError);
			expect(unknown.error.code).toBe("connection-lost");
			expect(exitCode).toBe(0);
			expect(suppressed.length).toBeGreaterThan(0);
			for (const id of ["lease-one", "lease-two"]) {
				const runId = runFor(wire, id);
				expect(runId).toBeDefined();
				expect(wire.some(frame => isRecord(frame) && frame.type === "managed_lifecycle" && frame.phase === "cancel_run" && frame.runId === runId)).toBe(true);
				const result = responseFor(wire, id);
				if (!result) throw new Error(`Missing shutdown bash response for ${id}`);
				expect(bashCancelled(result)).toBe(true);
			}
			expect(await Bun.file(slow.finished).exists()).toBe(false);
			expect(await Bun.file(second.finished).exists()).toBe(false);
			console.log(JSON.stringify({ row: 5, argv, env, commands, suppressed, wire, lifecycle, exitCode, stderr }));
		} finally {
			unsubscribe();
			if (child && child.exitCode === null) child.kill();
			await child?.exited;
			await stdoutDone;
			await stderrDone;
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 40_000);
});
