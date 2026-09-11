/**
 * D1 gate acceptance (mouriya-s-lab/oh-my-pi#7): one `target` picks where a
 * spawn runs, and the target-less path stays the pre-target path.
 *
 * 1. No target — task flat, eval `agent()`, and workpool creation still reach
 *    the pre-existing local policy plus executor, and a missing `agent` still
 *    resolves to the session's spawn default.
 * 2. Illegal input — unknown host, relative cwd, and a shell-fragment
 *    executable report distinct codes before any local agent discovery.
 * 3. Prepare — metadata only: the factory runs once, `prepare()` once,
 *    `start()`/`run()` never, and no local preflight is resolved.
 * 4. Same shared code — task flat, batch per-item, eval `agent()`, and
 *    workpool creation reject the same illegal host with the same code before
 *    any local preflight runs; mid-pool operations cannot rebind a target.
 * 5. Hygiene — the dispatch seams carry no `authStorage`/`modelRegistry`
 *    snapshot, enforced by a grep fence that fails on an unexpected grep error.
 *
 * The SSH host list is the existing SSH capability, so every fixture seeds
 * `loadCapability` instead of touching the filesystem. No model is ever
 * called: the executor and discovery seams are spied, and remote peers are the
 * `FakeRemoteEndpoint`/`LocalAgentEndpoint` doubles.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import { $which } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { CapabilityResult, SourceMeta } from "@oh-my-pi/pi-coding-agent/capability";
import * as capabilityModule from "@oh-my-pi/pi-coding-agent/capability";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { JAVASCRIPT_PRELUDE_SOURCE } from "@oh-my-pi/pi-coding-agent/eval/js/shared/prelude";
import { PYTHON_PRELUDE } from "@oh-my-pi/pi-coding-agent/eval/py/prelude";
import { runEvalWorkpool } from "@oh-my-pi/pi-coding-agent/eval/workpool-bridge";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import {
	DispatchAuthorizationError,
	type DispatchContext,
	type EndpointFactory,
	type NormalizeResult,
	normalizeAndAuthorize,
	prepareEndpoint,
	startEndpoint,
} from "@oh-my-pi/pi-coding-agent/task/dispatch";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { RunAck } from "@oh-my-pi/pi-coding-agent/task/endpoint";
import { LocalAgentEndpoint } from "@oh-my-pi/pi-coding-agent/task/endpoint/local";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as structuredSubagentModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ExecutionTarget } from "@oh-my-pi/pi-coding-agent/task/target";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPoolRegistry } from "@oh-my-pi/pi-coding-agent/task/workpool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { FakeRemoteEndpoint } from "./endpoint-fake";

const SOURCE: SourceMeta = {
	provider: "test-ssh",
	providerName: "Test SSH",
	path: "/tmp/ssh-config",
	level: "user",
};

const KNOWN_HOST: SSHHost = { name: "known", host: "known", _source: SOURCE };

const TASK_AGENT: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const SCOUT_AGENT: AgentDefinition = {
	name: "scout",
	description: "Recon agent",
	systemPrompt: "You are a scout.",
	source: "bundled",
};

/** The three illegal shapes that must stay distinguishable (acceptance row 2). */
const ILLEGAL_TARGETS = [
	{ target: { kind: "ssh", host: "ghost", cwd: "/srv/app" }, code: "unknown-host" },
	{ target: { kind: "ssh", host: "known", cwd: "./relative" }, code: "relative-cwd" },
	{
		target: { kind: "ssh", host: "known", cwd: "/srv/app", executable: "omp; rm -rf /" },
		code: "shell-metachar-executable",
	},
] as const;

const ILLEGAL_UNKNOWN_HOST = ILLEGAL_TARGETS[0]!.target;

/** Code suffix every caller of the shared gate appends to the validator message. */
const SHARED_CODE = "(code: unknown-host)";

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

function mockDiscovery(agents: AgentDefinition[] = [TASK_AGENT, SCOUT_AGENT]) {
	return vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

interface SessionOptions {
	spawns?: string | boolean;
	settings?: Record<string, unknown>;
	manager?: AsyncJobManager;
	budget?: () => { total: number | null; spent: number; hard: boolean };
	taskDepth?: number;
}

function createSession(options: SessionOptions = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			...options.settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => "D1Gate",
		...(options.manager ? { asyncJobManager: options.manager } : {}),
		...(options.budget ? { getTurnBudget: options.budget } : {}),
		...(options.taskDepth !== undefined ? { taskDepth: options.taskDepth } : {}),
	} as unknown as ToolSession;
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(entry => entry.type === "text");
	return part?.type === "text" ? (part.text ?? "") : "";
}

/** Authorization verdict of a normalized dispatch, or `undefined` when it routed. */
function dispatchCode(result: NormalizeResult): unknown {
	return result.status === "error" ? result.error.code : undefined;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
	return await promise.then(
		() => {
			throw new Error("expected the call to reject");
		},
		error => error,
	);
}

function authorizationCode(error: unknown): unknown {
	return error instanceof DispatchAuthorizationError ? error.code : undefined;
}

/** The local adapter stores its session as an opaque handle; a stand-in keeps this a pure gate test. */
const SESSION_STAND_IN = {} as unknown as AgentSession;

function localEndpoint(agent = "task"): LocalAgentEndpoint {
	return new LocalAgentEndpoint({
		session: SESSION_STAND_IN,
		agent,
		awaitTerminal: async () => ({ status: "completed" }),
		cancelRun: async () => {},
		terminate: async () => {},
	});
}

/** Fake peer whose `start()` holds the ACK until the test releases it. */
class GatedStartEndpoint extends FakeRemoteEndpoint {
	/** Resolves once `start()` is in flight, so an abort lands inside the ACK window. */
	readonly startEntered: Promise<void>;
	/** The ACK this peer issued, recorded before the caller can cancel it. */
	ack: RunAck | undefined;
	readonly #gate: PromiseWithResolvers<void>;
	readonly #entered = Promise.withResolvers<void>();

	constructor(gate: PromiseWithResolvers<void>) {
		super();
		this.#gate = gate;
		this.startEntered = this.#entered.promise;
	}

	override async start(assignment: string): Promise<RunAck> {
		this.#entered.resolve();
		await this.#gate.promise;
		const ack = await super.start(assignment);
		this.ack = ack;
		return ack;
	}
}

const managers = new Set<AsyncJobManager>();

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.add(manager);
	return manager;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers) await manager.dispose({ timeoutMs: 1_000 });
	managers.clear();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("D1 gate: target-less calls stay local", () => {
	it("runs a target-less task on the local executor with the session default agent", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("flat"));
		const tool = await TaskTool.create(createSession({ spawns: "scout" }));

		const result = await tool.execute("d1-flat", { task: "Map the auth module." } as TaskParams);

		// The local executor's result reaches the tool result unmodified.
		expect(textOf(result)).toContain("All done.");
		expect(textOf(result)).not.toContain("Task execution failed");
		expect(runSubprocess).toHaveBeenCalledTimes(1);
		expect(runSubprocess.mock.calls[0]?.[0]?.agent.name).toBe("scout");
	});

	it("runs a target-less eval agent through the local policy and executor", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("eval"));
		const manager = createManager();
		const session = createSession({ spawns: "scout", manager });

		const handle = await runEvalAgent({ prompt: "Map the eval bridge." }, { session });
		const job = manager.getJob(handle.id);
		if (!job) throw new Error(`eval agent handle ${handle.id} registered no job`);
		await job.promise;

		expect(handle.agent).toBe("scout");
		expect(runSubprocess).toHaveBeenCalledTimes(1);
		expect(runSubprocess.mock.calls[0]?.[0]?.agent.name).toBe("scout");
	});

	it("creates a target-less workpool on the legacy local policy path", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("pool"));
		const manager = createManager();
		const session = createSession({ spawns: "scout", manager });

		const created = await runEvalWorkpool({ op: "create" }, { session });

		expect(created).toEqual({ name: "scout-pool", agent: "scout", limit: 2 });
		expect(runSubprocess).not.toHaveBeenCalled();
	});
});

describe("D1 gate: illegal ssh targets", () => {
	it("reports each illegal shape before any local discovery", async () => {
		mockSshHosts();
		const discovery = mockDiscovery();
		const preflight = vi.spyOn(structuredSubagentModule, "resolveEffectiveSubagentPolicy");
		const session = createSession();

		for (const { target, code } of ILLEGAL_TARGETS) {
			const result = await normalizeAndAuthorize(target, { session, entryPoint: "task-flat" });
			expect(dispatchCode(result)).toBe(code);
		}

		expect(discovery).not.toHaveBeenCalled();
		expect(preflight).not.toHaveBeenCalled();
	});

	it("applies role, depth, and hard-budget authorization only to an explicit target", async () => {
		mockSshHosts();
		const sshTarget: ExecutionTarget = { kind: "ssh", host: "known", cwd: "/srv/app" };

		const restricted = createSession({ spawns: "scout" });
		expect(
			dispatchCode(
				await normalizeAndAuthorize(sshTarget, { session: restricted, entryPoint: "task-flat", agent: "task" }),
			),
		).toBe("role-not-permitted");

		const depthCapped = createSession({ taskDepth: 2 });
		expect(
			dispatchCode(await normalizeAndAuthorize(sshTarget, { session: depthCapped, entryPoint: "task-flat" })),
		).toBe("spawn-cap-exceeded");

		const drained = createSession({ budget: () => ({ total: 100, spent: 100, hard: true }) });
		expect(dispatchCode(await normalizeAndAuthorize(sshTarget, { session: drained, entryPoint: "task-flat" }))).toBe(
			"budget-exceeded",
		);

		// A closed spawn policy plus a drained budget still route when no target is
		// given: the pre-target path performs its own preflight checks.
		const closed = createSession({ spawns: false, budget: () => ({ total: 10, spent: 10, hard: true }) });
		expect(await normalizeAndAuthorize(undefined, { session: closed, entryPoint: "task-flat" })).toEqual({
			status: "local",
			target: { kind: "local" },
			agent: "task",
		});
		expect(
			dispatchCode(await normalizeAndAuthorize({ kind: "local" }, { session: closed, entryPoint: "task-flat" })),
		).toBe("role-not-permitted");
	});
});

describe("D1 gate: prepare and start seam", () => {
	it("prepares a remote endpoint once without starting, running, or resolving local preflight", async () => {
		mockSshHosts();
		const discovery = mockDiscovery();
		const preflight = vi.spyOn(structuredSubagentModule, "resolveEffectiveSubagentPolicy");
		const endpoint = new FakeRemoteEndpoint();
		const prepare = vi.spyOn(endpoint, "prepare");
		const start = vi.spyOn(endpoint, "start");
		const run = vi.spyOn(endpoint, "run");
		const factoryCalls: ExecutionTarget[] = [];
		const factory: EndpointFactory = async target => {
			factoryCalls.push(target);
			return endpoint;
		};
		const target: ExecutionTarget = { kind: "ssh", host: "known", cwd: "/srv/app" };

		const prepared = await prepareEndpoint(target, factory);

		expect(factoryCalls).toEqual([target]);
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(start).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(prepared).toEqual({
			role: { agent: "fake-remote", source: "remote" },
			capabilities: ["fake_remote/v0"],
		});
		expect(discovery).not.toHaveBeenCalled();
		expect(preflight).not.toHaveBeenCalled();
	});

	it("wraps an existing local session through the local adapter factory", async () => {
		const prepared = await prepareEndpoint({ kind: "local" }, async () => localEndpoint("scout"));

		expect(prepared).toEqual({ role: { agent: "scout", source: "local" }, capabilities: ["agent_session/v0"] });
	});

	it("rejects an endpoint whose transport disagrees with the target", async () => {
		const pending = prepareEndpoint({ kind: "local" }, async () => new FakeRemoteEndpoint());

		expect(authorizationCode(await rejected(pending))).toBe("target-invalid");
	});

	it("refuses to start a prepared remote role the session policy does not allow", async () => {
		mockSshHosts();
		const session = createSession({ spawns: "scout" });
		const endpoint = new FakeRemoteEndpoint();
		await prepareEndpoint({ kind: "ssh", host: "known", cwd: "/srv/app" }, async () => endpoint);
		const start = vi.spyOn(endpoint, "start");
		const ctx: DispatchContext = { session, entryPoint: "task-flat" };

		const pending = startEndpoint(endpoint, "Do remote work.", undefined, ctx);

		expect(authorizationCode(await rejected(pending))).toBe("role-not-permitted");
		expect(start).not.toHaveBeenCalled();
	});

	it("re-answers the hard budget for a prepared endpoint that drains before start", async () => {
		let budget = { total: 100, spent: 10, hard: true };
		const session = createSession({ budget: () => budget });
		const endpoint = localEndpoint();
		await prepareEndpoint({ kind: "local" }, async () => endpoint);
		const start = vi.spyOn(endpoint, "start");
		budget = { total: 100, spent: 100, hard: true };
		const ctx: DispatchContext = { session, entryPoint: "task-flat" };

		const pending = startEndpoint(endpoint, "Do local work.", undefined, ctx);

		expect(authorizationCode(await rejected(pending))).toBe("budget-exceeded");
		expect(start).not.toHaveBeenCalled();
	});

	it("never starts an endpoint when the signal already aborted", async () => {
		const session = createSession();
		const endpoint = localEndpoint();
		await prepareEndpoint({ kind: "local" }, async () => endpoint);
		const start = vi.spyOn(endpoint, "start");
		const controller = new AbortController();
		controller.abort(new Error("turn cancelled"));
		const ctx: DispatchContext = { session, entryPoint: "task-flat" };

		const pending = startEndpoint(endpoint, "Do local work.", controller.signal, ctx);

		await expect(pending).rejects.toThrow("turn cancelled");
		expect(start).not.toHaveBeenCalled();
	});

	it("cancels an accepted run whose signal aborts before the ACK returns", async () => {
		mockSshHosts();
		const session = createSession();
		const gate = Promise.withResolvers<void>();
		const endpoint = new GatedStartEndpoint(gate);
		await prepareEndpoint({ kind: "ssh", host: "known", cwd: "/srv/app" }, async () => endpoint);
		const cancel = vi.spyOn(endpoint, "cancelRun");
		const controller = new AbortController();
		const ctx: DispatchContext = { session, entryPoint: "task-flat" };

		const pending = startEndpoint(endpoint, "Do remote work.", controller.signal, ctx);
		await endpoint.startEntered;
		controller.abort(new Error("turn cancelled"));
		gate.resolve();

		await expect(pending).rejects.toThrow("turn cancelled");
		expect(cancel).toHaveBeenCalledTimes(1);
		const ack = endpoint.ack;
		if (!ack) throw new Error("the peer issued no ACK before the cancel");
		expect(cancel.mock.calls[0]?.[0]).toBe(ack.runId);
		expect(endpoint.asJobSnapshot().status).toBe("cancelled");
	});

	it("keeps the endpoint target fixed while preparation yields", async () => {
		mockSshHosts();
		const session = createSession();
		const endpoint = new FakeRemoteEndpoint();
		const target: ExecutionTarget = { kind: "ssh", host: "known", cwd: "/srv/app" };
		const pending = prepareEndpoint(target, async () => endpoint);
		target.host = "ghost";
		await pending;

		const ack = await startEndpoint(endpoint, "Use the prepared endpoint.", undefined, {
			session,
			entryPoint: "task-flat",
		});

		expect(endpoint.asJobSnapshot()).toMatchObject({ runId: ack.runId, status: "running" });
	});

	it("admits only one concurrent start for a preparation", async () => {
		mockSshHosts();
		const endpoint = new FakeRemoteEndpoint();
		await prepareEndpoint({ kind: "ssh", host: "known", cwd: "/srv/app" }, async () => endpoint);
		const start = vi.spyOn(endpoint, "start");
		const ctx: DispatchContext = { session: createSession(), entryPoint: "task-flat" };

		const results = await Promise.allSettled([
			startEndpoint(endpoint, "First assignment.", undefined, ctx),
			startEndpoint(endpoint, "Second assignment.", undefined, ctx),
		]);

		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		expect(start).toHaveBeenCalledTimes(1);
	});
});

describe("D1 gate: every caller reports the same code", () => {
	it("rejects one illegal host from task flat and batch per-item before any local preflight", async () => {
		mockSshHosts();
		const discovery = mockDiscovery();
		const preflight = vi.spyOn(structuredSubagentModule, "resolveEffectiveSubagentPolicy");
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("unexpected"));

		const flatTool = await TaskTool.create(createSession());
		discovery.mockClear();
		const flatText = textOf(
			await flatTool.execute("d1-illegal-flat", {
				task: "Map the auth module.",
				target: ILLEGAL_UNKNOWN_HOST,
			} as TaskParams),
		);
		expect(flatText).toContain("Task execution failed");
		expect(flatText).toContain(SHARED_CODE);

		const batchTool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		discovery.mockClear();
		const batchText = textOf(
			await batchTool.execute("d1-illegal-batch", {
				context: "Shared context.",
				tasks: [{ name: "Remote", task: "Map the auth module.", target: ILLEGAL_UNKNOWN_HOST }],
			} as unknown as TaskParams),
		);
		expect(batchText).toContain("Task Remote failed");
		expect(batchText).toContain(SHARED_CODE);

		expect(discovery).not.toHaveBeenCalled();
		expect(preflight).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
	});

	it("rejects one illegal host from eval agent and workpool creation before any local preflight", async () => {
		mockSshHosts();
		const discovery = mockDiscovery();
		const preflight = vi.spyOn(structuredSubagentModule, "resolveEffectiveSubagentPolicy");
		const session = createSession();

		await expect(
			runEvalAgent({ prompt: "Map the auth module.", target: ILLEGAL_UNKNOWN_HOST }, { session }),
		).rejects.toThrow(SHARED_CODE);
		await expect(
			runEvalWorkpool({ op: "create", agent: "scout", target: ILLEGAL_UNKNOWN_HOST }, { session }),
		).rejects.toThrow(SHARED_CODE);

		expect(discovery).not.toHaveBeenCalled();
		expect(preflight).not.toHaveBeenCalled();
	});

	it("rejects a target on a mid-pool operation and leaves the pool usable", async () => {
		mockDiscovery();
		const session = createSession({ manager: createManager() });
		const created = await runEvalWorkpool({ op: "create", agent: "scout", name: "gate-pool" }, { session });

		await expect(
			runEvalWorkpool({ op: "status", name: "gate-pool", target: { kind: "local" } }, { session }),
		).rejects.toThrow("workpool binds target at creation");

		await expect(runEvalWorkpool({ op: "status", name: "gate-pool" }, { session })).resolves.toMatchObject({
			name: "gate-pool",
			agent: "scout",
			closed: false,
		});
		expect(created).toEqual({ name: "gate-pool", agent: "scout", limit: 2 });
	});
});

type BridgeCall = (name: string, args: unknown) => Promise<unknown>;

interface PreludeSandbox {
	agent: (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
	workpool: (options?: Record<string, unknown>) => Promise<unknown>;
}

/** Run the shipped helper source verbatim against a host bridge stub. */
function loadPrelude(callTool: BridgeCall): PreludeSandbox {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox as unknown as PreludeSandbox;
}

const PYTHON_PATH = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

async function runPythonPrelude(
	code: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
	);
	const proc = Bun.spawn([PYTHON_PATH, "-c", `${prelude}\n${code}`], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	// Python's text-mode stdout emits \r\n on Windows.
	return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
}

const PYTHON_GATE_PROBES = [
	"try:",
	'    agent("Probe the gate.", target={"kind": "ssh", "host": "ghost", "cwd": "/srv/app"})',
	"except RuntimeError as exc:",
	'    print("agent:" + str(exc))',
	"else:",
	'    print("agent:no-error")',
	"try:",
	'    workpool(target={"kind": "ssh", "host": "ghost", "cwd": "/srv/app"})',
	"except RuntimeError as exc:",
	'    print("workpool:" + str(exc))',
	"else:",
	'    print("workpool:no-error")',
].join("\n");

describe("D1 gate: eval preludes forward the target", () => {
	it("carries an illegal target from the JS helpers into the shared gate", async () => {
		mockSshHosts();
		// Mocked so a helper that dropped the target would fail on the gate
		// assertion instead of falling through to a real local spawn.
		mockDiscovery();
		const session = createSession();
		const calls: string[] = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push(name);
			// The real bridge crosses a JSON wire; mirror that so the vm realm's
			// object prototypes never reach the validator.
			const wireArgs: unknown = JSON.parse(JSON.stringify(args));
			if (name === "__agent__") return await runEvalAgent(wireArgs, { session });
			if (name === "__workpool__") return await runEvalWorkpool(wireArgs, { session });
			throw new Error(`unexpected bridge call ${name}`);
		});
		const illegal = { kind: "ssh", host: "ghost", cwd: "/srv/app" };

		await expect(sandbox.agent("Probe the gate.", { target: illegal })).rejects.toThrow(SHARED_CODE);
		await expect(sandbox.workpool({ target: illegal })).rejects.toThrow(SHARED_CODE);
		expect(calls).toEqual(["__agent__", "__workpool__"]);
	});

	it("carries an illegal target from the Python keyword path into the shared gate", async () => {
		mockSshHosts();
		// Mocked so a helper that dropped the target would fail on the gate
		// assertion instead of falling through to a real local spawn.
		mockDiscovery();
		const session = createSession();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method !== "POST" || url.pathname !== "/v1/tool") {
					return new Response("Not Found", { status: 404 });
				}
				const body = (await request.json()) as { name?: unknown; args?: unknown };
				const name = typeof body.name === "string" ? body.name : "";
				try {
					const value =
						name === "__agent__"
							? await runEvalAgent(body.args, { session })
							: name === "__workpool__"
								? await runEvalWorkpool(body.args, { session })
								: undefined;
					if (value === undefined) return Response.json({ ok: false, error: `unexpected bridge call ${name}` });
					return Response.json({ ok: true, value });
				} catch (error) {
					return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			},
		});

		try {
			const result = await runPythonPrelude(PYTHON_GATE_PROBES, {
				PI_TOOL_BRIDGE_URL: server.url.toString(),
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			});

			expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("agent:");
			expect(lines[0]).toContain(SHARED_CODE);
			expect(lines[1]).toContain("workpool:");
			expect(lines[1]).toContain(SHARED_CODE);
		} finally {
			await server.stop(true);
		}
	});
});

describe("D1 gate: cross-transport payload hygiene", () => {
	const CODING_AGENT_ROOT = path.resolve(import.meta.dir, "../..");
	const FENCE_FILES = [
		"src/task/dispatch.ts",
		"src/task/index.ts",
		"src/eval/agent-bridge.ts",
		"src/eval/workpool-bridge.ts",
	];

	it("ships no local auth or model-registry snapshot through the dispatch seams", async () => {
		const proc = Bun.spawn(
			[
				"grep",
				"-rn",
				"-e",
				"authStorage",
				"-e",
				"modelRegistry",
				...FENCE_FILES.map(file => path.join(CODING_AGENT_ROOT, file)),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		// grep exits 1 when nothing matches and 0 when it does; any other exit
		// (missing file, bad option) means the fence never examined the seams and
		// must fail instead of passing by accident.
		if (exitCode !== 0 && exitCode !== 1) {
			throw new Error(`grep fence did not run (exit ${exitCode}): ${stderr.trim()}`);
		}
		const hits = stdout.split("\n").filter(line => line.length > 0);
		expect(hits.filter(line => !line.includes("// local-only:"))).toEqual([]);
	});
});
