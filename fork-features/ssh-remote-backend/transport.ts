/**
 * SSH transport for the fork-side managed RPC backend.
 *
 * Owns exactly one Bun child — the local `ssh` process — and hands it to
 * {@link RpcClient} through the public custom-spawn seam. OpenSSH owns connection
 * sharing: every peer runs its own SSH child over the shared ControlMaster, so
 * releasing one peer never runs `ssh -O exit` and never touches the connection
 * manager's master teardown. Stdin stays open for RPC frames, stdout is consumed
 * by the client, and stderr is drained here (so the SSH pipe cannot fill and
 * deadlock) with the tail available to the client's failure messages.
 */

import { NonZeroExitError } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { RpcClient, RpcClientError, type RpcAgentProcess } from "../../packages/coding-agent/src/modes/rpc/rpc-client";
import type { RpcErrorCode, RpcPrepareOptions } from "../../packages/coding-agent/src/modes/rpc/rpc-types";
import { ensureSshControlDir } from "../../packages/coding-agent/src/ssh/connection-manager";
import type { SshBackendCommand } from "./command";
import { SshBackendError } from "./errors";
import type { ProbedExecutable } from "./executable-probe";

/** Grace a signalled SSH child gets before escalation to SIGKILL. */
const DEFAULT_TERMINATION_GRACE_MS = 1000;
/** How long stdin EOF waits for the peer to drain and exit before the child is signalled. */
const DEFAULT_END_INPUT_TIMEOUT_MS = 30_000;
/** Ceiling on every exit wait taken after the child has been signalled. */
const SIGNALLED_EXIT_BOUND_MS = 5000;
/** Retained stderr tail; the process-tree helper keeps the same bound for diagnostics. */
const STDERR_TAIL_CHARS = NonZeroExitError.MAX_TRACE;

/** Managed codes that mean the peer refused the contract, not a failed connection. */
const PROTOCOL_INCOMPATIBLE_CODE: RpcErrorCode = "protocol-incompatible";

/** The one SSH child this transport owns, with both pipes and stdin. */
type SshChildProcess = Subprocess<"pipe", "pipe", "pipe">;

export interface OpenSshBackendTransportOptions {
	/** Resolved remote executable recorded by the factory probe; never re-probed here. */
	probedExecutable?: ProbedExecutable;
	/** Bootstrap context for the managed prepare frame, applied before the peer creates a session. */
	prepare?: RpcPrepareOptions;
	/** Override of the SIGTERM to SIGKILL escalation window. */
	terminationGraceMs?: number;
	/** Override of the stdin-EOF drain window before the child is signalled. */
	endInputTimeoutMs?: number;
}

export interface SshBackendTransport {
	/** Managed client bound to this SSH child; resolves only after the bootstrap negotiation. */
	readonly client: RpcClient;
	/** Actual local SSH exit status. */
	readonly exited: Promise<number>;
	/** The executable the factory resolved on the remote, when it probed one. */
	readonly probedExecutable?: ProbedExecutable;
	/** Release this peer only: closes the SSH child, never the shared master. */
	close(): Promise<void>;
	/** Graceful half-close: end stdin, then resolve with the child's real exit status. */
	endInput(): Promise<number>;
}

class SshBackendTransportImpl implements SshBackendTransport {
	readonly client: RpcClient;
	readonly exited: Promise<number>;
	readonly probedExecutable?: ProbedExecutable;
	#child: SshChildProcess;
	/** Exit status with a rejected exit normalized away, for transport-internal waits. */
	#settledExit: Promise<number | undefined>;
	#stderrDecoder = new TextDecoder();
	#stderrTail = "";
	#terminationGraceMs: number;
	#endInputTimeoutMs: number;
	#signalled = false;
	#killTimer?: NodeJS.Timeout;
	#closeWork?: Promise<void>;
	#endInputWork?: Promise<number>;

	constructor(child: SshChildProcess, options: OpenSshBackendTransportOptions) {
		this.#child = child;
		this.exited = child.exited;
		// The client reaper, `endInput` and callers read the status late, so normalize it
		// once here and settle any rejection into "no status" for transport-internal waits.
		this.#settledExit = this.exited.then(
			code => code,
			() => undefined,
		);
		// Once the child is gone, an armed SIGKILL escalation has no target left.
		void this.#settledExit.then(() => this.#clearKillTimer());
		this.probedExecutable = options.probedExecutable;
		this.#terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
		this.#endInputTimeoutMs = options.endInputTimeoutMs ?? DEFAULT_END_INPUT_TIMEOUT_MS;
		// Draining stderr is what keeps a chatty peer from filling the pipe and stalling
		// the RPC stream; the tail is served to the client through `peekStderr`.
		void this.#drainStderr(child.stderr);
		this.client = new RpcClient({
			// The remote argv is fixed by the command builder, so client agent args are
			// deliberately dropped: no local flag, path or task text reaches the peer.
			spawn: () => this.#agentProcess(),
			expectManagedBootstrap: true,
			prepare: options.prepare,
			terminationGraceMs: this.#terminationGraceMs,
		});
	}

	close(): Promise<void> {
		this.#closeWork ??= this.#close();
		return this.#closeWork;
	}

	endInput(): Promise<number> {
		this.#endInputWork ??= this.#endInput();
		return this.#endInputWork;
	}

	/**
	 * Close stdin so the peer observes EOF (finishing its owned runs and draining
	 * before exit), then resolve with the SSH child's real exit status.
	 */
	async #endInput(): Promise<number> {
		if (this.#child.exitCode !== null) return this.exited;
		this.#child.stdin.end();
		const graceful = await this.#within(this.#settledExit, this.#endInputTimeoutMs);
		if (graceful !== undefined) return graceful;
		// The peer never reacted to EOF; stop owning a live child instead of hanging.
		this.#terminate(this.#terminationGraceMs);
		const signalled = await this.#within(this.#settledExit, SIGNALLED_EXIT_BOUND_MS);
		if (signalled !== undefined) return signalled;
		throw new SshBackendError("connection-failed", "SSH child did not exit after stdin EOF, SIGTERM and SIGKILL");
	}

	async #close(): Promise<void> {
		this.#terminate(this.#terminationGraceMs);
		// Stop client timers and reject pending commands immediately, while only
		// this child is signalled. A bounded wait must not claim successful release.
		const released = await this.#within(
			Promise.all([this.exited, this.client.stop()]),
			SIGNALLED_EXIT_BOUND_MS,
		);
		if (released === undefined) {
			throw new SshBackendError("connection-failed", "SSH child did not exit after SIGTERM and SIGKILL");
		}
	}

	/** Signal this SSH child only; repeated calls keep the first escalation window. */
	#terminate(graceMs: number): void {
		if (this.#signalled || this.#child.exitCode !== null) return;
		this.#signalled = true;
		try {
			this.#child.kill("SIGTERM");
		} catch {
			// The child may already be gone; the exit wait below settles either way.
		}
		this.#killTimer = setTimeout(() => {
			try {
				this.#child.kill("SIGKILL");
			} catch {
				// Same: an exited child needs no further signal.
			}
		}, graceMs);
		// Never hold the event loop open just to escalate a signal.
		this.#killTimer.unref();
	}

	#clearKillTimer(): void {
		if (this.#killTimer === undefined) return;
		clearTimeout(this.#killTimer);
		this.#killTimer = undefined;
	}

	/** Resolve with the work's value, or `undefined` when the bound elapses first. */
	async #within<T>(work: Promise<T>, boundMs: number): Promise<T | undefined> {
		const bound = Promise.withResolvers<undefined>();
		const timer = setTimeout(() => bound.resolve(undefined), boundMs);
		try {
			return await Promise.race([work, bound.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#agentProcess(): RpcAgentProcess {
		return {
			stdin: this.#child.stdin,
			stdout: this.#child.stdout,
			peekStderr: () => this.#stderrTail,
			kill: (_reason, graceMs) => {
				this.#terminate(graceMs ?? this.#terminationGraceMs);
			},
			exited: this.exited,
		};
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				this.#stderrTail += this.#stderrDecoder.decode(chunk.value, { stream: true });
				if (this.#stderrTail.length > STDERR_TAIL_CHARS) this.#stderrTail = this.#stderrTail.slice(-STDERR_TAIL_CHARS);
			}
		} catch {
			// A failed read means no further diagnostics; the exit status still classifies.
		}
		// Flush a trailing partial code point so the tail reads as text.
		this.#stderrTail += this.#stderrDecoder.decode();
	}
}

/**
 * Launch one SSH child and start the managed RPC client over it.
 *
 * Resolves after the peer declared its managed bootstrap and confirmed the
 * prepare context, so a returned transport is ready for `getState`/`abort`.
 * Every failure path reaps the child before throwing.
 */
export async function openSshBackendTransport(
	command: SshBackendCommand,
	options: OpenSshBackendTransportOptions = {},
): Promise<SshBackendTransport> {
	ensureSshControlDir();
	let child: SshChildProcess;
	try {
		child = Bun.spawn([...command.ssh, ...command.remote], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (cause) {
		throw new SshBackendError(
			"connection-failed",
			`Failed to launch SSH: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	}
	const transport = new SshBackendTransportImpl(child, options);
	try {
		await transport.client.start();
	} catch (cause) {
		// Startup failed after the child existed: never leave the SSH peer running.
		await transport.close();
		throw toStartFailure(cause);
	}
	return transport;
}

/** Classify a managed start failure onto the backend taxonomy. */
function toStartFailure(cause: unknown): SshBackendError {
	const message = cause instanceof Error ? cause.message : String(cause);
	// A managed peer refuses the contract with one taxonomy code; every other failure —
	// peer or local — is a connection that never became usable.
	const refused = cause instanceof RpcClientError && cause.code === PROTOCOL_INCOMPATIBLE_CODE;
	return new SshBackendError(refused ? "protocol-incompatible" : "connection-failed", message, { cause });
}
