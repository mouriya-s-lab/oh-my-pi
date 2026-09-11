/**
 * Issue #10 row 4: peer release is scoped to the peer.
 *
 * Two transports are opened *through the factory* against the same resolved
 * host, so both local SSH children carry the same isolated ControlPath and the
 * second one must ride the mux master the first one established. The row proves
 * that with a real `ssh -O check` against that socket: the master pid is
 * observed before the first release and must be the *same* pid after it, after
 * the second release, and until the fixture explicitly exits it. Between those
 * observations the surviving peer keeps answering `get_state`, `abort` and
 * `pwd` — the release of one peer is a property of that peer's own SSH child,
 * never of the shared master or of the other peer's session.
 *
 * The shared production ControlMaster path is sampled before and after the whole
 * scenario and must be untouched: every socket operation in this file names the
 * fixture's own `-O`/ControlPath, so no business connection can be affected.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { SshBackendCommand } from "../command";
import {
	createSshBackendEndpoint,
	type SshBackendFactoryDeps,
	type SshExecutionTarget,
} from "../factory";
import { sshOptionValues, startFactorySshFixture, withinMs, type FactorySshFixture } from "./support/factory-fixture";
import { sshdBinaryPresent } from "./support/loopback-sshd";

// Never skip: the row exists to produce real mux evidence, and a missing daemon
// (or a daemon that cannot bind) must surface as a failure.
if (!(await sshdBinaryPresent())) {
	throw new Error("ABORT transport release integration: no local sshd; real SSH evidence cannot be collected");
}

const AGENT = "task";

describe("factory-opened transports share one real control master (issue #10 row 4)", () => {
	let fixture: FactorySshFixture | undefined;

	function active(): FactorySshFixture {
		if (!fixture) throw new Error("fixture was not started");
		return fixture;
	}

	function depsFor(current: FactorySshFixture, commands: SshBackendCommand[]): SshBackendFactoryDeps {
		return {
			lookup: current.lookupContext(),
			openTransport(command, options) {
				// Record the exact argv the production transport receives: the same
				// pure prefix transform `openTransport` applies, no second injection.
				commands.push(current.prefixCommand(command));
				return current.openTransport(command, options);
			},
			runSshCommand: current.runSshCommand,
		};
	}

	beforeAll(async () => {
		fixture = await startFactorySshFixture({ logLabel: "factory-row4" });
		console.log(`Row4 fixture setup: ${JSON.stringify(active().describeSetup(), null, 2)}`);
	}, 30_000);

	afterAll(async () => {
		// Peers are already released by the row itself; this only reaps the owned
		// master (idempotent) and the isolated daemon.
		await fixture?.stop();
	});

	it("releasing the first peer leaves the master and the second peer intact", async () => {
		const current = active();
		const commands: SshBackendCommand[] = [];
		const deps = depsFor(current, commands);
		const target: SshExecutionTarget = {
			kind: "ssh",
			host: current.alias,
			cwd: current.targetCwd,
			executable: current.wrapperPath,
		};
		const productionBefore = await current.productionControlSnapshot();
		const first = await createSshBackendEndpoint(target, { agent: AGENT }, deps);
		try {
			const second = await createSshBackendEndpoint(target, { agent: AGENT }, deps);
			try {
				// Both launches resolved the same host through the same isolated mux.
				expect(commands).toHaveLength(2);
				expect(commands[1].ssh).toEqual(commands[0].ssh);
				expect(commands[1].remote).toEqual(commands[0].remote);
				expect(sshOptionValues(commands[0].ssh, "ControlPath")[0]).toBe(current.controlPath);
				expect(sshOptionValues(commands[0].ssh, "ControlPath")[0]).not.toBe(current.productionControlPath);
				expect(commands[0].remote).toEqual([current.wrapperPath, "--mode", "rpc", "--rpc-subagent"]);

				const masterBefore = await current.masterStatus();
				expect(masterBefore.running).toBe(true);
				expect(masterBefore.pid).toBeNumber();

				// Both peers are live on that one master before any release.
				const firstState = await withinMs(first.transport.client.getState(), 15_000, "first get_state");
				const secondState = await withinMs(second.transport.client.getState(), 15_000, "second get_state");
				expect(firstState.sessionId).toBeString();
				expect(secondState.sessionId).toBeString();
				expect(secondState.sessionId).not.toBe(firstState.sessionId);
				await withinMs(first.transport.client.abort(), 15_000, "first abort");
				await withinMs(second.transport.client.abort(), 15_000, "second abort");
				for (const [label, endpoint] of [
					["first", first],
					["second", second],
				] as const) {
					const pwd = await withinMs(endpoint.transport.client.bash("pwd"), 15_000, `${label} pwd`);
					expect(pwd.output.trim()).toBe(current.targetCwd);
				}

				// Release peer one through stdin EOF; its own SSH child exits 0.
				const firstExit = await withinMs(first.transport.endInput(), 30_000, "first stdin EOF");
				expect(firstExit).toBe(0);
				expect(await withinMs(first.transport.exited, 10_000, "first SSH child exit")).toBe(0);
				const masterAfterRelease = await current.masterStatus();
				expect(masterAfterRelease.running).toBe(true);
				expect(masterAfterRelease.pid).toBe(masterBefore.pid);

				// The surviving peer still rides the same master.
				const survivorState = await withinMs(second.transport.client.getState(), 15_000, "survivor get_state");
				expect(survivorState.sessionId).toBe(secondState.sessionId);
				await withinMs(second.transport.client.abort(), 15_000, "survivor abort");
				const survivorPwd = await withinMs(second.transport.client.bash("pwd"), 15_000, "survivor pwd");
				expect(survivorPwd.output.trim()).toBe(current.targetCwd);
				expect(await current.masterStatus()).toMatchObject({ running: true, pid: masterBefore.pid });

				// Release peer two; the master outlives every client (ControlPersist).
				expect(await withinMs(second.transport.endInput(), 30_000, "second stdin EOF")).toBe(0);
				const masterAfterAllPeers = await current.masterStatus();
				expect(masterAfterAllPeers.running).toBe(true);
				expect(masterAfterAllPeers.pid).toBe(masterBefore.pid);

				// Explicit isolated cleanup: only the fixture's own socket is exited.
				const exited = await current.exitMaster();
				expect(exited.exitCode).toBe(0);
				const masterGone = await current.masterStatus();
				expect(masterGone.running).toBe(false);
				expect(await current.productionControlSnapshot()).toEqual(productionBefore);

				// A socket is not a regular file, so existence uses async fs.stat, never Bun.file.
				let socketLingersAfterExit = true;
				try {
					await fs.stat(current.controlPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") socketLingersAfterExit = false;
					else throw error;
				}
				const productionControlAfter = await current.productionControlSnapshot();
				console.log(
					`Row4 shared-master proof: ${JSON.stringify(
						{
							sshArgv: commands[0].ssh,
							remoteArgv: commands[0].remote,
							controlPath: current.controlPath,
							productionControlPath: current.productionControlPath,
							masterPid: masterBefore.pid,
							pidAfterFirstRelease: masterAfterRelease.pid,
							pidAfterAllPeersReleased: masterAfterAllPeers.pid,
							masterCheckBefore: masterBefore.stderr,
							masterCheckAfterAllPeers: masterAfterAllPeers.stderr,
							sessionIds: { first: firstState.sessionId, second: secondState.sessionId },
							firstExit,
							masterExit: { exitCode: exited.exitCode, stderr: exited.stderr },
							masterCheckAfterExit: masterGone.stderr,
							socketLingersAfterExit,
							productionControlBefore: productionBefore,
							productionControlAfter,
						},
						null,
						2,
					)}`,
				);
			} finally {
				await second.transport.close();
			}
		} finally {
			await first.transport.close();
		}
	}, 120_000);
});
