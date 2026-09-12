import { isRecord } from "@oh-my-pi/pi-utils";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES, normalizeToolName } from "../tools/builtin-names";
import { buildOutputValidator, formatAllValidationIssues } from "../tools/output-schema-validator";

export type ParamsErrorCode =
	| "unknown-parameter"
	| "invalid-shape"
	| "conflict-with-remote-policy"
	| "isolation-unsupported"
	| "strict-schema-unsatisfied"
	| "host-tool-denied";

export class ParamsError extends Error {
	constructor(readonly code: ParamsErrorCode, readonly detail: string, readonly field?: string) {
		super(detail);
		this.name = "ParamsError";
	}
}

export interface WorkpoolItem {
	id: string;
	text: string;
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Mint once when accepting an item, then carry its identity unchanged on every run. */
export function createWorkpoolItem(text: string): WorkpoolItem {
	let timestamp = Date.now();
	let id = "";
	for (let index = 0; index < 10; index++) {
		id = ULID_ALPHABET[timestamp % 32] + id;
		timestamp = Math.floor(timestamp / 32);
	}
	const entropy = crypto.getRandomValues(new Uint8Array(16));
	for (const byte of entropy) id += ULID_ALPHABET[byte & 31];
	return { id, text };
}

/** Explicit work only. No runtime defaults, kernel, registry, or credentials enter this value. */
export interface RunContract {
	task: string;
	context?: string;
	agent?: string;
	effort?: "lo" | "med" | "hi";
	outputSchema?: unknown;
	schemaMode?: "strict" | "permissive";
	tools?: readonly string[];
	isolated?: boolean;
	apply?: boolean;
	merge?: "auto" | "manual" | false;
	keepAlive?: boolean;
	retainArtifacts?: boolean;
	// #12: handle is an eval-entry alias for retainArtifacts (upstream b8779dae63 shape).
	handle?: boolean;
	/** Local presentation only; serializers must omit even when supplied directly. */
	detached?: boolean;
	timeout?: number;
	budget?: number;
	depth?: number;
	spawns?: number;
	workpoolItems?: readonly WorkpoolItem[];
	freshAgents?: boolean;
}

export interface LocalOnlyContext {
	name?: string;
	label?: string;
	parent?: string;
	detached?: boolean;
}

export type DistilledRunContract = { contract: RunContract; local: LocalOnlyContext } | { error: ParamsError };
const NATIVE_NAMES: ReadonlySet<string> = new Set([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);


export function readParamsError(raw: unknown): ParamsError | undefined {
	if (!isRecord(raw) || typeof raw.detail !== "string" || (raw.field !== undefined && typeof raw.field !== "string")) return undefined;
	switch (raw.code) {
		case "unknown-parameter":
		case "invalid-shape":
		case "conflict-with-remote-policy":
		case "isolation-unsupported":
		case "strict-schema-unsatisfied":
		case "host-tool-denied":
			return new ParamsError(raw.code, raw.detail, raw.field);
	}
	return undefined;
}

/** Parse entry aliases once; absence and explicit false remain distinct. */
export function distillRunContract(raw: unknown, entry: "task" | "eval" | "workpool"): DistilledRunContract {
	if (!isRecord(raw)) return { error: new ParamsError("invalid-shape", "Parameters must be an object") };
	const contract: RunContract = { task: "" };
	const local: LocalOnlyContext = {};
	const assigned = new Set<string>();
	const invalid = (field: string, detail: string): DistilledRunContract => ({ error: new ParamsError("invalid-shape", detail, field) });
	for (const [key, value] of Object.entries(raw)) {
		const field = key === "prompt" ? "task" : key === "schema" ? "outputSchema" : key === "items" ? "workpoolItems" : key;
		if (value === undefined) continue;
		if (assigned.has(field)) return invalid(key, `Both aliases for ${field} were supplied`);
		assigned.add(field);
		switch (field) {
			case "name": case "label": case "parent":
				if (typeof value !== "string") return invalid(key, `${key} must be a string`);
				local[field] = value;
				break;
			case "detached":
				if (typeof value !== "boolean") return invalid(key, `${key} must be a boolean`);
				local.detached = value;
				break;
		case "task": case "context": case "agent":
			if (typeof value !== "string" || (field !== "context" && !value.trim())) return invalid(key, `${key} must be a non-empty string`);
			contract[field] = value;
			break;
		case "handle":
			if (typeof value !== "boolean") return invalid(key, `${key} must be a boolean`);
			contract.handle = value;
			// #12: handle is an eval-entry alias for retainArtifacts (upstream b8779dae63 shape).
			if (value === true) contract.retainArtifacts = true;
			break;
		case "effort":
				if (value !== "lo" && value !== "med" && value !== "hi") return invalid(key, "effort must be lo, med, or hi");
				contract.effort = value;
				break;
			case "outputSchema":
				contract.outputSchema = value;
				break;
			case "schemaMode":
				if (value !== "strict" && value !== "permissive") return invalid(key, "schemaMode must be strict or permissive");
				contract.schemaMode = value;
				break;
			case "tools": {
				if (!Array.isArray(value) || !value.every((name): name is string => typeof name === "string" && name.trim().length > 0)) return invalid(key, "tools must be an array of non-empty names");
				const collision = value.find(name => NATIVE_NAMES.has(normalizeToolName(name)));
				if (collision !== undefined) return { error: new ParamsError("host-tool-denied", `Host tool ${collision} conflicts with a native tool`, `tools.${collision}`) };
				contract.tools = value;
				break;
			}
			case "isolated": case "apply": case "keepAlive": case "retainArtifacts": case "freshAgents":
				if (typeof value !== "boolean") return invalid(key, `${key} must be a boolean`);
				contract[field] = value;
				break;
			case "merge":
				if (value !== "auto" && value !== "manual" && value !== false && !(entry === "eval" && value === true)) return invalid(key, "merge must be auto, manual, or false");
				contract.merge = value === true ? "auto" : value;
				break;
			case "timeout": case "budget": case "depth": case "spawns":
				if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || ((field === "depth" || field === "spawns") && !Number.isSafeInteger(value))) return invalid(key, `${key} must be a finite non-negative ${field === "depth" || field === "spawns" ? "integer" : "number"}`);
				contract[field] = value;
				break;
			case "workpoolItems": {
				if (!Array.isArray(value)) return invalid(key, "workpool items must be an array");
				const items: WorkpoolItem[] = [];
				const ids = new Set<string>();
				for (const [index, item] of value.entries()) {
					if (!isRecord(item) || typeof item.id !== "string" || !item.id || typeof item.text !== "string" || Object.keys(item).some(name => name !== "id" && name !== "text") || ids.has(item.id)) return invalid(`${key}.${index}`, "workpool items require unique id and text strings");
					ids.add(item.id);
					items.push({ id: item.id, text: item.text });
				}
				contract.workpoolItems = items;
				break;
			}
			case "target":
				// The target boundary owns validation and authorization; never forward routing as work.
				break;
			case "op":
				if (entry !== "workpool" || value !== "create") return invalid(key, "Only workpool create is a run-contract entry");
				break;
			case "tasks":
				if (entry !== "task" || !Array.isArray(value)) return invalid(key, "tasks must be a task batch");
				for (const item of value) {
					const parsed = distillRunContract(item, "task");
					if ("error" in parsed) return parsed;
				}
				break;
			default:
				return { error: new ParamsError("unknown-parameter", `Unknown parameter ${key}`, key) };
		}
	}
	if (!assigned.has("task") && entry !== "workpool" && !assigned.has("tasks")) return invalid("task", "A task or prompt is required");
	return { contract, local };
}

/** Run at the execution endpoint, never as a caller-side replacement for remote execution. */
export function validateRunOutput(contract: RunContract, data: unknown): ParamsError | undefined {
	if (contract.schemaMode !== "strict" || !Object.hasOwn(contract, "outputSchema")) return undefined;
	const { validator, error } = buildOutputValidator(contract.outputSchema);
	if (error) return new ParamsError("strict-schema-unsatisfied", error, "outputSchema");
	const result = validator?.validate(data);
	if (result && !result.success) {
		const field = result.issues[0]?.path.map(String).join(".") || "outputSchema";
		return new ParamsError("strict-schema-unsatisfied", formatAllValidationIssues(result.issues), field);
	}
	return undefined;
}

export function authorizeHostTools(contract: RunContract, allowedNames: ReadonlySet<string>, nativeNames: ReadonlySet<string> = NATIVE_NAMES): ParamsError | undefined {
	for (const name of contract.tools ?? []) {
		if (nativeNames.has(normalizeToolName(name))) return new ParamsError("host-tool-denied", `Host tool ${name} conflicts with a native tool`, `tools.${name}`);
		if (!allowedNames.has(name)) return new ParamsError("conflict-with-remote-policy", `Remote policy does not grant host tool ${name}`, `tools.${name}`);
	}
	return undefined;
}

export function checkIsolationSupport(contract: RunContract, supported: boolean): ParamsError | undefined {
	if (contract.isolated && !supported) return new ParamsError("isolation-unsupported", "Execution endpoint cannot isolate its workspace", "isolated");
	return undefined;
}

/** The sole callback invocation gate: explicit grants never expose the surrounding kernel. */
export async function authorizeHostToolCall<T>(
	contract: RunContract,
	name: string,
	invoke: () => Promise<T>,
): Promise<T> {
	if (!contract.tools?.includes(name) || NATIVE_NAMES.has(normalizeToolName(name))) {
		throw new ParamsError("host-tool-denied", `Host tool ${name} was not explicitly authorized`, `tools.${name}`);
	}
	return invoke();
}
