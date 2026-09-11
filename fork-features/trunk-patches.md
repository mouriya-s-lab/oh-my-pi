# Trunk patches

This directory records fork-specific changes that live in trunk source rather than behind an extension seam: each entry names the files touched, the behaviour change, and why the hook cannot be expressed through a supported extension point. Everything listed here is a rebase liability, so keep entries terse and current.

**Lifecycle rule:** every section here MUST collapse once upstream exposes an equivalent seam or the fork-side implementation moves out of core — delete the section in the same change that lands the replacement.

## `packages/coding-agent/src/task/` — execution target skeleton (issue #2)

- Files touched: `types.ts`, `index.ts`, plus new sibling `target.ts`.
- Change: optional `target: ExecutionTarget` on the flat task schema + `TaskParams`/`TaskItem`; runtime validation in `TaskTool.execute` before agent/model preflight; `kind: "local"` (or omitted) preserves the pre-existing local path, `kind: "ssh"` is rejected with a clear "endpoint not yet implemented" message.
- Why in trunk: the RFC #1 §8 D1 target rides the existing native `task` schema so the model sees one shape; no current extension seam lets a fork extend the arktype schema without editing `types.ts`. Track `mouriya-s-lab/oh-my-pi#7` for the equivalent seam plan.
- Slice: `mouriya-s-lab/oh-my-pi#2` (skeleton); #3–#7 land the endpoint, batch per-item routing, and the full D1 gate.

## `packages/coding-agent/src/task/` — endpoint contract skeleton (issue #3)

- Files touched: new `endpoint.ts`, `endpoint/local.ts`, `endpoint/index.ts`; one-line `export * from "./endpoint"` in the `task/index.ts` barrel. No monitor, registry, executor, or renderer source is edited.
- Change: the transport-agnostic `AgentEndpoint` contract (four methods plus `terminate`, the `RunOutcome`/`RunAck`/`PrepareResult` shapes, the shared `EndpointSnapshot` view, and `execution-unknown` as a transport-only verdict), with `LocalAgentEndpoint` as a passive adapter over an already-created `AgentSession`. The adapter stores its session as a handle, allocates a run id on `start()`, and delegates to caller-supplied `awaitTerminal` / `cancelRun` / `terminate` hooks — it creates no session, does no I/O, and takes no locks, so local behaviour is untouched.
- Boundary: nothing consumes the endpoint yet. `AsyncJob.status` and `AgentRegistry`'s `AgentStatus` are deliberately not widened, `TaskTool.execute` is not rewired, and the three `as*Snapshot()` views are not read by the `hub` job/list renderers. `mouriya-s-lab/oh-my-pi#8` owns that migration plus the status-union widening; the surface still unowned by any slice (`deliverIrc`, `replyQuiescence`, `park`, `ensureLive`, `readResource`, `respondUi`, `snapshot`, `subscribe`) is listed in the `AgentEndpoint` doc comment and lands under #8/#9/#11/#13.
- Why in trunk: the contract must be importable by both the executor path and the monitor/registry path, which live in `src/task/` and `src/async/` — no extension seam spans them, and a fork-side shim would only add a copy that drifts.
- Slice: `mouriya-s-lab/oh-my-pi#3` (skeleton); #7 gates `prepare`/`start`, #8 migrates monitor/registry consumers.

## packages/coding-agent/src/modes/rpc/ — managed bootstrap flag (issue #4)

- Files touched: `cli/args.ts`, `main.ts`, `modes/rpc/rpc-mode.ts`, `modes/rpc/rpc-types.ts`, `modes/rpc/rpc-client.ts`.
- Change: `--rpc-subagent` (rejected unless `--mode rpc`) passes `{ managed }` as the fifth `runRpcMode` argument; managed bootstrap declares a `nativeAgent` block on the `ready` frame, fast-paths `get_state`/`abort`/`abort_bash` off the serial command queue, and initiates in-flight cancellation on stdin EOF instead of draining silently. Legacy path unchanged when the flag is absent.
- Why in trunk: the managed bootstrap rides the existing native RPC `ready`/command-queue/stdin lifecycle so hosts see one shape; no current extension seam lets a fork extend the RPC bootstrap without editing the mode runner.
- Slice: `mouriya-s-lab/oh-my-pi#4` (skeleton, https://github.com/mouriya-s-lab/oh-my-pi/issues/4); heartbeat/lease/resume/full errors land under https://github.com/mouriya-s-lab/oh-my-pi/issues/9.

## fork-features/ssh-remote-backend/ — self-contained SSH launcher (issue #5)

- Files touched: `fork-features/ssh-remote-backend/src/lookup.ts`, `src/command.ts`, `src/transport.ts`, `src/index.ts` (barrel), `README.md`, `test/lookup.test.ts`, `test/command.test.ts`, `test/loopback.integration.test.ts`; upstream barrel `packages/coding-agent/src/fork/ssh-remote-backend.ts` carries exactly one line — `export * from "../../../../fork-features/ssh-remote-backend/src";` — and `packages/coding-agent/src/ssh/connection-manager.ts` gains only the `export` keyword on `buildCommonArgs`. No `TaskTool` wiring.
- Change: fork-side launcher that looks up a known host via the existing SSH capability, builds an argv-only remote command (`--mode rpc --rpc-subagent`, no task text, stdin preserved), and returns a transport spec the managed RPC client from [#4](https://github.com/mouriya-s-lab/oh-my-pi/pull/21) can consume. The loopback test proves ready + `get_state` + `abort` against an isolated sshd; it is not the heterogeneous backend.
- exposed `buildCommonArgs` for fork-side reuse; no behavioural change.
- Why in trunk: the launcher must reuse the shared ssh argv builder so fork-side flags stay consistent with the native path; no extension seam exposes it, so the minimal seam is the one-keyword export. The endpoint wiring lands under [#7](https://github.com/mouriya-s-lab/oh-my-pi/issues/7) and the full backend heterogeneous OS/version matrix + trunk delta under [#10](https://github.com/mouriya-s-lab/oh-my-pi/issues/10).
- Slice: `mouriya-s-lab/oh-my-pi#5` (skeleton, https://github.com/mouriya-s-lab/oh-my-pi/issues/5).
