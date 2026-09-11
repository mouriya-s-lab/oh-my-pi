import { describe, expect, it } from "bun:test";
import { buildRemoteCommand, type SshBackendHostRecord } from "../src";

const host: SshBackendHostRecord = {
	name: "fixture", host: "192.0.2.7", username: "agent", port: 2222,
	source: { provider: "fixture", providerName: "Fixture", path: "/fixture/ssh.json", level: "project" },
};

describe("SSH backend two-stage command", () => {
	it("keeps the RPC stdin open and encodes only the fixed remote argv", () => {
		const executable = "/opt/bin/omp";
		const spec = buildRemoteCommand({ host, cwd: "/srv/work", executable });
		expect(spec.ssh[0]).toBe("ssh");
		expect(spec.ssh).toContain("agent@192.0.2.7");
		expect(spec.ssh).not.toContain("-n");
		expect(spec.remote).toEqual([executable, "--mode", "rpc", "--rpc-subagent"]);
		expect(spec.ssh.at(-1)).toBe("cd '/srv/work' && exec '/opt/bin/omp' '--mode' 'rpc' '--rpc-subagent'");
		expect(spec.allowStdin).toBe(true);
	});

	it("rejects shell fragments and relative working directories before launch", () => {
		expect(() => buildRemoteCommand({ host, cwd: "/srv/work", executable: "omp; rm -rf /" })).toThrow(/shell-metachar/);
		expect(() => buildRemoteCommand({ host, cwd: "relative/work" })).toThrow(/absolute/);
		expect(() => buildRemoteCommand({ host, cwd: "/srv/work", extraSshArgs: ["-n"] })).toThrow(/stdin/);
	});

	it("quotes cwd as data and puts strict host-key overrides before helper defaults", () => {
		const spec = buildRemoteCommand({ host, cwd: "/srv/it's a $(command) directory", extraSshArgs: ["-o", "StrictHostKeyChecking=yes", "-o", "ControlPath=none"] });
		expect(spec.ssh.at(-1)).toBe("cd '/srv/it'\\''s a $(command) directory' && exec 'omp' '--mode' 'rpc' '--rpc-subagent'");
		expect(spec.ssh.indexOf("StrictHostKeyChecking=yes")).toBeLessThan(spec.ssh.indexOf("StrictHostKeyChecking=accept-new"));
		expect(spec.ssh.indexOf("ControlPath=none")).toBe(4);
	});
});
