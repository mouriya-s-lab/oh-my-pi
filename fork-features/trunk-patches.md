# Trunk patches

This directory records fork-specific changes that live in trunk source rather than behind an extension seam: each entry names the files touched, the behaviour change, and why the hook cannot be expressed through a supported extension point. Everything listed here is a rebase liability, so keep entries terse and current.

**Lifecycle rule:** every section here MUST collapse once upstream exposes an equivalent seam or the fork-side implementation moves out of core — delete the section in the same change that lands the replacement.

## `packages/coding-agent/src/task/` — execution target skeleton (issue #2)

- Files touched: `types.ts`, `index.ts`, plus new sibling `target.ts`.
- Change: optional `target: ExecutionTarget` on the flat task schema + `TaskParams`/`TaskItem`; runtime validation in `TaskTool.execute` before agent/model preflight; `kind: "local"` (or omitted) preserves the pre-existing local path, `kind: "ssh"` is rejected with a clear "endpoint not yet implemented" message.
- Why in trunk: the RFC #1 §8 D1 target rides the existing native `task` schema so the model sees one shape; no current extension seam lets a fork extend the arktype schema without editing `types.ts`. Track `mouriya-s-lab/oh-my-pi#7` for the equivalent seam plan.
- Slice: `mouriya-s-lab/oh-my-pi#2` (skeleton); #3–#7 land the endpoint, batch per-item routing, and the full D1 gate.
