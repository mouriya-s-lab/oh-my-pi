import { afterEach, expect, spyOn, test } from "bun:test";
import { readHubHistoryViaEndpoint } from "../../src/modes/components/agent-hub";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { FakeRemoteEndpoint } from "../task/endpoint-fake";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

function registerRemote(id: string, status: "idle" | "parked", endpoint: FakeRemoteEndpoint) {
	const registry = AgentRegistry.global();
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		status,
		endpoint: { kind: "remote", reference: endpoint.handle.reference, endpoint },
	});
	return registry.get(id)!;
}

test("hub view snapshot + history read does not wake idle or parked peers", async () => {
	const idleEndpoint = new FakeRemoteEndpoint();
	idleEndpoint.setResource({
		kind: "history",
		ref: "idle-peer",
		peerId: idleEndpoint.handle.reference,
		text: "# idle transcript",
	});
	const parkedEndpoint = new FakeRemoteEndpoint();
	parkedEndpoint.setResource({
		kind: "history",
		ref: "parked-peer",
		peerId: parkedEndpoint.handle.reference,
		text: "# parked transcript",
	});
	const idleRef = registerRemote("idle-peer", "idle", idleEndpoint);
	const parkedRef = registerRemote("parked-peer", "parked", parkedEndpoint);

	const idleRunSpy = spyOn(idleEndpoint, "run");
	const idleStartSpy = spyOn(idleEndpoint, "start");
	const parkedRunSpy = spyOn(parkedEndpoint, "run");
	const parkedStartSpy = spyOn(parkedEndpoint, "start");

	// Snapshot reads (the hub table's status/badge path).
	expect(idleEndpoint.asJobSnapshot().status).toBe("idle");
	expect(parkedEndpoint.asJobSnapshot().status).toBe("idle");

	// History reads via the no-wake endpoint channel.
	const idlePage = await readHubHistoryViaEndpoint(idleRef, 0);
	const parkedPage = await readHubHistoryViaEndpoint(parkedRef, 0);
	expect(idlePage?.text).toBe("# idle transcript");
	expect(parkedPage?.text).toBe("# parked transcript");

	expect(idleRunSpy).not.toHaveBeenCalled();
	expect(idleStartSpy).not.toHaveBeenCalled();
	expect(parkedRunSpy).not.toHaveBeenCalled();
	expect(parkedStartSpy).not.toHaveBeenCalled();
	expect(idleEndpoint.runCount).toBe(0);
	expect(idleEndpoint.startCount).toBe(0);
	expect(parkedEndpoint.runCount).toBe(0);
	expect(parkedEndpoint.startCount).toBe(0);
	expect(AgentRegistry.global().get("parked-peer")?.status).toBe("parked");
});
