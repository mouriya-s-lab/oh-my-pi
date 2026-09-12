import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import type { RunAck, RunOpts, RunOutcome } from "../../src/task/endpoint";
import { LocalAgentEndpoint } from "../../src/task/endpoint/local";
import {
	authorizeHostTools,
	checkIsolationSupport,
	type ParamsError,
	type RunContract,
	validateRunOutput,
} from "../../src/task/params";
import { FakeRemoteEndpoint } from "./endpoint-fake";

export interface DirectoryFingerprint {
	path: string;
	kind: "directory" | "file" | "symlink";
	checksum?: string;
}

/** Real files make a failed isolation preflight observable beyond a call counter. */
export class FakeRemoteVcs {
	writes = 0;

	constructor(
		readonly cwd: string,
		readonly isolationSupported: boolean,
	) {}

	static async create(isolationSupported: boolean): Promise<FakeRemoteVcs> {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-params-remote-"));
		await Bun.write(path.join(cwd, "tracked.txt"), "original remote worktree\n");
		await Bun.write(path.join(cwd, "nested", "untracked.txt"), "untracked remote content\n");
		return new FakeRemoteVcs(cwd, isolationSupported);
	}

	async writeResult(): Promise<void> {
		this.writes++;
		await Bun.write(path.join(this.cwd, "tracked.txt"), "changed by remote executor\n");
		await Bun.write(path.join(this.cwd, "result.txt"), "remote artifact\n");
	}

	async fingerprint(): Promise<DirectoryFingerprint[]> {
		const result: DirectoryFingerprint[] = [];
		const visit = async (relative: string): Promise<void> => {
			const entries = await fs.readdir(path.join(this.cwd, relative), { withFileTypes: true });
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				const name = path.join(relative, entry.name);
				const absolute = path.join(this.cwd, name);
				if (entry.isDirectory()) {
					result.push({ path: name, kind: "directory" });
					await visit(name);
				} else if (entry.isSymbolicLink()) {
					result.push({ path: name, kind: "symlink", checksum: await fs.readlink(absolute) });
				} else {
					const bytes = await Bun.file(absolute).arrayBuffer();
					result.push({ path: name, kind: "file", checksum: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
				}
			}
		};
		await visit("");
		return result;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await fs.rm(this.cwd, { recursive: true, force: true });
	}
}

export interface FakeExecutionOptions {
	output?: unknown;
	allowedTools?: ReadonlySet<string>;
	nativeTools?: ReadonlySet<string>;
	vcs?: FakeRemoteVcs;
	execute?: (contract: RunContract) => Promise<unknown>;
}

/** Only execution is faked; contract failures come from production domain guards. */
export async function executeFakeRun(
	runId: string,
	contract: RunContract,
	options: FakeExecutionOptions,
): Promise<RunOutcome> {
	const failure =
		authorizeHostTools(contract, options.allowedTools ?? new Set(), options.nativeTools) ??
		checkIsolationSupport(contract, options.vcs?.isolationSupported ?? true);
	if (failure) return paramsFailure(runId, failure);
	if (options.vcs) await options.vcs.writeResult();
	const data = options.execute ? await options.execute(contract) : options.output;
	const outputFailure = validateRunOutput(contract, data);
	if (outputFailure) return paramsFailure(runId, outputFailure);
	return { status: "completed", runId, text: JSON.stringify(data) ?? "" };
}

function paramsFailure(runId: string, paramsError: ParamsError): RunOutcome {
	return { status: "failed", runId, error: paramsError.message, paramsError };
}

export interface FakeExecutionReceipt {
	runId: string;
	endpoint: FakeRemoteExecutor;
	contract: RunContract;
	outcome: RunOutcome;
}

export class FakeRemoteExecutor extends FakeRemoteEndpoint {
	readonly receipts: FakeExecutionReceipt[] = [];
	readonly #contracts = new Map<string, RunContract>();

	constructor(readonly execution: FakeExecutionOptions = {}) {
		super();
	}

	override async start(assignment: string, opts?: RunOpts): Promise<RunAck> {
		const ack = await super.start(assignment);
		this.#contracts.set(ack.runId, opts?.contract ?? { task: assignment });
		return ack;
	}

	override async run(runId: string): Promise<RunOutcome> {
		const contract = this.#contracts.get(runId);
		if (!contract) throw new Error(`No contract for ${runId}`);
		const outcome = await executeFakeRun(runId, contract, this.execution);
		this.receipts.push({ runId, endpoint: this, contract, outcome });
		this.completeRun(outcome);
		this.emitReplyDrained(runId);
		return super.run(runId);
	}
}

export function localExecutor(contract: RunContract, options: FakeExecutionOptions): LocalAgentEndpoint {
	return new LocalAgentEndpoint({
		session: {} as AgentSession,
		agent: "fixture-local",
		bus: new IrcBus(new AgentRegistry()),
		awaitTerminal: async () => {
			const { runId: _runId, ...terminal } = await executeFakeRun("local-fixture", contract, options);
			if (terminal.status === "execution-unknown") throw new Error("Local execution cannot be unknown");
			return terminal;
		},
		cancelRun: async () => {},
		terminate: async () => {},
	});
}
