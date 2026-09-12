# Environment prerequisites for C1–C13 (issue #14)

All unchecked as of 2026-09-12. Each row states the gap and concretely how
to satisfy it. Until every row is checked, `run-c*.sh` stay BLOCKED and exit
78 per RFC §10.1.

- [ ] **1. Forked binary deployed.** The stage-2 slices live on stacked
  branches, not on `main`, and no deployable fork binary exists. How to
  satisfy: merge PRs #19–#30 to `main`, then build the fork CLI
  (`packages/coding-agent/src/cli.ts`) into an installable binary.
- [ ] **2. PRs #19–#30 merged to `main`.** RFC #14 depends on all seven Full
  slices. How to satisfy: land the stacked chain in order; only then does a
  `main`-built binary contain the D1–D7 backend.
- [ ] **3. OMP SSH capability configured on two hosts.** `omp ssh` currently
  reports "No SSH hosts configured". How to satisfy (operator-side, not in
  this repo): `omp ssh add <name> --host <address>` for each of the two
  independent remotes, reusing the existing `~/.ssh/config` aliases. Agent
  changes must not touch user SSH/OMP capability config.
- [ ] **4. Second independent remote identified.** Only `cachyos` has an
  existing `~/.omp/remote-host/` entry. How to satisfy: evaluate a second
  host (`server`, `alicorn-dev`, or equivalent), confirm reachability and a
  resolvable remote `omp` executable + absolute `cwd`, and record the
  discovery source, version, and capabilities per RFC §10.1.
- [ ] **5. Remote model access verified.** RFC §10.1 requires "远端模型访问与
  测试目录的既有授权来源". How to satisfy: confirm each remote already has
  model API authorization and a writable test directory via its own existing
  config/secret path; reuse, never paste credentials into tasks or logs.
- [ ] **6. Cross-version pair identified.** C11 needs two compatible-version
  runs plus one missing-capability run. How to satisfy: install or locate a
  second OMP build at a different version on one remote and record both
  versions and their negotiated capability sets.
