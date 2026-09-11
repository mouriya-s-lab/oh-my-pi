/**
 * SSH host resolution for the fork-side backend.
 *
 * The existing SSH capability stays the only host inventory: a resolution
 * performs one capability load, keeps the discovery ordering untouched (the
 * first entry for a name wins) and reports which discovery source answered.
 * A missing user agent directory is a classified failure, never a silent
 * fallback to project-only sources.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getSSHConfigPath, isEnoent } from "@oh-my-pi/pi-utils";
import { loadCapability } from "../../packages/coding-agent/src/capability";
import { type SSHHost, sshCapability } from "../../packages/coding-agent/src/capability/ssh";
// Side-effect import: registers the provider that backs the default host load.
import "../../packages/coding-agent/src/discovery/ssh";
import type { SshBackendErrorCode } from "./errors";

/** Lookup failures, both codes taken from the shared backend taxonomy. */
export type HostLookupErrorCode = Extract<SshBackendErrorCode, "unknown-host" | "no-agent-directory">;

/** Discovery source that answered for a resolved host. */
export type ResolvedSshHostSource = "project" | "user-agent" | "legacy-project";

export interface ResolvedHost {
	/** Canonical host address from the capability entry (never the alias). */
	readonly host: string;
	/** Source the surviving entry came from. */
	readonly source: ResolvedSshHostSource;
	/** The untouched capability record; command building reads username/port/keyPath from it. */
	readonly rawEntry: SSHHost;
}

/**
 * Injectable lookup context, so the factory and tests can supply profile-aware
 * resolution without a second inventory and without touching real SSH config.
 */
export interface ResolveSshHostContext {
	/** Discovery cwd; defaults to the process project directory. */
	readonly cwd?: string;
	/** Inventory loader; defaults to one `loadCapability` call over the SSH capability. */
	readonly loadHosts?: (cwd?: string) => Promise<readonly SSHHost[]>;
	/** User agent directory; `undefined` is a classified failure, not a fallback. */
	readonly getAgentDirectory?: () => Promise<string | undefined>;
}

/** Classified lookup failure; the factory converts it into the shared backend error. */
export class HostLookupError extends Error {
	readonly code: HostLookupErrorCode;
	/** Names the loaded inventory did offer, sorted; populated for `unknown-host`. */
	readonly availableNames: readonly string[];

	constructor(code: HostLookupErrorCode, message: string, availableNames: readonly string[] = []) {
		super(message);
		this.name = "HostLookupError";
		this.code = code;
		this.availableNames = availableNames;
	}
}

async function defaultLoadHosts(cwd?: string): Promise<readonly SSHHost[]> {
	const { items } = await loadCapability<SSHHost>(sshCapability.id, { cwd });
	return items;
}

/**
 * Require the user agent directory to exist as a directory. Discovery reads its
 * absence as "no user-level SSH source"; the backend refuses to resolve hosts
 * against a half-configured profile and reports the missing directory instead.
 */
async function assertAgentDirectory(directory: string | undefined): Promise<void> {
	if (directory === undefined) {
		throw new HostLookupError(
			"no-agent-directory",
			"SSH host lookup needs the user agent directory, but the lookup context provided none",
		);
	}
	let stats: Stats;
	try {
		stats = await fs.stat(directory);
	} catch (err) {
		if (isEnoent(err) || (err instanceof Error && "code" in err && err.code === "ENOTDIR")) {
			throw new HostLookupError(
				"no-agent-directory",
				`User agent directory ${JSON.stringify(directory)} is missing; SSH host lookup does not fall back to project-only sources`,
			);
		}
		throw err;
	}
	if (!stats.isDirectory()) {
		throw new HostLookupError(
			"no-agent-directory",
			`User agent directory ${JSON.stringify(directory)} is not a directory`,
		);
	}
}

/**
 * Name the source of the surviving entry from its capability metadata: a
 * user-level entry comes from the agent directory, the current project
 * `.omp/ssh.json` is `project`, and every older project file (`ssh.json` /
 * `.ssh.json` in the project root) is `legacy-project`.
 */
function classifySource(rawEntry: SSHHost, cwd: string | undefined): ResolvedSshHostSource {
	const { level, path: sourcePath } = rawEntry._source;
	if (level === "user") return "user-agent";
	return path.resolve(sourcePath) === path.resolve(getSSHConfigPath("project", cwd))
		? "project"
		: "legacy-project";
}

/**
 * Resolve `host` against the existing SSH capability.
 *
 * Exactly one inventory load happens per call and the first entry whose name
 * matches wins, so the discovery priority (project `.omp/ssh.json` → user agent
 * directory → legacy project files) stays authoritative.
 */
export async function resolveSshHost(host: string, ctx: ResolveSshHostContext = {}): Promise<ResolvedHost> {
	// Default agent directory is read live, so a profile switch is picked up.
	await assertAgentDirectory(ctx.getAgentDirectory ? await ctx.getAgentDirectory() : getAgentDir());

	const items = await (ctx.loadHosts ?? defaultLoadHosts)(ctx.cwd);
	const rawEntry = items.find(entry => entry.name === host);
	if (rawEntry === undefined) {
		const availableNames = items.map(entry => entry.name).sort();
		throw new HostLookupError(
			"unknown-host",
			`Unknown SSH host ${JSON.stringify(host)}; available SSH hosts: ${availableNames.length > 0 ? availableNames.join(", ") : "(none)"}`,
			availableNames,
		);
	}
	return { host: rawEntry.host, source: classifySource(rawEntry, ctx.cwd), rawEntry };
}
