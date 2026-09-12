import { describe, expect, it } from "bun:test";
import { distillRunContract } from "../../src/task/params";
import { FakeRemoteExecutor } from "./fake-remote-executor";

/** The fake remote owns its ladder; the wire carries only the literal. */
const REMOTE_LADDER = { lo: "remote-lo-tier", med: "remote-med-tier", hi: "remote-hi-tier" } as const;

describe("execution-domain effort", () => {
	it("effort literal 'hi' travels verbatim; not locally resolved", async () => {
		const distilled = distillRunContract({ task: "Do work", effort: "hi" }, "task");
		if ("error" in distilled) throw distilled.error;
		const { contract } = distilled;
		expect(contract.effort).toBe("hi");

		let resolvedEffort: string | undefined;
		const remote = new FakeRemoteExecutor({
			execute: async seen => {
				resolvedEffort = REMOTE_LADDER[seen.effort ?? "med"];
				return { ok: true };
			},
		});
		const ack = await remote.start(contract.task, { contract });
		const outcome = await remote.run(ack.runId);
		expect(outcome.status).toBe("completed");
		await remote.terminate();
		// The receipt carries the literal, never a locally expanded provider/model name.
		expect(remote.receipts[0]?.contract.effort).toBe("hi");
		expect(resolvedEffort).toBe("remote-hi-tier");
	});
});
