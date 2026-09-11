/**
 * Acceptance row 1 — the envelope crosses the wire without a second identity
 * (issue #11).
 *
 * A message the local coordinator's bus sends to a canonical remote peer is
 * carried by the production managed channel over an in-memory byte loopback;
 * the peer runtime's real `IrcBus.injectInbound` receives the very envelope the
 * sender minted. The row asserts both ends agree on `id`/`ts`/`from`/`to`/
 * `replyTo`/`wakeRelay` and that each side recorded exactly one message — which
 * is what "no second identity" means: no re-mint and no ordinary remote
 * `bus.send()`.
 *
 * The same composition proves the identity boundary itself: a peer root whose
 * native name is `Main` resolves to its coordinator-assigned canonical id, so
 * two runtimes each having their own `Main` never collide, and a spoofed
 * `from`, stale generation, or revoked route is refused with
 * `authorization-denied` by the real dispatcher before any bus work happens.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { isRecord, withTimeout } from "@oh-my-pi/pi-utils";
import { deliveredEnvelope, IrcAcceptanceHarness, isDeniedManagedIrcResponse, managedIrcFrameKind } from "./fixture";

describe("issue #11 acceptance row 1: one envelope, one identity", () => {
	test("local bus -> remote bus keeps id/ts/from/to/replyTo/wakeRelay verbatim, one message per side", async () => {
		const harness = await IrcAcceptanceHarness.start();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const remoteSession = harness.remote.sessionFor(harness.remoteRoot);
			remoteSession.outcome = "woken";

			// Sent the way the hub does: the remote route's endpoint adapter carries
			// the bus-minted envelope, and nothing downstream may mint a second one.
			const sentFrom = harness.localRoot;
			const receipt = await harness.local.bus.send(
				{
					from: sentFrom,
					to: harness.remoteRoot,
					body: "row1 envelope fidelity",
					replyTo: "msg:deliberately-unrelated",
				},
				{ expectsReply: true, operationId: "op:fidelity" },
			);
			expect(receipt).toEqual({ to: harness.remoteRoot, outcome: "woken" });

			const inbound = harness.inboundRecords;
			expect(inbound).toHaveLength(1);
			const envelope = inbound[0]!.envelope;
			// Delivery correlation is independent of the unchanged message identity.
			expect(inbound[0]!.operationId).toBe("op:fidelity");
			expect(envelope.id).not.toBe("op:fidelity");

			// The wire frame carries the same envelope; reading it back off the
			// transcript proves the transport did not rewrite the identity either.
			const deliveredFrames = harness.transcript.frames.filter(
				entry => entry.direction === "client->server" && managedIrcFrameKind(entry.frame) === "irc_delivery",
			);
			expect(deliveredFrames).toHaveLength(1);
			expect(deliveredEnvelope(deliveredFrames[0]!.frame)).toEqual(envelope);

			const remoteDelivered = remoteSession.delivered;
			expect(remoteDelivered).toHaveLength(1);
			const atRemote = remoteDelivered[0]!;
			expect(atRemote.id).toBe(envelope.id);
			expect(atRemote.ts).toBe(envelope.ts);
			expect(atRemote.from).toBe(sentFrom);
			expect(atRemote.to).toBe(harness.remoteRoot);
			expect(atRemote.replyTo).toBe("msg:deliberately-unrelated");
			expect(atRemote.wakeRelay).toBeUndefined();
			expect(atRemote.body).toBe("row1 envelope fidelity");

			// One message on each side: the sender's bus never re-delivers its own
			// outbound frame locally, and the recipient never mints a second one.
			expect(harness.local.sessionFor(harness.localRoot).delivered).toHaveLength(0);
			expect(remoteSession.delivered).toHaveLength(1);
			harness.transcript.print("row1 envelope fidelity");
		} finally {
			await harness.stop();
		}
	});

	test("both runtimes name their root Main yet route on distinct canonical ids", async () => {
		const harness = await IrcAcceptanceHarness.start();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			expect(harness.local.registry.get(harness.localRoot)?.displayName).toBe("Main");
			expect(harness.local.registry.get(harness.remoteRoot)?.displayName).toBe("Main");
			expect(harness.localRoot).not.toBe(harness.remoteRoot);

			const remoteSession = harness.remote.sessionFor(harness.remoteRoot);
			// The canonical id is the only routing key; it reaches exactly the peer
			// that owns it even though its display name is shared.
			await harness.local.bus.send({ from: harness.localRoot, to: harness.remoteRoot, body: "canonical route" });
			expect(remoteSession.delivered).toHaveLength(1);
			expect(remoteSession.delivered[0]!.to).toBe(harness.remoteRoot);
			expect(harness.inboundRecords[0]!.envelope.to).toBe(harness.remoteRoot);
			harness.transcript.print("row1 Main collision");
		} finally {
			await harness.stop();
		}
	});

	test("spoofed from, stale generation, and a revoked route are refused authorization-denied without injection", async () => {
		const harness = await IrcAcceptanceHarness.start();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const generation = harness.coordinatorBinding.generation;
			const remoteSession = harness.remote.sessionFor(harness.remoteRoot);

			// (1) A sender outside the bound scope is refused before the peer's bus
			// is reached.
			const spoofed = harness.transcript.nextDenied();
			harness.server.receiveRaw(
				harness.server.managedWire(generation, {
					kind: "irc_delivery",
					envelope: { id: "msg:spoofed", from: "peer:attacker", to: harness.remoteRoot, body: "spoofed sender", ts: 1 },
					operationId: "msg:spoofed",
				}),
			);
			expect((await spoofed).code).toBe("authorization-denied");

			// (2) A frame still carrying the superseded generation is stale.
			const stale = harness.transcript.nextDenied();
			harness.server.receiveRaw(
				harness.server.managedWire(generation - 1, {
					kind: "irc_delivery",
					envelope: { id: "msg:stale", from: harness.localRoot, to: harness.remoteRoot, body: "stale generation", ts: 2 },
					operationId: "msg:stale",
				}),
			);
			expect((await stale).code).toBe("authorization-denied");

			// (3) A revoked route cannot deliver: revocation drops the sender from the
			// connection's allowed set.
			harness.server.channel.revoke(harness.localRoot);
			const revoked = harness.transcript.nextDenied();
			harness.server.receiveRaw(
				harness.server.managedWire(generation, {
					kind: "irc_delivery",
					envelope: { id: "msg:revoked", from: harness.localRoot, to: harness.remoteRoot, body: "revoked sender", ts: 3 },
					operationId: "msg:revoked",
				}),
			);
			expect((await revoked).code).toBe("authorization-denied");

			expect(harness.inboundRecords).toHaveLength(0);
			expect(remoteSession.delivered).toHaveLength(0);
			harness.transcript.print("row1 authorization negatives");
		} finally {
			await harness.stop();
		}
	});


	test("a peer-registration frame outside the bound ancestry is refused, and an unbound channel refuses every frame", async () => {
		const harness = await IrcAcceptanceHarness.start();
		try {
			harness.registerPeers();
			const generation = harness.coordinatorBinding.generation;

			// A descendant announcement whose parent is not in the scope is refused.
			// Passive roster updates may still arrive; only the rejected identity
			// must be absent from the accepted frames and recipient roster.
			const outside = harness.transcript.nextDenied();
			harness.server.receiveRaw(
				harness.server.managedWire(generation, {
					kind: "peer_registered",
					canonicalId: "peer:outsider",
					parentId: "peer:other-root",
					displayName: "outsider",
					roles: [],
					generation,
				}),
			);
			expect((await outside).code).toBe("authorization-denied");
			expect(harness.peerFrames).not.toContainEqual(expect.objectContaining({
				kind: "peer_registered", canonicalId: "peer:outsider", parentId: "peer:other-root",
			}));
			expect(harness.remote.registry.get("peer:outsider")).toBeUndefined();
			expect(harness.inboundRecords).toHaveLength(0);
		} finally {
			await harness.stop();
		}

		const unbound = await IrcAcceptanceHarness.start({ unboundServer: true });
		try {
			const denied = unbound.transcript.nextDenied();
			unbound.server.receiveRaw(
				unbound.server.managedWire(1, {
					kind: "irc_delivery",
					envelope: { id: "msg:unbound", from: "peer:anyone", to: "peer:anyone", body: "unbound", ts: 1 },
					operationId: "msg:unbound",
				}),
			);
			expect((await denied).code).toBe("authorization-denied");
			expect(unbound.inboundRecords).toHaveLength(0);
			unbound.transcript.print("row1 unbound channel");
		} finally {
			await unbound.stop();
		}
	});
});

describe("issue #11 row 3: ACK, delivery receipt, then model reply", () => {
	test("ACK cannot finish delivery and a woken receipt cannot answer the sender's waiter", async () => {
		const harness = await IrcAcceptanceHarness.start();
		const receiverGate = Promise.withResolvers<void>();
		const modelGate = Promise.withResolvers<void>();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const receiver = harness.remote.sessionFor(harness.remoteRoot);
			receiver.outcome = "woken";
			receiver.gate = receiverGate.promise;
			const request = harness.local.bus.createEnvelope({
				from: harness.localRoot, to: harness.remoteRoot, body: "wake and answer later",
			});
			let replySettled = false;
			let deliverySettled = false;
			const waiter = harness.local.bus.wait(harness.localRoot, { from: harness.remoteRoot }, 2_000)
				.then(reply => { replySettled = true; return reply; });
			const ack = harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && isRecord(entry.frame) &&
				entry.frame.type === "response" && entry.frame.command === "managed_irc" &&
				entry.frame.success === true && isRecord(entry.frame.data) && entry.frame.data.operationId === request.id);
			const delivery = harness.local.bus.sendEnvelope(request, { expectsReply: true })
				.then(receipt => { deliverySettled = true; return receipt; });
			const ackEntry = await ack;
			// A real command round trip fences the client's processing of the earlier ACK.
			await harness.client.getState();
			expect(receiver.delivered).toHaveLength(0);
			expect(deliverySettled).toBe(false);
			expect(replySettled).toBe(false);
			expect(harness.transcript.frames.filter(entry => managedIrcFrameKind(entry.frame) === "irc_receipt")).toHaveLength(0);
			const receiptFrame = harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && managedIrcFrameKind(entry.frame) === "irc_receipt");
			receiverGate.resolve();
			expect(await delivery).toEqual({ to: harness.remoteRoot, outcome: "woken" });
			const receiptEntry = await receiptFrame;
			expect(receiptEntry.frame).toMatchObject({ frame: { kind: "irc_receipt", operationId: request.id, outcome: "woken" } });
			expect(receiver.delivered).toEqual([request]);
			expect(replySettled).toBe(false);
			const modelReply = modelGate.promise.then(() => harness.sendFromRemote({
				from: harness.remoteRoot, to: harness.localRoot, body: "model answer", replyTo: request.id,
			}));
			const replyFrame = harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && managedIrcFrameKind(entry.frame) === "irc_delivery");
			expect(replySettled).toBe(false);
			modelGate.resolve();
			expect((await modelReply).outcome).toBe("injected");
			const replyEntry = await replyFrame;
			const reply = await waiter;
			expect(reply).toEqual(deliveredEnvelope(replyEntry.frame));
			expect(reply?.id).not.toBe(request.id);
			expect(reply?.replyTo).toBe(request.id);
			expect(reply?.body).toBe("model answer");
			const frames = harness.transcript.frames;
			expect(frames.indexOf(ackEntry)).toBeLessThan(frames.indexOf(receiptEntry));
			expect(frames.indexOf(receiptEntry)).toBeLessThan(frames.indexOf(replyEntry));
			expect(frames.filter(entry => entry.direction === "server->client" && isRecord(entry.frame) &&
				entry.frame.type === "response" && entry.frame.command === "managed_irc" &&
				isRecord(entry.frame.data) && entry.frame.data.operationId === request.id)).toHaveLength(1);
			expect(frames.filter(entry => entry.direction === "server->client" &&
				managedIrcFrameKind(entry.frame) === "irc_receipt")).toHaveLength(1);
			harness.transcript.print("row3 ACK then woken receipt then distinct reply");
		} finally {
			receiverGate.resolve();
			modelGate.resolve();
			await harness.stop();
		}
	});
});

describe("issue #11 row 5: receiver deduplication and uncertain delivery", () => {
	test("two physical deliveries with one operation id share a receipt and invoke the receiver bus once", async () => {
		const harness = await IrcAcceptanceHarness.start();
		const inject = spyOn(harness.remote.bus, "injectInbound");
		try {
			harness.registerPeers();
			harness.connectRemoteEndpoint();
			harness.remote.sessionFor(harness.remoteRoot).outcome = "woken";
			const envelope = harness.local.bus.createEnvelope({
				from: harness.localRoot, to: harness.remoteRoot, body: "deliver once despite wire replay",
			});
			const operationId = "op:physical-replay";
			const firstReceipt = await harness.client.deliverIrc(envelope, {
				operationId, targetPeerId: envelope.to, timeoutMs: 1_000,
			});
			const original = harness.transcript.frames.find(entry =>
				entry.direction === "client->server" && deliveredEnvelope(entry.frame)?.id === envelope.id);
			if (!original || !isRecord(original.frame)) throw new Error("Original delivery frame was not observed");
			const secondReceipt = harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && managedIrcFrameKind(entry.frame) === "irc_receipt");
			// Replay bytes, not deliverIrc(): the outbound cache would avoid a second wire write.
			harness.server.receiveRaw(original.frame);
			const replayReceipt = await secondReceipt;
			expect(firstReceipt).toEqual({ to: envelope.to, outcome: "woken" });
			expect(replayReceipt.frame).toMatchObject({
				generation: harness.coordinatorBinding.generation,
				correlationId: original.frame.correlationId,
				operationId,
				frame: { kind: "irc_receipt", operationId, outcome: firstReceipt.outcome },
			});
			expect(typeof original.frame.correlationId).toBe("string");
			expect(original.frame.correlationId).not.toBe(operationId);
			expect(envelope.id).not.toBe(operationId);
			const receipts = harness.transcript.frames.filter(entry =>
				entry.direction === "server->client" && managedIrcFrameKind(entry.frame) === "irc_receipt");
			expect(receipts).toHaveLength(2);
			expect(receipts[1]!.frame).toEqual(receipts[0]!.frame);
			expect(harness.transcript.frames.filter(entry =>
				entry.direction === "client->server" && deliveredEnvelope(entry.frame)?.id === envelope.id)).toHaveLength(2);
			expect(inject).toHaveBeenCalledTimes(1);
			expect(harness.remote.sessionFor(harness.remoteRoot).delivered).toEqual([envelope]);
			harness.transcript.print("row5 replayed operation receives cached receipt");
		} finally {
			inject.mockRestore();
			await harness.stop();
		}
	});

	test("an emitted frame with no receipt times out indeterminate rather than failed or delivered", async () => {
		const harness = await IrcAcceptanceHarness.start({ dropDeliveries: true });
		try {
			harness.registerPeers();
			const envelope = harness.local.bus.createEnvelope({
				from: harness.localRoot, to: harness.remoteRoot, body: "receipt lost after emission",
			});
			// Real platform timeout is part of this byte-loopback transport contract.
			const receipt = await harness.client.deliverIrc(envelope, {
				operationId: envelope.id, targetPeerId: envelope.to, timeoutMs: 30,
			});
			expect(receipt).toMatchObject({ to: envelope.to, outcome: "indeterminate" });
			expect(harness.transcript.frames.filter(entry =>
				entry.direction === "client->server" && deliveredEnvelope(entry.frame)?.id === envelope.id)).toHaveLength(1);
			expect(harness.transcript.frames.filter(entry => managedIrcFrameKind(entry.frame) === "irc_receipt")).toHaveLength(0);
			expect(harness.inboundRecords).toHaveLength(0);
			harness.transcript.print("row5 emitted frame has no receipt: indeterminate");
		} finally {
			await harness.stop();
		}
	});
});

describe("issue #11 dynamic identity grants and coordinator forwarding", () => {
	test("only an authorized native-child registration request obtains a canonical sender grant", async () => {
		const harness = await IrcAcceptanceHarness.start();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			const generation = harness.ircBinding.generation;
			expect(harness.coordinatorBinding.generation).toBe(generation);
			const selfGranted = `${harness.remoteRoot}:self-granted`;
			const refused = harness.transcript.waitForFrame(entry =>
				entry.direction === "client->server" && isDeniedManagedIrcResponse(entry.frame));
			harness.server.emit({ type: "managed_irc", generation, frame: {
				kind: "peer_registered", canonicalId: selfGranted, parentId: harness.remoteRoot,
				displayName: "self-granted", roles: ["sub"], generation,
			} });
			expect((await refused).frame).toMatchObject({ code: "authorization-denied" });
			expect((await harness.sendFromRemote({
				from: selfGranted, to: harness.localRoot, body: "cannot self-grant",
			}, { timeoutMs: 1_000 })).outcome).toBe("failed");
			expect(harness.local.sessionFor(harness.localRoot).delivered).toHaveLength(0);
			await expect(withTimeout(harness.server.channel.requestPeerRegistration({
				nativeId: "untrusted-child", parentId: harness.localRoot, displayName: "untrusted-child", roles: ["sub"],
			}), 1_000, "Unauthorized registration was not refused")).rejects.toMatchObject({ code: "authorization-denied" });
			const requestStart = harness.transcript.frames.length;
			const grant = await withTimeout(harness.server.channel.requestPeerRegistration({
				nativeId: "native-child", parentId: harness.remoteRoot, displayName: "native child", roles: ["sub"],
			}), 1_000, "Native child did not receive its root grant");
			expect(grant.canonicalId).not.toBe("native-child");
			expect(grant.parentId).toBe(harness.remoteRoot);
			expect(grant.generation).toBe(generation);
			const registrationFrames = harness.transcript.frames.slice(requestStart);
			const request = registrationFrames.find(entry => managedIrcFrameKind(entry.frame) === "peer_registration_request");
			const response = registrationFrames.find(entry => managedIrcFrameKind(entry.frame) === "peer_registered");
			if (!request || !response || !isRecord(request.frame) || !isRecord(response.frame)) {
				throw new Error("Registration request and correlated grant were not observed");
			}
			expect(typeof request.frame.correlationId).toBe("string");
			expect(response.frame.correlationId).toBe(request.frame.correlationId);
			expect(harness.local.registry.get(grant.canonicalId)?.parentId).toBe(harness.remoteRoot);
			expect((await harness.sendFromRemote({
				from: grant.canonicalId, to: harness.localRoot, body: "root-authorized child speaks",
			}, { timeoutMs: 1_000 })).outcome).toBe("injected");
			expect(harness.local.sessionFor(harness.localRoot).delivered.map(message => message.from)).toEqual([grant.canonicalId]);
			harness.transcript.print("native child request obtains root-correlated canonical grant");
		} finally {
			await harness.stop();
		}
	});

	test("same-generation rebind cannot revive a revoked descendant and a mapped identity is not a sender grant", async () => {
		const harness = await IrcAcceptanceHarness.start();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.server.channel.revoke(harness.localChild);
			harness.server.channel.bind(harness.coordinatorBinding);
			const denied = harness.transcript.nextDenied();
			harness.server.receiveRaw(harness.server.managedWire(harness.coordinatorBinding.generation, {
				kind: "irc_delivery", operationId: "revoked-child",
				envelope: { id: "revoked-child", ts: 1, from: harness.localChild, to: harness.remoteRoot, body: "still revoked" },
			}));
			expect((await denied).code).toBe("authorization-denied");
			const mappedId = `${harness.remoteRoot}:mapped-only`;
			harness.local.registry.mapManagedPeerIdentity({
				canonicalId: mappedId, nativeId: "mapped-only", ownerPeerId: harness.remoteRoot,
				generation: harness.ircBinding.generation,
			});
			expect(harness.local.registry.managedPeerIdentity(mappedId)?.canonicalId).toBe(mappedId);
			expect(await harness.sendFromRemote({
				from: mappedId, to: harness.localRoot, body: "mapping is not authority",
			}, { timeoutMs: 1_000 })).toMatchObject({ outcome: "failed", error: "authorization-denied" });
			expect(harness.inboundRecords).toHaveLength(0);
			expect(harness.local.sessionFor(harness.localRoot).delivered).toHaveLength(0);
			harness.transcript.print("revoked same-generation rebind and mapped-but-ungranted sender");
		} finally {
			await harness.stop();
		}
	});

	test("a later remote C reaches older remote B through the root without reminting or ordinary bus.send", async () => {
		const b = await IrcAcceptanceHarness.start();
		const rootSend = spyOn(b.local.bus, "send");
		const receiverSend = spyOn(b.remote.bus, "send");
		const inject = spyOn(b.remote.bus, "injectInbound");
		try {
			b.registerPeers();
			b.attachLocalInbound();
			b.connectRemoteEndpoint();
			const beforeC = b.transcript.frames.length;
			const c = await b.attachRemote("remote-c");
			expect(c.local).toBe(b.local);
			expect(b.ircBinding.generation).toBe(b.coordinatorBinding.generation);
			expect(c.ircBinding.generation).toBe(c.coordinatorBinding.generation);
			const envelope = c.remote.bus.createEnvelope({
				from: c.remoteRoot, to: b.remoteRoot, body: "C speaks through root to older B", replyTo: "prior-message", wakeRelay: true,
			});
			expect((await c.sendFromRemote(envelope, { timeoutMs: 1_000 })).outcome).toBe("injected");
			const roster = b.transcript.frames.slice(beforeC);
			const grantIndex = roster.findIndex(entry => entry.direction === "client->server" &&
				managedIrcFrameKind(entry.frame) === "peer_registered" && isRecord(entry.frame) &&
				isRecord(entry.frame.frame) && entry.frame.frame.canonicalId === c.remoteRoot);
			const deliveryIndex = roster.findIndex(entry => entry.direction === "client->server" &&
				deliveredEnvelope(entry.frame)?.id === envelope.id);
			expect(grantIndex).toBeGreaterThanOrEqual(0);
			expect(deliveryIndex).toBeGreaterThan(grantIndex);
			expect(b.server.channel.binding?.allowedDescendants).toContain(c.remoteRoot);
			expect(b.remote.sessionFor(b.remoteRoot).delivered).toEqual([envelope]);
			expect(b.inboundRecords.map(record => record.envelope)).toEqual([envelope]);
			expect(deliveredEnvelope(roster[deliveryIndex]!.frame)).toEqual(envelope);
			expect(c.transcript.frames.filter(entry => entry.direction === "server->client" &&
				deliveredEnvelope(entry.frame)?.id === envelope.id)).toHaveLength(1);
			expect(roster.filter(entry => entry.direction === "client->server" &&
				deliveredEnvelope(entry.frame)?.id === envelope.id)).toHaveLength(1);
			expect(rootSend).not.toHaveBeenCalled();
			expect(receiverSend).not.toHaveBeenCalled();
			expect(inject).toHaveBeenCalledTimes(1);
			c.transcript.print("cross-remote C to root preserves original envelope");
			b.transcript.print("older B learns C from authoritative roster before forwarded inbound");
		} finally {
			rootSend.mockRestore();
			receiverSend.mockRestore();
			inject.mockRestore();
			await b.stop();
		}
	});
});
