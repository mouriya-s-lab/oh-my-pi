import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPool } from "../../src/task/workpool";
import type { EffectiveSubagentPolicy } from "../../src/task/structured-subagent";
import type { ToolSession } from "../../src/tools";
import { FakeRemoteExecutor } from "./fake-remote-executor";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const AGENT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Do the work.",
	source: "bundled",
};

const POLICY = {
	discovery: { agents: [AGENT], projectAgentsDir: null },
	agentName: "scout",
	agent: AGENT,
	effectiveAgent: AGENT,
	schema: { schema: undefined, source: "none", mode: "permissive", outputSchemaOverridesAgent: false },
	planMode: false,
	isIsolated: false,
	mergeMode: "patch",
	applyChanges: true,
	enableLsp: false,
	enableIrc: true,
} satisfies EffectiveSubagentPolicy;

function makeSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRuntimeMs": 0,
			"eval.workpool.freshAgents": false,
		}),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	} satisfies ToolSession;
}

async function untilSettled(pool: WorkPool, count: number): Promise<void> {
	// Same condition-spin as test/task/workpool.test.ts: endpoint turns settle
	// on microtasks through the async job manager, so no wall-clock wait.
	for (let attempt = 0; attempt < 10_000; attempt++) {
		if (pool.items.length === count && pool.peek().pending === 0) return;
		await Promise.resolve();
	}
	throw new Error(`pool did not settle (${pool.peek().pending} pending)`);
}

describe("execution-domain workpool endpoint", () => {
	it("workpool reuses same endpoint across batches; item IDs are stable unique ULIDs", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0 });
		try {
			const session = makeSession(manager);
			const endpoint = new FakeRemoteExecutor({ output: { ok: true } });
			// keepAlive keeps the aggregate job (and the pool) open past the
			// first drain so follow-up work lands on the same bound endpoint.
			const pool = new WorkPool(session, {
				name: "wp",
				policy: POLICY,
				endpoint,
				contract: { task: "wp work", keepAlive: true },
			});
			const endpointA = pool.endpoint;
			const batchA = pool.push(["a1", "a2", "a3"]);
			await untilSettled(pool, 3);
			const batchB = pool.push(["b1", "b2", "b3"]);
			await untilSettled(pool, 6);
			expect(pool.endpoint).toBe(endpointA);
			const ids = [...batchA, ...batchB];
			for (const id of ids) expect(id).toMatch(ULID_RE);
			expect(new Set(ids).size).toBe(6);
			// Every turn carried its items on the contract; the endpoint never changed.
			expect(endpoint.receipts.length).toBeGreaterThanOrEqual(2);
			for (const receipt of endpoint.receipts) expect(receipt.contract.workpoolItems?.length).toBeGreaterThan(0);
			pool.close();
		} finally {
			await manager.dispose();
		}
	});
});
