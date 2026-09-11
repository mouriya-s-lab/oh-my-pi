/**
 * Issue #10 row 3: the root factory opens a real managed RPC peer.
 *
 * Every assertion here runs against real OpenSSH (the isolated loopback daemon
 * from the shared fixture), the real `ssh` binary, and the real in-repo CLI
 * launched by the production transport — nothing is mocked and nothing is
 * skipped. What this file proves, in order:
 *
 * 1. `createSshBackendEndpoint` resolves the host through the production lookup
 *    context, probes the absolute executable, and builds an argv that pins the
 *    host key strictly while the fixture's isolation only ever occupies the
 *    first (winning) OpenSSH option slots.
 * 2. The peer's own prepare acknowledgement and ready declaration are what the
 *    factory validates: applied cwd is the target cwd and never the fixture
 *    HOME, the applied role is the requested one, and the capability set is the
 *    peer's full major-1 set.
 * 3. Live control works on the same wire: typed `get_state`, `abort`, and a
 *    remote `pwd` whose logical output is the target cwd (the wrapper never
 *    `cd`s) and whose physical output is the same directory.
 * 4. The concrete AgentEndpoint surface the factory returns is exercised with a
 *    control-only, model-free lifecycle: `/session info` is a local builtin, so
 *    the run completes without any provider request while the run id minted by
 *    the peer stays identical across the ACK, the endpoint event stream, the
 *    endpoint snapshots and the client's managed state.
 * 5. Closing stdin ends the real SSH child with exit code 0.
 * 6. A PATH-probe miss is the classified `executable-missing` failure, raised
 *    before any transport is opened.
 * 7. A named profile is activated before the peer's eager `.env` load: the
 *    requested profile's sentinel reaches a remote bash command, the default
 *    config root's sentinel never does, and the profile travels only in the
 *    prepare frame while cwd still arrives through it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";
import type { SshBackendCommand } from "../command";
import { SshBackendError } from "../errors";
import {
	createSshBackendEndpoint,
	type SshBackendFactoryDeps,
	type SshExecutionTarget,
} from "../factory";
import { MANAGED_NATIVE_AGENT_CAPABILITIES, type RpcManagedRunEvent } from "../../../packages/coding-agent/src/modes/rpc/rpc-types";
import type { EndpointEvent } from "../../../packages/coding-agent/src/task/endpoint";
import { sshFlagValues, sshOptionValues, startFactorySshFixture, withinMs, type FactorySshFixture } from "./support/factory-fixture";
import { sshdBinaryPresent } from "./support/loopback-sshd";

// A missing daemon fails the file instead of skipping it: these rows exist to
// produce real-SSH evidence, and a silent skip would report the opposite.
if (!(await sshdBinaryPresent())) {
	throw new Error("ABORT factory integration: no local sshd; real SSH evidence cannot be collected");
}

/** Bundled agent definition, resolved on the peer from its own discovery. */
const AGENT = "task";
/** Locally consumed builtin: completes the managed run without a provider request. */
const SESSION_INFO_COMMAND = "/session info";
/**
 * Named profile for the profile-order row. The fixture HOME carries two dotenv
 * sentinels — one in the default config root, one in this profile's root — so
 * the value a remote bash command observes identifies which root the peer's
 * eager `.env` load read. Both values are inert test data, never secrets.
 */
const PROFILE = "issue10-row3";
const PROFILE_SENTINEL = "OMP_ISSUE10_PROFILE_SENTINEL";
const DEFAULT_ROOT_SENTINEL = "issue10-default-root";
const NAMED_PROFILE_SENTINEL = "issue10-named-profile";

async function nextEvent(iterator: AsyncIterator<EndpointEvent>, label: string): Promise<EndpointEvent> {
	const next = await withinMs(iterator.next(), 15_000, label);
	if (next.done || next.value === undefined) throw new Error(`${label} ended the endpoint subscription early`);
	return next.value;
}

describe("factory-opened managed SSH endpoint (issue #10 row 3)", () => {
	let fixture: FactorySshFixture | undefined;

	function active(): FactorySshFixture {
		if (!fixture) throw new Error("fixture was not started");
		return fixture;
	}

	function targetFor(executable: string): SshExecutionTarget {
		const current = active();
		return { kind: "ssh", host: current.alias, cwd: current.targetCwd, executable };
	}

	/** Production deps plus a recorder; the isolation stays inside openTransport. */
	function depsFor(commands: SshBackendCommand[], probes: string[] = []): SshBackendFactoryDeps {
		const current = active();
		return {
			lookup: current.lookupContext(),
			openTransport(command, options) {
				// Record the exact argv the production transport receives: the same
				// pure prefix transform `openTransport` applies, no second injection.
				commands.push(current.prefixCommand(command));
				return current.openTransport(command, options);
			},
			async runSshCommand(ssh, remote) {
				probes.push(remote.join(" "));
				return await current.runSshCommand(ssh, remote);
			},
		};
	}

	beforeAll(async () => {
		fixture = await startFactorySshFixture({ logLabel: "factory-row3" });
		console.log(`Row3 fixture setup: ${JSON.stringify(active().describeSetup(), null, 2)}`);
	}, 30_000);

	afterAll(async () => {
		await fixture?.stop();
	});

	it("prepare launches the real peer, pins the host key, and acknowledges cwd, role and capabilities", async () => {
		const current = active();
		const commands: SshBackendCommand[] = [];
		const endpoint = await createSshBackendEndpoint(targetFor(current.wrapperPath), { agent: AGENT }, depsFor(commands));
		try {
			expect(commands).toHaveLength(1);
			const command = commands[0];
			// The remote argv is exactly the fixed managed launch; cwd/profile/agent
			// travel in the prepare frame, never in argv.
			expect(command.remote).toEqual([current.wrapperPath, "--mode", "rpc", "--rpc-subagent"]);
			expect(command.executableResolutionPolicy).toBe("absolute");
			expect(command.allowStdin).toBe(true);
			// Fixture isolation occupies the first (OpenSSH first-value-wins) slots.
			expect(command.ssh[0]).toBe("ssh");
			expect(command.ssh[1]).toBe("-F");
			expect(command.ssh[2]).toBe("/dev/null");
			expect(sshOptionValues(command.ssh, "StrictHostKeyChecking")[0]).toBe("yes");
			expect(sshOptionValues(command.ssh, "UserKnownHostsFile")).toContain(current.knownHostsPath);
			expect(sshOptionValues(command.ssh, "GlobalKnownHostsFile")[0]).toBe("/dev/null");
			expect(sshOptionValues(command.ssh, "IdentitiesOnly")[0]).toBe("yes");
			// A shared production ControlMaster is never addressed by this row: the
			// fixture path wins the first-value comparison.
			expect(sshOptionValues(command.ssh, "ControlPath")[0]).toBe(current.controlPath);
			expect(sshOptionValues(command.ssh, "ControlPath")[0]).not.toBe(current.productionControlPath);
			// Identity and port come from the discovered host record (production path).
			expect(sshFlagValues(command.ssh, "-i")).toEqual([current.clientKeyPath]);
			expect(sshFlagValues(command.ssh, "-p")).toEqual([String(current.port)]);
			expect(command.ssh.at(-1)).toBe(`${current.hostUsername}@${current.host}`);

			const client = endpoint.transport.client;
			const applied = client.getPreparedContext();
			expect(applied?.cwd).toBe(current.targetCwd);
			expect(applied?.agent).toBe(AGENT);
			expect(client.getNativeAgentCapabilities()).toEqual(MANAGED_NATIVE_AGENT_CAPABILITIES);
			const lifecycle = client.getManagedLifecycle();
			expect(lifecycle.status).toBe("active");
			if (lifecycle.status !== "active") throw new Error(`managed lifecycle is ${lifecycle.status}`);
			expect(lifecycle.heartbeatSeconds).toBeGreaterThan(0);
			expect(lifecycle.leaseSeconds).toBeGreaterThan(0);

			const prepared = await endpoint.prepare();
			expect(prepared.role).toEqual({ agent: AGENT, source: "remote" });
			expect(prepared.capabilities).toContain("sessionControl");
			// #11: capability flipped to 1.
			expect(prepared.capabilities).toContain("ircBidirectional");

			// Live control on the same connection: typed state, then a real abort.
			const state = await withinMs(client.getState(), 15_000, "get_state");
			expect(state.sessionId).toBeString();
			expect(state.isStreaming).toBe(false);
			expect(state.managedRuns).toBeArray();
			// The client resolves `abort()` only on a success response for that
			// command (a refusal rejects), so completing this await is its success.
			await withinMs(client.abort(), 15_000, "abort");

			// The wrapper never `cd`s: this directory can only come from prepare.
			const pwd = await withinMs(client.bash("pwd"), 15_000, "remote pwd");
			expect(pwd.exitCode).toBe(0);
			expect(pwd.output.trim()).toBe(current.targetCwd);
			expect(pwd.output.trim()).not.toBe(current.home);
			const physical = await withinMs(client.bash("pwd -P"), 15_000, "remote pwd -P");
			expect(physical.output.trim()).toBe(await fs.realpath(current.targetCwd));
			expect(await fs.realpath(current.home)).not.toBe(await fs.realpath(current.targetCwd));

			console.log(
				`Row3 factory proof: ${JSON.stringify(
					{
						sshArgv: command.ssh,
						remoteArgv: command.remote,
						probedExecutable: endpoint.transport.probedExecutable,
						applied,
						lifecycle,
						state: { sessionId: state.sessionId, isStreaming: state.isStreaming, managedRuns: state.managedRuns },
						pwd: pwd.output.trim(),
						pwdPhysical: physical.output.trim(),
						targetCwd: current.targetCwd,
						home: current.home,
						strictOptions: sshOptionValues(command.ssh, "StrictHostKeyChecking"),
					},
					null,
					2,
				)}`,
			);
		} finally {
			await endpoint.transport.close();
		}
	}, 60_000);

	it("a named profile is selected before the peer's eager .env load", async () => {
		const current = active();
		// The peer resolves a named profile's config root from its own HOME, exactly
		// as `getProfileRootDir` does after `setProfile`: <home>/<config dir>/profiles/<name>.
		// `getProfileRootDir` cannot answer here — it resolves against the operator's
		// HOME — so the fixture HOME is paired with CONFIG_DIR_NAME, the constant
		// `getProfileConfigRoot` itself builds on, instead of guessing a user path.
		const configRoot = path.join(current.home, CONFIG_DIR_NAME);
		const profileRoot = path.join(configRoot, "profiles", PROFILE);
		// A `.env` load that ran before profile selection reads the default root's
		// value; the correct bootstrap order reads the profile root's. The values are
		// inert markers, and both files live under the fixture root.
		await Bun.write(path.join(configRoot, ".env"), `${PROFILE_SENTINEL}=${DEFAULT_ROOT_SENTINEL}\n`);
		await Bun.write(path.join(profileRoot, ".env"), `${PROFILE_SENTINEL}=${NAMED_PROFILE_SENTINEL}\n`);

		const commands: SshBackendCommand[] = [];
		const endpoint = await createSshBackendEndpoint(
			{ kind: "ssh", host: current.alias, cwd: current.targetCwd, executable: current.wrapperPath, profile: PROFILE },
			{ agent: AGENT },
			depsFor(commands),
		);
		try {
			expect(commands).toHaveLength(1);
			const command = commands[0];
			// The profile is session configuration: it travels in the prepare frame, so
			// the remote argv stays the fixed managed launch with no profile flag.
			expect(command.remote).toEqual([current.wrapperPath, "--mode", "rpc", "--rpc-subagent"]);
			const applied = endpoint.transport.client.getPreparedContext();
			expect(applied?.profile).toBe(PROFILE);
			// cwd arrives through the same prepare frame, independently of the profile.
			expect(applied?.cwd).toBe(current.targetCwd);

			// The peer's own bash child observes the environment its eager `.env` load
			// produced, so the sentinel identifies the config root that load read.
			const probe = await withinMs(
				endpoint.transport.client.bash(`printf 'sentinel=%s\\n' "$(printenv ${PROFILE_SENTINEL})" && pwd`),
				15_000,
				"named-profile sentinel",
			);
			expect(probe.exitCode).toBe(0);
			const [sentinelLine, cwdLine] = probe.output.trim().split("\n");
			expect(sentinelLine).toBe(`sentinel=${NAMED_PROFILE_SENTINEL}`);
			expect(sentinelLine).not.toContain(DEFAULT_ROOT_SENTINEL);
			expect(cwdLine).toBe(current.targetCwd);

			console.log(
				`Row3 named profile: ${JSON.stringify(
					{
						profile: applied?.profile,
						configRoot,
						profileRoot,
						remoteArgv: command.remote,
						sentinel: sentinelLine,
						cwd: cwdLine,
					},
					null,
					2,
				)}`,
			);
		} finally {
			await endpoint.transport.close();
		}
	}, 60_000);

	it("endpoint surface: model-free run lifecycle with one peer-minted run id across wire, events and snapshots", async () => {
		const current = active();
		const commands: SshBackendCommand[] = [];
		const endpoint = await createSshBackendEndpoint(targetFor(current.wrapperPath), { agent: AGENT }, depsFor(commands));
		const wireRuns: RpcManagedRunEvent[] = [];
		const unsubscribe = endpoint.transport.client.onManagedRunEvent(event => wireRuns.push(event));
		const iterator = endpoint.subscribe()[Symbol.asyncIterator]();
		try {
			const baseline = await endpoint.snapshot();
			expect(baseline.snapshot.status).toBe("idle");
			expect(baseline.snapshot.runId).toBeNull();
			const opening = await nextEvent(iterator, "endpoint baseline");
			expect(opening.type).toBe("snapshot");

			const ack = await withinMs(endpoint.start(SESSION_INFO_COMMAND), 15_000, "endpoint start");
			expect(ack.runId).toBeString();
			const outcome = await withinMs(endpoint.run(ack.runId), 30_000, "endpoint run");
			expect(outcome.runId).toBe(ack.runId);
			expect(outcome.status).toBe("completed");
			// #11 reports the independent reply barrier's revision and confirmed outbound watermark.
			const drained = await withinMs(endpoint.waitReplyDrained(ack.runId), 15_000, "reply drain");
			expect(drained.status).toBe("drained");
			if (drained.status !== "drained") throw new Error("Reply drain was interrupted");
			expect(typeof drained.runStatusRevision).toBe("number");
			expect(typeof drained.outboundWatermark).toBe("number");

			// The endpoint's own stream must carry the same identity the ACK minted.
			const seen: EndpointEvent[] = [];
			for (let index = 0; index < 16; index += 1) {
				const event = await nextEvent(iterator, `endpoint event ${index}`);
				seen.push(event);
				if (event.type === "run_outcome") break;
			}
			const ackEvent = seen.find(event => event.type === "run_ack");
			expect(ackEvent?.runId).toBe(ack.runId);
			const outcomeEvent = seen.find(event => event.type === "run_outcome");
			expect(outcomeEvent?.runId).toBe(ack.runId);

			// Actual wire frames for the same run, forwarded verbatim by the client.
			const startFrame = wireRuns.find(event => event.type === "managed_run_start");
			expect(startFrame).toMatchObject({ runId: ack.runId, command: "prompt" });
			const endFrame = wireRuns.find(event => event.type === "managed_run_end");
			// #11: run_end.replyDrained is now false; barrier arrives independently.
			expect(endFrame).toMatchObject({
				runId: ack.runId,
				status: "completed",
				replyDrained: false,
			});
			expect(typeof endFrame?.runStatusRevision).toBe("number");

			const state = await withinMs(endpoint.transport.client.getState(), 15_000, "get_state after run");
			expect(state.managedRuns?.some(run => run.runId === ack.runId)).toBe(true);
			const snapshot = await endpoint.snapshot();
			expect(snapshot.snapshot.runId).toBe(ack.runId);
			expect(endpoint.asJobSnapshot().runId).toBe(ack.runId);
			expect(endpoint.asHandleSnapshot().runId).toBe(ack.runId);
			expect(endpoint.asRosterSnapshot().runId).toBe(ack.runId);

			// Control pair on a terminal, drained run: park hands back the peer's
			// opaque reference and ensureLive reopens exactly that session.
			const parked = await withinMs(endpoint.park(ack.runId), 15_000, "endpoint park");
			expect(parked.acknowledged).toBe(true);
			if (!parked.acknowledged || parked.resumeReference === undefined) {
				throw new Error(`park did not hand back a resume reference: ${JSON.stringify(parked)}`);
			}
			const reopened = await withinMs(endpoint.ensureLive(parked.resumeReference), 15_000, "endpoint ensureLive");
			expect(reopened.acknowledged).toBe(true);

			console.log(
				`Row3 endpoint lifecycle: ${JSON.stringify(
					{
						ack,
						outcome,
						wireRuns,
						endpointEvents: seen,
						snapshot: snapshot.snapshot,
						jobSnapshot: endpoint.asJobSnapshot(),
						resumeReference: parked.resumeReference,
						reopened,
						managedRuns: state.managedRuns?.filter(run => run.runId === ack.runId),
					},
					null,
					2,
				)}`,
			);
		} finally {
			await iterator.return?.();
			unsubscribe();
			await endpoint.terminate();
			expect(await endpoint.transport.exited).toBe(0);
		}
	}, 90_000);

	it("ending stdin releases the real SSH child with exit code 0", async () => {
		const current = active();
		const commands: SshBackendCommand[] = [];
		const endpoint = await createSshBackendEndpoint(targetFor(current.wrapperPath), { agent: AGENT }, depsFor(commands));
		const state = await withinMs(endpoint.transport.client.getState(), 15_000, "get_state before EOF");
		expect(state.sessionId).toBeString();
		const exitCode = await withinMs(endpoint.transport.endInput(), 30_000, "SSH stdin EOF");
		expect(exitCode).toBe(0);
		expect(await withinMs(endpoint.transport.exited, 10_000, "SSH child exit")).toBe(0);
		await endpoint.transport.close();
		console.log(`Row3 stdin EOF: SSH child exit code ${exitCode}; session ${state.sessionId} closed cleanly`);
	}, 60_000);

	it("a PATH-probe miss fails with the classified executable-missing error before any launch", async () => {
		const commands: SshBackendCommand[] = [];
		const probes: string[] = [];
		const missing = "issue10-missing-omp";
		let failure: unknown;
		try {
			await createSshBackendEndpoint(targetFor(missing), { agent: AGENT }, depsFor(commands, probes));
		} catch (error) {
			failure = error;
		}
		if (!(failure instanceof SshBackendError)) {
			throw new Error(`expected a classified SshBackendError, observed ${String(failure)}`);
		}
		expect(failure.code).toBe("executable-missing");
		// The probe ran exactly once over real SSH; no transport or peer was created.
		expect(probes).toEqual([`command -v ${missing}`]);
		expect(commands).toHaveLength(0);
		console.log(`Row3 negative probe: ${JSON.stringify({ probes, commands: commands.length, code: failure.code, message: failure.message })}`);
	}, 60_000);
});
