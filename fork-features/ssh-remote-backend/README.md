# SSH remote backend (issue #5)

Fork-side SSH launcher: looks up a known host via the existing SSH capability, builds an argv-only remote command, and returns a transport spec the managed RPC client can consume. Skeleton for [mouriya-s-lab#5](https://github.com/mouriya-s-lab/oh-my-pi/issues/5), on the fork side of the [RFC #1](https://github.com/mouriya-s-lab/oh-my-pi/issues/1) §5/§9 boundary (core keeps the public seams; the fork owns the SSH backend).

## Public API (`src/index.ts`)

- `lookupSshHost(name)` — resolves `name` against the existing SSH capability (`loadCapability`). Discovery ordering and source retention are unchanged: entries dedupe by name with first (highest-priority) winning, and the record keeps `source` mapped from `_source`.
- `buildRemoteCommand({ host, cwd, ... })` — argv-only remote command (`--mode rpc --rpc-subagent`); task text is never joined into argv. Extra SSH args are placed *before* the shared helper defaults because OpenSSH uses first-value-wins for `-o`: strict host-key pinning (`StrictHostKeyChecking=yes`) and the temp ControlPath override the helper's `accept-new`/shared path. Stdin is always kept (never `-n`) so the RPC protocol survives.
- `createManagedRpcTransport(...)` — composes lookup + command into a transport spec; throws with `availableNames` on unknown host. `keepMasterOpen` means the consumer must never terminate the shared master.

## Upstream rule

Exactly one barrel line lives upstream, in `packages/coding-agent/src/fork/ssh-remote-backend.ts`:

```ts
export * from "../../../../fork-features/ssh-remote-backend/src";
```

The only other upstream touch is the `export` keyword on `buildCommonArgs` (`packages/coding-agent/src/ssh/connection-manager.ts`), a minimal reuse seam with no behavioural change. No `TaskTool` wiring — that lands under [#7](https://github.com/mouriya-s-lab/oh-my-pi/issues/7).

## Consuming it

```ts
const transport = await createManagedRpcTransport({ name: "fishbox", cwd: "/tmp/work" });
const client = new RpcClient({ command: () => [...transport.command], expectManagedBootstrap: true });
```

`command` as an array is an argv *prefix* (the client appends its RPC args), so pass the builder form returning a copy — never the array itself — to avoid appended args.

## Tests

`test/loopback.integration.test.ts` proves ready + `get_state` + `abort` against an isolated loopback sshd. That is transport verification only; the full heterogeneous OS/version matrix lands under [#10](https://github.com/mouriya-s-lab/oh-my-pi/issues/10).
