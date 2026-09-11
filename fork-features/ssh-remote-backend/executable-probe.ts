/**
 * Remote executable resolution for the fork-side backend (issue #10 D1).
 *
 * A configured absolute program is trusted as-is and costs no I/O. A bare name
 * is resolved through the remote shell's own PATH (`command -v`), which is the
 * only authority on what a non-interactive SSH session can run — this is what
 * makes "the remote PATH has no `omp`" an explicit classified failure instead
 * of a mysterious post-launch death.
 *
 * Probe stdout is an external boundary: the remote host is free to print
 * anything. A hit therefore requires exit 0 and exactly one trimmed absolute
 * path from the single-program domain; a multi-line, whitespace-bearing,
 * relative or shell-metacharacter-bearing answer is a miss. The probe never
 * quotes, escapes or repairs that output into a runnable word — the recorded
 * path is the launched path or there is no path.
 */

import { buildSshPrefix, isAbsoluteRemotePath, isShellInertRemoteProgram } from "./command";
import type { ResolvedHost } from "./lookup";

/** One SSH invocation: the local prefix plus the exact remote argv. */
export type RunSshCommand = (
	ssh: readonly string[],
	remote: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Result of resolving the remote executable before launch. */
export interface ProbedExecutable {
	/** `absolute`: used as given; `path-probe-hit`: PATH resolved it; `path-probe-miss`: unusable. */
	readonly kind: "absolute" | "path-probe-hit" | "path-probe-miss";
	/** The exact path the backend will launch for the two hit kinds; absent on a miss. */
	readonly path?: string;
}

/**
 * Resolve `executable` on the remote host.
 *
 * The caller decides the policy by shape: an absolute path is authoritative and
 * unprobed, anything else goes through the PATH probe. A bare name is validated
 * before it is spliced into the probe argv, so a fragment can never be re-read
 * by the remote shell as syntax.
 */
export async function probeRemoteExecutable(
	resolved: ResolvedHost,
	executable: string,
	deps: { runSshCommand: RunSshCommand },
): Promise<ProbedExecutable> {
	if (!isShellInertRemoteProgram(executable)) return { kind: "path-probe-miss" };
	if (executable.startsWith("/")) return { kind: "absolute", path: executable };

	const result = await deps.runSshCommand(buildSshPrefix(resolved), ["command", "-v", executable]);
	if (result.exitCode !== 0) return { kind: "path-probe-miss" };
	const probedPath = result.stdout.trim();
	if (!isAbsoluteRemotePath(probedPath) || !isShellInertRemoteProgram(probedPath)) {
		return { kind: "path-probe-miss" };
	}
	return { kind: "path-probe-hit", path: probedPath };
}
