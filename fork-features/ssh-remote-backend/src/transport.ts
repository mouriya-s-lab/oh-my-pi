import { buildRemoteCommand } from "./command";
import { lookupSshHost } from "./lookup";

export interface RemoteRpcTransport {
	/** Complete argv for RpcClient's command builder or custom spawn seam. */
	command: readonly string[];
	notes: { allowStdin: true; managedBootstrap: true; keepMasterOpen: true };
}

export async function createManagedRpcTransport(input: {
	name: string;
	cwd: string;
	executable?: string;
	extraSshArgs?: readonly string[];
}): Promise<RemoteRpcTransport> {
	const lookup = await lookupSshHost(input.name, { cwd: input.cwd });
	if (lookup.kind === "unknown-host") {
		throw new Error(`Unknown SSH host ${JSON.stringify(lookup.name)}; availableNames: ${JSON.stringify(lookup.availableNames)}`);
	}
	const spec = buildRemoteCommand({
		host: lookup.entry,
		cwd: input.cwd,
		executable: input.executable,
		extraSshArgs: input.extraSshArgs,
	});
	return { command: spec.ssh, notes: { allowStdin: true, managedBootstrap: true, keepMasterOpen: true } };
}
