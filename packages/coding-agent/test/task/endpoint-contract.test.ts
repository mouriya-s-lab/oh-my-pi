import { afterEach, describe, expect, it, vi } from "bun:test";
import { IrcBus, type IrcEnvelope } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
		...(hooks.bus !== undefined ? { bus: hooks.bus } : {}),
	});
}

/**
 * A bus over its own registry with `peer` as a recording local session — the
 * minimum a behavioral delivery row needs, without touching the global bus the
 * rest of the suite shares.
 */
function deliveryBus(peer: string): {
	bus: IrcBus;
	registry: AgentRegistry;
	delivered: { envelope: IrcEnvelope; expectsReply: boolean | undefined }[];
} {
	const registry = new AgentRegistry();
	const delivered: { envelope: IrcEnvelope; expectsReply: boolean | undefined }[] = [];
	const session = {
		async deliverIrcMessage(envelope: IrcEnvelope, opts?: { expectsReply?: boolean }) {
			delivered.push({ envelope, expectsReply: opts?.expectsReply });
			return "injected" as const;
		},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		waitForIrcReplies: async () => {},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
	registry.register({
		id: peer,
		displayName: peer,
		kind: "sub",
		status: "running",
		endpoint: { kind: "local", session, sessionFile: null },
	});
	return { bus: new IrcBus(registry), registry, delivered };
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

// The inbound boundary is behavioural, not a stub check: an endpoint reports
// how *its peer's* side took the frame, keeps the sender's envelope verbatim,
// and collapses a replayed operation into the one hand-over it already had.

const PEER = "peer:local-child";

function frame(overrides: Partial<IrcEnvelope> = {}): IrcEnvelope {
	return {
		id: "msg-1",
		from: "peer:local-main",
		to: PEER,
		body: "hand this over",
		ts: 1_700_000_000_000,
		...overrides,
	};
}

describe("inbound IRC delivery", () => {
	it("delivers one frame to the peer and hands the envelope over verbatim", async () => {
		const { bus, delivered } = deliveryBus(PEER);
		const endpoint = localEndpoint({ bus });
		const envelope = frame({ replyTo: "msg-0" });

		const receipt = await endpoint.deliverIrc(envelope, { operationId: "op-7", generation: 3 });

		expect(receipt).toEqual({ status: "delivered", to: PEER, outcome: "injected" });
		expect(delivered).toHaveLength(1);
		// Same identity in and out: no id/ts re-minted, no address rewritten.
		expect(delivered[0]!.envelope).toEqual(envelope);
		expect(delivered[0]!.envelope.id).toBe("msg-1");
		expect(delivered[0]!.envelope.ts).toBe(1_700_000_000_000);
		expect(delivered[0]!.envelope.from).toBe("peer:local-main");
	});

	it("injects a replayed operation once and returns the same receipt to the replay", async () => {
		const { bus, delivered } = deliveryBus(PEER);
		const endpoint = localEndpoint({ bus });

		const first = await endpoint.deliverIrc(frame(), { operationId: "op-7", generation: 3 });
		const replay = await endpoint.deliverIrc(frame(), { operationId: "op-7", generation: 3 });

		expect(delivered).toHaveLength(1);
		expect(replay).toEqual(first);
		// A different generation is a different operation scope: it delivers.
		const otherGeneration = await endpoint.deliverIrc(frame(), { operationId: "op-7", generation: 4 });
		expect(delivered).toHaveLength(2);
		expect(otherGeneration).toEqual(first);
	});

	it("reports failed for a peer this endpoint's bus cannot reach, and never fakes a hand-over", async () => {
		const { bus } = deliveryBus(PEER);
		const endpoint = localEndpoint({ bus });

		const receipt = await endpoint.deliverIrc(frame({ to: "peer:remote-main" }));

		expect(receipt.status).toBe("failed");
		if (receipt.status !== "failed") throw new Error("expected a failed receipt");
		expect(receipt.to).toBe("peer:remote-main");
		expect(receipt.error).toContain("peer:remote-main");
	});

	it("reports indeterminate — neither delivered nor failed — when a transport cannot confirm the frame", async () => {
		const { bus, delivered } = deliveryBus(PEER);
		const endpoint = new FakeRemoteEndpoint({ ircBus: bus });
		await endpoint.start(REMOTE_ASSIGNMENT);
		endpoint.setDeliveryIndeterminate(true);
		const receipt = await endpoint.deliverIrc(frame(), { operationId: "op-9", generation: 1 });
		expect(receipt.status).toBe("indeterminate");
		if (receipt.status !== "indeterminate") throw new Error("expected an indeterminate receipt");
		expect(receipt.to).toBe(PEER);
		expect(endpoint.frames).toHaveLength(1);
		expect(delivered).toHaveLength(1);
	});
	it("records a frame the fake peer took, and collapses a replayed operation into one hand-over", async () => {
		const { bus, delivered } = deliveryBus(PEER);
		const endpoint = new FakeRemoteEndpoint({ ircBus: bus });
		await endpoint.start(REMOTE_ASSIGNMENT);
		const envelope = frame();
		const first = await endpoint.deliverIrc(envelope, { operationId: "op-9", generation: 1 });
		const replay = await endpoint.deliverIrc(envelope, { operationId: "op-9", generation: 1 });
		expect(first).toEqual({ status: "delivered", to: PEER, outcome: "injected" });
		expect(replay).toEqual(first);
		expect(endpoint.frames).toHaveLength(1);
		expect(endpoint.frames[0]!.envelope).toEqual(envelope);
		expect(endpoint.deliveries.get("1\u0000op-9")).toBe(1);
		expect(delivered).toHaveLength(1);
	});
	it("fails without a configured transport instead of faking a delivery", async () => {
		const endpoint = new FakeRemoteEndpoint();
		await endpoint.start(REMOTE_ASSIGNMENT);
		const receipt = await endpoint.deliverIrc(frame(), { operationId: "op-9", generation: 1 });
		expect(receipt.status).toBe("failed");
		if (receipt.status !== "failed") throw new Error("expected a failed receipt");
		expect(receipt.error).toContain("inbound IRC transport not configured");
		expect(endpoint.frames).toHaveLength(0);
	});
});
