import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { RpcClient } from "../../../packages/coding-agent/src/modes/rpc/rpc-client";
import { RpcFrameDecoder } from "../../../packages/coding-agent/src/modes/rpc/rpc-frame";
import { quotePosixPath } from "../../../packages/coding-agent/src/ssh/utils";
import { createManagedRpcTransport } from "../src";
import { startIsolatedLoopbackSshd, sshdBinaryPresent, type LoopbackSshdHandle } from "./support/loopback-sshd";

const hasSshd = await sshdBinaryPresent();
const loopback = hasSshd ? describe : describe.skip;

function resolveRepoRoot(): string {
	return path.resolve(import.meta.dir, "../../..");
}

// Real subprocess/TCP events require platform time; these are failure bounds, not guessed success delays.
async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

interface ObservedResponse {
	id: string;
	command: string;
	success: boolean;
}

interface LivePeer {
	client: RpcClient;
	child: Subprocess<"pipe", "pipe", "pipe">;
	ready: Promise<number>;
	requests: Array<{ id: string; type: string }>;
	waitForResponse(id: string): Promise<ObservedResponse>;
	observed: Promise<void>;
	stderr: Promise<string>;
}

loopback("isolated SSH managed RPC", () => {
	let fixture: LoopbackSshdHandle | undefined;
	let tempDir: string | undefined;
	const peerAbort = new AbortController();
	const peers: LivePeer[] = [];
	let first: LivePeer;
	let second: LivePeer;
	let port: number;
	let alias: string;
	let executable: string;

	// Last-resort synchronous finalizer also covers interrupted setup. It touches only our peer children;
	// the helper owns daemon/temp lifecycle.
	const finalize = () => {
		peerAbort.abort();
	};

	beforeAll(async () => {
		fixture = await startIsolatedLoopbackSshd({ logLabel: "ssh-loopback" });
		tempDir = fixture.tmpDir;
		port = fixture.port;
		process.once("exit", finalize);
		alias = `loopback-${port}`;

		// Real project discovery, not a patched inventory. The unique alias lives only under the fixture cwd.
		await Bun.write(path.join(tempDir, "ssh.json"), JSON.stringify({
			hosts: { [alias]: { host: "127.0.0.1", username: os.userInfo().username, port } },
		}));
		executable = path.join(tempDir, "managed-omp");
		// A two-line executable script preserves the public single-path executable contract.
		// Absolute Bun avoids the non-interactive SSH PATH failure recorded in RFC #1 §10.
		const home = path.join(tempDir, "home");
		await fs.promises.mkdir(home);
		// Select a real bundled model explicitly: control-only RPC needs no API key or model request.
		await Bun.write(executable, `#!/bin/sh\nexec env HOME=${quotePosixPath(home)} PI_CODING_AGENT_DIR=${quotePosixPath(path.join(home, ".omp", "agent"))} XDG_DATA_HOME=${quotePosixPath(path.join(home, "data"))} XDG_STATE_HOME=${quotePosixPath(path.join(home, "state"))} XDG_CACHE_HOME=${quotePosixPath(path.join(home, "cache"))} ${quotePosixPath(process.execPath)} ${quotePosixPath(path.join(resolveRepoRoot(), "packages/coding-agent/src/cli.ts"))} --no-session --provider anthropic --model claude-sonnet-4-5 "$@"\n`);
		await fs.promises.chmod(executable, 0o700);
	}, 15_000);

	afterAll(async () => {
		try {
			for (const peer of peers) peer.child.stdin.end();
			for (const peer of peers) await peer.client.stop();
			peerAbort.abort();
			await Promise.all(peers.map(peer => peer.child.exited));
		} finally {
			// Reap our peers first, then hand the daemon and tempdir to the helper's idempotent stop.
			await fixture?.stop();
			if (tempDir) expect(fs.existsSync(tempDir)).toBe(false);
			process.removeListener("exit", finalize);
		}
	});

	async function openPeer(): Promise<LivePeer> {
		const sshd = fixture;
		if (!sshd || !tempDir) throw new Error("Loopback fixture not initialized");
		const transport = await createManagedRpcTransport({
			name: alias, cwd: tempDir, executable,
			extraSshArgs: [
				"-F", "/dev/null", "-i", sshd.clientKeyPath,
				"-o", `UserKnownHostsFile=${sshd.knownHostsPath}`,
				"-o", "GlobalKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=yes",
				"-o", "IdentitiesOnly=yes", "-p", String(port),
				// Independent-connection fallback is acceptable for this skeleton: release must not kill the daemon/peer.
				// Disable multiplexing before helper defaults, avoiding any user/global control socket or persistent process.
				"-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
			],
		});
		const child = Bun.spawn([...transport.command], {
			stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: peerAbort.signal,
		});
		const stderr = new Response(child.stderr).text();
		const [clientOutput, evidenceOutput] = child.stdout.tee();
		const ready = Promise.withResolvers<number>();
		const responses = new Map<string, ObservedResponse>();
		const responseWaiters = new Map<string, (response: ObservedResponse) => void>();
		const requests: Array<{ id: string; type: string }> = [];
		const decoder = new RpcFrameDecoder();
		const textDecoder = new TextDecoder();
		const observed = (async () => {
			for await (const line of readLines(evidenceOutput)) {
				const parsed: unknown = JSON.parse(textDecoder.decode(line));
				const frame = decoder.push(parsed);
				if (!frame || typeof frame !== "object") continue;
				if ("type" in frame && frame.type === "ready" && "nativeAgent" in frame) {
					const nativeAgent = frame.nativeAgent;
					if (nativeAgent && typeof nativeAgent === "object" && "protocolMajor" in nativeAgent && typeof nativeAgent.protocolMajor === "number") ready.resolve(nativeAgent.protocolMajor);
				}
				if ("type" in frame && frame.type === "response" && "id" in frame && typeof frame.id === "string" && "command" in frame && typeof frame.command === "string" && "success" in frame && typeof frame.success === "boolean") {
					const response = { id: frame.id, command: frame.command, success: frame.success };
					responses.set(frame.id, response);
					responseWaiters.get(frame.id)?.(response);
					responseWaiters.delete(frame.id);
				}
			}
		})();
		const client = new RpcClient({
			expectManagedBootstrap: true,
			// Public spawn seam retains stdin EOF and wire evidence; it consumes the factory argv unchanged.
			spawn: () => ({
				stdin: { write(data) {
					const text = typeof data === "string" ? data : new TextDecoder().decode(data);
					const request: unknown = JSON.parse(text);
					if (request && typeof request === "object" && "id" in request && typeof request.id === "string" && "type" in request && typeof request.type === "string") requests.push({ id: request.id, type: request.type });
					return child.stdin.write(data);
				} },
				stdout: clientOutput, peekStderr: () => "See captured loopback SSH stderr",
				kill: signal => {
					// The RpcClient seam passes an Exception reason; Bun's kill takes a signal, so narrow it.
					if (child.exitCode !== null) return;
					child.kill(typeof signal === "string" || typeof signal === "number" ? signal : "SIGTERM");
				}, exited: child.exited,
			}),
		});
		const peer: LivePeer = {
			client, child, ready: ready.promise, requests, observed, stderr,
			waitForResponse(id) {
				const response = responses.get(id);
				if (response) return Promise.resolve(response);
				const pending = Promise.withResolvers<ObservedResponse>();
				responseWaiters.set(id, pending.resolve);
				return pending.promise;
			},
		};
		peers.push(peer);
		try {
			await within(client.start(), 15_000, "managed RpcClient ready");
		} catch (error) {
			await client.stop();
			throw new Error(`${String(error)}\nSSH stderr: ${await stderr}`, { cause: error });
		}
		return peer;
	}

	async function assertResponse(peer: LivePeer, command: "get_state" | "abort"): Promise<void> {
		if (command === "get_state") await peer.client.getState();
		else await peer.client.abort();
		const request = peer.requests.findLast(entry => entry.type === command);
		if (!request) throw new Error(`RpcClient did not send ${command}`);
		// The tee's evidence reader may lag RpcClient; await the actual frame rather than scheduler ordering.
		const response = await within(peer.waitForResponse(request.id), 1_000, `observing ${command} ${request.id}`);
		expect(response).toEqual({ id: request.id, command, success: true });
		console.log(`Live RPC response: ${JSON.stringify(response)}`);
	}

	it("real launch of managed omp over loopback", async () => {
		first = await openPeer();
		expect(await within(first.ready, 15_000, "observed ready frame")).toBe(1);
		console.log("Live ready: nativeAgent.protocolMajor=1 (in-repo CLI, absolute Bun, managed bootstrap)");
	}, 20_000);

	it("control frames succeed on the live managed session", async () => {
		await assertResponse(first, "get_state");
		await assertResponse(first, "abort");
	}, 10_000);

	it("clean stdin close, exit 0", async () => {
		second = await openPeer();
		await assertResponse(second, "get_state");
		first.child.stdin.end();
		expect(await within(first.child.exited, 10_000, "SSH stdin EOF")).toBe(0);
		await first.observed;
		console.log("Released first peer via stdin EOF: SSH exitCode=0; second peer remains connected");
	}, 25_000);

	it("release one peer, second peer's control frame still succeeds", async () => {
		expect(first.child.exitCode).toBe(0);
		await assertResponse(second, "get_state");
		second.child.stdin.end();
		expect(await within(second.child.exited, 10_000, "second peer stdin EOF")).toBe(0);
		await second.observed;
		console.log("Second peer survived first release: get_state success=true; own EOF exitCode=0");
	}, 15_000);
});
