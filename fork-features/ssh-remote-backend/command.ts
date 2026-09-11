/**
 * Local SSH argv and remote argv construction for the fork-side backend.
 *
 * Two stages, joined only at spawn time by the transport: `ssh` is the local
 * OpenSSH prefix (binary, options, destination) and `remote` is the exact
 * remote argv the peer executes. Nothing here builds a shell string — the
 * remote words are joined by the remote login shell, so every word must be
 * inert shell data: a single program path from the target validator's own
 * domain, never a fragment. The task's cwd/profile/agent travel in the managed
 * prepare frame, never in argv, and task text never reaches either stage.
 */

import { buildCommonArgs } from "../../packages/coding-agent/src/ssh/connection-manager";
import { buildSshTarget } from "../../packages/coding-agent/src/ssh/utils";
import type { ResolvedHost } from "./lookup";

/** How the caller resolved `executable` before the command was built. */
export type ExecutableResolutionPolicy = "absolute" | "path-probe";

export interface BuildSshBackendCommandInput {
	readonly resolved: ResolvedHost;
	/** Remote absolute working directory; carried by the prepare frame, never by argv. */
	readonly cwd: string;
	/** Remote program: an absolute path (`absolute`) or a bare PATH name (`path-probe`). */
	readonly executable: string;
	/** Profile the peer activates during bootstrap. */
	readonly profile?: string;
	/** Starting role the peer resolves during bootstrap. */
	readonly agent?: string;
}

export interface SshBackendCommand {
	/** Local `ssh` argv prefix; the transport appends {@link remote} verbatim. */
	readonly ssh: readonly string[];
	/** Remote argv words; the remote shell joins them, so every word is shell-inert. */
	readonly remote: readonly string[];
	/** Stdin is never closed: RPC frames travel over it. */
	readonly allowStdin: true;
	readonly executableResolutionPolicy: ExecutableResolutionPolicy;
}

/**
 * The exact character class the task target validator rejects in a remote
 * program (mirror of `SHELL_METACHAR_RE` in
 * `packages/coding-agent/src/task/target.ts`): whitespace, quotes, expansion,
 * substitution, redirection and list separators. Everything else — including
 * non-ASCII names, `:`, `+`, `=`, `%`, `@` — stays a single program word.
 */
const SHELL_METACHAR_RE = /[\s;&|<>()`$\\"'*?[\]{}!#~]/;

/**
 * Whether a value can be spliced into remote argv as one inert program word.
 * The remote shell joins argv with spaces and re-parses it, so this is the one
 * gate both the command builder and the executable probe rely on.
 */
export function isShellInertRemoteProgram(value: string): boolean {
	return value.length > 0 && !SHELL_METACHAR_RE.test(value);
}

/** POSIX (`/…`) or Windows (`C:\…`, `C:/…`) absolute remote path, as the target validator accepts them. */
export function isAbsoluteRemotePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * The local SSH prefix shared by the command builder and the executable probe.
 * `StrictHostKeyChecking=yes` is prepended because OpenSSH keeps the first
 * value: the helper's `accept-new` default must never win. `allowStdin` keeps
 * `-n` out, so the RPC stream can use the child's stdin.
 */
export function buildSshPrefix(resolved: ResolvedHost): string[] {
	const host = resolved.rawEntry;
	return [
		"ssh",
		"-o",
		"StrictHostKeyChecking=yes",
		...buildCommonArgs(host, { allowStdin: true }),
		buildSshTarget(host.username, host.host),
	];
}

/** Prepare-frame values are session configuration, so a blank or NUL-bearing one is refused. */
function assertPrepareValue(value: string | undefined, label: string): void {
	if (value === undefined) return;
	if (value.trim() === "" || value.includes("\0")) {
		throw new Error(`Remote ${label} must be a non-empty string without NUL when set`);
	}
}

/**
 * Build the two argv stages for one SSH launch. Invalid input is a programming
 * error — the task target validator owns user-facing rejection — so it throws
 * instead of returning a half-built command.
 */
export function buildSshBackendCommand(input: BuildSshBackendCommandInput): SshBackendCommand {
	if (input.cwd.length === 0 || input.cwd.includes("\0") || !isAbsoluteRemotePath(input.cwd)) {
		throw new Error(
			`Remote cwd must be an absolute remote path without NUL (got ${JSON.stringify(input.cwd)}); the local cwd is never forwarded`,
		);
	}
	assertPrepareValue(input.profile, "profile");
	assertPrepareValue(input.agent, "agent");
	if (!isShellInertRemoteProgram(input.executable)) {
		throw new Error(
			`Remote executable must be a bare program path without shell metacharacters (got ${JSON.stringify(input.executable)})`,
		);
	}
	return {
		ssh: buildSshPrefix(input.resolved),
		remote: [input.executable, "--mode", "rpc", "--rpc-subagent"],
		allowStdin: true,
		executableResolutionPolicy: input.executable.startsWith("/") ? "absolute" : "path-probe",
	};
}
