import { describe, expect, test } from "bun:test";
import { IrcAwaitTargetStopped } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { isRecord, withTimeout } from "@oh-my-pi/pi-utils";
import { deliveredEnvelope, IrcAcceptanceHarness, managedIrcFrameKind, NATIVE_ROOT } from "./fixture";

describe("issue #11 row 4: terminal outcome is not a reply-drained barrier", () => {
	test("the SSH adapter stays owned after terminal while a distinct queued reply reaches and answers the sender", async () => {
		const harness = await IrcAcceptanceHarness.start({ autoStartRuns: false });
		const abort = new AbortController();
		const releaseReply = Promise.withResolvers<void>();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const runId = "row4:queued-reply";
			const accepted = harness.remoteEndpoint.start("answer the queued IRC request");
			harness.server.emitRunStart(runId);
			expect((await accepted).runId).toBe(runId);
			const startEntry = await harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && isRecord(entry.frame) &&
				entry.frame.type === "managed_run_start" && entry.frame.runId === runId, 0);
			const request = harness.local.bus.createEnvelope({
				from: harness.localRoot, to: harness.remoteRoot, body: "reply after the terminal frame",
			});
			let senderSettled = false;
			const sender = harness.local.bus.waitReply(harness.remoteRoot, {
				senderId: harness.localRoot, signal: abort.signal, timeoutMs: 2_000,
				awaitTarget: { registry: harness.local.registry, target: harness.remoteRoot },
				send: () => harness.local.bus.sendEnvelope(request, { expectsReply: true }),
			}).then(
				result => { senderSettled = true; return { kind: "reply", result } as const; },
				(error: unknown) => { senderSettled = true; return { kind: "error", error } as const; },
			);
			await harness.server.settle();
			expect(harness.remote.sessionFor(harness.remoteRoot).delivered).toEqual([request]);
			let drainSettled = false;
			const drained = harness.remoteEndpoint.waitReplyDrained(runId, { signal: abort.signal })
				.then(result => { drainSettled = true; return result; });
			const reply = harness.remote.bus.createEnvelope({
				from: harness.remoteRoot, to: harness.localRoot, body: "the delayed answer", replyTo: request.id,
			});
			const queuedReply = releaseReply.promise.then(() => harness.server.channel.deliverIrc(reply, {
				operationId: reply.id, targetPeerId: harness.localRoot, timeoutMs: 2_000,
			}));
			void queuedReply.catch(() => {});
			harness.server.emitRunEnd(runId, "completed", 7, false);
			await harness.client.getState();
			expect(await harness.remoteEndpoint.run(runId)).toEqual({ runId, status: "completed" });
			expect(drainSettled).toBe(false);
			expect(senderSettled).toBe(false);
			expect(harness.local.sessionFor(harness.localRoot).delivered).toEqual([]);
			const endEntry = await harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && isRecord(entry.frame) &&
				entry.frame.type === "managed_run_end" && entry.frame.runId === runId, 0);
			expect(endEntry.frame).toEqual({
				type: "managed_run_end", runId, status: "completed", runStatusRevision: 7, replyDrained: false,
			});

			releaseReply.resolve();
			expect(await queuedReply).toEqual({ to: harness.localRoot, outcome: "injected" });
			const senderResult = await withTimeout(sender, 2_000, "sender did not consume the reverse reply");
			expect(senderResult).toEqual({
				kind: "reply", result: { receipt: { to: harness.remoteRoot, outcome: "injected" }, reply },
			});
			expect(reply.id).not.toBe(request.id);
			// The parked sender consumes the reply, so it is not injected a second time.
			expect(harness.local.sessionFor(harness.localRoot).delivered).toEqual([]);
			expect(drainSettled).toBe(false);
			const replyEntry = await harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && deliveredEnvelope(entry.frame)?.id === reply.id, 0);
			harness.server.emitReplyDrainedBarrier(runId, 7, 1);
			expect(await withTimeout(drained, 2_000, "adapter did not observe the independent barrier")).toEqual({
				status: "drained", runStatusRevision: 7, outboundWatermark: 1,
			});
			const barrierEntry = await harness.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && managedIrcFrameKind(entry.frame) === "reply_drained_barrier", 0);
			expect(barrierEntry.frame).toEqual({
				type: "managed_irc", generation: harness.ircBinding.generation,
				frame: { kind: "reply_drained_barrier", runId, runStatusRevision: 7, outboundWatermark: 1 },
			});
			const frames = harness.transcript.frames;
			expect(frames.indexOf(startEntry)).toBeLessThan(frames.indexOf(endEntry));
			expect(frames.indexOf(endEntry)).toBeLessThan(frames.indexOf(replyEntry));
			expect(frames.indexOf(replyEntry)).toBeLessThan(frames.indexOf(barrierEntry));
			harness.transcript.print("row4 accepted start, terminal, consumed reverse reply, independent drain");
		} finally {
			abort.abort();
			releaseReply.resolve();
			await harness.stop();
		}
	});

	test("no reply is judged stopped only by the parent run's matching barrier, never terminal, child, or wrong revision", async () => {
		const harness = await IrcAcceptanceHarness.start();
		const abort = new AbortController();
		try {
			harness.registerPeers();
			harness.attachLocalInbound();
			harness.connectRemoteEndpoint();
			const { runId } = await harness.remoteEndpoint.start("finish without replying");
			let senderSettled = false;
			const sender = harness.local.bus.waitReply(harness.remoteRoot, {
				senderId: harness.localRoot, signal: abort.signal, timeoutMs: 2_000,
				awaitTarget: { registry: harness.local.registry, target: harness.remoteRoot },
				send: () => harness.local.bus.send({
					from: harness.localRoot, to: harness.remoteRoot, body: "answer or finish",
				}, { expectsReply: true }),
			}).then(
				result => { senderSettled = true; return { kind: "reply", result } as const; },
				(error: unknown) => { senderSettled = true; return { kind: "error", error } as const; },
			);
			await harness.server.settle();
			let drainSettled = false;
			const drained = harness.remoteEndpoint.waitReplyDrained(runId, { signal: abort.signal })
				.then(result => { drainSettled = true; return result; });
			// Even a terminal snapshot claiming replyDrained cannot replace the IRC barrier.
			harness.server.emitRunEnd(runId, "completed", 0, true);
			await harness.client.getState();
			expect(await harness.remoteEndpoint.run(runId)).toEqual({ runId, status: "completed" });
			expect(senderSettled).toBe(false);
			expect(drainSettled).toBe(false);

			harness.server.emitReplyDrainedBarrier(runId, 0, 0, harness.remoteChild);
			await harness.client.getState();
			expect(senderSettled).toBe(false);
			expect(drainSettled).toBe(false);
			harness.server.emitReplyDrainedBarrier(runId, 1, 0, harness.remoteRoot);
			await harness.client.getState();
			expect(senderSettled).toBe(false);
			expect(drainSettled).toBe(false);

			harness.server.emitReplyDrainedBarrier(runId, 0, 0, harness.remoteRoot);
			expect(await withTimeout(drained, 2_000, "matching parent barrier did not drain")).toEqual({
				status: "drained", runStatusRevision: 0, outboundWatermark: 0,
			});
			const result = await withTimeout(sender, 2_000, "matching parent barrier did not stop the no-reply waiter");
			expect(result.kind).toBe("error");
			if (result.kind !== "error") throw new Error("no-reply waiter unexpectedly received a reply");
			expect(result.error).toBeInstanceOf(IrcAwaitTargetStopped);
			expect(harness.local.sessionFor(harness.localRoot).delivered).toEqual([]);
			harness.transcript.print("row4 terminal and invalid barriers cannot stop; matching parent barrier can, preserving zero facts");
		} finally {
			abort.abort();
			await harness.stop();
		}
	});

	test("older remote B's native waiter follows later C's relayed run and stops only after C's barrier fanout", async () => {
		const b = await IrcAcceptanceHarness.start();
		const abort = new AbortController();
		try {
			b.registerPeers();
			b.attachLocalInbound();
			b.connectRemoteEndpoint();
			const c = await b.attachRemote("laterC");
			await b.server.settle();
			const beforeRun = b.transcript.frames.length;
			let senderSettled = false;
			const sender = b.remote.bus.waitReply(c.remoteRoot, {
				senderId: NATIVE_ROOT, signal: abort.signal, timeoutMs: 2_000,
				awaitTarget: { registry: b.remote.registry, target: c.remoteRoot },
				send: () => b.remote.bus.send({
					from: NATIVE_ROOT, to: c.remoteRoot, body: "C, finish without answering B",
				}, { expectsReply: true }),
			}).then(
				result => { senderSettled = true; return { kind: "reply", result } as const; },
				(error: unknown) => { senderSettled = true; return { kind: "error", error } as const; },
			);
			const { runId } = await c.remoteEndpoint.start("finish without answering older B");
			const startEntry = await b.transcript.waitForFrame(entry =>
				entry.direction === "client->server" && managedIrcFrameKind(entry.frame) === "peer_state_changed" &&
				isRecord(entry.frame) && isRecord(entry.frame.frame) && entry.frame.frame.canonicalId === c.remoteRoot &&
				entry.frame.frame.runId === runId && entry.frame.frame.state === "running", beforeRun);
			const requestEntry = await b.transcript.waitForFrame(entry =>
				entry.direction === "server->client" && deliveredEnvelope(entry.frame)?.from === b.remoteRoot &&
				deliveredEnvelope(entry.frame)?.to === c.remoteRoot, beforeRun);
			const request = deliveredEnvelope(requestEntry.frame);
			if (!request) throw new Error("B's outbound delivery omitted its IRC envelope");
			const receiptEntry = await b.transcript.waitForFrame(entry =>
				entry.direction === "client->server" && managedIrcFrameKind(entry.frame) === "irc_receipt" &&
				isRecord(entry.frame) && isRecord(entry.frame.frame) &&
				entry.frame.frame.operationId === request.id, beforeRun);
			expect(receiptEntry.frame).toMatchObject({
				frame: { kind: "irc_receipt", operationId: request.id, outcome: "injected" },
			});
			expect(c.remote.sessionFor(c.remoteRoot).delivered).toEqual([request]);
			expect(senderSettled).toBe(false);
			c.server.emitRunEnd(runId, "completed", 4, false);
			const endEntry = await b.transcript.waitForFrame(entry =>
				entry.direction === "client->server" && managedIrcFrameKind(entry.frame) === "peer_state_changed" &&
				isRecord(entry.frame) && isRecord(entry.frame.frame) && entry.frame.frame.canonicalId === c.remoteRoot &&
				entry.frame.frame.runId === runId && entry.frame.frame.state === "idle", beforeRun);
			await b.server.settle();
			expect(endEntry.frame).toMatchObject({ frame: { runId, runStatusRevision: 4 } });
			expect(b.remote.registry.get(c.remoteRoot)?.status).toBe("idle");
			expect(senderSettled).toBe(false);
			expect(b.barriers.filter(frame => frame.peerId === c.remoteRoot)).toEqual([]);

			c.server.emitReplyDrainedBarrier(runId, 4, 0);
			const barrierEntry = await b.transcript.waitForFrame(entry =>
				entry.direction === "client->server" && managedIrcFrameKind(entry.frame) === "reply_drained_barrier" &&
				isRecord(entry.frame) && isRecord(entry.frame.frame) && entry.frame.frame.peerId === c.remoteRoot &&
				entry.frame.frame.runId === runId, beforeRun);
			await b.server.settle();
			expect(barrierEntry.frame).toEqual({
				type: "managed_irc", generation: b.coordinatorBinding.generation,
				frame: { kind: "reply_drained_barrier", peerId: c.remoteRoot, runId, runStatusRevision: 4, outboundWatermark: 0 },
			});
			const result = await withTimeout(sender, 2_000, "C's barrier did not release B's native no-reply waiter");
			expect(result.kind).toBe("error");
			if (result.kind !== "error") throw new Error("B unexpectedly received a reply from C");
			expect(result.error).toBeInstanceOf(IrcAwaitTargetStopped);
			expect(b.remote.sessionFor(b.remoteRoot).delivered).toEqual([]);
			expect(b.transcript.frames.indexOf(startEntry)).toBeLessThan(b.transcript.frames.indexOf(endEntry));
			expect(b.transcript.frames.indexOf(endEntry)).toBeLessThan(b.transcript.frames.indexOf(barrierEntry));
			c.transcript.print("row4 C originates terminal and separate no-reply barrier");
			b.transcript.print("row4 older B native waiter follows C start, terminal, and authoritative barrier fanout");
		} finally {
			abort.abort();
			await b.stop();
		}
	});
});
