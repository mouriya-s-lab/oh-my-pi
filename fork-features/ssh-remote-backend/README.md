# SSH remote backend

The directly invocable backend for [mouriya-s-lab#10](https://github.com/mouriya-s-lab/oh-my-pi/issues/10) consumes the native SSH discovery, managed RPC and endpoint interfaces. It does not create a second task executor or copy local configuration onto a peer.

## Public API

- `factory.ts`: `createSshBackendEndpoint(target, params?, deps?)` and `createSshBackendFactory(deps?).prepare(target, params?)` open a managed peer and return a concrete `AgentEndpoint`. `sshEndpointFactory` implements the public callback type from `task/dispatch.ts`; it accepts only SSH targets.
- `lookup.ts`: `resolveSshHost(alias, context?)` performs one existing capability load and returns the untouched record plus its project/user-agent/legacy-project source. A missing user agent directory or unknown alias is an explicit error. The discovery context is local; the remote target's cwd/profile never changes local host discovery.
- `command.ts`: `buildSshBackendCommand` returns separate local SSH and remote argv. The remote words are exactly the executable plus `--mode rpc --rpc-subagent`. `buildCommonArgs` receives `allowStdin: true`, and `StrictHostKeyChecking=yes` takes precedence over the helper's first-contact default.
- `executable-probe.ts`: absolute executables incur no probe. Other names use non-interactive `command -v`; only a single absolute, shell-inert result is accepted. Missing executables never produce a fabricated installation path.
- `transport.ts`: `openSshBackendTransport` owns one local SSH child and exposes its managed `RpcClient`, actual exit promise and resolved executable metadata. `endInput()` closes stdin and waits for the SSH exit; `close()` releases only that peer. OpenSSH owns the shared control socket, and production teardown never issues master `-O exit`.

The upstream barrel `packages/coding-agent/src/fork/ssh-remote-backend.ts` re-exports the factory. The complete upstream delta, including the pre-profile bootstrap hook and managed-event listener, is recorded in [`../trunk-patches.md`](../trunk-patches.md).

## Direct invocation

```ts
const endpoint = await createSshBackendEndpoint({
  kind: "ssh",
  host: "build-host",
  cwd: "/srv/work",
  executable: "/opt/bin/omp",
});
try {
  const prepared = await endpoint.prepare();
  const ack = await endpoint.start(assignment);
  const outcome = await endpoint.run(ack.runId, signal);
  await endpoint.waitReplyDrained(ack.runId, { signal });
} finally {
  await endpoint.terminate();
}
```

The peer applies cwd/profile and resolves its starting role before session construction. Prepare returns the role the peer actually selected and capabilities from its ready frame. Assignment text travels only through RPC stdin. Run IDs and terminal/reply-drained facts come from the peer; transport loss is `execution-unknown`, never a fabricated task failure or local retry.

## Current integration boundary

Native task/eval/workpool callers still reject SSH targets. Migrating those execution drivers to the endpoint callback, including mixed batches and persistent follow-ups, is a core-owned [#8](https://github.com/mouriya-s-lab/oh-my-pi/issues/8) follow-up. Exporting the factory does not claim that task-tool routing is enabled. Heterogeneous host/PATH/version verification remains under [#14](https://github.com/mouriya-s-lab/oh-my-pi/issues/14).

The `src/` launcher is retained for the frozen [#6](https://github.com/mouriya-s-lab/oh-my-pi/issues/6) evidence. Its historical loopback test is not the production factory entry point, and the frozen evidence is not regenerated here.

## Verification

`test/lookup.test.ts` and `test/command.test.ts` cover discovery/error/argv/probe boundaries. `test/factory.integration.test.ts` and `test/transport-single-peer-release.test.ts` invoke the factory against the real isolated sshd helper, pinned host keys and an absolute-Bun wrapper for the actual CLI. They check remote cwd, named-profile `.env` selection before initialization, control responses, endpoint lifecycle, stdin EOF and shared-master survival. `test/hygiene.test.ts` checks forbidden direct internal references with a TypeScript AST, the re-export-only barrel and the trunk-patches ledger.
