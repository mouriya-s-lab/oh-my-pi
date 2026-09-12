# Parameter execution domain (D6)

Canonical interpretation for [RFC #1 §7 / D6](https://github.com/mouriya-s-lab/oh-my-pi/issues/1), implemented by [slice #12](https://github.com/mouriya-s-lab/oh-my-pi/issues/12). `task/params.ts` distills entry aliases into `RunContract` and `LocalOnlyContext`. A field omitted by the caller remains absent: it is not filled from the coordinator's agent, model registry, kernel, credentials, plugin environment, MCP instances or session persistence. The selected execution domain owns its defaults and validates explicit requests.

`task` in the Entry column includes flat and per-item batch requests; eval means `agent()`; workpool means creation options plus pushed items. Unsupported entry syntax fails rather than disappearing. Target normalization and authorization retain their separate D1 contract.

| Parameter | Entry (task/eval/workpool) | Semantics | Wire? | Conflict handling |
| --- | --- | --- | --- | --- |
| `agent` | task/eval/workpool | Explicit role only. Local D1 defaults apply only to local execution; an omitted remote role is selected by remote preparation. | Explicit value only | Role/authorization mismatch fails; no local same-name fallback. |
| `task/prompt` | task/eval/workpool | Verbatim work text; entry alias normalizes to `task`, not a locally rewritten prompt. | Yes | Missing or non-string work text is `invalid-shape`; conflicting aliases fail. |
| `context` | task/eval/workpool | Explicit shared context remains separate verbatim work text. No parent transcript or implicit namespace is attached. | Yes | Invalid shape or conflicting aliases fail. |
| `name/label` | task/eval/workpool | Coordinator-assigned peer identity and display label. | No | Kept only in `LocalOnlyContext`; not remote role/model configuration. |
| `parent` | task/eval/workpool | Coordinator routing ownership, not a transferable session. | No | Kept only in `LocalOnlyContext`; no parent session serialization. |
| `model` (explicit) | — (REJECTED) | Never accepted on any entry. A caller-supplied `model` fails distillation with `unknown-parameter` (`field: "model"`); per upstream `b8779dae63` the execution domain owns model selection and no coordinator or caller registry is consulted. | Never on the wire | Rejected at the boundary, not defaulted or forwarded. |
| `handle` | task/eval/workpool | Eval-entry alias for `retainArtifacts`: `handle: true` sets `retainArtifacts: true` in the distilled contract so an `agent://` handle keeps its temporary artifacts directory. | Via `retainArtifacts` | Non-boolean shape is `invalid-shape`; downstream retention/support failures keep their own codes. |
| `effort` | task/eval/workpool | Literal `lo`, `med` or `hi`; execution domain resolves its own ladder. | Explicit literal only | Invalid literal is `invalid-shape`; never locally expand remote effort into a provider/model name. |
| `outputSchema` | task/eval/workpool (`schema` is eval alias) | Opaque explicit schema overrides role schema; output executor validates there. Coordinator validates returned protocol, never reruns the model. | Explicit value only | Invalid schema fails; strict invalid payload is `strict-schema-unsatisfied` with field-level detail. |
| `schemaMode` | task/eval/workpool | Explicit `strict` or `permissive`; remote output executor owns acceptance. | Explicit value only | Invalid mode fails; strict failure cannot become plain-text success. |
| `tools` | task/eval/workpool | Explicit names authorize only corresponding host callbacks in the original kernel. Arguments/results travel through named calls; kernel objects and implicit namespace do not. | Explicit allowlist only; callback invocation retains its call ID | Native-name collision or ungranted callback is `host-tool-denied`; remote policy denying a grant is `conflict-with-remote-policy`. Never shadow native tools. |
| `isolated` | task/eval/workpool | Isolation in the selected cwd's repository, using that execution domain's VCS. No clone of the coordinator repository. | Explicit boolean only | Unsupported isolation is `isolation-unsupported` before workspace writes. |
| `apply` | task/eval/workpool | Applies isolation output only to the selected cwd repository. Remote execution never applies to the coordinator repository. | Explicit boolean only | Unsupported/conflicting workspace policy fails; return references only. |
| `merge` | task/eval/workpool | Explicit `auto`, `manual` or `false`, interpreted by the workspace-owning executor. | Explicit value only | Invalid/conflicting merge policy fails; no auto-fetch or local patch application. |
| `keepAlive` | task/eval/workpool | Controls execution-domain worker retention, not coordinator process persistence. | Explicit boolean only | Unsupported retention fails; no forced persistence configuration. |
| `retainArtifacts` | task/eval/workpool | Controls artifacts in the execution domain. Coordinator stores returned references only. | Explicit boolean only | Unsupported retention fails; no artifact mirroring. |
| `detached` | task/eval/workpool | Coordinator scheduling/presentation only, not remote daemon/nohup semantics. | No | Distilled into local context; never enables remote persistence. |
| `timeout` | task/eval/workpool | Seconds; coordinator deadline is an upper bound across endpoints, with execution-domain limits also enforced. | Explicit bound only | Effective allowance is the smaller bound; expiration stops admission/execution, never resets on host switch. |
| `budget` | task/eval/workpool | Coordinator's cumulative cost allowance across endpoints; remote may tighten it. | Explicit bound only | Exhausted ledger rejects further work; host switch cannot replenish spend. |
| `depth` | task/eval/workpool | Coordinator delegation-depth upper bound and execution-domain restriction both apply. | Explicit bound only | Deeper delegation cannot loosen either limit. |
| `spawns` | task/eval/workpool | Coordinator cumulative spawn allowance across all endpoint selections. | Explicit bound only | Exhaustion rejects admission; changing host does not reset count. |
| `workpool items` | workpool | Stable ULID per item assigned when pushed, with per-item progress/result. First and later pushes use the same bound endpoint. | Explicit item IDs and work text | Invalid item shape fails; no local-session fallback or ID reassignment. |
| `freshAgents` | workpool | New subagent per item, on the same bound endpoint; not a new endpoint or borrowed local session. | Explicit boolean only | Unsupported fresh-worker semantics fail, never silently reuse a session. |

## Result and failure ownership

`ParamsError` has one of `unknown-parameter`, `invalid-shape`, `conflict-with-remote-policy`, `isolation-unsupported`, `strict-schema-unsatisfied`, or `host-tool-denied`. A failed contract is failed work, not a retry on the coordinator and not a successful result with a warning. `RunOutcome` retains structured parameter error information. When remote repository work produces artifacts, `remoteArtifacts` contains `repoRef` and optional `branch` / `patchRef`; the coordinator does not fetch, mirror or apply them.

Host callbacks are explicit capability grants, not serialized functions. Native tool names retain authority. Remote policy can deny a requested callback before any invocation. No implicit kernel, MCP, plugin, environment, credential or session state crosses the contract boundary.

## Existing lifecycle semantics

Eval handle `wait()` refers only to the initial job; later `send()` responses use Hub/history. A wait timeout does not cancel the job. Workpools have no `pool.wait()`; Hub waits address `pool.name`. The first full drain closes a pool, so keep-alive follow-up work must be pushed before that boundary. `freshAgents` controls worker reuse independently of endpoint identity. Park/revive/hard-abort ownership remains the endpoint lifecycle contract. TUI-only custom components/editor/theme/raw-input hooks are not fabricated remotely.

## Deferred (blocked pending)

The six parameter acceptance rows use local fake remote execution, output and VCS fixtures. They are not evidence of real heterogeneous remote execution. [Issue #14](https://github.com/mouriya-s-lab/oh-my-pi/issues/14) owns real-remote model/rule differences (C10) and the full structured/interactive matrix (C12). Native task/workpool SSH routing consumer stubs remain the [issue #8 follow-up](https://github.com/mouriya-s-lab/oh-my-pi/issues/8); this slice does not migrate them.
