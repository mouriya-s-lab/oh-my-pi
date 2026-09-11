import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { CapabilityResult, SourceMeta } from "@oh-my-pi/pi-coding-agent/capability";
import * as capabilityModule from "@oh-my-pi/pi-coding-agent/capability";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { validateExecutionTarget } from "@oh-my-pi/pi-coding-agent/task/target";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the flat task schema accepts an optional discriminated `target`.
// Omitting it (or `kind: "local"`) is bit-for-bit the pre-existing local path;
// `kind: "ssh"` is validated against the SSH capability before anything else
// runs — no agent discovery, eval-tool resolution, or job-manager work — and is
// rejected today because the endpoint is not implemented yet (stage-1 skeleton
// for issue #2; the endpoint lands under #7).

const SOURCE: SourceMeta = {
	provider: "test-ssh",
	providerName: "Test SSH",
	path: "/tmp/ssh-config",
	level: "user",
};

const KNOWN_HOST: SSHHost = { name: "known", host: "known", _source: SOURCE };

/** Seed the SSH capability load without touching the filesystem. */
function mockSshHosts(hosts: SSHHost[] = [KNOWN_HOST]): void {
	const result: CapabilityResult<SSHHost> = {
		items: hosts,
		all: hosts,
		warnings: [],
		providers: hosts.length > 0 ? ["test-ssh"] : [],
	};
	vi.spyOn(capabilityModule, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

describe("task target schema (flat form)", () => {
	it("leaves an omitted target absent from the parsed call", () => {
		const parsed = taskSchema({ task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("target" in parsed).toBe(false);
		}
	});

	it("accepts an explicit local target", () => {
		const parsed = taskSchema({ task: "Map the auth module.", target: { kind: "local" } });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.target).toEqual({ kind: "local" });
		}
	});

	it("accepts a well-formed ssh target", () => {
		const parsed = taskSchema({
			task: "Map the auth module.",
			target: { kind: "ssh", host: "known", cwd: "/srv/app" },
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.target).toEqual({ kind: "ssh", host: "known", cwd: "/srv/app" });
		}
	});

	it("drops a stray top-level target from the batch shape", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const parsed = batch({ context: "ctx", tasks: [{ task: "x" }], target: { kind: "local" } });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("target" in parsed).toBe(false);
		}
	});
});

describe("validateExecutionTarget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves omitted and explicit-local targets to the local variant", async () => {
		expect(await validateExecutionTarget(undefined)).toEqual({ target: { kind: "local" } });
		expect(await validateExecutionTarget({ kind: "local" })).toEqual({ target: { kind: "local" } });
	});

	it("accepts a known host with an absolute cwd", async () => {
		mockSshHosts();
		const result = await validateExecutionTarget({ kind: "ssh", host: "known", cwd: "/srv/app" });
		expect(result).toEqual({ target: { kind: "ssh", host: "known", cwd: "/srv/app" } });
	});

	it("rejects an unknown host with `unknown-host`", async () => {
		mockSshHosts();
		const result = await validateExecutionTarget({ kind: "ssh", host: "ghost", cwd: "/srv/app" });
		expect("error" in result && result.error.code).toBe("unknown-host");
	});

	it("rejects a relative cwd with `relative-cwd`", async () => {
		mockSshHosts();
		const result = await validateExecutionTarget({ kind: "ssh", host: "known", cwd: "./relative" });
		expect("error" in result && result.error.code).toBe("relative-cwd");
	});

	it("rejects a shell-metachar executable with `shell-metachar-executable`", async () => {
		mockSshHosts();
		const result = await validateExecutionTarget({
			kind: "ssh",
			host: "known",
			cwd: "/srv/app",
			executable: "omp; rm -rf /",
		});
		expect("error" in result && result.error.code).toBe("shell-metachar-executable");
	});
});

describe("task target runtime gate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	/** Create the tool with discovery mocked, then clear the spy so only the executed call is observed. */
	async function createTool() {
		const discoverySpy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		discoverySpy.mockClear();
		return { tool, discoverySpy };
	}

	async function executeCall(tool: TaskTool, target: unknown): Promise<string> {
		const result = await tool.execute("tool-call", { task: "Map the auth module.", target });
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("rejects a valid ssh target as not yet implemented before any agent discovery", async () => {
		mockSshHosts();
		const { tool, discoverySpy } = await createTool();
		const text = await executeCall(tool, { kind: "ssh", host: "known", cwd: "/srv/app" });
		expect(text).toContain("not yet implemented");
		expect(text).toContain('"known"');
		expect(discoverySpy.mock.calls.length).toBe(0);
	});

	it("rejects every illegal target before any agent discovery", async () => {
		mockSshHosts();
		const { tool, discoverySpy } = await createTool();
		const illegalTargets = [
			{ kind: "ssh", host: "ghost", cwd: "/srv/app" },
			{ kind: "ssh", host: "known", cwd: "./relative" },
			{ kind: "ssh", host: "known", cwd: "/srv/app", executable: "omp; rm -rf /" },
		];
		for (const target of illegalTargets) {
			discoverySpy.mockClear();
			const text = await executeCall(tool, target);
			expect(text).toContain("Task execution failed");
			expect(discoverySpy.mock.calls.length).toBe(0);
		}
	});
});
