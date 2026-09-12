#!/usr/bin/env bash
# B1–B4 baseline capture for RFC #1 stage-2 slice #14.
#
# Records the upstream `omp --mode rpc --no-session` assumption baseline from
# RFC §10.2 (B1 environment, B2 command channel, B3 irc_message refusal,
# B4 hub name-conflict refusal) against the locally installed binary.
# This is NOT C1–C13 evidence: everything here runs on one machine with the
# upstream binary, no SSH, no second remote.
#
# Wire-shape note: request frames carry the command in `type`
# (e.g. `{"id":"...","type":"get_subagents"}`), per RFC §10.2 and
# `packages/coding-agent/src/modes/rpc/rpc-types.ts`. A
# `{"type":"command","command":"..."}` envelope is rejected with
# `Unknown command: command`; that rejection describes the envelope, not the
# upstream protocol, so this script sends the `type`-carries-command shape.
#
# Usage: fork-features/acceptance/run-baseline.sh [OUT_DIR]
# Idempotent: re-running overwrites the same files with fresh output.
# No credentials are read, written, or transmitted.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-/Users/mouriya/Ext/work/omp-remote-agents/08b-matrix/2026-09-12-issue14-baseline}"
mkdir -p "$OUT_DIR"

TIMEOUT=""
if command -v timeout >/dev/null 2>&1; then
	TIMEOUT="timeout 120"
fi

# --- B1: environment -------------------------------------------------------
$TIMEOUT omp --version > "$OUT_DIR/b1.txt"
printf '# NOTE: upstream production binary (bun global install), NOT a fork build from this branch.\n' >> "$OUT_DIR/b1.txt"

git -C "$REPO_ROOT" rev-parse HEAD > "$OUT_DIR/b1-sha.txt"

{
	command -v omp
	python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$(command -v omp)"
	realpath "$REPO_ROOT/packages/coding-agent/src/cli.ts" 2>/dev/null \
		|| python3 -c "import os; print(os.path.realpath('$REPO_ROOT/packages/coding-agent/src/cli.ts'))"
} > "$OUT_DIR/b1-entry.txt"

# --- B2: command channel ----------------------------------------------------
B2_RAW="$(mktemp)"
trap 'rm -f "$B2_RAW" "$B3_RAW"' EXIT
printf '%s\n' \
	'{"id":"b2-1","type":"set_subagent_subscription","level":"events"}' \
	'{"id":"b2-2","type":"get_subagents"}' \
	'{"id":"b2-3","type":"abort"}' \
	'{"id":"b2-4","type":"irc_message","message":{"role":"custom","customType":"irc:relay","content":"hi","display":true,"details":{"from":"probe","to":"main"},"attribution":"agent","timestamp":0}}' \
	| $TIMEOUT omp --mode rpc --no-session > "$B2_RAW"

{
	grep -m1 '"command":"set_subagent_subscription"' "$B2_RAW"
	grep -m1 '"command":"get_subagents"' "$B2_RAW"
	grep -m1 '"command":"abort"' "$B2_RAW"
	grep -m1 '"command":"irc_message"' "$B2_RAW"
} > "$OUT_DIR/b2.txt"

# --- B3: hub name-conflict refusal ------------------------------------------
# The probe must pass host-tool validation (name + description + parameters)
# to reach the native-hub conflict check; a bare {"name":"hub","schema":{}}
# stops earlier at `Host tool "hub" must provide a non-empty description`,
# which is a different refusal and NOT the RFC B4 baseline.
B3_RAW="$(mktemp)"
printf '%s\n' \
	'{"id":"b3-1","type":"set_host_tools","tools":[{"name":"hub","description":"issue-14 baseline hub-conflict probe","parameters":{"type":"object","properties":{}}}]}' \
	| $TIMEOUT omp --mode rpc --no-session > "$B3_RAW"

grep -m1 '"command":"set_host_tools"' "$B3_RAW" > "$OUT_DIR/b3-hub-conflict.txt"

# --- B4: concatenated raw responses -----------------------------------------
cp "$OUT_DIR/b2.txt" "$OUT_DIR/b4.txt"

echo "baseline written to $OUT_DIR"
wc -c "$OUT_DIR"/b1.txt "$OUT_DIR"/b1-sha.txt "$OUT_DIR"/b1-entry.txt "$OUT_DIR"/b2.txt "$OUT_DIR"/b3-hub-conflict.txt "$OUT_DIR"/b4.txt
