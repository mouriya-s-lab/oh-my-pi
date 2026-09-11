import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { CapabilityResult, SourceMeta } from "@oh-my-pi/pi-coding-agent/capability";
import * as capabilityModule from "@oh-my-pi/pi-coding-agent/capability";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { REMOTE_EXECUTION_NOT_WIRED } from "@oh-my-pi/pi-coding-agent/task/dispatch";
import { validateExecutionTarget } from "@oh-my-pi/pi-coding-agent/task/target";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the flat task call and every batch item accept an optional
// discriminated `target`. Omitting it (or `kind: "local"`) is bit-for-bit the
// pre-existing local path; `kind: "ssh"` is normalized and authorized per item
// before anything else runs — no agent discovery, eval-tool resolution, or
// job-manager work — and the spawn is rejected today because the endpoint
// dispatch is not wired end-to-end yet (#7 routing gate; #8 owns the dispatch).

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

	it("keeps a per-item target inside the batch shape", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const parsed: unknown = batch({
			context: "ctx",
			tasks: [
				{ task: "x", target: { kind: "local" } },
				{ task: "y", target: { kind: "ssh", host: "known", cwd: "/srv/app" } },
			],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && "tasks" in parsed && Array.isArray(parsed.tasks)) {
			expect(parsed.tasks[0]?.target).toEqual({ kind: "local" });
			expect(parsed.tasks[1]?.target).toEqual({ kind: "ssh", host: "known", cwd: "/srv/app" });
		} else {
			throw new Error("expected a batch parse result with tasks[]");
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

	function createSession(batch = false): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": batch }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	/** Create the tool with discovery mocked, then clear the spy so only the executed call is observed. */
	async function createTool(batch = false) {
		const discoverySpy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession(batch));
		discoverySpy.mockClear();
		return { tool, discoverySpy };
	}

	async function executeText(tool: TaskTool, params: unknown): Promise<string> {
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	async function executeCall(tool: TaskTool, target: unknown): Promise<string> {
		return executeText(tool, { task: "Map the auth module.", target });
	}

	it("rejects a valid ssh target at the not-wired boundary before any agent discovery", async () => {
		mockSshHosts();
		const { tool, discoverySpy } = await createTool();
		const text = await executeCall(tool, { kind: "ssh", host: "known", cwd: "/srv/app" });
		expect(text).toContain(`Task execution failed: ${REMOTE_EXECUTION_NOT_WIRED}`);
		expect(discoverySpy.mock.calls.length).toBe(0);
	});

	it("rejects every illegal target with its code before any agent discovery", async () => {
		mockSshHosts();
		const { tool, discoverySpy } = await createTool();
		const illegalTargets = [
			{ target: { kind: "ssh", host: "ghost", cwd: "/srv/app" }, code: "unknown-host" },
			{ target: { kind: "ssh", host: "known", cwd: "./relative" }, code: "relative-cwd" },
			{
				target: { kind: "ssh", host: "known", cwd: "/srv/app", executable: "omp; rm -rf /" },
				code: "shell-metachar-executable",
			},
		];
		for (const { target, code } of illegalTargets) {
			discoverySpy.mockClear();
			const text = await executeCall(tool, target);
			expect(text).toContain("Task execution failed");
			expect(text).toContain(`(code: ${code})`);
			expect(discoverySpy.mock.calls.length).toBe(0);
		}
	});

	it("gates a remote batch item before any agent discovery", async () => {
		mockSshHosts();
		const { tool, discoverySpy } = await createTool(true);
		const text = await executeText(tool, {
			context: "shared background",
			tasks: [
				{ name: "LocalItem", task: "Map the auth module." },
				{ name: "RemoteItem", task: "Map the remote module.", target: { kind: "ssh", host: "known", cwd: "/srv/app" } },
			],
		});
		expect(text).toContain(`Task execution failed: ${REMOTE_EXECUTION_NOT_WIRED}`);
		expect(discoverySpy.mock.calls.length).toBe(0);
	});

	it("names the offending batch item in the gate error before any agent discovery", async () => {
		mockSshHosts();
		const { tool, discoverySpy } = await createTool(true);
		const text = await executeText(tool, {
			context: "shared background",
			tasks: [
				{ name: "LocalItem", task: "Map the auth module." },
				{ name: "RemoteItem", task: "Map the remote module.", target: { kind: "ssh", host: "ghost", cwd: "/srv/app" } },
			],
		});
		expect(text).toContain("Task RemoteItem failed:");
		expect(text).toContain("(code: unknown-host)");
		expect(discoverySpy.mock.calls.length).toBe(0);
	});
});
