import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { normalizeAndAuthorize, REMOTE_EXECUTION_NOT_WIRED } from "../task/dispatch";
import { createEvalCustomTools, describeEvalTools } from "../task/eval-tools";
import { resolveEffectiveSubagentPolicy } from "../task/structured-subagent";
import { type WorkPoolPeekResult, type WorkPoolStatus, WorkPoolRegistry } from "../task/workpool";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for eval work pools. */
export const EVAL_WORKPOOL_BRIDGE_NAME = "__workpool__";

interface EvalWorkpoolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export type EvalWorkpoolResult =
	| { name: string; agent: string; limit: number }
	| { ids: string[] }
	| WorkPoolStatus
	| WorkPoolPeekResult
	| { dropped: string[] };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(args: unknown): Record<string, unknown> {
	if (!isUnknownRecord(args)) throw new ToolError("workpool() arguments must be an object");
	return args;
}

function requireName(args: Record<string, unknown>): string {
	if (typeof args.name !== "string" || args.name.trim().length === 0) {
		throw new ToolError("workpool operation requires a non-empty name");
	}
	return args.name.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ToolError(`workpool ${key} must be a non-empty string`);
	}
	return value.trim();
}

function optionalTools(args: Record<string, unknown>): string[] | undefined {
	if (args.tools === undefined) return undefined;
	if (!Array.isArray(args.tools) || !args.tools.every(tool => typeof tool === "string" && tool.length > 0)) {
		throw new ToolError("workpool tools must be an array of non-empty strings");
	}
	return args.tools;
}

function getPool(options: EvalWorkpoolBridgeOptions, name: string) {
	const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
	const pool = WorkPoolRegistry.global().get(ownerId, name);
	if (!pool) throw new ToolError(`unknown workpool "${name}"`);
	return pool;
}

/** Create or operate a process-local pool of keep-alive subagents. */
export async function runEvalWorkpool(args: unknown, options: EvalWorkpoolBridgeOptions): Promise<EvalWorkpoolResult> {
	const record = requireRecord(args);
	const op = record.op;
	if (typeof op !== "string") throw new ToolError("workpool() requires an op");

	if (op === "create") {
		const agent = optionalString(record, "agent");
		const requestedName = optionalString(record, "name");
		const context = optionalString(record, "context");
		const tools = optionalTools(record);
		const targetInput = record.target;
		const gate = await normalizeAndAuthorize(targetInput, {
			session: options.session,
			entryPoint: "workpool",
			...(agent ? { agent } : {}),
		});
		if (gate.status === "error") {
			throw new ToolError(`${gate.error.message} (code: ${gate.error.code})`, { code: gate.error.code });
		}
		if (gate.status === "ssh") {
			throw new ToolError(REMOTE_EXECUTION_NOT_WIRED);
		}
		// Only an explicitly supplied target is carried into the pool; pools that
		// omitted one stay on the pre-target local path with no target authorization.
		const boundTarget = targetInput === undefined || targetInput === null ? undefined : gate.target;
		if (tools?.length && options.session.getPlanModeState?.()?.enabled === true) {
			throw new ToolError("Eval-defined tools are unavailable in plan mode.");
		}
		// The shared dispatcher already resolved the local default role for a
		// target-carrying call; passing it here keeps one normalized identity.
		const policy = await resolveEffectiveSubagentPolicy({
			session: options.session,
			invocationKind: "eval",
			assignment: `Create workpool ${requestedName ?? agent ?? "worker"}`,
			agent: gate.agent,
		});
		const customTools = tools?.length
			? createEvalCustomTools(options.session, await describeEvalTools(options.session, tools, options.signal))
			: [];
		const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
		const registry = WorkPoolRegistry.global();
		let name = requestedName ?? `${policy.agentName}-pool`;
		if (!requestedName) {
			const base = name;
			let suffix = 2;
			while (registry.get(ownerId, name) || options.session.asyncJobManager?.getJob(name)) {
				name = `${base}-${suffix++}`;
			}
		}
		// Target-carrying creation awaits the pool's own creation-time authorization
		// before it is registered; target-less creation keeps the synchronous path.
		const pool = boundTarget
			? await registry.createAuthorized(options.session, {
					name,
					policy,
					...(context ? { context } : {}),
					customTools,
					target: boundTarget,
				})
			: registry.create(options.session, {
					name,
					policy,
					...(context ? { context } : {}),
					customTools,
				});
		options.emitStatus?.({ op: "workpool", action: "create", pool: name, count: pool.limit() });
		return { name, agent: policy.agentName, limit: pool.limit() };
	}

	const name = requireName(record);
	if (record.target !== undefined) {
		throw new ToolError("workpool binds target at creation");
	}
	const pool = getPool(options, name);
	if (op === "push") {
		if (!Array.isArray(record.items) || !record.items.every(item => typeof item === "string")) {
			throw new ToolError("workpool push requires an items string array");
		}
		const ids = pool.push(record.items);
		options.emitStatus?.({ op: "workpool", action: "push", pool: name, count: ids.length });
		return { ids };
	}
	if (op === "status") return pool.status();
	if (op === "peek") return pool.peek();
	if (op === "close") {
		const result = pool.close();
		options.emitStatus?.({ op: "workpool", action: "close", pool: name, count: result.dropped.length });
		return result;
	}
	throw new ToolError(`unknown workpool operation "${op}"`);
}
