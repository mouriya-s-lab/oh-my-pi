/**
 * Execution target for a single task spawn.
 *
 * Introduced by RFC #1 §8 D1 as a stage-1 skeleton (issue #2): the `task`
 * tool accepts an optional discriminated `target` that names *where* the
 * spawn will execute, with only shape and semantic validation wired here.
 * Full `prepare`/`start` gating, batch per-item routing, and the SSH
 * endpoint itself land in later slices (#3, #4, #5, #7).
 *
 * Two invariants this file must protect on its own:
 *
 * 1. **No remote side effects on invalid input.** Callers rely on the
 *    validator to fail *before* any endpoint start, session create, or SSH
 *    spawn, so validation is a pure lookup over the existing SSH capability
 *    plus lexical checks; nothing here opens a connection.
 * 2. **Local behaviour is bit-for-bit preserved.** Omitting `target`, or
 *    passing `{ kind: "local" }`, resolves to the local variant and the
 *    caller stays on the pre-existing code path.
 */

import { loadCapability } from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";

/**
 * Discriminated target for a `task` spawn. `local` is the pre-existing
 * behaviour; `ssh` names a known SSH capability entry plus an absolute
 * remote `cwd`. `executable` is a single remote program path (defaults to
 * whatever `omp` the remote PATH resolves), never a shell fragment.
 * `profile` selects a remote-side profile; the fork holds no per-target
 * credential material.
 */
export type ExecutionTarget =
	| { kind: "local" }
	| {
			kind: "ssh";
			host: string;
			cwd: string;
			executable?: string;
			profile?: string;
	  };

/**
 * Stable identifiers for the illegal cases {@link validateExecutionTarget}
 * rejects. Acceptance criterion 2 on issue #2 requires the three failure
 * modes to remain observably distinct, and these codes are the wire
 * consumers can key off (log lines, downstream error-handling in #7).
 */
export type TargetValidationErrorCode =
	| "invalid-shape"
	| "empty-host"
	| "unknown-host"
	| "empty-cwd"
	| "relative-cwd"
	| "shell-metachar-executable";

export interface TargetValidationError {
	code: TargetValidationErrorCode;
	message: string;
}

export type ValidateExecutionTargetResult =
	| { target: ExecutionTarget }
	| { error: TargetValidationError };

/**
 * Characters that would break a single-program remote argv if permitted in
 * `executable`. Anything a POSIX shell would treat as syntax, quoting, or
 * expansion belongs here; whitespace is included so callers cannot smuggle
 * an argument by hiding it inside the "path". Compare to
 * `RpcClientOptions.command`/`ssh/connection-manager.ts`, which also
 * refuse to concatenate task text into argv.
 */
const SHELL_METACHAR_RE = /[\s;&|<>()`$\\"'*?[\]{}!#~]/;

/**
 * Validate a `target` from the task wire schema. Returns the normalized
 * {@link ExecutionTarget} on success, or a {@link TargetValidationError}
 * whose `code` distinguishes each rejection path. `undefined`/`null`
 * resolve to `{ kind: "local" }` so callers can pass through user input
 * without a branch.
 *
 * The validator is intentionally I/O light: only the SSH capability lookup
 * (already used by the SSH command mode) touches the filesystem. It never
 * establishes a connection, spawns a process, or reads remote state.
 */
export async function validateExecutionTarget(
	target: unknown,
	opts: { cwd?: string } = {},
): Promise<ValidateExecutionTargetResult> {
	if (target === undefined || target === null) {
		return { target: { kind: "local" } };
	}
	if (typeof target !== "object" || Array.isArray(target)) {
		return {
			error: {
				code: "invalid-shape",
				message: "task `target` must be an object with a discriminated `kind`; omit for local execution.",
			},
		};
	}
	const record: Record<string, unknown> = target as Record<string, unknown>;
	// `target` has already been narrowed to a non-array object above; the
	// alias below is a structural view over its own-property values so every
	// subsequent field access is `unknown` and must be narrowed before use.
	const kind = record.kind;
	if (kind === "local") return { target: { kind: "local" } };
	if (kind !== "ssh") {
		return {
			error: {
				code: "invalid-shape",
				message: `task \`target.kind\` must be "local" or "ssh" (got ${JSON.stringify(kind)}).`,
			},
		};
	}

	const hostRaw = record.host;
	if (typeof hostRaw !== "string" || hostRaw.trim() === "") {
		return {
			error: {
				code: "empty-host",
				message: "task `target.host` must be a non-empty SSH capability entry name.",
			},
		};
	}
	const host = hostRaw.trim();

	const cwdRaw = record.cwd;
	if (typeof cwdRaw !== "string" || cwdRaw === "") {
		return {
			error: {
				code: "empty-cwd",
				message: "task `target.cwd` is required for `kind: \"ssh\"` and must be a non-empty absolute path.",
			},
		};
	}
	if (!isAbsoluteRemotePath(cwdRaw)) {
		return {
			error: {
				code: "relative-cwd",
				message: `task \`target.cwd\` must be an absolute remote path; ${JSON.stringify(cwdRaw)} is relative. The local cwd is never forwarded.`,
			},
		};
	}
	const cwd = cwdRaw;

	let executable: string | undefined;
	if ("executable" in record && record.executable !== undefined) {
		const executableRaw = record.executable;
		if (typeof executableRaw !== "string" || executableRaw.trim() === "") {
			return {
				error: {
					code: "shell-metachar-executable",
					message: "task `target.executable` must be a single program path when set; drop the field to use the remote PATH's `omp`.",
				},
			};
		}
		const candidate = executableRaw.trim();
		if (SHELL_METACHAR_RE.test(candidate)) {
			return {
				error: {
					code: "shell-metachar-executable",
					message: `task \`target.executable\` must be a bare program path with no shell metacharacters (got ${JSON.stringify(candidate)}); task text is never joined into argv.`,
				},
			};
		}
		executable = candidate;
	}

	let profile: string | undefined;
	if ("profile" in record && record.profile !== undefined) {
		const profileRaw = record.profile;
		if (typeof profileRaw !== "string" || profileRaw.trim() === "") {
			return {
				error: {
					code: "invalid-shape",
					message: "task `target.profile` must be a non-empty string when set.",
				},
			};
		}
		profile = profileRaw.trim();
	}

	const hosts = await loadKnownSshHosts(opts.cwd);
	if (!hosts.some(entry => entry.name === host)) {
		return {
			error: {
				code: "unknown-host",
				message: `task \`target.host\` ${JSON.stringify(host)} is not a known SSH capability entry; add it to the existing SSH config sources before targeting it.`,
			},
		};
	}

	const normalized: ExecutionTarget = { kind: "ssh", host, cwd };
	if (executable !== undefined) normalized.executable = executable;
	if (profile !== undefined) normalized.profile = profile;
	return { target: normalized };
}

/**
 * Accept POSIX (`/…`) and Windows (`C:\…`, `C:/…`) absolute paths so the
 * validator does not force an OS assumption on the remote. Everything else
 * — bare names, `./…`, `~/…`, empty — is treated as relative and rejected.
 */
function isAbsoluteRemotePath(candidate: string): boolean {
	if (candidate.startsWith("/")) return true;
	return /^[A-Za-z]:[\\/]/.test(candidate);
}

async function loadKnownSshHosts(cwd?: string): Promise<SSHHost[]> {
	const options = cwd ? { cwd } : {};
	const result = await loadCapability<SSHHost>(sshCapability.id, options);
	return result.items;
}
