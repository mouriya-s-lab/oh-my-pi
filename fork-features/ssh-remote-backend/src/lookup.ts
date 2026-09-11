import { loadCapability } from "../../../packages/coding-agent/src/capability";
import { type SSHHost, sshCapability } from "../../../packages/coding-agent/src/capability/ssh";
import type { SourceMeta } from "../../../packages/coding-agent/src/capability/types";
import "../../../packages/coding-agent/src/discovery/ssh";

export interface SshBackendHostRecord {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	source: SourceMeta;
}

export type LookupResult =
	| { kind: "found"; entry: SshBackendHostRecord }
	| { kind: "unknown-host"; name: string; availableNames: readonly string[] };

export async function lookupSshHost(name: string, opts?: { cwd?: string }): Promise<LookupResult> {
	const { items } = await loadCapability<SSHHost>(sshCapability.id, { cwd: opts?.cwd });
	const host = items.find(entry => entry.name === name);
	if (!host) return { kind: "unknown-host", name, availableNames: items.map(entry => entry.name).sort() };
	return {
		kind: "found",
		entry: {
			name: host.name,
			host: host.host,
			username: host.username,
			port: host.port,
			keyPath: host.keyPath,
			source: host._source,
		},
	};
}
