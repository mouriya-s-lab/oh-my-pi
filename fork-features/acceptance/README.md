# C1–C13 dual-remote acceptance harness (RFC #1 stage-2, issue #14)

Operator-facing scaffold for the cross-host acceptance matrix defined in
[RFC §10.3](https://github.com/mouriya-s-lab/oh-my-pi/issues/1) (issue #1).
It does NOT implement the matrix: as of this commit the matrix is **BLOCKED**
per RFC §10.1 — see `env-prerequisites.md`.

## What is runnable today

- `run-baseline.sh [OUT_DIR]` — captures the B1–B4 baseline from RFC §10.2
  against the locally installed `omp` binary. Fresh evidence lands in
  `/Users/mouriya/Ext/work/omp-remote-agents/08b-matrix/2026-09-12-issue14-baseline/`
  by default. Re-running overwrites the same files; no credentials involved.
- `run-c1-c3.sh`, `run-c4-c6.sh`, `run-c7-c8.sh`, `run-c9-c11.sh`,
  `run-c12-c13.sh` — placeholders. Each prints `BLOCKED` and exits `78`
  (`EX_CONFIG`) until the prerequisites are satisfied.

## The matrix

`matrix.md` reproduces the 13 acceptance rows verbatim from RFC §10.3, plus a
runtime-bindings section (`R1`/`R2`/`R3`/`S`/`J`) left as placeholders. `R` is
an actually created remote peer, `S` an actual local/another-remote peer, `J`
an actual job — output bindings, not reusable aliases. `hub(...)` is the
native tool call shape, not a shell command.

## Wire-shape note

Request frames carry the command in `type`
(e.g. `{"id":"b2-2","type":"get_subagents"}`), per RFC §10.2 and
`packages/coding-agent/src/modes/rpc/rpc-types.ts`. A
`{"type":"command","command":"..."}` envelope is rejected with
`Unknown command: command`; that rejection describes the envelope, not the
upstream protocol, so `run-baseline.sh` sends the `type`-carries-command
shape. Likewise the B3 hub-conflict probe must pass host-tool validation
(`name` + `description` + `parameters`) to reach the native-hub conflict
check; a bare `{"name":"hub","schema":{}}` stops earlier at a
must-provide-description refusal, which is a different refusal and NOT the
RFC B4 baseline.

## Prior experimental evidence

`/Users/mouriya/Ext/work/omp-remote-agents/08b-matrix/` holds earlier
single-machine experiments (d01–d20, e02–e06, b2, b4, c13). Per RFC §10.3
they are experimental results listed separately and do NOT count as C1–C13
passed. Nothing in this directory re-labels them.
