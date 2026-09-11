import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as capabilityModule from "../../../packages/coding-agent/src/capability";
import type { SSHHost } from "../../../packages/coding-agent/src/capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../../packages/coding-agent/src/capability/types";
import { createManagedRpcTransport, lookupSshHost } from "../src";

const source: SourceMeta = { provider: "ssh-json", providerName: "SSH Config", path: "/fixture/ssh.json", level: "project" };
const known: SSHHost = { name: "known", host: "192.0.2.7", username: "agent", port: 2222, _source: source };
afterEach(() => mock.restore());
function seed(items: SSHHost[]): void {
	const result: CapabilityResult<SSHHost> = { items, all: items, warnings: [], providers: ["ssh-json"] };
	spyOn(capabilityModule, "loadCapability").mockResolvedValue(result);
}

describe("SSH backend host lookup", () => {
	it("resolves a known alias with its canonical source record", async () => {
		seed([known]);
		expect(await lookupSshHost("known")).toEqual({
			kind: "found", entry: { name: "known", host: "192.0.2.7", username: "agent", port: 2222, keyPath: undefined, source },
		});
	});

	it("reports unknown aliases with sorted available names", async () => {
		seed([known]);
		expect(await lookupSshHost("nope")).toEqual({ kind: "unknown-host", name: "nope", availableNames: ["known"] });
		seed([{ ...known, name: "zulu" }, known, { ...known, name: "alpha" }]);
		expect(await lookupSshHost("nope")).toEqual({ kind: "unknown-host", name: "nope", availableNames: ["alpha", "known", "zulu"] });
		await expect(createManagedRpcTransport({ name: "nope", cwd: "/fixture" })).rejects.toThrow(/nope.*availableNames.*alpha.*known.*zulu/);
	});
});
