import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeSend } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import { deliveredEnvelope, IrcAcceptanceHarness, managedIrcFrameKind } from "./fixture";

describe("IRC acceptance row 6: broadcast reaches parked peers without waking them", () => {
	test("all returns five individual receipts for three running and two parked local/remote recipients", async () => {
		const harness = await IrcAcceptanceHarness.start();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();

			const localRunning = "broadcast-running";
			const localParked = "broadcast-parked";
			harness.local.registerLocalPeer({ id: localRunning, kind: "sub", parentId: harness.localRoot });
			const localParkedSession = harness.local.registerLocalPeer({
				id: localParked,
				kind: "sub",
				parentId: harness.localRoot,
				status: "parked",
			});
			harness.local.registry.setStatus(harness.remoteChild, "parked");
			harness.remote.registry.setStatus(harness.remoteChild, "parked");
			const remoteParkedSession = harness.remote.sessionFor(harness.remoteChild);
			localParkedSession.isStreaming = false;
			remoteParkedSession.isStreaming = false;
			localParkedSession.outcome = "woken";
			remoteParkedSession.outcome = "woken";

			const runningTargets = [harness.localChild, localRunning, harness.remoteRoot];
			const parkedTargets = [localParked, harness.remoteChild];
			const targets = [...runningTargets, ...parkedTargets].sort();
			// Bootstrap-only refs must not make the broadcast's roster larger than
			// its sender and these five recipients. Preserve both managed routes.
			const rosterIds = new Set([harness.localRoot, ...targets]);
			for (const ref of harness.local.registry.list()) {
				if (!rosterIds.has(ref.id)) harness.local.registry.unregister(ref.id);
			}
			expect(harness.local.registry.list().map(ref => ref.id).sort()).toEqual([...rosterIds].sort());
			expect(harness.local.registry.listVisibleTo(harness.localRoot).map(ref => ref.id).sort()).toEqual(
				[...runningTargets].sort(),
			);
			expect(harness.local.registry.list().filter(ref => ref.status === "parked").map(ref => ref.id).sort()).toEqual(
				[...parkedTargets].sort(),
			);
			const remoteRef = harness.local.registry.get(harness.remoteChild);
			if (!remoteRef || remoteRef.endpoint.kind !== "remote") throw new Error("Expected a remote-tagged parked peer");
			expect(remoteRef.endpoint.endpoint).toBe(harness.remoteEndpoint);

			const body = "row6 broadcast stays queued for parked recipients";
			const sent = await executeSend(
				{ registry: harness.local.registry, senderId: harness.localRoot, settings: Settings.isolated() },
				{ to: "all", message: body },
			);
			expect(sent.isError).toBeFalsy();
			const receipts = sent.details?.receipts;
			if (!receipts) throw new Error("Expected individual broadcast receipts");
			expect(receipts).toHaveLength(5);
			expect([...receipts].sort((left, right) => left.to.localeCompare(right.to))).toEqual(
				targets.map(id => harness.local.registry.canonicalizeManagedPeerId(id))
					.sort((left, right) => left.localeCompare(right)).map(to => ({ to, outcome: "injected" })),
			);

			for (const id of [harness.localChild, localRunning]) {
				const delivered = harness.local.sessionFor(id).delivered;
				expect(delivered).toHaveLength(1);
				expect(delivered[0]).toMatchObject({
					from: harness.localRoot, to: harness.local.registry.canonicalizeManagedPeerId(id), body,
				});
				expect(harness.local.bus.inbox(id, { peek: true })).toEqual([]);
			}
			const remoteDelivered = harness.remote.sessionFor(harness.remoteRoot).delivered;
			expect(remoteDelivered).toHaveLength(1);
			expect(remoteDelivered[0]).toMatchObject({ from: harness.localRoot, to: harness.remoteRoot, body });
			expect(harness.remote.bus.inbox(harness.remoteRoot, { peek: true })).toEqual([]);
			expect(harness.local.sessionFor(harness.localRoot).delivered).toEqual([]);

			const localQueued = harness.local.bus.inbox(localParked, { peek: true });
			const remoteQueued = harness.remote.bus.inbox(harness.remoteChild, { peek: true });
			expect(localQueued).toHaveLength(1);
			expect(localQueued[0]).toMatchObject({
				from: harness.localRoot, to: harness.local.registry.canonicalizeManagedPeerId(localParked), body,
			});
			expect(remoteQueued).toHaveLength(1);
			expect(remoteQueued[0]).toMatchObject({ from: harness.localRoot, to: harness.remoteChild, body });
			// The remote receipt must come from the receiver's private mailbox,
			// not a coordinator-side queue masquerading as successful delivery.
			expect(harness.local.bus.inbox(harness.remoteChild, { peek: true })).toEqual([]);
			expect(localParkedSession.delivered).toEqual([]);
			expect(remoteParkedSession.delivered).toEqual([]);
			expect(harness.local.sessionFor(localParked)).toBe(localParkedSession);
			expect(harness.remote.sessionFor(harness.remoteChild)).toBe(remoteParkedSession);
			const parkedStates = {
				local: harness.local.registry.get(localParked)?.status,
				remoteAtCoordinator: harness.local.registry.get(harness.remoteChild)?.status,
				remoteAtReceiver: harness.remote.registry.get(harness.remoteChild)?.status,
			};
			expect(parkedStates).toEqual({ local: "parked", remoteAtCoordinator: "parked", remoteAtReceiver: "parked" });

			const remoteEnvelopes = harness.transcript.frames
				.filter(entry => entry.direction === "client->server" && managedIrcFrameKind(entry.frame) === "irc_delivery")
				.map(entry => deliveredEnvelope(entry.frame));
			expect(remoteEnvelopes).toHaveLength(2);
			expect(remoteEnvelopes).toContainEqual(remoteDelivered[0]);
			expect(remoteEnvelopes).toContainEqual(remoteQueued[0]);
			if (process.env.IRC_ACCEPTANCE_TRANSCRIPT === "1") {
				console.log("row6 broadcast receipts", JSON.stringify(receipts));
				console.log("row6 parked states", JSON.stringify(parkedStates));
				console.log("row6 parked mailboxes", JSON.stringify({ local: localQueued, remote: remoteQueued }));
			}
			harness.transcript.print("row6 broadcast: three running, two parked, five receipts");
		} finally {
			await harness.stop();
		}
	});
});
