import { describe, expect, it } from "bun:test";
import { FakeRemoteExecutor, FakeRemoteVcs } from "./fake-remote-executor";

describe("execution-domain isolation", () => {
	it("LOCAL row 3: unsupported remote isolation fails without changing tracked or untracked files", async () => {
		await using vcs = await FakeRemoteVcs.create(false);
		const before = await vcs.fingerprint();
		const endpoint = new FakeRemoteExecutor({ vcs, output: "would write the remote checkout" });
		const contract = { task: "Change remote files", isolated: true, apply: true };
		const ack = await endpoint.start(contract.task, { contract });
		expect(await endpoint.run(ack.runId)).toMatchObject({
			status: "failed", paramsError: { code: "isolation-unsupported", field: "isolated" },
		});
		const after = await vcs.fingerprint();
		expect(after).toEqual(before);
		expect(vcs.writes).toBe(0);
		// Prove the same executor really can dirty this directory when isolation is not requested.
		const control = new FakeRemoteExecutor({ vcs, output: "written" });
		const controlAck = await control.start("Change remote files", { contract: { task: "Change remote files" } });
		expect((await control.run(controlAck.runId)).status).toBe("completed");
		expect(await vcs.fingerprint()).not.toEqual(before);
	});
});
