import { describe, expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeBridge(opts?: { streaming?: boolean }) {
	const woken: AgentMessage[][] = [];
	const steered: AgentMessage[] = [];
	let streaming = opts?.streaming ?? false;
	const host = {
		isDisposed: () => false,
		isStreaming: () => streaming,
		planModeEnabled: () => false,
		settings: { get: () => false },
		emitSessionEvent: async () => {},
		wakeForIrc: (records: AgentMessage[]) => {
			woken.push(records);
		},
		agent: {
			steer: (message: AgentMessage) => {
				steered.push(message);
			},
		},
	} as unknown as IrcBridgeHost;
	return {
		bridge: new IrcBridge(host),
		woken,
		steered,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
}

function registerLocalTree(registry: AgentRegistry): void {
	const localEndpoint = { kind: "local", session: null, sessionFile: null } as const;
	registry.register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", endpoint: localEndpoint });
	registry.register({
		id: "worker-1",
		displayName: "worker-1",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		endpoint: localEndpoint,
	});
	registry.register({
		id: "worker-2",
		displayName: "worker-2",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		endpoint: localEndpoint,
	});
}

function aliasLocalPeer(registry: AgentRegistry, nativeId: string, canonicalId: string): void {
	registry.registerManagedLocalAlias({
		identity: { canonicalId, nativeId, ownerPeerId: "canon-main", generation: 1 },
	});
}

describe("IrcBridge wake-relay marking", () => {
	it("marks relay messages so the peer never relays them back", async () => {
		const registry = new AgentRegistry();
		const globalSpy = spyOn(AgentRegistry, "global").mockReturnValue(registry);
		try {
			const { bridge, woken } = makeBridge();
			const ts = 1_700_000_000_000;
			const outcome = await bridge.deliver(
				{ id: "irc-1", from: "B", to: "A", body: "You hang up", ts, wakeRelay: true },
				undefined,
			);

			expect(outcome).toBe("woken");
			expect(woken).toHaveLength(1);
			const record = woken[0][0] as CustomMessage;
			expect(record.details).toMatchObject({ from: "B", wakeRelay: true });
			expect(record.timestamp).toBe(ts);
		} finally {
			globalSpy.mockRestore();
		}
	});

	it("leaves genuine messages without relay marking", async () => {
		const registry = new AgentRegistry();
		const globalSpy = spyOn(AgentRegistry, "global").mockReturnValue(registry);
		try {
			const { bridge, woken } = makeBridge();
			const ts = 1_700_000_000_001;
			const outcome = await bridge.deliver(
				{ id: "irc-2", from: "B", to: "A", body: "status?", ts },
				undefined,
			);

			expect(outcome).toBe("woken");
			expect(woken).toHaveLength(1);
			const record = woken[0][0] as CustomMessage;
			expect(record.details).not.toHaveProperty("wakeRelay");
			expect(record.details).toMatchObject({ from: "B", message: "status?" });
			expect(record.timestamp).toBe(ts);
		} finally {
			globalSpy.mockRestore();
		}
	});

	it("steers canonical parent messages while queueing canonical siblings verbatim", async () => {
		const registry = new AgentRegistry();
		registerLocalTree(registry);
		aliasLocalPeer(registry, MAIN_AGENT_ID, "canon-main");
		aliasLocalPeer(registry, "worker-1", "canon-worker-1");
		aliasLocalPeer(registry, "worker-2", "canon-worker-2");
		const globalSpy = spyOn(AgentRegistry, "global").mockReturnValue(registry);
		try {
			const { bridge, steered } = makeBridge({ streaming: true });
			const ts = 1_700_000_000_010;

			const parentMsg = { id: "irc-parent-1", from: "canon-main", to: "canon-worker-1", body: "keep going", ts };
			const parentSnapshot = { ...parentMsg };
			const parentOutcome = await bridge.deliver(parentMsg, undefined);

			expect(parentOutcome).toBe("injected");
			expect(steered).toHaveLength(1);
			expect(steered[0].timestamp).toBe(ts);
			expect(parentMsg).toEqual(parentSnapshot);
			expect(bridge.hasPending()).toBe(false);

			const siblingMsg = {
				id: "irc-sibling-1",
				from: "canon-worker-2",
				to: "canon-worker-1",
				body: "hey neighbor",
				ts,
			};
			const siblingSnapshot = { ...siblingMsg };
			const siblingOutcome = await bridge.deliver(siblingMsg, undefined);

			expect(siblingOutcome).toBe("injected");
			expect(steered).toHaveLength(1);
			expect(siblingMsg).toEqual(siblingSnapshot);
			expect(bridge.hasPending()).toBe(true);
			const pending = bridge.drainPending();
			expect(pending).toHaveLength(1);
			const queued = pending[0] as CustomMessage;
			expect(queued.details).toMatchObject({
				id: "irc-sibling-1",
				from: "canon-worker-2",
				message: "hey neighbor",
			});
			expect(queued.timestamp).toBe(ts);
		} finally {
			globalSpy.mockRestore();
		}
	});

	it("renders the same wake card for native Main and its canonical alias", async () => {
		const nativeRegistry = new AgentRegistry();
		nativeRegistry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			endpoint: { kind: "local", session: null, sessionFile: null },
		});
		const canonicalRegistry = new AgentRegistry();
		canonicalRegistry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			endpoint: { kind: "local", session: null, sessionFile: null },
		});
		canonicalRegistry.registerManagedLocalAlias({
			identity: { canonicalId: "canon-main", nativeId: MAIN_AGENT_ID, ownerPeerId: "canon-main", generation: 1 },
		});

		const sender = "B";
		const body = "status?";
		const ts = 1_700_000_000_020;

		const nativeSpy = spyOn(AgentRegistry, "global").mockReturnValue(nativeRegistry);
		let nativeRecord: CustomMessage;
		try {
			const { bridge, woken } = makeBridge();
			const outcome = await bridge.deliver(
				{ id: "irc-root", from: sender, to: MAIN_AGENT_ID, body, ts },
				undefined,
			);
			expect(outcome).toBe("woken");
			expect(woken).toHaveLength(1);
			nativeRecord = woken[0][0] as CustomMessage;
		} finally {
			nativeSpy.mockRestore();
		}

		const canonicalSpy = spyOn(AgentRegistry, "global").mockReturnValue(canonicalRegistry);
		try {
			const { bridge, woken } = makeBridge();
			const outcome = await bridge.deliver(
				{ id: "irc-root", from: sender, to: "canon-main", body, ts },
				undefined,
			);
			expect(outcome).toBe("woken");
			expect(woken).toHaveLength(1);
			const canonicalRecord = woken[0][0] as CustomMessage;
			expect(canonicalRecord.content).toBe(nativeRecord.content);
			expect(canonicalRecord.details).toMatchObject({ from: sender, message: body });
			expect(canonicalRecord.details).not.toHaveProperty("wakeRelay");
			expect(canonicalRecord.timestamp).toBe(ts);
		} finally {
			canonicalSpy.mockRestore();
		}
	});
});
