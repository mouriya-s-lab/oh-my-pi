import { expect, test } from "bun:test";
import { FakeRemoteEndpoint } from "./endpoint-fake";

const PEER = "fake-remote";

async function settleAfterProbe(
	endpoint: FakeRemoteEndpoint,
	ref: string,
): Promise<{ status: "completed" | "failed"; errorCode?: string }> {
	const probe = await endpoint.readResource({ kind: "result", ref, peerId: PEER, probe: true });
	if (probe.status === "available") return { status: "completed" };
	if (probe.status === "unavailable" || probe.status === "expired") {
		return { status: "failed", errorCode: "result-ref-unavailable" };
	}
	return { status: "failed", errorCode: "result-ref-unavailable" };
}

test("local job settles as completed only after ResultRef availability probe succeeds", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.setResource({ kind: "result", ref: "resX", peerId: PEER, text: "payload", availability: "unavailable" });

	// Probe initially unavailable: the job stays pending, never completed.
	const pending = await settleAfterProbe(endpoint, "resX");
	expect(pending.status).toBe("failed");
	expect(pending.errorCode).toBe("result-ref-unavailable");

	// The peer publishes the bytes; the next probe settles completed.
	endpoint.setResourceAvailability("result", "resX", "available");
	const done = await settleAfterProbe(endpoint, "resX");
	expect(done.status).toBe("completed");

	// And the bytes are actually fetchable after the probe.
	const chunk = await endpoint.readResource({ kind: "result", ref: "resX", peerId: PEER });
	expect(chunk.status).toBe("chunk");
});

test("local job settles as failed when ResultRef is never available", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.setResource({ kind: "result", ref: "resY", peerId: PEER, text: "payload", availability: "unavailable" });
	const done = await settleAfterProbe(endpoint, "resY");
	expect(done.status).toBe("failed");
	expect(done.errorCode).toBe("result-ref-unavailable");
});

test("expired ResultRef also settles failed result-ref-unavailable", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.setResource({ kind: "result", ref: "resZ", peerId: PEER, text: "payload", availability: "expired" });
	const done = await settleAfterProbe(endpoint, "resZ");
	expect(done.status).toBe("failed");
	expect(done.errorCode).toBe("result-ref-unavailable");
});
