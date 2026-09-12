import { describe, expect, it } from "bun:test";
import { authorizeHostToolCall, distillRunContract } from "../../src/task/params";
import { FakeRemoteExecutor } from "./fake-remote-executor";

describe("execution-domain host tools", () => {
	it("LOCAL row 2: only an explicitly granted callback executes in the original kernel", async () => {
		const distilled = distillRunContract({ task: "Use the granted callback", tools: ["authorized"] }, "eval");
		if ("error" in distilled) throw distilled.error;
		const kernel = {
			value: 40,
			calls: [] as string[],
			async authorized() { this.calls.push("authorized"); this.value += 2; return this.value; },
			async notAuthorized() { this.calls.push("notAuthorized"); this.value = -1; return this.value; },
		};
		const endpoint = new FakeRemoteExecutor({
			allowedTools: new Set(["authorized"]),
			execute: async contract => {
				const value = await authorizeHostToolCall(contract, "authorized", () => kernel.authorized());
				await expect(authorizeHostToolCall(contract, "notAuthorized", () => kernel.notAuthorized()))
					.rejects.toMatchObject({ code: "host-tool-denied", field: "tools.notAuthorized" });
				return { value };
			},
		});
		const ack = await endpoint.start(distilled.contract.task, { contract: distilled.contract });
		expect(await endpoint.run(ack.runId)).toMatchObject({ status: "completed", text: '{"value":42}' });
		expect(kernel.value).toBe(42);
		expect(kernel.calls).toEqual(["authorized"]);
	});

	it("LOCAL row 6: remote policy denial of an explicit grant fails before any callback or task execution", async () => {
		let executions = 0;
		const endpoint = new FakeRemoteExecutor({
			allowedTools: new Set(),
			execute: async () => { executions++; return "incorrect success"; },
		});
		const contract = { task: "Use the granted callback", tools: ["authorized"] };
		const ack = await endpoint.start(contract.task, { contract });
		expect(await endpoint.run(ack.runId)).toMatchObject({
			status: "failed", paramsError: { code: "conflict-with-remote-policy", field: "tools.authorized" },
		});
		expect(endpoint.asJobSnapshot().status).toBe("failed");
		expect(executions).toBe(0);
	});
});
