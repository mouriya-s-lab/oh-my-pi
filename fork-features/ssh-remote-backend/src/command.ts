import * as path from "node:path";
import { buildCommonArgs } from "../../../packages/coding-agent/src/ssh/connection-manager";
import { buildSshTarget, quotePosixPath } from "../../../packages/coding-agent/src/ssh/utils";
import type { SshBackendHostRecord } from "./lookup";

export interface RemoteCommandSpec {
	/** Complete local SSH argv; pass as a command builder, not an RpcClient prefix. */
	ssh: readonly string[];
	/** Fixed remote argv: no task text or caller-supplied shell fragments. */
	remote: readonly string[];
	/** The launcher must keep stdin open for RPC frames. */
	allowStdin: true;
}

export function buildRemoteCommand(input: {
	host: SshBackendHostRecord;
	cwd: string;
	executable?: string;
	extraSshArgs?: readonly string[];
}): RemoteCommandSpec {
	const executable = input.executable ?? "omp";
	if (!executable || /[\s;&|<>()`$\\"'*?[\]{}!#~\0]/.test(executable)) {
		throw new Error("Remote executable must be a single path without shell-metachar characters");
	}
	if (!path.posix.isAbsolute(input.cwd) || input.cwd.includes("\0")) {
		throw new Error("Remote cwd must be an absolute POSIX path without NUL");
	}
	if (input.extraSshArgs?.includes("-n")) throw new Error("SSH -n would close the managed RPC stdin");
	const remote = [executable, "--mode", "rpc", "--rpc-subagent"];
	return {
		ssh: [
			"ssh",
			// OpenSSH uses the first option value: explicit isolation/pinning overrides helper defaults.
			...(input.extraSshArgs ?? []),
			"-o", "StrictHostKeyChecking=yes",
			...buildCommonArgs(input.host, { allowStdin: true }),
			buildSshTarget(input.host.username, input.host.host),
			`cd ${quotePosixPath(input.cwd)} && exec ${remote.map(quotePosixPath).join(" ")}`,
		],
		remote,
		allowStdin: true,
	};
}
