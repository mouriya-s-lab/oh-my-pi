import { afterEach, expect, spyOn, test } from "bun:test";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { HistoryProtocolHandler } from "../../src/internal-urls/history-protocol";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { ResourceOwnershipError, assertLocalDisplayPath } from "../../src/task/resource";
import { FakeRemoteEndpoint } from "../task/endpoint-fake";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

function remoteRef(id: string, endpoint: FakeRemoteEndpoint) {
	const registry = AgentRegistry.global();
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		endpoint: { kind: "remote", reference: endpoint.handle.reference, endpoint },
	});
	return registry.get(id)!;
}

test("agent:// dispatches through endpoint.readResource for remote refs", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.setResource({
		kind: "result",
		ref: "xyz",
		peerId: endpoint.handle.reference,
		text: "remote bytes",
		displayPath: "/tmp/display-only.md",
	});
	remoteRef("xyz", endpoint);
	const spy = spyOn(endpoint, "readResource");
	const resource = await new AgentProtocolHandler().resolve(new URL("agent://xyz") as never);
	expect(spy).toHaveBeenCalled();
	expect(resource.content).toBe("remote bytes");
});

test("history:// dispatches through endpoint.readResource for remote refs", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.setResource({
		kind: "history",
		ref: "hist-1",
		peerId: endpoint.handle.reference,
		text: "# hist-1 transcript",
	});
	remoteRef("hist-1", endpoint);
	const resource = await new HistoryProtocolHandler().resolve(new URL("history://hist-1") as never);
	expect(resource.content).toBe("# hist-1 transcript");
});

test("local open of remote displayPath throws remote-path-not-local", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.setResource({
		kind: "result",
		ref: "remote-x",
		peerId: endpoint.handle.reference,
		text: "x",
		displayPath: "/remote/nonexistent",
	});
	const probe = await endpoint.readResource({
		kind: "result",
		ref: "remote-x",
		peerId: endpoint.handle.reference,
		probe: true,
	});
	expect(probe.status).toBe("available");
	if (probe.status !== "available") throw new Error("expected available probe");
	expect(() => assertLocalDisplayPath(probe.ref)).toThrow(ResourceOwnershipError);
	try {
		assertLocalDisplayPath(probe.ref);
		throw new Error("should have thrown");
	} catch (error) {
		expect((error as ResourceOwnershipError).code).toBe("remote-path-not-local");
	}
});

test("readResource with mismatched peerId returns cross-peer-forbidden", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.setResource({ kind: "result", ref: "X", peerId: "peer-a", text: "secret" });
	const result = await endpoint.readResource({ kind: "result", ref: "X", peerId: "peer-b" });
	expect(result.status).toBe("forbidden");
	if (result.status !== "forbidden") throw new Error("expected forbidden");
	expect(result.code).toBe("cross-peer-forbidden");
});
