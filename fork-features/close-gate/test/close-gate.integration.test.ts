import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readLines } from "@oh-my-pi/pi-utils";
import { $, type Subprocess } from "bun";
import { RpcClient } from "../../../packages/coding-agent/src/modes/rpc/rpc-client";
import { RpcFrameDecoder } from "../../../packages/coding-agent/src/modes/rpc/rpc-frame";
import { quotePosixPath } from "../../../packages/coding-agent/src/ssh/utils";
import { validateExecutionTarget } from "../../../packages/coding-agent/src/task/target";
import { FakeRemoteEndpoint } from "../../../packages/coding-agent/test/task/endpoint-fake";
import { createManagedRpcTransport } from "../../ssh-remote-backend/src/transport";
import { sshdBinaryPresent, startIsolatedLoopbackSshd } from "../../ssh-remote-backend/test/support/loopback-sshd";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cli = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const evidenceDir = path.resolve(import.meta.dir, "../evidence");
const baselineInputs = [
	'{"id":"baseline-subscribe","type":"set_subagent_subscription","level":"events"}',
	'{"id":"baseline-subagents","type":"get_subagents"}',
	'{"id":"baseline-abort","type":"abort"}',
	'{"id":"baseline-irc-ingress","type":"irc_message","message":{"role":"custom","customType":"irc:relay","content":"transport-boundary-probe","display":true,"details":{"from":"probe-source","to":"probe-target"},"attribution":"agent","timestamp":0}}',
];
const hubConflictInput = '{"id":"irc-native-hub-conflict","type":"set_host_tools","tools":[{"name":"hub","description":"IRC transport compatibility probe","parameters":{"type":"object","properties":{}}}]}';

type ObservedFrame =
	| { type: "ready"; managed: boolean; protocolMajor: number | undefined }
	| { type: "response"; id: string | undefined; command: string; success: boolean; error: string | undefined; sessionId: string | undefined };

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	// Real SSH subprocess events cannot use fake time; this timer only bounds failure.
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out`)), 15_000);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// A second reader captures actual LF wire lines, not frames reconstructed from client return values.
class WireCapture {
	readonly lines: string[] = [];
	readonly frames = new Map<string, { frame: ObservedFrame; raw: string }>();
	readonly done: Promise<void>;
	#changed = Promise.withResolvers<void>();
	#ended = false;

	constructor(stream: ReadableStream<Uint8Array>) {
		this.done = this.#read(stream);
		// Keep failures handled until the owner awaits done/wait, without changing the rejected promise.
		void this.done.catch(() => {});
	}

	async #read(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new RpcFrameDecoder();
		const textDecoder = new TextDecoder();
		try {
			for await (const bytes of readLines(stream)) {
				const raw = `${textDecoder.decode(bytes)}\n`;
				this.lines.push(raw);
				const value = decoder.push(JSON.parse(raw));
				if (!isRecord(value)) continue;
				let frame: ObservedFrame;
				if (value.type === "ready") {
					frame = { type: "ready", managed: "nativeAgent" in value, protocolMajor: isRecord(value.nativeAgent) && typeof value.nativeAgent.protocolMajor === "number" ? value.nativeAgent.protocolMajor : undefined };
				} else if (value.type === "response" && typeof value.command === "string" && typeof value.success === "boolean") {
					frame = { type: "response", id: typeof value.id === "string" ? value.id : undefined, command: value.command, success: value.success, error: typeof value.error === "string" ? value.error : undefined, sessionId: isRecord(value.data) && typeof value.data.sessionId === "string" ? value.data.sessionId : undefined };
				} else continue;
				this.frames.set(frame.type === "ready" ? "ready" : frame.id ?? frame.command, { frame, raw });
				this.#changed.resolve();
				this.#changed = Promise.withResolvers<void>();
			}
		} finally {
			this.#ended = true;
			this.#changed.resolve();
		}
	}

	async wait(id: string): Promise<{ frame: ObservedFrame; raw: string }> {
		return within((async () => {
			for (;;) {
				const found = this.frames.get(id);
				if (found) return found;
				if (this.#ended) {
					await this.done;
					throw new Error(`EOF before frame ${id}`);
				}
				await this.#changed.promise;
			}
		})(), `wire frame ${id}`);
	}
}

interface LivePeer {
	client: RpcClient;
	child: Subprocess<"pipe", "pipe", "pipe">;
	wire: WireCapture;
	stderr: Promise<string>;
	requests: Array<{ id: string; type: string }>;
}

async function control(peer: LivePeer, command: "get_state" | "abort") {
	if (command === "get_state") await within(peer.client.getState(), command);
	else await within(peer.client.abort(), command);
	const request = peer.requests.findLast(entry => entry.type === command);
	if (!request) throw new Error(`No ${command} request observed`);
	const observed = await peer.wire.wait(request.id);
	expect(observed.frame).toMatchObject({ type: "response", id: request.id, command, success: true });
	console.log(`Close-gate control (summary; full wire frame persisted): ${JSON.stringify(observed.frame)}`);
	return observed;
}

async function persist(name: string, contents: string): Promise<void> {
	await Bun.write(path.join(evidenceDir, name), contents);
}

if (!(await sshdBinaryPresent())) throw new Error("ABORT close-gate: sshd unavailable; real SSH evidence cannot be collected");

describe.if(await sshdBinaryPresent())("stage-1 real loopback SSH close-gate", () => {
	it("captures B1–B4, managed control, real transport EOF and explicitly bounded endpoint/resume evidence", async () => {
		const daemon = await startIsolatedLoopbackSshd({ logLabel: "close-gate" });
		const peers: LivePeer[] = [];
		let local: Subprocess<"pipe", "pipe", "pipe"> | undefined;
		let localStderr: Promise<string> | undefined;
		const peerAbort = new AbortController();
		try {
			const home = path.join(daemon.tmpDir, "home");
			const agentDir = path.join(home, ".omp", "agent");
			const config = path.join(agentDir, "config.yml");
			await Bun.write(config, "modelRoles:\n  default: anthropic/claude-sonnet-4-5\n");
			const isolatedEnv = { HOME: home, PI_CODING_AGENT_DIR: agentDir, XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache") };
			const shaResult = await $`git rev-parse HEAD`.cwd(repoRoot).quiet();
			const sha = shaResult.text().trim();
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
			expect((await $`git rev-parse --verify HEAD`.cwd(repoRoot).quiet()).text().trim()).toBe(sha);
			const versionResult = await $`${process.execPath} ${cli} --version`.cwd(repoRoot).env({ ...process.env, ...isolatedEnv }).quiet();
			const version = versionResult.text().trim();
			expect(version).toMatch(/^omp\/\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
			const sshdPath = Bun.which("sshd");
			if (!sshdPath) throw new Error("sshd disappeared after prerequisite check");
			const sshdVersion = await $`${sshdPath} -V`.quiet();
			const sshVersion = await $`ssh -V`.quiet();
			const environment = { bun: Bun.version, sshd: `${sshdVersion.text()}${sshdVersion.stderr.toString()}`.trim(), sshClient: `${sshVersion.text()}${sshVersion.stderr.toString()}`.trim(), platform: process.platform, architecture: process.arch };
			const baseline = { sha, shaScope: "HEAD before the close-gate evidence commit; driver changes are in the containing commit", version, cli, commands: { sha: "git rev-parse HEAD", version: [process.execPath, cli, "--version"] }, exitCodes: { sha: shaResult.exitCode, version: versionResult.exitCode }, environment, model: { selection: "anthropic/claude-sonnet-4-5", authorization: "No model request or credential required for control-only RPC; fresh temporary config, no copied user configs" } };
			await persist("baseline.json", `${JSON.stringify(baseline, null, 2)}\n`);
			console.log(`Close-gate B1 environment: ${JSON.stringify(baseline)}`);

			// Explicit bundled model permits credential-free control-only startup; RFC frames issue no model request.
			const localCommand = [process.execPath, cli, "--mode", "rpc", "--no-session", "--provider", "anthropic", "--model", "claude-sonnet-4-5"];
			local = Bun.spawn(localCommand, { cwd: daemon.tmpDir, env: { ...process.env, ...isolatedEnv }, stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: peerAbort.signal });
			localStderr = new Response(local.stderr).text();
			const localWire = new WireCapture(local.stdout);
			const localReady = await localWire.wait("ready");
			expect(localReady.frame).toEqual({ type: "ready", managed: false, protocolMajor: undefined });
			for (const input of baselineInputs) local.stdin.write(`${input}\n`);
			const baselineFrames: string[] = [];
			for (const [id, command] of [["baseline-subscribe", "set_subagent_subscription"], ["baseline-subagents", "get_subagents"], ["baseline-abort", "abort"], ["baseline-irc-ingress", "irc_message"]]) {
				// Legacy unknown-command responses deliberately omit id (rpc-mode.ts default arm).
				const observed = await localWire.wait(command === "irc_message" ? command : id);
				if (command === "irc_message") expect(observed.frame).toMatchObject({ type: "response", command, success: false, error: "Unknown command: irc_message" });
				else expect(observed.frame).toMatchObject({ type: "response", id, command, success: true });
				baselineFrames.push(observed.raw);
				console.log(`Close-gate baseline: ${observed.raw.trim()}`);
			}
			await persist("b2-b3-frames.jsonl", baselineFrames.join(""));
			local.stdin.write(`${hubConflictInput}\n`);
			const conflict = await localWire.wait("irc-native-hub-conflict");
			expect(conflict.frame).toMatchObject({ type: "response", id: "irc-native-hub-conflict", command: "set_host_tools", success: false, error: 'RPC host tool "hub" conflicts with an existing tool' });
			await persist("b4-hub-conflict.json", conflict.raw);
			console.log(`Close-gate B4: ${conflict.raw.trim()}`);
			local.stdin.end();
			expect(await within(local.exited, "legacy stdin EOF exit")).toBe(0);
			await localWire.done;
			await persist("baseline.json", `${JSON.stringify({ ...baseline, legacy: { command: localCommand, readyFrame: localReady.raw, inputFrames: baselineInputs.map(line => `${line}\n`), hostToolInput: `${hubConflictInput}\n`, exitCode: local.exitCode } }, null, 2)}\n`);

			const alias = `close-gate-${daemon.port}`;
			await Bun.write(path.join(daemon.tmpDir, "ssh.json"), JSON.stringify({ hosts: { [alias]: { host: daemon.host, port: daemon.port, username: os.userInfo().username } } }));
			const executable = path.join(daemon.tmpDir, "managed-omp");
			const environmentArgs = Object.entries(isolatedEnv).map(([key, value]) => `${key}=${quotePosixPath(value)}`).join(" ");
			await Bun.write(executable, `#!/bin/sh\nexec env ${environmentArgs} ${quotePosixPath(process.execPath)} ${quotePosixPath(cli)} --no-session --provider anthropic --model claude-sonnet-4-5 --config ${quotePosixPath(config)} "$@"\n`);
			await fs.chmod(executable, 0o700);
			const validated = await validateExecutionTarget({ kind: "ssh", host: alias, cwd: daemon.tmpDir, executable }, { cwd: daemon.tmpDir });
			if ("error" in validated) throw new Error(JSON.stringify(validated.error));
			if (validated.target.kind !== "ssh") throw new Error("Target did not resolve to SSH");
			const target = validated.target;
			const transport = await createManagedRpcTransport({ name: target.host, cwd: target.cwd, executable: target.executable, extraSshArgs: ["-F", "/dev/null", "-i", daemon.clientKeyPath, "-o", `UserKnownHostsFile=${daemon.knownHostsPath}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-p", String(daemon.port), "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no"] });

			async function openPeer(): Promise<LivePeer> {
				const child = Bun.spawn([...transport.command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: peerAbort.signal });
				const stderr = new Response(child.stderr).text();
				const [clientOutput, observedOutput] = child.stdout.tee();
				const wire = new WireCapture(observedOutput);
				const requests: LivePeer["requests"] = [];
				const client = new RpcClient({ command: [...transport.command], expectManagedBootstrap: true,
					// The public seam observes the SSH PID/EOF and tees bytes; command itself is consumed unchanged.
					spawn: () => ({ stdin: { write(data) {
						const request: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
						if (isRecord(request) && typeof request.id === "string" && typeof request.type === "string") requests.push({ id: request.id, type: request.type });
						return child.stdin.write(data);
					} }, stdout: clientOutput, peekStderr: () => "See close-gate captured SSH stderr", kill: signal => { if (child.exitCode === null) child.kill(typeof signal === "string" || typeof signal === "number" ? signal : "SIGTERM"); }, exited: child.exited }),
				});
				const peer = { client, child, wire, stderr, requests };
				peers.push(peer);
				await within(client.start(), "managed startup");
				expect((await wire.wait("ready")).frame).toEqual({ type: "ready", managed: true, protocolMajor: 1 });
				return peer;
			}

			const first = await openPeer();
			const firstState = await control(first, "get_state");
			await control(first, "abort");
			const endpoint = new FakeRemoteEndpoint();
			await endpoint.prepare();
			const ack = await endpoint.start("test-only bridge watching the real SSH transport; not a dispatched task");
			const outcome = endpoint.run(ack.runId);
			const remoteHandle = endpoint.handle;
			if (remoteHandle.kind !== "remote") throw new Error("Expected remote test handle");
			const reference = remoteHandle.reference;
			// The fake is advanced only by observed EOF, never by a manually resolved outcome.
			const lostTransport = first.wire.done.then(() => endpoint.abortTransport());
			first.child.kill("SIGTERM");
			const breakExitCode = await within(first.child.exited, "terminated SSH child");
			await within(lostTransport, "SSH stdout EOF");
			// Required platform observation window after EOF; correctness above waits for the actual exit/EOF events.
			await Bun.sleep(500);
			expect(breakExitCode).not.toBe(0);
			expect((await outcome).status).toBe("execution-unknown");
			const snapshots = { job: endpoint.asJobSnapshot(), handle: endpoint.asHandleSnapshot(), roster: endpoint.asRosterSnapshot() };
			for (const snapshot of Object.values(snapshots)) expect(snapshot.status).toBe("execution-unknown");
			await persist("composed-managed-session.jsonl", first.wire.lines.join(""));
			const lossEvidence = { bridge: "FakeRemoteEndpoint test adapter triggered by real SSH stdout EOF; NOT live hub/registry/AsyncJobManager integration", target, transportCommand: transport.command, sshdPid: daemon.sshdPid, sshChildPid: first.child.pid, signal: "SIGTERM", exitCode: breakExitCode, stdoutEof: true, reference, snapshots };
			await persist("execution-unknown-snapshots.json", `${JSON.stringify(lossEvidence, null, 2)}\n`);
			console.log(`Close-gate transport break: ${JSON.stringify(lossEvidence)}`);
			await first.client.stop();

			// There is no reference-taking resume API in v0: retain the same opaque caller token,
			// attempt reattachment via the only available operation (fresh launch), and compare real session IDs.
			const resumeAttempt = { reference, peer: await openPeer() };
			expect(resumeAttempt.reference).toBe(reference);
			const freshState = await control(resumeAttempt.peer, "get_state");
			if (firstState.frame.type !== "response" || freshState.frame.type !== "response") throw new Error("Missing session state responses");
			expect(firstState.frame.sessionId).toBeString();
			expect(freshState.frame.sessionId).toBeString();
			expect(freshState.frame.sessionId).not.toBe(firstState.frame.sessionId);
			resumeAttempt.peer.child.stdin.end();
			expect(await within(resumeAttempt.peer.child.exited, "fresh session EOF")).toBe(0);
			await resumeAttempt.peer.wire.done;
			await resumeAttempt.peer.client.stop();
			await persist("resume-v0-undefined.md", `# Same-reference resume observation\n\nResume within the four-method contract is v0-undefined per issue #3 doc-comment; #4 owns the resume protocol negotiation (mouriya-s-lab#9).\n\nReferences: [contract #3](https://github.com/mouriya-s-lab/oh-my-pi/issues/3), [bootstrap #4](https://github.com/mouriya-s-lab/oh-my-pi/issues/4), [full lifecycle #9](https://github.com/mouriya-s-lab/oh-my-pi/issues/9).\n\nThe contract does not expose resume/ensureLive. The retained opaque test-adapter token was \`${reference}\`; it was NOT sent as a supported server resume request. Fresh RpcClient startup is the only implemented attempt; it made a new SSH connection and NEW session, not an automatic resume. No task was submitted or replayed.\n\nOriginal session: \`${firstState.frame.sessionId}\`; SSH PID ${first.child.pid}, transport exit ${breakExitCode}.\nFresh session: \`${freshState.frame.sessionId}\`; SSH PID ${resumeAttempt.peer.child.pid}, clean EOF exit 0.\n\nObserved fresh-connection wire frames (verbatim):\n\n\`\`\`jsonl\n${resumeAttempt.peer.wire.lines.join("")}\`\`\`\n\nThis does not prove reconnect-to-existing-session, duplicate execution prevention, terminal-event ordering or task completion. Those require the full lifecycle protocol.\n`);

			const second = await openPeer();
			const secondState = await control(second, "get_state");
			await persist("second-peer-get-state.json", secondState.raw);
			second.child.stdin.end();
			expect(await within(second.child.exited, "second peer EOF")).toBe(0);
			await second.wire.done;
			console.log("Close-gate: legacy + fresh resume-attempt + second peer clean EOF exitCode=0; row 2 blocked #7/#11; live row 3 blocked #8 (only test-adapter fanout observed)");
		} finally {
			peerAbort.abort();
			if (local) await local.exited;
			if (localStderr) console.log(`Close-gate local stderr: ${(await localStderr).trim()}`);
			for (const peer of peers) {
				await peer.client.stop();
				await peer.child.exited;
				console.log(`Close-gate SSH stderr: ${(await peer.stderr).trim()}`);
			}
			await daemon.stop();
			console.log("Close-gate cleanup: SSH children reaped; sshd stopped; isolated config/home/keys removed");
		}
	}, 120_000);
});
