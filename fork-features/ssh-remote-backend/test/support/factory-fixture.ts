/**
 * Shared real-SSH fixture for the issue #10 factory/transport integration rows.
 *
 * One isolated loopback `sshd` (the existing helper, never a mock), one isolated
 * project SSH inventory, one isolated remote agent environment, and one owned
 * OpenSSH ControlMaster socket. Nothing here touches the user's real SSH config,
 * keys, known_hosts, agent directory or shared connection-manager control path:
 *
 * - the host inventory is the production discovery shape (`.omp/ssh.json` in the
 *   target cwd), resolved through the production lookup context,
 * - the local SSH prefix the tests inject overrides only *local* OpenSSH options
 *   (config file, identity, known_hosts, ControlPath) and never the remote argv,
 * - the control socket lives in a short owned `/tmp` path, so a long fixture
 *   tempdir can never overflow `sun_path`, and only this fixture's master is
 *   ever addressed by `ssh -O check` / `ssh -O exit`.
 *
 * The peer is the real repo CLI (`packages/coding-agent/src/cli.ts`) launched by
 * absolute Bun through a tiny temporary wrapper; the wrapper pins the isolated
 * HOME/agent/XDG environment and deliberately does not `cd`, so the working
 * directory the tests observe can only come from the managed prepare frame.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getControlPathTemplate } from "../../../../packages/coding-agent/src/ssh/connection-manager";
import { quotePosixPath } from "../../../../packages/coding-agent/src/ssh/utils";
import type { SshBackendCommand } from "../../command";
import type { RunSshCommand } from "../../executable-probe";
import type { ResolveSshHostContext } from "../../lookup";
import { openSshBackendTransport, type OpenSshBackendTransportOptions, type SshBackendTransport } from "../../transport";
import { startIsolatedLoopbackSshd, type LoopbackSshdHandle } from "./loopback-sshd";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages/coding-agent/src/cli.ts");
/** Control-only RPC needs a resolvable model but never a provider request. */
const CLI_ARGS = ["--no-session", "--provider", "anthropic", "--model", "claude-sonnet-4-5"];

/** Observed state of one file path, used to prove unrelated SSH state is untouched. */
export interface PathSnapshot {
	exists: boolean;
	mtimeMs?: number;
	ino?: number;
	size?: number;
}

export interface FactorySshFixture {
	readonly sshd: LoopbackSshdHandle;
	readonly alias: string;
	readonly port: number;
	readonly host: string;
	readonly hostUsername: string;
	/** Fixture root under the short `/tmp` alias; holds work/home/wrapper/socket. */
	readonly root: string;
	/** Remote target cwd: a real directory, never the fixture HOME. */
	readonly targetCwd: string;
	readonly home: string;
	readonly agentDir: string;
	readonly wrapperPath: string;
	readonly wrapperContent: string;
	readonly controlDir: string;
	readonly controlPath: string;
	readonly productionControlPath: string;
	readonly knownHostsPath: string;
	readonly clientKeyPath: string;
	/** Local-only OpenSSH options prepended to every fixture SSH invocation. */
	readonly sshPrefixArgs: readonly string[];
	/** Production-shaped lookup context: project inventory cwd + isolated agent directory. */
	lookupContext(): ResolveSshHostContext;
	/** Same argv stages with the fixture isolation options prepended to the local prefix. */
	prefixCommand(command: SshBackendCommand): SshBackendCommand;
	/** Production transport with the fixture prefix injected; remote argv untouched. */
	openTransport(command: SshBackendCommand, options?: OpenSshBackendTransportOptions): Promise<SshBackendTransport>;
	/** Production runSshCommand shape for the executable PATH probe. */
	runSshCommand: RunSshCommand;
	/** Real `ssh -O check` against the fixture control socket; pid present while the master lives. */
	masterStatus(): Promise<{ running: boolean; pid?: number; stderr: string }>;
	/** Real `ssh -O exit` against the fixture control socket only. */
	exitMaster(): Promise<{ exitCode: number; stderr: string }>;
	/** Snapshot of the shared production ControlPath, so a row can prove it was never touched. */
	productionControlSnapshot(): Promise<PathSnapshot>;
	/** Structured setup facts for the PR evidence log (isolated paths only, no secrets). */
	describeSetup(): Record<string, unknown>;
	/** Stop the owned master, then the daemon; idempotent, safe after peers were released. */
	stop(): Promise<void>;
}

/**
 * Bound a promise that waits on real SSH/subprocess events. The integration
 * rows deliberately run against the platform clock (a real daemon, a real
 * client and a real peer cannot be advanced by fake timers), so the timer here
 * only turns a hang into a failure message — it never races a correct result.
 */
export async function withinMs<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** Values of every `-o key=value` option, in argv order (OpenSSH keeps the first). */
export function sshOptionValues(argv: readonly string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] !== "-o") continue;
		const pair = argv[index + 1];
		const separator = pair.indexOf("=");
		if (separator <= 0 || pair.slice(0, separator) !== key) continue;
		values.push(pair.slice(separator + 1));
	}
	return values;
}

/** Values following every occurrence of a plain flag, in argv order. */
export function sshFlagValues(argv: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === flag) values.push(argv[index + 1]);
	}
	return values;
}

async function snapshot(pathToStat: string): Promise<PathSnapshot> {
	try {
		const stats = await fs.stat(pathToStat);
		return { exists: true, mtimeMs: stats.mtimeMs, ino: stats.ino, size: stats.size };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		throw error;
	}
}

/** Prepend local OpenSSH options, preserving every existing local and remote word. */
function prefixSshArgv(ssh: readonly string[], prefixArgs: readonly string[]): string[] {
	const binary = ssh[0];
	if (binary === undefined) throw new Error("SSH argv prefix is empty");
	return [binary, ...prefixArgs, ...ssh.slice(1)];
}

async function runSsh(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

export async function startFactorySshFixture(opts: { logLabel?: string } = {}): Promise<FactorySshFixture> {
	const label = opts.logLabel ?? "factory-ssh";
	const sshd = await startIsolatedLoopbackSshd({ logLabel: label });
	let root: string | undefined;
	let stopWork: Promise<void> | undefined;
	try {
		// `/tmp` is used as the alias form, never its `/private/tmp` realpath: the
		// peer echoes back the exact string it was asked to enter, so the fixture
		// must own that string. macOS `standardizeMacOSPath` maps `/private/...`
		// to the `/var`…/`/tmp`… alias, and a realpath here would make the durable
		// string diverge from the ACK.
		root = await fs.mkdtemp(path.join("/tmp", "omp-ssh10-"));
		const targetCwd = path.join(root, "work");
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp", "agent");
		// The user agent directory must exist before the production lookup stats it.
		// Bun.write below creates every other parent directory, so no mkdir precedes it.
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });

		const alias = `issue10-${sshd.port}`;
		const hostUsername = os.userInfo().username;
		const sshJsonPath = path.join(targetCwd, ".omp", "ssh.json");
		// Bun.write creates parent directories; no mkdir precedes content writes.
		await Bun.write(
			sshJsonPath,
			`${JSON.stringify(
				{ hosts: { [alias]: { host: sshd.host, port: sshd.port, username: hostUsername, key: sshd.clientKeyPath } } },
				null,
				2,
			)}\n`,
		);

		// The wrapper runtime is deliberately the actual running Bun: process.execPath
		// is the absolute path of this test's own runtime, so the peer launches the
		// identical binary instead of whatever `bun` resolves to on PATH.
		const bunBinary = process.execPath;
		if (!path.basename(bunBinary).startsWith("bun")) {
			throw new Error(`the test runtime ${JSON.stringify(bunBinary)} is not a Bun binary`);
		}
		const wrapperPath = path.join(root, "managed-omp");
		// No `cd`: the working directory can only arrive through the managed prepare frame.
		const wrapperContent = [
			"#!/bin/sh",
			`exec env HOME=${quotePosixPath(home)} PI_CODING_AGENT_DIR=${quotePosixPath(agentDir)} XDG_DATA_HOME=${quotePosixPath(path.join(home, "data"))} XDG_STATE_HOME=${quotePosixPath(path.join(home, "state"))} XDG_CACHE_HOME=${quotePosixPath(path.join(home, "cache"))} PI_NO_TITLE=1 PI_SKIP_VERSION_CHECK=1 ${quotePosixPath(bunBinary)} ${quotePosixPath(CLI_ENTRY)} ${CLI_ARGS.join(" ")} "$@"`,
			"",
		].join("\n");
		// Bun.write creates parent directories; the executable bit needs an explicit async chmod.
		await Bun.write(wrapperPath, wrapperContent);
		await fs.chmod(wrapperPath, 0o700);

		// Owned, short control socket: the shared production path is never addressed.
		const controlDir = path.join(root, "sock");
		await fs.mkdir(controlDir, { recursive: true, mode: 0o700 });
		const controlPath = path.join(controlDir, "c.sock");
		const productionControlPath = getControlPathTemplate();

		const sshPrefixArgs: readonly string[] = [
			"-F",
			"/dev/null",
			"-o",
			`UserKnownHostsFile=${sshd.knownHostsPath}`,
			"-o",
			"GlobalKnownHostsFile=/dev/null",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"IdentityAgent=none",
			"-o",
			`ControlPath=${controlPath}`,
		];

		const masterArgv = (operation: "check" | "exit"): string[] => [
			"ssh",
			"-F",
			"/dev/null",
			"-o",
			"BatchMode=yes",
			"-o",
			`UserKnownHostsFile=${sshd.knownHostsPath}`,
			"-o",
			"GlobalKnownHostsFile=/dev/null",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"IdentityAgent=none",
			"-o",
			`ControlPath=${controlPath}`,
			"-p",
			String(sshd.port),
			"-O",
			operation,
			`${hostUsername}@${sshd.host}`,
		];

		const fixture: FactorySshFixture = {
			sshd,
			alias,
			port: sshd.port,
			host: sshd.host,
			hostUsername,
			root,
			targetCwd,
			home,
			agentDir,
			wrapperPath,
			wrapperContent,
			controlDir,
			controlPath,
			productionControlPath,
			knownHostsPath: sshd.knownHostsPath,
			clientKeyPath: sshd.clientKeyPath,
			sshPrefixArgs,
			lookupContext: () => ({ cwd: targetCwd, getAgentDirectory: async () => agentDir }),
			prefixCommand(command) {
				return { ...command, ssh: prefixSshArgv(command.ssh, sshPrefixArgs) };
			},
			openTransport(command, options) {
				return openSshBackendTransport({ ...command, ssh: prefixSshArgv(command.ssh, sshPrefixArgs) }, options);
			},
			async runSshCommand(ssh, remote) {
				// The remote argv is appended verbatim: isolation options are local only.
				return await runSsh([...prefixSshArgv(ssh, sshPrefixArgs), ...remote]);
			},
			async masterStatus() {
				const result = await runSsh(masterArgv("check"));
				const pid = /Master running \(pid=(\d+)\)/.exec(result.stderr)?.[1];
				return { running: result.exitCode === 0 && pid !== undefined, pid: pid === undefined ? undefined : Number(pid), stderr: result.stderr.trim() };
			},
			async exitMaster() {
				const result = await runSsh(masterArgv("exit"));
				return { exitCode: result.exitCode, stderr: result.stderr.trim() };
			},
			productionControlSnapshot: () => snapshot(productionControlPath),
			describeSetup: () => ({
				logLabel: label,
				sshdPid: sshd.sshdPid,
				sshdPort: sshd.port,
				hostAlias: alias,
				targetCwd,
				home,
				agentDir,
				wrapperPath,
				wrapperContent,
				bunExecutable: bunBinary,
				bunOnPath: Bun.which("bun"),
				controlPath,
				productionControlPath,
				knownHostsPath: sshd.knownHostsPath,
				clientKeyPath: sshd.clientKeyPath,
				sshPrefixArgs,
				masterCheckArgv: masterArgv("check"),
				masterExitArgv: masterArgv("exit"),
			}),
			stop() {
				if (stopWork) return stopWork;
				stopWork = (async () => {
					// Owned master first (its socket lives under `root`), then the daemon.
					// A row that already exited the master itself leaves no socket, so
					// cleanup only asks when there is still something to exit. A socket
					// is not a regular file, so existence uses async fs.stat, never Bun.file.
					let socketPresent = true;
					try {
						await fs.stat(controlPath);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") socketPresent = false;
						else throw error;
					}
					const exited = socketPresent
						? `master exit ${JSON.stringify(await this.exitMaster())}`
						: "master already exited by the row";
					await fs.rm(root ?? "", { recursive: true, force: true });
					await sshd.stop();
					console.log(
						`[${label}] Cleanup: ${exited}; fixture root and control socket removed; isolated sshd stopped`,
					);
				})();
				return stopWork;
			},
		};
		console.log(`[${label}] Fixture ready: ${JSON.stringify(fixture.describeSetup())}`);
		return fixture;
	} catch (error) {
		// Setup failure: never leave the isolated daemon or our root behind.
		if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
		await sshd.stop().catch(() => undefined);
		throw error;
	}
}
