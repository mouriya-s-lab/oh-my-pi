import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { FakeRemoteEndpoint } from "./endpoint-fake";

function runEcho(): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("echo", ["ui-bridge-alive"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", chunk => {
			out += String(chunk);
		});
		child.on("error", reject);
		child.on("close", code => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`echo exited with ${code}`));
		});
	});
}

test("ui bridge: adapter attached answers the request", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.resources.scriptUi({ requestId: "r1", kind: "response", value: "picked-a" });
	const answer = await endpoint.respondUi({ requestId: "r1", kind: "select", title: "Pick", options: ["a", "b"] });
	expect(answer.kind).toBe("response");
	expect(answer.requestId).toBe("r1");
	// Real local subprocess is alive alongside the bridge.
	expect(await runEcho()).toBe("ui-bridge-alive");
});

test("ui bridge: no UI adapter answers unavailable/no-ui fast", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.resources.setNoUi(true);
	const started = Date.now();
	const answer = await endpoint.respondUi({ requestId: "r2", kind: "confirm", title: "Sure?" });
	expect(answer).toMatchObject({ requestId: "r2", kind: "unavailable", reason: "no-ui" });
	expect(Date.now() - started).toBeLessThan(100);
});

test("ui bridge: connection drop answers unavailable/disconnected", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.resources.setDisconnected(true);
	const answer = await endpoint.respondUi({ requestId: "r3", kind: "input", title: "Name?" });
	expect(answer).toMatchObject({ requestId: "r3", kind: "unavailable", reason: "disconnected" });
});

test("ui bridge: never default-approves on cancel", async () => {
	const endpoint = new FakeRemoteEndpoint();
	endpoint.resources.scriptUi({ requestId: "r4", kind: "cancelled" });
	const answer = await endpoint.respondUi({ requestId: "r4", kind: "editor", title: "Edit" });
	expect(answer.kind).toBe("cancelled");
});
