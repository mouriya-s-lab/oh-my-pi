import { normalizeProfileName } from "@oh-my-pi/pi-utils/dirs";
import { ensureSshControlDir } from "../../packages/coding-agent/src/ssh/connection-manager";
import type { EndpointFactory } from "../../packages/coding-agent/src/task/dispatch";
import type { PrepareResult } from "../../packages/coding-agent/src/task/endpoint";
import type { ExecutionTarget } from "../../packages/coding-agent/src/task/target";
import { buildSshBackendCommand } from "./command";
import { SshBackendEndpoint } from "./endpoint";
import { SshBackendError } from "./errors";
import { probeRemoteExecutable, type RunSshCommand } from "./executable-probe";
import { HostLookupError, resolveSshHost, type ResolveSshHostContext } from "./lookup";
import { openSshBackendTransport } from "./transport";

export type SshExecutionTarget = Extract<ExecutionTarget, { kind: "ssh" }>;

export interface SshBackendPrepareParams {
	/** The starting role is resolved on the remote peer, never from local agent discovery. */
	readonly agent?: string;
}

export interface SshBackendFactoryDeps {
	/** Local capability discovery context; never populated from the remote target's cwd/profile. */
	readonly lookup?: ResolveSshHostContext;
	readonly openTransport?: typeof openSshBackendTransport;
	readonly runSshCommand?: RunSshCommand;
}

export interface SshBackendFactory {
	prepare(target: SshExecutionTarget, params?: SshBackendPrepareParams): Promise<SshBackendEndpoint>;
}

const runSshCommand: RunSshCommand = async (ssh, remote) => {
	ensureSshControlDir();
	const child = Bun.spawn([...ssh, ...remote], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode === 255) {
		throw new SshBackendError("connection-failed", `SSH executable probe could not connect: ${stderr.trim()}`);
	}
	return { exitCode, stdout, stderr };
};

/**
 * The public EndpointFactory callback is the current registration seam. OpenSSH
 * owns the shared control socket: each transport owns only its SSH child, so a
 * peer release never invokes the connection manager's master teardown methods.
 */
export function createSshBackendFactory(deps: SshBackendFactoryDeps = {}): SshBackendFactory {
	return {
		async prepare(target, params = {}) {
			try {
				const resolved = await resolveSshHost(target.host, deps.lookup);
				const executable = target.executable ?? "omp";
				const probedExecutable = await probeRemoteExecutable(resolved, executable, {
					runSshCommand: deps.runSshCommand ?? runSshCommand,
				});
				if (probedExecutable.kind === "path-probe-miss" || probedExecutable.path === undefined) {
					throw new SshBackendError("executable-missing", `Remote executable ${JSON.stringify(executable)} was not found on ${JSON.stringify(resolved.host)}`);
				}
				const command = buildSshBackendCommand({
					resolved,
					cwd: target.cwd,
					executable: probedExecutable.path,
					profile: target.profile,
					agent: params.agent,
				});
				const transport = await (deps.openTransport ?? openSshBackendTransport)(command, {
					probedExecutable,
					prepare: { cwd: target.cwd, profile: target.profile, agent: params.agent },
				});
				try {
					const applied = transport.client.getPreparedContext();
					const capabilities = transport.client.getNativeAgentCapabilities();
					// The peer may canonicalize symlinks; resolving that path locally
					// would incorrectly apply this machine's filesystem to a remote cwd.
					if (!applied?.cwd?.trim() || !applied.agent?.trim() || capabilities === undefined) {
						throw new SshBackendError("protocol-incompatible", "Remote prepare did not acknowledge its working directory, effective role and capabilities");
					}
					if (target.profile !== undefined && normalizeProfileName(applied.profile) !== normalizeProfileName(target.profile)) {
						throw new SshBackendError("protocol-incompatible", "Remote prepare did not acknowledge the requested profile");
					}
					const prepared: PrepareResult = {
						role: { agent: applied.agent, source: "remote" },
						capabilities: Object.entries(capabilities).filter(([, enabled]) => enabled === 1).map(([name]) => name),
					};
					return new SshBackendEndpoint(transport, prepared, `ssh:${resolved.rawEntry.name}:${crypto.randomUUID()}`);
				} catch (error) {
					await transport.close();
					throw error;
				}
			} catch (error) {
				if (error instanceof SshBackendError) throw error;
				if (error instanceof HostLookupError) throw new SshBackendError(error.code, error.message, { cause: error });
				throw new SshBackendError("connection-failed", error instanceof Error ? error.message : String(error), { cause: error });
			}
		},
	};
}

/** Direct public factory; task/workpool execution migration is a separate core-owned change. */
export async function createSshBackendEndpoint(
	target: SshExecutionTarget,
	params?: SshBackendPrepareParams,
	deps?: SshBackendFactoryDeps,
): Promise<SshBackendEndpoint> {
	return createSshBackendFactory(deps).prepare(target, params);
}

export const sshEndpointFactory: EndpointFactory = target => {
	if (target.kind !== "ssh") throw new Error("sshEndpointFactory only handles ssh targets");
	return createSshBackendEndpoint(target);
};
