import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

export interface LoopbackSshdHandle {
	host: "127.0.0.1";
	port: number;
	clientKeyPath: string;
	knownHostsPath: string;
	tmpDir: string;
	sshdPid: number;
	stop(): Promise<void>;
}

// Real subprocess/TCP events require platform time; these are failure bounds, not guessed success delays.
const LISTEN_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 250;
const PROBE_INTERVAL_MS = 50;

/** Actual binary discovery, shared by the caller's describe.if guard and the fixture spawn. */
export async function sshdBinaryPresent(): Promise<boolean> {
	return process.platform !== "win32" && $which("sshd") !== null;
}

async function freePort(): Promise<number> {
	const ready = Promise.withResolvers<number>();
	const server = net.createServer();
	server.once("error", ready.reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		server.close(error => {
			if (error) ready.reject(error);
			else if (address && typeof address !== "string") ready.resolve(address.port);
			else ready.reject(new Error("Loopback probe did not receive a TCP address"));
		});
	});
	return ready.promise;
}

async function canConnect(port: number): Promise<boolean> {
	const connected = Promise.withResolvers<boolean>();
	const socket = net.connect(port, "127.0.0.1");
	const finish = (result: boolean) => {
		socket.destroy();
		connected.resolve(result);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
	return connected.promise;
}

/**
 * Isolated loopback sshd owning its keypair, pinned host key, listener, daemon and tempdir.
 * Every call gets its own tempdir, keys and port, so concurrent consumers stay independent.
 * `stop()` is idempotent: it aborts and reaps the daemon, then removes the tempdir.
 * Consumers stop their own peers/subprocesses before calling `stop()`.
 */
export async function startIsolatedLoopbackSshd(opts: { logLabel?: string } = {}): Promise<LoopbackSshdHandle> {
	const label = opts.logLabel ?? "loopback-sshd";
	const sshdBinary = $which("sshd");
	if (process.platform === "win32" || !sshdBinary) {
		throw new Error("sshd not found on PATH; the isolated loopback fixture requires a local OpenSSH daemon");
	}
	const tmpDir = await fs.promises.mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "omp-ssh-loopback-"));
	const daemonAbort = new AbortController();
	let daemon: Subprocess<"ignore", "ignore", "ignore"> | undefined;
	// Last-resort synchronous finalizer also covers interrupted setup. It touches only this call's daemon/tempdir.
	const finalize = () => {
		daemonAbort.abort();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	};
	process.once("exit", finalize);

	// Drop the exit hook only after cleanup succeeds; a failure keeps the last-resort finalizer armed.
	const stopDaemon = async (): Promise<void> => {
		daemonAbort.abort();
		if (daemon) await daemon.exited;
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
		process.removeListener("exit", finalize);
		console.log(`[${label}] Cleanup: isolated sshd stopped; fixture keys/config/known_hosts and tempdir removed`);
	};

	try {
		const port = await freePort();
		const clientKeyPath = path.join(tmpDir, "id_ed25519");
		const knownHostsPath = path.join(tmpDir, "known_hosts");
		const logPath = path.join(tmpDir, "sshd.log");
		for (const key of ["id_ed25519", "host_ed25519"]) {
			const generated = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path.join(tmpDir, key)]);
			if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
		}
		await Bun.write(path.join(tmpDir, "authorized_keys"), Bun.file(path.join(tmpDir, "id_ed25519.pub")));
		const hostKey = (await Bun.file(path.join(tmpDir, "host_ed25519.pub")).text()).trim().split(/\s+/);
		await Bun.write(knownHostsPath, `[127.0.0.1]:${port} ${hostKey[0]} ${hostKey[1]}\n`);
		const fingerprint = Bun.spawnSync(["ssh-keygen", "-lf", path.join(tmpDir, "host_ed25519.pub")]);
		if (fingerprint.exitCode !== 0) throw new Error(fingerprint.stderr.toString());
		console.log(
			`[${label}] Pinned loopback host key: ${fingerprint.stdout.toString().trim()}; StrictHostKeyChecking=yes`,
		);
		const configPath = path.join(tmpDir, "sshd_config");
		await Bun.write(configPath, [
			`HostKey ${path.join(tmpDir, "host_ed25519")}`,
			`Port ${port}`,
			"ListenAddress 127.0.0.1",
			`PidFile ${path.join(tmpDir, "sshd.pid")}`,
			"LogLevel VERBOSE",
			"StrictModes no",
			"PasswordAuthentication no",
			"KbdInteractiveAuthentication no",
			"PubkeyAuthentication yes",
			`AuthorizedKeysFile ${path.join(tmpDir, "authorized_keys")}`,
			"UsePAM no",
			"PermitTTY no",
			// No Subsystem directive: this daemon exposes no SFTP subsystem.
			"",
		].join("\n"));
		daemon = Bun.spawn([sshdBinary, "-f", configPath, "-D", "-E", logPath], {
			stdin: "ignore", stdout: "ignore", stderr: "ignore", signal: daemonAbort.signal,
		});
		const deadline = Date.now() + LISTEN_TIMEOUT_MS;
		while (!(await canConnect(port))) {
			if (daemon.exitCode !== null || Date.now() >= deadline) {
				throw new Error(`Isolated sshd failed to listen: ${await Bun.file(logPath).text()}`);
			}
			await Bun.sleep(PROBE_INTERVAL_MS);
		}
		const sshdPid = daemon.pid;
		let stopped: Promise<void> | undefined;
		return {
			host: "127.0.0.1",
			port,
			clientKeyPath,
			knownHostsPath,
			tmpDir,
			sshdPid,
			stop() {
				if (stopped) return stopped;
				const pending = stopDaemon().catch(error => {
					stopped = undefined;
					throw error;
				});
				stopped = pending;
				return pending;
			},
		};
	} catch (error) {
		// Failure setup: reap a partially spawned daemon, drop the exit hook, remove the tempdir; keep the cause.
		process.removeListener("exit", finalize);
		daemonAbort.abort();
		if (daemon) await daemon.exited.catch(() => undefined);
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}
