/**
 * Command-construction and executable-resolution contract for the fork SSH
 * backend (issue #10 rows 2 and the D1 "PATH 未找到 Bun" trap).
 *
 * Two observable promises are covered here: the built argv is a strict
 * two-stage pair (local SSH prefix + fixed remote program) that carries no
 * task text, cwd or bootstrap value, and the executable probe either records a
 * real absolute path or reports a plain miss — it never repairs remote output
 * into a runnable word and never leaves stdin closed.
 */

import { describe, expect, it } from "bun:test";
import type { SSHHost } from "../../../packages/coding-agent/src/capability/ssh";
import type { SourceMeta } from "../../../packages/coding-agent/src/capability/types";
import { buildSshBackendCommand, type BuildSshBackendCommandInput } from "../command";
import { probeRemoteExecutable, type RunSshCommand } from "../executable-probe";
import type { ResolvedHost } from "../lookup";

const source: SourceMeta = {
	provider: "ssh-json",
	providerName: "SSH Config",
	path: "/fixture/.omp/ssh.json",
	level: "project",
};
const rawEntry: SSHHost = { name: "fixture", host: "192.0.2.7", username: "agent", port: 2222, _source: source };
const resolved: ResolvedHost = { host: "192.0.2.7", source: "project", rawEntry };
const base: BuildSshBackendCommandInput = { resolved, cwd: "/srv/work", executable: "/opt/bin/omp" };

interface RunCall {
	readonly ssh: readonly string[];
	readonly remote: readonly string[];
}

/** Stub transport: records every SSH invocation and returns one canned answer. */
function createRunStub(response: { exitCode: number; stdout: string; stderr: string }): {
	runSshCommand: RunSshCommand;
	calls: RunCall[];
} {
	const calls: RunCall[] = [];
	return {
		calls,
		runSshCommand: async (ssh, remote) => {
			calls.push({ ssh, remote });
			return response;
		},
	};
}

describe("buildSshBackendCommand", () => {
	it("builds two argv stages with stdin kept open and host keys pinned", () => {
		const spec = buildSshBackendCommand(base);
		expect(spec.ssh[0]).toBe("ssh");
		// The destination ends the local prefix: no `cd … && exec …` string is appended.
		expect(spec.ssh.at(-1)).toBe("agent@192.0.2.7");
		expect(spec.ssh).toContain("2222");
		// `-n` would close the RPC stream's stdin.
		expect(spec.ssh).not.toContain("-n");
		// OpenSSH keeps the first value, so the explicit pin must precede the helper default.
		expect(spec.ssh.indexOf("StrictHostKeyChecking=yes")).toBeLessThan(
			spec.ssh.indexOf("StrictHostKeyChecking=accept-new"),
		);
		expect(spec.remote).toEqual(["/opt/bin/omp", "--mode", "rpc", "--rpc-subagent"]);
		expect(spec.allowStdin).toBe(true);
		expect(spec.executableResolutionPolicy).toBe("absolute");
		expect(buildSshBackendCommand({ ...base, executable: "omp" }).executableResolutionPolicy).toBe("path-probe");
	});

	it("keeps task text, cwd and bootstrap values out of both stages", () => {
		const spec = buildSshBackendCommand({
			resolved,
			cwd: "/srv/issue10-cwd-marker",
			executable: "omp",
			profile: "issue10-profile-marker",
			agent: "issue10-agent-marker",
		});
		// The remote argv is the whole remote program; cwd/profile/agent travel in the prepare frame.
		expect(spec.remote).toEqual(["omp", "--mode", "rpc", "--rpc-subagent"]);
		const argv = [...spec.ssh, ...spec.remote];
		expect(argv.some(word => word.includes("issue10-cwd-marker"))).toBe(false);
		expect(argv.some(word => word.includes("marker"))).toBe(false);
		expect(argv.some(word => /&&|\bcd\b|\bexec\b/.test(word))).toBe(false);
	});

	const rejections: Array<[string, Partial<BuildSshBackendCommandInput>, RegExp]> = [
		["a command separator in the executable", { executable: "omp; rm -rf /" }, /metachar/],
		["whitespace inside the executable path", { executable: "/opt/my omp" }, /metachar/],
		["a tilde-expanding executable", { executable: "~/.local/bin/omp" }, /metachar/],
		["a relative remote cwd", { cwd: "relative/work" }, /absolute/],
		["a NUL-bearing remote cwd", { cwd: "/srv/work\u0000" }, /NUL/],
		["a blank profile", { profile: " " }, /profile/],
		["a NUL-bearing agent", { agent: "peer\u0000" }, /agent/],
	];
	it.each(rejections)("rejects %s before launch", (_label, patch, pattern) => {
		expect(() => buildSshBackendCommand({ ...base, ...patch })).toThrow(pattern);
	});
});

describe("probeRemoteExecutable", () => {
	it("accepts a configured absolute path without touching SSH", async () => {
		const stub = createRunStub({ exitCode: 0, stdout: "", stderr: "" });
		expect(await probeRemoteExecutable(resolved, "/opt/bin/omp", { runSshCommand: stub.runSshCommand })).toEqual({
			kind: "absolute",
			path: "/opt/bin/omp",
		});
		expect(stub.calls).toEqual([]);
	});

	it("records the exact absolute path the PATH probe resolved", async () => {
		const stub = createRunStub({ exitCode: 0, stdout: "/usr/local/bin/omp\n", stderr: "" });
		expect(await probeRemoteExecutable(resolved, "omp", { runSshCommand: stub.runSshCommand })).toEqual({
			kind: "path-probe-hit",
			path: "/usr/local/bin/omp",
		});
		expect(stub.calls.length).toBe(1);
		expect(stub.calls[0].remote).toEqual(["command", "-v", "omp"]);
		expect(stub.calls[0].ssh[0]).toBe("ssh");
		expect(stub.calls[0].ssh.at(-1)).toBe("agent@192.0.2.7");
		expect(stub.calls[0].ssh.indexOf("StrictHostKeyChecking=yes")).toBeLessThan(
			stub.calls[0].ssh.indexOf("StrictHostKeyChecking=accept-new"),
		);
	});

	const unusableAnswers: Array<[string, { exitCode: number; stdout: string }]> = [
		["a nonzero exit", { exitCode: 1, stdout: "" }],
		["empty output", { exitCode: 0, stdout: "\n" }],
		["a relative answer from a shell alias or function", { exitCode: 0, stdout: "omp\n" }],
		["two candidate paths", { exitCode: 0, stdout: "/usr/bin/omp\n/opt/homebrew/bin/omp\n" }],
		["a diagnostic line", { exitCode: 0, stdout: "/usr/bin/omp version 5.0\n" }],
		["shell syntax smuggled through stdout", { exitCode: 0, stdout: "/usr/bin/omp; rm -rf /\n" }],
	];
	it.each(unusableAnswers)("misses on %s instead of repairing remote output", async (_label, answer) => {
		const stub = createRunStub({ ...answer, stderr: "" });
		expect(await probeRemoteExecutable(resolved, "omp", { runSshCommand: stub.runSshCommand })).toEqual({
			kind: "path-probe-miss",
		});
	});

	it("misses a bare name that is not inert shell data without invoking SSH", async () => {
		const stub = createRunStub({ exitCode: 0, stdout: "/usr/bin/omp\n", stderr: "" });
		expect(await probeRemoteExecutable(resolved, "omp; rm -rf /", { runSshCommand: stub.runSshCommand })).toEqual({
			kind: "path-probe-miss",
		});
		expect(stub.calls).toEqual([]);
	});
});
