import { describe, expect, it } from "bun:test";
import { distillRunContract } from "../../src/task/params";
import { FakeRemoteExecutor, localExecutor } from "./fake-remote-executor";

describe("execution-domain strict schema", () => {
	it("LOCAL row 1: local and remote reject a missing required field instead of accepting plain text", async () => {
		const distilled = distillRunContract({
			task: "Report the answer",
			outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
			schemaMode: "strict",
		}, "task");
		if ("error" in distilled) throw distilled.error;
		const { contract } = distilled;
		const options = { output: { explanation: "No answer field was supplied" } };
		const local = localExecutor(contract, options);
		const remote = new FakeRemoteExecutor(options);
		for (const endpoint of [local, remote]) {
			const ack = await endpoint.start(contract.task, { contract });
			const outcome = await endpoint.run(ack.runId);
			expect(outcome).toMatchObject({ status: "failed", paramsError: { code: "strict-schema-unsatisfied", field: "answer" } });
			expect(endpoint.asJobSnapshot().status).toBe("failed");
			await endpoint.terminate();
		}
	});
});
