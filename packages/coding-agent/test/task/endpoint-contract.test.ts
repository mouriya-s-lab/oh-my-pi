import { afterEach, describe, expect, it, vi } from "bun:test";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RunAck, RunOutcome } from "@oh-my-pi/pi-coding-agent/task/endpoint";
import { LocalAgentEndpoint, type LocalAgentEndpointOptions } from "@oh-my-pi/pi-coding-agent/task/endpoint/local";
import { FakeRemoteEndpoint } from "./endpoint-fake";

// Contract: an endpoint reports a run through exactly one of four terminal
// verdicts, `start()` hands back a receipt rather than a result, and the three
// `as*Snapshot()` views always describe the same run. `execution-unknown` is a
// transport verdict reachable only when a remote transport dies mid-run — the
// fake below is the only implementation here that can produce it. A local run
// never reports it, and a remote lifecycle never creates a local session.

const REMOTE_ASSIGNMENT = "Verify the endpoint contract from the remote side.";
const LOCAL_ASSIGNMENT = "Verify the endpoint contract from the local side.";

/**
 * A fake holding one run in flight, plus the deferred that settles it: nothing
 * about the run is observable through `run()` until the resolver fires.
 */
async function openRemoteRun(): Promise<{
	endpoint: FakeRemoteEndpoint;
	ack: RunAck;
	advance: PromiseWithResolvers<RunOutcome>;
	runPromise: Promise<RunOutcome>;
}> {
	const advance = Promise.withResolvers<RunOutcome>();
	const endpoint = new FakeRemoteEndpoint({ simulate: { runResolver: () => advance.promise } });
	const ack = await endpoint.start(REMOTE_ASSIGNMENT);
	return { endpoint, ack, advance, runPromise: endpoint.run(ack.runId) };
}

// The local adapter stores its session as an opaque handle and never calls into
// it, so a stand-in keeps this a pure contract test (same convention as
// `test/acp-agent.test.ts`).
const SESSION_STAND_IN = {} as unknown as AgentSession;

function localEndpoint(hooks: Partial<LocalAgentEndpointOptions> = {}): LocalAgentEndpoint {
	return new LocalAgentEndpoint({
		session: SESSION_STAND_IN,
		agent: "sonic",
		awaitTerminal: hooks.awaitTerminal ?? (async () => ({ status: "completed" })),
		cancelRun: hooks.cancelRun ?? (async () => {}),
		terminate: hooks.terminate ?? (async () => {}),
	});
}

describe("AgentEndpoint contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("settles a completed run from the resolver's outcome", async () => {
		const { endpoint, ack, advance, runPromise } = await openRemoteRun();
		advance.resolve({ status: "completed", runId: ack.runId, text: "All four verdicts reachable." });

		const outcome = await runPromise;

		expect(outcome.status).toBe("completed");
		expect(outcome.runId).toBe(ack.runId);
		expect(endpoint.asJobSnapshot().status).toBe("completed");
	});

	it("settles a failed run as failed rather than execution-unknown", async () => {
		const { endpoint, ack, advance, runPromise } = await openRemoteRun();
		advance.resolve({ status: "failed", runId: ack.runId, error: "peer exited with code 3" });

		expect((await runPromise).status).toBe("failed");
		expect(endpoint.asJobSnapshot().status).toBe("failed");
	});

	it("settles a cancelled run when cancelRun is invoked", async () => {
		const { endpoint, ack, runPromise } = await openRemoteRun();

		await endpoint.cancelRun(ack.runId);

		expect((await runPromise).status).toBe("cancelled");
		expect(endpoint.asJobSnapshot().status).toBe("cancelled");
	});

	it("hands back a start ACK while the run has no outcome yet", async () => {
		const { endpoint, ack, advance, runPromise } = await openRemoteRun();

		// `start()` already resolved, yet the run holds no verdict: the only
		// thing that settles it is the resolver below, so an ACK is a receipt
		// for the accepted assignment rather than its result.
		expect(endpoint.asJobSnapshot()).toMatchObject({ runId: ack.runId, status: "running" });

		advance.resolve({ status: "completed", runId: ack.runId, text: "Assignment finished." });

		expect((await runPromise).status).toBe("completed");
		expect(endpoint.asJobSnapshot().status).toBe("completed");
	});

	it("reports execution-unknown on all three views when the transport aborts", async () => {
		const { endpoint, ack, advance, runPromise } = await openRemoteRun();

		endpoint.abortTransport();
		const outcome = await runPromise;

		expect(outcome.status).toBe("execution-unknown");
		const job = endpoint.asJobSnapshot();
		expect(job.status).toBe("execution-unknown");
		expect(endpoint.asHandleSnapshot().status).toBe("execution-unknown");
		expect(endpoint.asRosterSnapshot().status).toBe("execution-unknown");
		// All three views describe the same run, so they must not diverge.
		expect(job.runId).toBe(ack.runId);
		expect(job.endpointKind).toBe("remote");
		expect(endpoint.asHandleSnapshot()).toEqual(job);
		expect(endpoint.asRosterSnapshot()).toEqual(job);

		// A resolver that lands after the transport died cannot overwrite the
		// verdict. `advance.promise` was subscribed by the fake before this
		// await, so its late outcome is delivered to the endpoint first.
		advance.resolve({ status: "completed", runId: ack.runId, text: "Too late to observe." });
		await advance.promise;
		expect(endpoint.asJobSnapshot().status).toBe("execution-unknown");
	});

	it("never creates a local session for a remote-only lifecycle", async () => {
		const createSession = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockRejectedValue(new Error("a remote lifecycle must not create a local AgentSession"));
		const { endpoint, runPromise } = await openRemoteRun();

		expect((await endpoint.prepare()).role.source).toBe("remote");
		endpoint.abortTransport();
		expect((await runPromise).status).toBe("execution-unknown");
		await endpoint.terminate();

		expect(createSession.mock.calls.length).toBe(0);
	});

	it("never reports execution-unknown from a local run", async () => {
		const endpoint = localEndpoint({ awaitTerminal: async () => ({ status: "cancelled" }) });

		expect((await endpoint.prepare()).role.source).toBe("local");
		const ack = await endpoint.start(LOCAL_ASSIGNMENT);

		expect((await endpoint.run(ack.runId)).status).toBe("cancelled");
		const job = endpoint.asJobSnapshot();
		expect(job.status).toBe("cancelled");
		expect(endpoint.asHandleSnapshot().status).toBe("cancelled");
		expect(endpoint.asRosterSnapshot().status).toBe("cancelled");
		expect(job.endpointKind).toBe("local");
	});

	it("rejects a cancel for a run other than the current one", async () => {
		const endpoint = localEndpoint();
		const ack = await endpoint.start(LOCAL_ASSIGNMENT);

		await expect(endpoint.cancelRun(crypto.randomUUID())).rejects.toThrow(/unknown run/);
		await endpoint.cancelRun(ack.runId);
	});
});
