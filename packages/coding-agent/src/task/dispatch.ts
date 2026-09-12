import type { ToolSession } from "../tools";
import type { AgentEndpoint, PrepareResult, RunAck } from "./endpoint";
import type { RunContract } from "./params";
import { resolveSpawnPolicy } from "./spawn-policy";
import { type ExecutionTarget, type TargetValidationError, validateExecutionTarget } from "./target";
import { canSpawnAtDepth } from "./types";

export interface DispatchContext {
	session: ToolSession;
	entryPoint: "task-flat" | "task-batch-item" | "eval-agent" | "workpool";
	itemIndex?: number;
	agent?: string;
	blockingHint?: boolean;
}

export type DispatchAuthorizationErrorCode =
	| "host-not-permitted"
	| "role-not-permitted"
	| "budget-exceeded"
	| "spawn-cap-exceeded"
	| "target-invalid";

export type DispatchAuthorizationResult =
	| { allowed: true }
	| { allowed: false; reason: string; code: DispatchAuthorizationErrorCode };

export class DispatchAuthorizationError extends Error {
	constructor(readonly code: DispatchAuthorizationErrorCode, message: string) {
		super(message);
		this.name = "DispatchAuthorizationError";
	}
}

export type NormalizeResult =
	| { status: "local"; target: ExecutionTarget & { kind: "local" }; agent: string }
	| { status: "ssh"; target: ExecutionTarget & { kind: "ssh" }; agent?: string }
	| { status: "error"; error: TargetValidationError | DispatchAuthorizationError };

export const REMOTE_EXECUTION_NOT_WIRED =
	"remote execution not yet wired end-to-end (mouriya-s-lab#8 owns the AgentEndpoint dispatch)";

/** The host allowlist is the existing SSH capability, checked by the target validator. */
function authorize(ctx: DispatchContext, agent: string | undefined): DispatchAuthorizationResult {
	const policy = resolveSpawnPolicy(ctx.session.getSessionSpawns());
	// An omitted SSH role is unresolved until prepare. Never substitute a local role;
	// startEndpoint checks the peer's actual role against this same policy.
	if (!policy.enabled || (agent !== undefined && policy.allowedAgents !== null && !policy.allowedAgents.includes(agent))) {
		return { allowed: false, code: "role-not-permitted", reason: `Cannot spawn '${agent ?? "remote default"}'. Allowed: ${policy.allowedErrorText}` };
	}
	if (agent !== undefined && ctx.session.settings.get("task.disabledAgents")?.includes(agent)) {
		return { allowed: false, code: "role-not-permitted", reason: `Agent "${agent}" is disabled in settings.` };
	}
	const budget = ctx.session.getTurnBudget?.();
	if (budget?.hard && budget.total !== null && budget.spent >= budget.total) {
		return { allowed: false, code: "budget-exceeded", reason: `Turn token budget exhausted (${budget.spent}/${budget.total} output tokens).` };
	}
	const depth = ctx.session.taskDepth ?? 0;
	const maxDepth = ctx.session.settings.get("task.maxRecursionDepth") ?? 2;
	if (!canSpawnAtDepth(maxDepth, depth)) {
		return { allowed: false, code: "spawn-cap-exceeded", reason: `Cannot spawn another agent at task depth ${depth}; maximum depth is ${maxDepth}.` };
	}
	return { allowed: true };
}

/** Validate routing before local discovery, and retain the untouched legacy preflight for omitted targets. */
export async function normalizeAndAuthorize(target: unknown, ctx: DispatchContext): Promise<NormalizeResult> {
	const validation = await validateExecutionTarget(target, { cwd: ctx.session.cwd });
	if ("error" in validation) return { status: "error", error: validation.error };
	const resolvedTarget = validation.target;
	const agent = ctx.agent?.trim() || (resolvedTarget.kind === "local" ? resolveSpawnPolicy(ctx.session.getSessionSpawns()).defaultAgent : undefined);
	// No-target callers keep their existing policy order, errors and budget semantics.
	if (target !== undefined && target !== null) {
		const authorization = authorize(ctx, agent);
		if (!authorization.allowed) {
			return { status: "error", error: new DispatchAuthorizationError(authorization.code, authorization.reason) };
		}
	}
	if (resolvedTarget.kind === "local") return { status: "local", target: resolvedTarget, agent: agent! };
	return { status: "ssh", target: resolvedTarget, ...(agent !== undefined ? { agent } : {}) };
}

/** Local factories wrap an existing preflight/session in LocalAgentEndpoint; remote factories own their configuration. */
export type EndpointFactory = (target: ExecutionTarget) => Promise<AgentEndpoint>;

const preparedEndpoints = new WeakMap<AgentEndpoint, { target: ExecutionTarget; agent: string }>();

/** After normalizeAndAuthorize, prepare metadata only: neither start nor run is invoked here. */
export async function prepareEndpoint(target: ExecutionTarget, endpointFactory: EndpointFactory): Promise<PrepareResult> {
	const boundTarget = Object.freeze({ ...target });
	const endpoint = await endpointFactory(boundTarget);
	preparedEndpoints.delete(endpoint);
	const result = await endpoint.prepare();
	const source = boundTarget.kind === "local" ? "local" : "remote";
	if (endpoint.handle.kind !== source || result.role.source !== source || !result.role.agent.trim()) {
		throw new DispatchAuthorizationError("target-invalid", "Endpoint preparation returned an invalid target or role identity.");
	}
	preparedEndpoints.set(endpoint, { target: boundTarget, agent: result.role.agent });
	return result;
}

/** Re-check the prepared role and live authorization immediately before accepting an assignment. */
export async function startEndpoint(
	endpoint: AgentEndpoint,
	assignment: string,
	signal: AbortSignal | undefined,
	ctx: DispatchContext,
	contract?: RunContract,
): Promise<RunAck> {
	signal?.throwIfAborted();
	const prepared = preparedEndpoints.get(endpoint);
	if (!prepared) throw new DispatchAuthorizationError("target-invalid", "Endpoint must be prepared before start.");
	const result = await normalizeAndAuthorize(prepared.target, { ...ctx, agent: prepared.agent });
	if (result.status === "error") throw result.error;
	signal?.throwIfAborted();
	// Claim this preparation after the asynchronous gate, so concurrent starts
	// cannot overwrite the live run or use metadata superseded by a new prepare.
	if (preparedEndpoints.get(endpoint) !== prepared) {
		throw new DispatchAuthorizationError("target-invalid", "Endpoint preparation was already used or superseded.");
	}
	preparedEndpoints.delete(endpoint);
	const ack = await (contract === undefined ? endpoint.start(assignment) : endpoint.start(assignment, { contract }));
	if (signal?.aborted) {
		await endpoint.cancelRun(ack.runId);
		signal.throwIfAborted();
	}
	return ack;
}
