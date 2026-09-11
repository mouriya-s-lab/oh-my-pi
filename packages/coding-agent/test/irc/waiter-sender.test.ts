import { describe, expect, test } from "bun:test";
import { IrcAwaitTargetStopped, type DeliveryResult } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { isRecord, withTimeout } from "@oh-my-pi/pi-utils";
import { deliveredEnvelope, IrcAcceptanceHarness, managedIrcFrameKind } from "./fixture";

describe("issue #11 acceptance row 2: sender-owned from-filtered waiter", () => {
	test("get_state overtakes a held send and a different replyTo still answers only the matching sender waiter", async () => {
		const harness = await IrcAcceptanceHarness.start();
		const receiverGate = Promise.withResolvers<void>();
		const abort = new AbortController();
		const pending: Promise<unknown>[] = [];
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const receiver = harness.remote.sessionFor(harness.remoteRoot);
			const sender = harness.local.sessionFor(harness.localRoot);
			receiver.gate = receiverGate.promise;
			const request = harness.local.bus.createEnvelope({
				from: harness.localRoot, to: harness.remoteRoot, body: "answer while my delivery is held",
			});
			let sendAwaitSettled = false;
			let deliverySettled = false;
			const frameStart = harness.transcript.frames.length;
			const sendAwait = harness.local.bus.waitReply(harness.remoteRoot, {
				senderId: harness.localRoot,
				timeoutMs: 5_000,
				signal: abort.signal,
				awaitTarget: { registry: harness.local.registry, target: harness.remoteRoot },
				send: () => harness.local.bus.sendEnvelope(request, { expectsReply: true }).then(receipt => {
					deliverySettled = true;
					return receipt;
				}),
			}).finally(() => { sendAwaitSettled = true; });
			pending.push(sendAwait);
			void sendAwait.catch(() => {});
			const requestFrame = await harness.transcript.waitForFrame(entry =>
				entry.direction === "client->server" && deliveredEnvelope(entry.frame)?.id === request.id, frameStart);
			const state = await withTimeout(harness.client.getState(), 1_000, "get_state blocked behind send-await");
			expect(state.isStreaming).toBe(false);
			expect(receiver.delivered).toHaveLength(0);
			expect(deliverySettled).toBe(false);
			expect(sendAwaitSettled).toBe(false);
			const stateResponse = harness.transcript.frames.slice(frameStart).find(entry =>
				entry.direction === "server->client" && isRecord(entry.frame) &&
				entry.frame.type === "response" && entry.frame.command === "get_state");
			expect(stateResponse).toBeDefined();
			if (!stateResponse) throw new Error("Missing concurrent get_state response");
			expect(harness.transcript.frames.indexOf(requestFrame)).toBeLessThan(harness.transcript.frames.indexOf(stateResponse));

			// Matching replyTo is insufficient: a different authorized peer goes to
			// the session, leaving the root's from-filtered waiter intact.
			const wrongReply = harness.remote.bus.createEnvelope({
				from: harness.remoteChild, to: harness.localRoot, body: "wrong peer", replyTo: request.id,
			});
			expect(await harness.server.channel.deliverIrc(wrongReply, {
				operationId: wrongReply.id, targetPeerId: harness.localRoot, timeoutMs: 1_000,
			})).toEqual({ to: harness.localRoot, outcome: "injected" });
			expect(sender.delivered).toEqual([wrongReply]);
			expect(sendAwaitSettled).toBe(false);

			const reply = harness.remote.bus.createEnvelope({
				from: harness.remoteRoot, to: harness.localRoot, body: "correct peer, unrelated thread",
				replyTo: "deliberately-not-the-request-id",
			});
			expect(reply.replyTo).not.toBe(request.id);
			expect(await harness.server.channel.deliverIrc(reply, {
				operationId: reply.id, targetPeerId: harness.localRoot, timeoutMs: 1_000,
			})).toEqual({ to: harness.localRoot, outcome: "injected" });
			// The reply arrived before send's receipt: only a waiter parked before
			// send can consume it here, without session injection or inbox fallback.
			expect(deliverySettled).toBe(false);
			expect(sendAwaitSettled).toBe(false);
			expect(sender.delivered).toEqual([wrongReply]);
			expect(harness.local.bus.inbox(harness.localRoot, { peek: true })).toEqual([]);
			receiverGate.resolve();
			const result = await withTimeout(sendAwait, 1_000, "Matching from did not answer the sender waiter");
			expect(result).toEqual({ receipt: { to: harness.remoteRoot, outcome: "injected" }, reply });
			expect(receiver.delivered).toEqual([request]);
			expect(sender.delivered).toEqual([wrongReply]);
			expect(harness.local.bus.inbox(harness.localRoot, { peek: true })).toEqual([]);
			harness.transcript.print("row2 get_state overtakes held send; from matches despite different replyTo");
			if (Bun.env.IRC_ACCEPTANCE_TRANSCRIPT === "1") {
				process.stdout.write(`[irc observations] row2 request=${request.id}; get_state returned with delivery and send-await pending; wrong-from=${wrongReply.from} entered session; reply-from=${result.reply?.from}; replyTo=${result.reply?.replyTo}; sender inbox=0; matching reply never entered session\n`);
			}
		} finally {
			receiverGate.resolve();
			abort.abort();
			await harness.stop();
			await Promise.allSettled(pending);
		}
	});

	test("a reused peer's already-drained run cannot stop a new waiter, and only the new run's drain ends it", async () => {
		const harness = await IrcAcceptanceHarness.start();
		const abort = new AbortController();
		const pending: Promise<unknown>[] = [];
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const bus = harness.local.bus;
			bus.markRemoteRunStarted(harness.remoteRoot, "old-run");
			bus.markRemoteReplyDrained(harness.remoteRoot, "old-run");
			harness.local.registry.setStatus(harness.remoteRoot, "idle");
			let settled = false;
			const request = bus.createEnvelope({
				from: harness.localRoot, to: harness.remoteRoot, body: "start another execution",
			});
			const waiter = bus.waitReply(harness.remoteRoot, {
				senderId: harness.localRoot,
				timeoutMs: 5_000,
				signal: abort.signal,
				awaitTarget: { registry: harness.local.registry, target: harness.remoteRoot },
				send: () => bus.sendEnvelope(request, { expectsReply: true }),
			}).finally(() => { settled = true; });
			pending.push(waiter);
			void waiter.catch(() => {});
			await harness.transcript.waitForFrame(entry => entry.direction === "server->client" &&
				managedIrcFrameKind(entry.frame) === "irc_receipt" && isRecord(entry.frame) &&
				isRecord(entry.frame.frame) && entry.frame.frame.operationId === request.id, 0);
			await withTimeout(harness.client.getState(), 1_000, "State round trip stalled after reused-peer send");
			expect(harness.remote.sessionFor(harness.remoteRoot).delivered).toEqual([request]);
			expect(settled).toBe(false);
			bus.markRemoteRunStarted(harness.remoteRoot, "new-run");
			harness.local.registry.setStatus(harness.remoteRoot, "running");
			bus.markRemoteReplyDrained(harness.remoteRoot, "old-run");
			harness.local.registry.setStatus(harness.remoteRoot, "idle");
			await withTimeout(harness.client.getState(), 1_000, "State round trip stalled before new drain");
			expect(settled).toBe(false);
			bus.markRemoteReplyDrained(harness.remoteRoot, "new-run");
			await expect(withTimeout(waiter, 1_000, "New run drain did not stop the waiter")).rejects.toBeInstanceOf(IrcAwaitTargetStopped);
			expect(settled).toBe(true);
			expect(harness.local.sessionFor(harness.localRoot).delivered).toEqual([]);
			expect(bus.inbox(harness.localRoot, { peek: true })).toEqual([]);
			harness.transcript.print("row2 reused peer ignores old-run drain; waits for new-run drain");
			if (Bun.env.IRC_ACCEPTANCE_TRANSCRIPT === "1") {
				process.stdout.write("[irc observations] reused peer: old-run started+drained before waiter; request delivered; waiter pending after old drain and new-run idle; stale old barrier ignored; new-run drain rejected IrcAwaitTargetStopped\n");
			}
		} finally {
			abort.abort();
			await harness.stop();
			await Promise.allSettled(pending);
		}
	});

	test("a native child waiter parked before its grant consumes an immediate canonical reply without inbox leakage", async () => {
		const harness = await IrcAcceptanceHarness.start();
		const identity = Promise.withResolvers<string>();
		const replyDelivery = Promise.withResolvers<DeliveryResult>();
		const abort = new AbortController();
		const pending: Promise<unknown>[] = [];
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const nativeId = "waiting-native-child";
			const child = harness.remote.registerLocalPeer({ id: nativeId, kind: "sub", parentId: harness.remoteRoot });
			harness.remote.bus.registerPendingIdentity(nativeId, identity.promise);
			let settled = false;
			const frameStart = harness.transcript.frames.length;
			const waiter = harness.remote.bus.waitReply(harness.localRoot, {
				senderId: nativeId,
				timeoutMs: 5_000,
				signal: abort.signal,
				send: () => harness.remote.bus.send({
					from: nativeId, to: harness.localRoot, body: "reply immediately after grant",
				}, { expectsReply: true }),
			}).finally(() => { settled = true; });
			pending.push(waiter);
			void waiter.catch(() => {});
			void replyDelivery.promise.catch(() => {});
			await withTimeout(harness.client.getState(), 1_000, "State round trip stalled while identity pending");
			expect(settled).toBe(false);
			expect(harness.transcript.frames.slice(frameStart).filter(entry =>
				managedIrcFrameKind(entry.frame) === "irc_delivery")).toEqual([]);
			const grant = await withTimeout(harness.server.channel.requestPeerRegistration({
				nativeId, parentId: harness.remoteRoot, displayName: nativeId, roles: ["sub"],
			}), 1_000, "Native child registration did not receive a canonical grant");
			harness.remote.registry.mapManagedPeerIdentity({
				canonicalId: grant.canonicalId, nativeId, ownerPeerId: harness.remoteRoot, generation: grant.generation,
			});
			harness.local.sessionFor(harness.localRoot).onDeliver = request => {
				const delivery = harness.local.bus.send({
					from: harness.localRoot, to: request.from, body: "immediate canonical reply", replyTo: request.id,
				});
				pending.push(delivery);
				void delivery.then(replyDelivery.resolve, replyDelivery.reject);
			};
			identity.resolve(grant.canonicalId);
			const result = await withTimeout(waiter, 1_000, "Canonical reply missed the pre-grant native waiter");
			expect(result.receipt).toEqual({ to: harness.localRoot, outcome: "injected" });
			expect(result.reply).toMatchObject({
				from: harness.localRoot, to: grant.canonicalId, body: "immediate canonical reply",
			});
			expect(await withTimeout(replyDelivery.promise, 1_000, "Canonical reply lacked a receipt"))
				.toEqual({ to: grant.canonicalId, outcome: "injected" });
			const requests = harness.local.sessionFor(harness.localRoot).delivered;
			expect(requests).toHaveLength(1);
			expect(requests[0].from).toBe(grant.canonicalId);
			expect(requests[0].from).not.toBe(nativeId);
			expect(result.reply?.replyTo).toBe(requests[0].id);
			expect(child.delivered).toEqual([]);
			expect(harness.remote.bus.inbox(nativeId, { peek: true })).toEqual([]);
			expect(harness.remote.bus.inbox(grant.canonicalId, { peek: true })).toEqual([]);
			harness.transcript.print("row2 pre-grant native waiter consumes immediate canonical reply");
			if (Bun.env.IRC_ACCEPTANCE_TRANSCRIPT === "1") {
				process.stdout.write(`[irc observations] pre-grant native=${nativeId}; no delivery before grant; canonical=${grant.canonicalId}; request-from=${requests[0].from}; reply-to=${result.reply?.to}; native and canonical inboxes=0; child session deliveries=0\n`);
			}
		} finally {
			identity.reject(new Error("Native waiter acceptance cleanup"));
			abort.abort();
			await harness.stop();
			await Promise.allSettled(pending);
		}
	});
});
