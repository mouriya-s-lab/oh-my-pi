/**
 * Host-resolution contract for the fork SSH backend (issue #10 row 1).
 *
 * The module under test owns three externally observable promises: discovery
 * keeps its authoritative ordering (one capability load, first entry wins, no
 * second inventory), the resolved record reports which source answered, and a
 * missing user agent directory is a classified failure rather than a fallback
 * to project-only sources.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSSHConfigPath } from "@oh-my-pi/pi-utils";
import * as capabilityModule from "../../../packages/coding-agent/src/capability";
import type { SSHHost } from "../../../packages/coding-agent/src/capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../../packages/coding-agent/src/capability/types";
import { HostLookupError, resolveSshHost, type ResolveSshHostContext } from "../lookup";

/** Fixture project cwd; nothing on disk is touched when the inventory is injected. */
const CWD = "/tmp/omp-issue10-lookup-fixture";
/** Existing directory used wherever a resolution only needs the agent-dir check to pass. */
const EXISTING_DIR = import.meta.dir;

const KNOWN_NAME = "known";
const KNOWN_ADDRESS = "192.0.2.7";

function sourceMeta(level: SourceMeta["level"], sourcePath: string): SourceMeta {
	return { provider: "ssh-json", providerName: "SSH Config", path: sourcePath, level };
}

/** Capability metadata exactly as the discovery provider emits it for each source. */
function discoverySources(cwd: string): Record<"project" | "user" | "legacy", SourceMeta> {
	return {
		project: sourceMeta("project", getSSHConfigPath("project", cwd)),
		user: sourceMeta("user", getSSHConfigPath("user", cwd)),
		legacy: sourceMeta("project", path.join(cwd, "ssh.json")),
	};
}

/** Run a lookup expected to fail and return its classified error for field assertions. */
async function lookupFailure(work: Promise<unknown>): Promise<HostLookupError> {
	const failure = await work.then(
		() => undefined,
		(err: unknown) => err,
	);
	expect(failure).toBeInstanceOf(HostLookupError);
	if (!(failure instanceof HostLookupError)) throw new Error("expected a classified host lookup failure");
	return failure;
}

describe("resolveSshHost", () => {
	it("keeps the capability ordering and tags the source that answered", async () => {
		const { project, user, legacy } = discoverySources(CWD);
		const entries: SSHHost[] = [
			{ name: KNOWN_NAME, host: KNOWN_ADDRESS, username: "agent", port: 2222, _source: project },
			{ name: KNOWN_NAME, host: "10.0.0.1", username: "other", _source: user },
			{ name: KNOWN_NAME, host: "10.0.0.2", _source: legacy },
		];
		const loads: Array<string | undefined> = [];
		const ctx: ResolveSshHostContext = {
			cwd: CWD,
			getAgentDirectory: async () => EXISTING_DIR,
			loadHosts: async cwd => {
				loads.push(cwd);
				return entries;
			},
		};

		const projectWins = await resolveSshHost(KNOWN_NAME, ctx);
		expect(projectWins).toEqual({ host: KNOWN_ADDRESS, source: "project", rawEntry: entries[0] });
		// One inventory read per resolution: no second enumeration, no re-derivation.
		expect(loads).toEqual([CWD]);

		// The same entries in reverse priority must resolve to the reverse winner:
		// ordering stays the capability's, not a source ranking invented here.
		const reversed = await resolveSshHost(KNOWN_NAME, { ...ctx, loadHosts: async () => [...entries].reverse() });
		expect(reversed).toEqual({ host: "10.0.0.2", source: "legacy-project", rawEntry: entries[2] });

		const userOnly = await resolveSshHost(KNOWN_NAME, {
			...ctx,
			loadHosts: async () => [{ name: KNOWN_NAME, host: "10.0.0.1", _source: user }],
		});
		expect(userOnly.source).toBe("user-agent");
	});

	it("loads the capability inventory exactly once through the default loader", async () => {
		const entry: SSHHost = {
			name: KNOWN_NAME,
			host: KNOWN_ADDRESS,
			username: "agent",
			port: 2222,
			_source: discoverySources(CWD).project,
		};
		const result: CapabilityResult<SSHHost> = { items: [entry], all: [entry], warnings: [], providers: ["ssh-json"] };
		const load = spyOn(capabilityModule, "loadCapability").mockResolvedValue(result);
		try {
			const resolved = await resolveSshHost(KNOWN_NAME, {
				cwd: CWD,
				getAgentDirectory: async () => EXISTING_DIR,
			});
			expect(resolved).toEqual({ host: KNOWN_ADDRESS, source: "project", rawEntry: entry });
			expect(load).toHaveBeenCalledTimes(1);
			expect(load).toHaveBeenCalledWith("ssh", { cwd: CWD });
		} finally {
			load.mockRestore();
		}
	});

	it("reports unknown aliases with the sorted names the inventory did offer", async () => {
		const { project, user, legacy } = discoverySources(CWD);
		const entries: SSHHost[] = [
			{ name: "zulu", host: "10.0.0.9", _source: user },
			{ name: KNOWN_NAME, host: KNOWN_ADDRESS, _source: project },
			{ name: "alpha", host: "10.0.0.1", _source: legacy },
		];
		const ctx: ResolveSshHostContext = {
			cwd: CWD,
			getAgentDirectory: async () => EXISTING_DIR,
			loadHosts: async () => entries,
		};

		const failure = await lookupFailure(resolveSshHost("nope", ctx));
		expect(failure.code).toBe("unknown-host");
		expect(failure.availableNames).toEqual(["alpha", KNOWN_NAME, "zulu"]);
		expect(failure.message).toContain('Unknown SSH host "nope"');
		expect(failure.message).toContain("alpha, known, zulu");
	});

	it("refuses to resolve when the user agent directory is missing", async () => {
		let loads = 0;
		const ctx: ResolveSshHostContext = {
			cwd: CWD,
			loadHosts: async () => {
				loads += 1;
				return [];
			},
		};

		// No directory was supplied at all.
		const absent = await lookupFailure(
			resolveSshHost(KNOWN_NAME, { ...ctx, getAgentDirectory: async () => undefined }),
		);
		expect(absent.code).toBe("no-agent-directory");

		// A configured directory that does not exist on disk.
		const missingPath = path.join(os.tmpdir(), "omp-issue10-missing-agent-dir");
		const missing = await lookupFailure(
			resolveSshHost(KNOWN_NAME, { ...ctx, getAgentDirectory: async () => missingPath }),
		);
		expect(missing.code).toBe("no-agent-directory");
		expect(missing.message).toContain(missingPath);

		// Neither failure may fall back to the project-only inventory.
		expect(loads).toBe(0);
	});

	it("resolves a project host through the real capability pipeline", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue10-project-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue10-agent-"));
		const alias = `issue10-project-${path.basename(projectDir)}`;
		try {
			await Bun.write(
				getSSHConfigPath("project", projectDir),
				JSON.stringify({ hosts: { [alias]: { host: "192.0.2.9", username: "agent", port: 2222 } } }),
			);
			const resolved = await resolveSshHost(alias, { cwd: projectDir, getAgentDirectory: async () => agentDir });
			expect(resolved.host).toBe("192.0.2.9");
			expect(resolved.source).toBe("project");
			expect(resolved.rawEntry).toMatchObject({ name: alias, host: "192.0.2.9", username: "agent", port: 2222 });

			const unknown = await lookupFailure(
				resolveSshHost(`${alias}-missing`, { cwd: projectDir, getAgentDirectory: async () => agentDir }),
			);
			expect(unknown.code).toBe("unknown-host");
			// The real discovery pipeline supplied the inventory, so the local alias is listed.
			expect(unknown.availableNames).toContain(alias);
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
