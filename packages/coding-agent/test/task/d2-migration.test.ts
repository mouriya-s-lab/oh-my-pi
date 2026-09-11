/**
 * D2 migration acceptance (mouriya-s-lab/oh-my-pi#8): a *remote* run's real
 * verdict has to survive the registry, the async monitor, the hub snapshot and
 * the eval handle — `execution-unknown` when the transport dies, and "terminal
 * but replies outstanding" while a run's reply barrier is un-drained — without
 * fabricating a local `AgentSession` anywhere.
 *
 * Acceptance rows:
 * 1. local endpoint — the tagged reference keeps helper identity and the
 *    registry's list/event behaviour unchanged across status transitions.
 * 2. unknown fanout — losing the transport mid-run reaches job, AgentRef
 *    (handle), hub job row, hub roster row and eval handle alike, with no
 *    `exitCode: 0` fabrication.
 * 3. terminal ≠ deliverable — a completed run holds the owner drain until its
 *    replies drain; abort is per-waiter and never settles the run itself.
 * 4. resume — a run the peer still owns (in flight, or terminal without its
 *    replies drained) refuses park and resume as `still-owned`; after the peer
 *    reports the drain, the same opaque reference and run id reopen, and the
 *    peer's session table still holds exactly one session.
 * 5. hygiene — the whole remote driver never calls `createAgentSession`, and
 *    `snapshot()`/`subscribe()` answers come from the endpoint's own stream;
 *    `runSubprocess`'s `endpointExecution` monitor reports a transport loss the
 *    same way, with no fabricated local session and no fabricated exit code.
 *
 * The peer is the single `FakeRemoteEndpoint` (test/task/endpoint-fake.ts);
 * the registry, the job manager, the hub tool, the roster and the eval handle
 * bridge are the real production surfaces. The extra describes pin the
 * monitor's `endpointExecution` driver and the endpoint's subscription
 * teardown, both of which the rows above depend on.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { CapabilityResult, SourceMeta } from "@oh-my-pi/pi-coding-agent/capability";
import * as capabilityModule from "@oh-my-pi/pi-coding-agent/capability";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { runEvalStatus } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	AgentRegistry,
	getLocalSession,
	getLocalSessionFile,
	type RegistryEvent,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type DispatchContext, prepareEndpoint } from "@oh-my-pi/pi-coding-agent/task/dispatch";
import type { EndpointEvent, RunAck } from "@oh-my-pi/pi-coding-agent/task/endpoint";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { executeList } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import type { JobSnapshot } from "@oh-my-pi/pi-coding-agent/tools/hub/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { activityRowsFromProgress } from "../../src/activity";
import { FakeRemoteEndpoint } from "./endpoint-fake";

const OWNER_ID = "D2Owner";
const LOCAL_ID = "D2LocalScout";
const LOCAL_SESSION_FILE = "/tmp/omp-d2-migration/local.jsonl";
const REMOTE_ASSIGNMENT = "Inspect the remote migration surface.";

/**
 * The local endpoint stores its session as an opaque handle and never calls
 * into it, so a stand-in keeps this a migration test rather than a session
 * test — the same convention as `endpoint-contract.test.ts`/`d1-gate.test.ts`.
 */
const SESSION_STAND_IN = {} as unknown as AgentSession;

const managers = new Set<AsyncJobManager>();

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.add(manager);
	return manager;
}

/** Structurally-partial session: only the fields the driven surfaces read. */
function createToolSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		settings: { get: () => undefined },
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => OWNER_ID,
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(entry => entry.type === "text");
	return part?.type === "text" ? (part.text ?? "") : "";
}

/**
 * Drain the microtask queue without touching the wall clock, so a waiter that
 * wrongly resolves immediately is observed as settled and one that correctly
 * holds is observed as pending.
 */
async function flushMicrotasks(turns = 32): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

/** Production `hub` snapshot: the rows a UI renders for jobs. */
async function hubJobs(session: ToolSession): Promise<{ jobs: JobSnapshot[]; text: string }> {
	const result = await new HubTool(session).execute("d2-hub-jobs", { op: "jobs" });
	const details = result.details;
	if (!details || !("jobs" in details) || !details.jobs) throw new Error("hub jobs returned no job list");
	return { jobs: details.jobs, text: textOf(result) };
}

function jobRow(jobs: JobSnapshot[], jobId: string): JobSnapshot {
	const row = jobs.find(job => job.id === jobId);
	if (!row) throw new Error(`hub jobs omitted ${jobId}`);
	return row;
}

interface RemoteDriver {
	endpoint: FakeRemoteEndpoint;
	ack: RunAck;
	job: AsyncJob;
	agentId: string;
}

/** Start a run on the fake peer and hand it to the real monitor + registry. */
async function startRemoteRun(
	manager: AsyncJobManager,
	options: { agentId: string; jobId: string },
): Promise<RemoteDriver> {
	const endpoint = new FakeRemoteEndpoint();
	const ack = await endpoint.start(REMOTE_ASSIGNMENT);
	AgentRegistry.global().register({
		id: options.agentId,
		displayName: options.agentId,
		kind: "sub",
		// D2: the remote variant carries an opaque reference plus its endpoint.
		endpoint: { kind: "remote", reference: endpoint.handle.reference, endpoint },
	});
	const job = manager.registerEndpoint(endpoint, ack.runId, {
		id: options.jobId,
		agentId: options.agentId,
		ownerId: OWNER_ID,
	});
	return { endpoint, ack, job, agentId: options.agentId };
}

/**
 * One-way RPC frame source: a started `RpcClient` reads these frames exactly
 * as it reads a real child's stdout. The process never exits, so the client's
 * reader stays live until the test's `using` disposes it.
 */
function createRpcFrameSource(): { child: RpcAgentProcess; push: (frame: unknown) => void } {
	const encoder = new TextEncoder();
	const ready = { type: "ready", protocolVersion: 1 };
	let push: (frame: unknown) => void = () => {};
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			push = frame => controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
			push(ready);
		},
	});
	const child: RpcAgentProcess = {
		stdin: { write: () => {} },
		stdout,
		peekStderr: () => "",
		kill: () => {},
		exited: Promise.withResolvers<number>().promise,
	};
	return { child, push: frame => push(frame) };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers) await manager.dispose({ timeoutMs: 1_000 });
	managers.clear();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("D2 row 1: local endpoint keeps the registry contract", () => {
	it("exposes helper identity and unchanged list/event behaviour", () => {
		const registry = AgentRegistry.global();
		const events: RegistryEvent[] = [];
		const unsubscribe = registry.onChange(event => events.push(event));
		const ref = registry.register({
			id: LOCAL_ID,
			displayName: "Local Scout",
			kind: "sub",
			status: "idle",
			endpoint: { kind: "local", session: SESSION_STAND_IN, sessionFile: LOCAL_SESSION_FILE },
		});

		// The tagged union is read through the helpers, and no flat field survives
		// to let a caller treat a remote ref as a session-bearing one.
		expect(getLocalSession(ref)).toBe(SESSION_STAND_IN);
		expect(getLocalSessionFile(ref)).toBe(LOCAL_SESSION_FILE);
		expect("session" in ref).toBe(false);
		expect("sessionFile" in ref).toBe(false);
		expect(registry.list()).toContain(ref);
		expect(registry.listVisibleTo(OWNER_ID).map(candidate => candidate.id)).toContain(LOCAL_ID);

		// Registration and transition events keep their shape and ref identity.
		expect(events.map(event => event.type)).toEqual(["registered"]);
		expect(events[0]!.ref).toBe(ref);
		expect(registry.setStatus(LOCAL_ID, "running")).toBe(true);
		expect(events.map(event => event.type)).toEqual(["registered", "status_changed"]);
		expect(events[1]!.ref).toBe(ref);
		expect(ref.status).toBe("running");
		// Liveness still comes from the attached session — the stand-in makes no
		// claim, so a `running` status with no live turn must not read as running.
		expect(registry.isRunning(ref)).toBe(false);

		// A session-as-CAS caller is still matched by identity.
		expect(registry.setStatus(LOCAL_ID, "idle", SESSION_STAND_IN)).toBe(true);
		expect(getLocalSession(registry.get(LOCAL_ID))).toBe(SESSION_STAND_IN);
		expect(registry.setStatus(LOCAL_ID, "aborted", {} as unknown as AgentSession)).toBe(false);
		expect(ref.status).toBe("idle");
		unsubscribe();
	});
});

describe("D2 row 2: a lost transport fans out as execution-unknown", () => {
	it("reports the transport verdict on job, handle, hub rows and eval handle", async () => {
		const manager = createManager();
		const session = createToolSession(manager);
		const { endpoint, ack, job, agentId } = await startRemoteRun(manager, {
			agentId: "D2RemoteScout",
			jobId: "d2-remote-scout",
		});

		endpoint.abortTransport();
		await job.promise;

		// Job: settled unknown, remote, and with no fabricated process exit code.
		expect(job.status).toBe("execution-unknown");
		expect(job.endpointKind).toBe("remote");
		expect(job.runId).toBe(ack.runId);
		expect(job.exitCode).toBeNull();
		expect(job.errorText).toContain("transport");
		expect(job.resultText).toBeUndefined();

		// Handle: the ref carries the same verdict, stays addressable in rosters,
		// and never claims a live turn it cannot observe.
		const registry = AgentRegistry.global();
		const ref = registry.get(agentId);
		if (!ref) throw new Error("remote ref disappeared from the registry");
		expect(ref.status).toBe("execution-unknown");
		expect(ref.endpoint.kind).toBe("remote");
		expect(registry.isRunning(ref)).toBe(false);
		expect(registry.listVisibleTo(OWNER_ID).map(candidate => candidate.id)).toContain(agentId);

		// UI: the hub job row and the roster row both read that same verdict.
		const snapshot = await hubJobs(session);
		expect(jobRow(snapshot.jobs, job.id)).toMatchObject({
			id: job.id,
			status: "execution-unknown",
			endpointKind: "remote",
			exitCode: null,
		});
		expect(snapshot.text).toContain("execution-unknown");
		expect(snapshot.text).not.toContain("[task] — completed");

		const roster = await executeList(registry, OWNER_ID, { limit: 10 }, null);
		const rosterDetails = roster.details;
		if (!rosterDetails) throw new Error("hub roster returned no details");
		expect(rosterDetails.counts?.["execution-unknown"]).toBe(1);
		const peer = rosterDetails.peers?.find(candidate => candidate.id === agentId);
		if (!peer) throw new Error("hub roster omitted the unknown remote peer");
		expect(peer.status).toBe("execution-unknown");
		expect(peer.endpointKind).toBe("remote");

		// Eval handle: the verdict survives the eval bridge instead of degrading
		// to a completed snapshot.
		const handle = runEvalStatus({ item: { kind: "agent", id: job.id } }, { session });
		expect(handle.status).toBe("execution-unknown");
		expect(handle.error).toContain("transport");
	});
});

describe("D2 row 3: a terminal run is not deliverable until replies drain", () => {
	it("holds the owner drain open until the reply barrier is drained", async () => {
		const manager = createManager();
		const { endpoint, ack, job } = await startRemoteRun(manager, {
			agentId: "D2RemoteDrain",
			jobId: "d2-remote-drain",
		});

		const drain = manager.waitForOwnerJobsAndReplies(OWNER_ID);
		let drained = false;
		void drain.then(() => {
			drained = true;
		});

		endpoint.completeRun({ status: "completed", runId: ack.runId, text: "peer finished the assignment" });
		await job.promise;
		expect(job.status).toBe("completed");
		expect(job.exitCode).toBe(0);

		// The run is terminal, but its reply obligation is outstanding: the
		// "stopped without replying" verdict must stay unavailable.
		await flushMicrotasks();
		expect(drained).toBe(false);
		expect(endpoint.asJobSnapshot().status).toBe("completed");

		endpoint.emitReplyDrained(ack.runId);
		expect(await drain).toEqual({ status: "drained" });
	});

	it("releases only the aborted waiter and leaves the run's own barrier intact", async () => {
		const manager = createManager();
		const { endpoint, ack, job } = await startRemoteRun(manager, {
			agentId: "D2RemoteAbort",
			jobId: "d2-remote-abort",
		});
		endpoint.completeRun({ status: "completed", runId: ack.runId, text: "peer finished the assignment" });
		await job.promise;

		const controller = new AbortController();
		const aborted = manager.waitForOwnerJobsAndReplies(OWNER_ID, controller.signal);
		let settled = false;
		void aborted.then(() => {
			settled = true;
		});
		await flushMicrotasks();
		expect(settled).toBe(false);

		controller.abort();
		expect(await aborted).toEqual({ status: "aborted" });

		// Aborting one waiter neither drains nor cancels the run: the barrier is
		// still pending until the peer itself reports the replies drained.
		endpoint.emitReplyDrained(ack.runId);
		expect(await manager.waitForOwnerJobsAndReplies(OWNER_ID)).toEqual({ status: "drained" });
	});

	it("does not hold a local job behind a remote reply barrier", async () => {
		const manager = createManager();
		manager.register("task", "local work", async () => "done", { ownerId: OWNER_ID });

		expect(await manager.waitForOwnerJobsAndReplies(OWNER_ID)).toEqual({ status: "drained" });
	});
});

describe("D2 monitor: cancellation delegates, a rejected run reports unknown", () => {
	it("delegates a cancel to the endpoint instead of settling the job locally", async () => {
		const manager = createManager();
		const { endpoint, ack, job } = await startRemoteRun(manager, {
			agentId: "D2RemoteCancel",
			jobId: "d2-remote-cancel",
		});

		expect(manager.cancel(job.id, { ownerId: OWNER_ID })).toBe(true);
		// The job is still running the moment the request returns: only the
		// endpoint's own verdict may settle it, so a local pre-settlement would
		// show here as a fabricated cancellation.
		expect(job.status).toBe("running");
		await job.promise;

		// The endpoint — not the monitor — produced the verdict, and its run
		// state agrees with the job row.
		expect(endpoint.asJobSnapshot()).toMatchObject({ runId: ack.runId, status: "cancelled" });
		expect(job.status).toBe("cancelled");
		expect(job.exitCode).toBeNull();
		expect(AgentRegistry.global().get("D2RemoteCancel")?.status).toBe("aborted");
	});

	it("maps a rejected remote run to unknown rather than failed", async () => {
		const manager = createManager();
		const endpoint = new FakeRemoteEndpoint({
			simulate: { runResolver: () => Promise.reject(new Error("peer link dropped")) },
		});
		const ack = await endpoint.start(REMOTE_ASSIGNMENT);
		AgentRegistry.global().register({
			id: "D2RemoteReject",
			displayName: "Remote Reject",
			kind: "sub",
			endpoint: { kind: "remote", reference: endpoint.handle.reference, endpoint },
		});
		const job = manager.registerEndpoint(endpoint, ack.runId, {
			id: "d2-remote-reject",
			agentId: "D2RemoteReject",
			ownerId: OWNER_ID,
		});

		await job.promise;

		// A rejection is the observer losing the run, not the run failing: a
		// `failed` verdict would claim a peer exit the monitor never saw.
		expect(job.status).toBe("execution-unknown");
		expect(job.exitCode).toBeNull();
		expect(job.errorText).toBe("peer link dropped");
		const ref = AgentRegistry.global().get("D2RemoteReject");
		if (!ref) throw new Error("remote ref disappeared from the registry");
		expect(ref.status).toBe("execution-unknown");
	});
});

describe("D2 RPC waiters: a scheduling pause is not a final stop", () => {
	it("keeps a non-terminal agent_end from settling waitForIdle", async () => {
		const frames = createRpcFrameSource();
		using client = new RpcClient({ spawn: () => frames.child });
		await client.start();

		const idle = client.waitForIdle(2_000);
		let settled = false;
		void idle.then(() => {
			settled = true;
		});

		// This handshake proves the pause frame reached every session listener —
		// `waitForIdle`'s included — before the pending state is inspected below.
		const sawPause = Promise.withResolvers<void>();
		client.onSessionEvent(event => {
			if (event.type === "agent_end" && event.isTerminal === false) sawPause.resolve();
		});
		frames.push({ type: "agent_end", isTerminal: false });
		await sawPause.promise;
		await flushMicrotasks();
		expect(settled).toBe(false);

		frames.push({ type: "agent_end" });
		await idle;
	});

	it("collects past a non-terminal agent_end and stops at the terminal one", async () => {
		const frames = createRpcFrameSource();
		using client = new RpcClient({ spawn: () => frames.child });
		await client.start();

		const collected = client.collectEvents(2_000);
		frames.push({ type: "agent_end", isTerminal: false });
		frames.push({ type: "message_start" });
		frames.push({ type: "agent_end" });

		const events = await collected;

		// The pause frame is not collected and, more importantly, does not end
		// the collection early: the event after it is still there.
		expect(events.map(event => event.type)).toEqual(["message_start", "agent_end"]);
	});
});

describe("D2 row 4: resume reaches the same reference and run", () => {
	it("re-opens the existing peer reference once its owner has let go", async () => {
		const manager = createManager();
		const { endpoint, ack, job, agentId } = await startRemoteRun(manager, {
			agentId: "D2RemoteResume",
			jobId: "d2-remote-resume",
		});
		const reference = endpoint.handle.reference;

		// A run that is still in flight belongs to the peer: resuming here would
		// start a second execution of the same logical session, and parking would
		// freeze work that is still moving.
		expect(await endpoint.ensureLive(reference)).toEqual({
			acknowledged: false,
			reason: expect.stringContaining("still-owned"),
		});
		expect(await endpoint.park(ack.runId)).toEqual({
			acknowledged: false,
			reason: expect.stringContaining("still-owned"),
		});

		endpoint.abortTransport();
		await job.promise;
		expect(job.status).toBe("execution-unknown");

		// A lost transport confirms nothing about the far side: the run is
		// `execution-unknown`, not cancelled, and the peer still owns it until
		// its cleanup is reported. Resuming now would be the second execution.
		expect(await endpoint.ensureLive(reference)).toEqual({
			acknowledged: false,
			reason: expect.stringContaining("still-owned"),
		});

		// The peer's own drain report releases ownership; only then does the same
		// reference reopen, and it reuses the same run in the same sole session.
		endpoint.emitReplyDrained(ack.runId);
		const resumed = await endpoint.ensureLive(reference);
		expect(resumed).toEqual({ acknowledged: true });
		expect(endpoint.sessionsCreatedCount).toBe(1);
		expect(endpoint.sessions.get(reference)?.runId).toBe(ack.runId);
		expect(endpoint.asHandleSnapshot().runId).toBe(ack.runId);

		// The lifecycle path resumes the same opaque reference — no local session,
		// no new peer session, same run identity. Resuming is an acknowledgement
		// of reachability, not a run verdict: the registry keeps the peer's own
		// `execution-unknown` instead of resurrecting the ref as `idle`.
		const live = await AgentLifecycleManager.global().ensureLive(agentId);
		expect(live.kind).toBe("remote");
		if (live.kind !== "remote") throw new Error("expected the lifecycle manager to return a remote live agent");
		expect(live.reference).toBe(endpoint.handle.reference);
		expect(live.endpoint).toBe(endpoint);
		expect(endpoint.asRosterSnapshot().status).toBe("execution-unknown");
		expect(AgentRegistry.global().get(agentId)?.status).toBe("execution-unknown");
		expect(endpoint.sessionsCreatedCount).toBe(1);
		expect(endpoint.asHandleSnapshot().runId).toBe(ack.runId);
	});

	it("refuses to revive a reference the peer never held", async () => {
		const endpoint = new FakeRemoteEndpoint();

		const missing = await endpoint.ensureLive("never-connected");

		expect(missing).toEqual({ acknowledged: false, reason: expect.any(String) });
		expect(endpoint.sessionsCreatedCount).toBe(0);
	});

	it("parks and resumes against the same peer session entry only after the drain", async () => {
		const endpoint = new FakeRemoteEndpoint();
		const ack = await endpoint.start(REMOTE_ASSIGNMENT);
		const reference = endpoint.handle.reference;
		if (!endpoint.sessions.get(reference)) throw new Error("the peer opened no session for the run it acked");

		// A busy run is refused, and so is a run that reached its verdict while
		// still owing replies: both are states the peer still owns, so parking or
		// resuming them would leave two owners for one session.
		expect(await endpoint.park(ack.runId)).toEqual({
			acknowledged: false,
			reason: expect.stringContaining("still-owned"),
		});
		endpoint.completeRun({ status: "completed", runId: ack.runId, text: "peer finished the assignment" });
		expect(await endpoint.park(ack.runId)).toEqual({
			acknowledged: false,
			reason: expect.stringContaining("still-owned"),
		});
		expect(await endpoint.ensureLive(reference)).toEqual({
			acknowledged: false,
			reason: expect.stringContaining("still-owned"),
		});
		expect(endpoint.sessions.get(reference)?.parked).toBe(false);

		// The drain fact ends the ownership: parking then suspends the entry in
		// place — the run identity survives, no session is created to hold the
		// suspension, and the acknowledgement names the resumable reference.
		endpoint.emitReplyDrained(ack.runId);
		expect(await endpoint.park(ack.runId)).toEqual({ acknowledged: true, resumeReference: reference });
		const parked = endpoint.sessions.get(reference);
		if (!parked) throw new Error("the peer session disappeared while parking");
		expect(parked.parked).toBe(true);
		expect(parked.runId).toBe(ack.runId);
		expect(endpoint.sessionsCreatedCount).toBe(1);

		// Resuming clears the flag on that same entry — the run id belongs to the
		// session, not to the suspension.
		expect(await endpoint.ensureLive(reference)).toEqual({ acknowledged: true });
		expect(endpoint.sessions.get(reference)).toBe(parked);
		expect(parked.parked).toBe(false);
		expect(parked.runId).toBe(ack.runId);
		expect(endpoint.sessions.size).toBe(1);
		expect(endpoint.sessionsCreatedCount).toBe(1);

		// A stale run id and an unknown reference are refused, and neither
		// refusal creates or frees a peer session.
		expect(await endpoint.park("not-the-run")).toEqual({ acknowledged: false, reason: expect.any(String) });
		expect(await endpoint.ensureLive("never-connected")).toEqual({
			acknowledged: false,
			reason: expect.any(String),
		});
		expect(parked.parked).toBe(false);
		expect(endpoint.sessions.size).toBe(1);
		expect(endpoint.sessionsCreatedCount).toBe(1);
	});
});

describe("D2 row 5: the remote driver never forges a local session", () => {
	it("serves snapshot/subscribe from the endpoint and calls no session factory", async () => {
		const createSession = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockRejectedValue(new Error("a remote run must not create a local AgentSession"));
		const manager = createManager();
		const endpoint = new FakeRemoteEndpoint();
		const events: EndpointEvent[] = [];

		// Subscriber before the run: the stream must carry its own initial
		// snapshot, then the peer's ACK, outcome and reply drain.
		const stream = endpoint.subscribe();
		const drained = Promise.withResolvers<void>();
		const consume = (async () => {
			for await (const event of stream) {
				events.push(event);
				if (event.type === "reply_drained") {
					drained.resolve();
					return;
				}
			}
			drained.resolve();
		})();

		const ack = await endpoint.start(REMOTE_ASSIGNMENT);
		AgentRegistry.global().register({
			id: "D2RemoteHygiene",
			displayName: "Remote Hygiene",
			kind: "sub",
			endpoint: { kind: "remote", reference: endpoint.handle.reference, endpoint },
		});
		const job = manager.registerEndpoint(endpoint, ack.runId, {
			id: "d2-remote-hygiene",
			agentId: "D2RemoteHygiene",
			ownerId: OWNER_ID,
		});

		const head = await endpoint.snapshot();
		expect(head.snapshot).toMatchObject({ endpointKind: "remote", runId: ack.runId });

		endpoint.completeRun({ status: "completed", runId: ack.runId, text: "peer finished the assignment" });
		await job.promise;
		endpoint.emitReplyDrained(ack.runId);
		await drained.promise;
		await consume;
		expect(await manager.waitForOwnerJobsAndReplies(OWNER_ID)).toEqual({ status: "drained" });

		const observable = events.filter(event => event.type !== "status_changed" && event.type !== "activity_changed");
		expect(observable.map(event => event.type)).toEqual(["snapshot", "run_ack", "run_outcome", "reply_drained"]);
		for (let index = 1; index < observable.length; index++) {
			expect(observable[index]!.revision).toBeGreaterThan(observable[index - 1]!.revision);
		}
		for (const event of observable) expect(event.endpointKind).toBe("remote");
		const ackEvent = observable.find(event => event.type === "run_ack");
		if (ackEvent?.type !== "run_ack") throw new Error("endpoint stream never acknowledged the run");
		expect(ackEvent.runId).toBe(ack.runId);
		const outcomeEvent = observable.find(event => event.type === "run_outcome");
		if (outcomeEvent?.type !== "run_outcome") throw new Error("endpoint stream never reported the run outcome");
		expect(outcomeEvent.runId).toBe(ack.runId);
		const drainedEvent = observable.find(event => event.type === "reply_drained");
		if (drainedEvent?.type !== "reply_drained") throw new Error("endpoint stream never reported the reply drain");
		expect(drainedEvent.runId).toBe(ack.runId);

		expect(createSession.mock.calls.length).toBe(0);
	});
});

describe("D2 endpoint subscriptions: a stopped consumer leaves the stream intact", () => {
	it("settles a pending next() on return without disturbing another subscriber", async () => {
		const endpoint = new FakeRemoteEndpoint();
		const stopped = endpoint.subscribe()[Symbol.asyncIterator]();
		const live = endpoint.subscribe()[Symbol.asyncIterator]();

		// Each subscription opens with a baseline snapshot; consuming it leaves
		// the following `next()` genuinely pending, because no event exists yet.
		expect(await stopped.next()).toMatchObject({ done: false });
		expect(await live.next()).toMatchObject({ done: false });
		const pending = stopped.next();

		await stopped.return?.();

		// The awaiting `next()` is released as done instead of hanging on a
		// promise no event can resolve once the listener is gone.
		expect(await pending).toEqual({ done: true, value: undefined });
		expect(await stopped.next()).toEqual({ done: true, value: undefined });

		// Isolation: the other subscriber keeps receiving live events in revision
		// order, and the endpoint keeps emitting after the stop.
		const ack = await endpoint.start(REMOTE_ASSIGNMENT);
		const ackEvent = await live.next();
		if (ackEvent.done) throw new Error("the live subscriber stopped receiving events");
		expect(ackEvent.value.type).toBe("run_ack");
		if (ackEvent.value.type !== "run_ack") throw new Error("expected the peer's run acknowledgement");
		expect(ackEvent.value.runId).toBe(ack.runId);

		const statusEvent = await live.next();
		if (statusEvent.done) throw new Error("the live subscriber never saw the status change");
		expect(statusEvent.value.revision).toBeGreaterThan(ackEvent.value.revision);
	});
});

const DRIVER_ID = "D2RemoteDriver";

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

/** Seed the SSH capability load without touching the filesystem. */
function mockSshHosts(): void {
	const result: CapabilityResult<SSHHost> = {
		items: [KNOWN_HOST],
		all: [KNOWN_HOST],
		warnings: [],
		providers: ["test-ssh"],
	};
	vi.spyOn(capabilityModule, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

/** Structurally-partial dispatch session: only the policy fields `startEndpoint` reads. */
function createDispatchContext(): DispatchContext {
	return {
		session: {
			cwd: "/tmp",
			settings: { get: () => undefined },
			getSessionSpawns: () => "*",
		} as unknown as ToolSession,
		entryPoint: "task-flat",
	};
}

describe("D2 monitor driver: a lost transport reaches the result and the activity projection", () => {
	it("returns a null exit code and publishes the unknown status through runSubprocess", async () => {
		const createSession = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockRejectedValue(new Error("a remote run must not create a local AgentSession"));
		mockSshHosts();
		const endpoint = new FakeRemoteEndpoint();
		// Instrument the one method the monitor awaits, so the test learns the
		// run is genuinely in flight before the transport dies — no wall-clock
		// race and no second endpoint class.
		const entered = Promise.withResolvers<void>();
		const runEndpoint = endpoint.run.bind(endpoint);
		vi.spyOn(endpoint, "run").mockImplementation(runId => {
			entered.resolve();
			return runEndpoint(runId);
		});
		const prepared = await prepareEndpoint({ kind: "ssh", host: "known", cwd: "/srv/app" }, async () => endpoint);
		expect(prepared.role.source).toBe("remote");
		AgentRegistry.global().register({
			id: DRIVER_ID,
			displayName: DRIVER_ID,
			kind: "sub",
			endpoint: { kind: "remote", reference: endpoint.handle.reference, endpoint },
		});

		const snapshots: AgentProgress[] = [];
		const run = runSubprocess({
			cwd: "/tmp",
			agent: TASK_AGENT,
			task: REMOTE_ASSIGNMENT,
			index: 0,
			id: DRIVER_ID,
			enableIrc: false,
			enableLsp: false,
			endpointExecution: { endpoint, context: createDispatchContext() },
			onProgress: snapshot => snapshots.push(snapshot),
		});

		await entered.promise;
		endpoint.abortTransport();
		const result = await run;

		// The transport died mid-run: `null` is the honest exit code, and it is
		// emphatically not a success verdict.
		expect(result.exitCode).toBeNull();
		expect(result.aborted).toBe(false);
		expect(result.error).toContain("transport aborted");

		// The published progress carries the same verdict as the result, so a
		// renderer never sees a live spinner or a completed run.
		const last = snapshots.at(-1);
		if (!last) throw new Error("the endpoint run published no progress");
		expect(last.status).toBe("execution-unknown");
		for (const snapshot of snapshots) expect(snapshot.status).not.toBe("completed");

		// Activity projection: the lifecycle row follows the published progress.
		const lifecycle = activityRowsFromProgress(last).find(row => row.kind === "lifecycle");
		if (!lifecycle) throw new Error("the activity projection dropped the lifecycle row");
		expect(lifecycle.status).toBe("execution-unknown");

		// Registry verdict, peer session count and local-session hygiene.
		expect(AgentRegistry.global().get(DRIVER_ID)?.status).toBe("execution-unknown");
		expect(endpoint.sessionsCreatedCount).toBe(1);
		const peerSession = endpoint.sessions.get(endpoint.handle.reference);
		if (!peerSession) throw new Error("the peer held no session for the reference it acked");
		expect(endpoint.asHandleSnapshot().runId).toBe(peerSession.runId);
		expect(createSession.mock.calls.length).toBe(0);
	});
});
