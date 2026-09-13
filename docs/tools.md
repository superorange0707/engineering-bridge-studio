# MCP tool reference

The Codex plugin provides two workspace entry tools and, after setup, nineteen project tools. The underlying Bridge STDIO server continues to expose the nineteen project tools directly for Web connections.

## Studio and setup

| Tool | Purpose |
| --- | --- |
| `bridge_studio` | Start or reuse the local Studio workspace and return its URL. Available before project setup. Open it in the current task's browser panel; it does not start an experiment. |
| `bridge_setup_status` | Check project setup and refresh the delegated project tools in the current session. Returns setup errors without making the workspace entry unavailable. |

Studio uses the same project tools below. Its browser API is a bounded adapter, not a second execution engine or a separate experiment store.

## Engineering and research collaboration

ChatGPT Web supplies the plan and reviews evidence; Codex executes in a separate writable run directory. Source-project files remain outside that writable root. Local configuration must explicitly include the source workspace UUID in `collaboration.execution_workspace_ids` before execution; the list defaults empty and is independent of controlled-APPLY authorization.

This list controls permission to start execution. Removing a workspace from it prevents new runs; existing evidence remains readable, and lifecycle review/interrupt operations remain available without starting another executor. A `localReadOnly` runtime rejects all three mutating collaboration tools. The Bridge uses its authenticated client connection as the access boundary, not per-Web-user roles.

| Tool | Purpose |
| --- | --- |
| `collaboration_run` | Persist an engineering/research contract, copy declared safe inputs and start a bounded network-off Codex run. Accepts a client-generated `request_id` UUID, `workspace_id`, `contract`, optional `input_files` and `parent_run_id`. Retry a lost response using the same ID and unchanged payload; new experiments use new IDs. |
| `collaboration_result` | Poll or recover one durable run, its evidence, artifact manifest and review. |
| `collaboration_history` | Recover paginated summaries using `workspace_id`, optional `offset` (default 0) and `limit` (default 20, max 50). Follow `next_offset`; retrieve full contracts with `collaboration_result`. |
| `collaboration_artifact` | Read a declared artifact by run ID and path after verifying its complete hash. Optional `offset_bytes` and `max_bytes` return at most 64 KiB per call; follow `next_offset_bytes` until `eof`. |
| `collaboration_review` | Persist the Web supervisor's `accept`, `revise` or `reject` judgment and feedback. This does not APPLY source changes or publish anything. |
| `collaboration_interrupt` | Persist cancellation intent and make a bounded stop request. `interrupting` and `ready=false` mean it is still settling; poll `collaboration_result`. Repeated cancellation is safe. |

Contracts contain `domain`, `objective`, `plan`, `acceptance_criteria` and `expected_artifacts`. Research metadata records question, hypothesis, baselines, data, split, seeds, metrics and protocol. Tool schemas from `tools/list` are authoritative. Artifacts and model prose are untrusted evidence; completed execution is not a verified research finding. See the [workflow guide](chatgpt-codex-workflow.md) for the full Web → Codex → evidence → Web loop.

Artifact `bytes` and `sha256` describe the whole verified file. `chunk_bytes` and `offset_bytes` describe only this response. Text pages use `content`; binary data or a page splitting a UTF-8 character uses `content_base64`. Decode each page to bytes and concatenate in offset order before parsing a large JSON file or comparing the whole-file hash. A partial page must never be treated as a complete result. History objectives longer than 512 characters carry an explicit truncation marker.

Cancellation intent is written before waiting for the executor, and the wait is bounded to five seconds. An executor acknowledgment alone does not certify that the execution has stopped: active execution remains `interrupting` until its terminal result arrives. A restarted pending cancellation becomes `interrupted` without replay. This adopts the deadline and cancellation separation used by [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web), with the Bridge's durable run identity instead of its browser-turn broker.

## `run_task`

Inputs: `workspace_id`, `instruction`, optional `executor` (`"codex" | "dsh"`, default `codex`), optional Codex `routing` (`auto`, `implementer`, `local_lead`, or `repo_principal`), and optional linked-task fields `parent_task_id` plus `handoff_snapshot`.

Starts a supervised task with the selected executor and returns `task_id`. Codex defaults to `routing=auto`; explicit logical-role selection is an advanced override. DSH rejects all Codex routing/handoff fields. Callers cannot provide a model or reasoning effort. The central registry currently maps `implementer`, `local_lead`, and `repo_principal` to `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`, each with reasoning `max` and summary `concise`. Future generations change the registry, not routing/business logic. Before starting/resuming any thread, Bridge queries `model/list` with hidden models included and fails closed unless every configured exact model advertises `max`.

Automatic routing is deliberately conservative: high-risk or architectural work selects `repo_principal`; only clearly bounded implementation selects `implementer`; uncertain work selects `local_lead`. A linked cross-role task requires a bounded `handoff_snapshot` and starts a new native thread rather than changing the parent thread's model. Snapshot fields are `objective`, `current_state`, `plan_reference`, `changed_files`, `git_state`, `confirmed_facts`, `important_decisions`, `rejected_or_failed_approaches`, `test_status`, `current_blocker`, `decision_required`, and `relevant_evidence`. It transfers bounded state/evidence, not chat history.

`run_task` is always read-only: Codex uses approval `never`, a read-only sandbox policy, and disabled network access; DSH is pinned read-only per process. An unknown workspace becomes a failed task; it does not grant access to a new path. Executor and Codex role are fixed for the task lifetime.

## `task_result`

Input: `task_id`.

Returns the task state, readiness, fixed `executor`, and current bounded `evidence`. Queued and running tasks have `ready: false`. A successful turn has state `waiting_for_supervisor_review`, `ready: true`, and `review_output`. After acceptance, state is `completed` and the reviewed text is returned as `output`. Failures return a safe `{code,message}` error. An unknown task ID returns `UNKNOWN_TASK`.

Conditional fields:

- `thread_id`: present only for Codex tasks once a real native app-server thread exists. DSH headless has no machine-resumable session seam, so DSH tasks never carry a fabricated `thread_id`.
- `routing`, `logical_role`, `routing_reason`, `model`, `reasoning_effort`, and `codex_version`: Codex routing metadata. The effort is always `max`.
- `parent_task_id`, `routing_transition`, and `handoff_snapshot`: present for linked handoffs/escalations/de-escalations.
- `partial_output`: present only when a genuine interrupt produced real partial output (for example, DSH cached partial stdout or the last completed Codex agent message). The task state is still `failed`; `partial_output` is never completed `output` and never appears in `error`.

`evidence` contains bounded command-execution and file-change items. When the existing bounds truncate or evict evidence, explicit markers are returned: strings cut by the size bound end with `[truncated]`, an oversized changes list gains a `[truncated: N additional changes omitted]` entry, and evidence evicted by the total count limit is reported through a synthetic `evidence-drop` item. These markers mean the diagnostic information is incomplete.

## `control_task`

Inputs: `task_id`, `action`, and optional `instruction`.

The actions are state-specific:

- `continue`: while `waiting_for_supervisor_review`, requires a non-empty instruction, queues another read-only turn, and preserves app-server thread continuity with `thread/resume` for Codex. For DSH, `continue` starts a new headless execution; there is no native resume.
- `steer`: while `running`, requires a non-empty instruction and steers the active turn (Codex only).
- `interrupt`: while `running`, interrupts the active turn. When interruption completes, the task ends as `failed`; genuine partial output may be exposed as `partial_output`.
- `accept`: while `waiting_for_supervisor_review`, marks the reviewed output `completed` without starting another turn.

Invalid actions for the current state return `INVALID_STATE_TRANSITION`. There is no automatic timeout, automatic acceptance, or persistent task supervision state.

## `bind_project`

Input: `project_path`.

Canonicalizes and inspects the project without granting admission, then checks for an exact authoritative registration. An existing registration may be outside managed roots and returns the same `workspace_id` only after current filesystem and optional Git identity/type/root evidence matches; registration bypasses managed-root admission, never identity verification. An unknown path must be inside an explicitly approved managed root before it can be auto-onboarded. No model is invoked. A directory workspace that later gains Git upgrades its existing UUID/evidence in place.

## `workspace_diagnostics`

Exactly one input: `workspace_id` or `project_path`.

Reports bounded deterministic status without mutation or a model: existing authoritative registration, direct workspace-ID usability, managed-root or explicitly enabled Codex-reference onboarding eligibility, filesystem/optional-Git identity status, duplicate identity matches, whether a unique stale record could reconcile, and separate controlled-proposal readiness. It still reports whether a path appears in Codex metadata when metadata onboarding is disabled, but that reference is not an admission boundary. A healthy Git identity remains usable when unstaged work is present; index dirtiness is reported as a proposal blocker, not as a registration/identity failure. It never binds, refreshes, reconciles, authorizes a root, changes write policy, or treats a failed managed bind as evidence that an approved workspace is unusable.

## `refresh_workspace_registry`

Optional input: `workspace_id`.

Deterministically refreshes project references from the configured Codex `config.toml`, validates recorded identities, and discovers Git and non-Git directories. It refuses other metadata files (including `auth.json`), canonicalizes and deduplicates aliases, and reports missing, unsafe-broad, explicitly excluded, and ambiguous candidates. A valid narrow Codex project reference auto-onboards a new workspace only when trusted configuration enables `codex_projects.auto_onboard`, using the configured `permission_policy.allow_write`; otherwise it is reported as `auto_onboarding_disabled`. Existing stable workspaces may still reconcile through updated metadata. Managed roots independently auto-onboard projects that have not appeared in Codex metadata under their configured policy. Missing paths check updated Codex references first, then approved roots, and rebind only on one high-confidence filesystem/optional-Git match. There is no model turn, network call, watcher, or daemon.

## `create_project`

Inputs: `parent`, `name`, `confirmation` (must equal `CREATE` exactly).

Creates and git-initializes a new single-segment directory inside an approved managed root and registers its stable identity using that root's permission policy. Only `mkdir` and `git init` are performed; the repository is left unborn (no commit) and no files are added.

## `authorize_workspace_write`

Inputs: `workspace_id`, `confirmation` (must equal `AUTHORIZE` exactly).

Grants persistent controlled-APPLY permission to one auto-onboarded managed workspace only; approved seed policies remain authoritative through `workspaces.json`. The authorization is persisted first, then applied at runtime. Approved candidates and managed-root policies may already set `allow_write: true`. In every case this gates only exact `APPLY`; it is not direct-write access and does not change `run_task` or proposal generation (both stay read-only).

## `generate_controlled_patch`

Inputs: `workspace_id`, `change_request`, optional `routing`, and optional linked-task `parent_task_id` plus `handoff_snapshot`.

Read-only proposal flow available in any registered workspace; no write authorization is required to generate. The root of a Git workspace must be its Git top-level and the index must match HEAD. A clean existing/unborn Git base retains the unified-diff flow. When tracked unstaged work exists, Bridge instead requests a strict reviewed exact-preimage JSON proposal: tracked regular-file `modify` and absent-file `create` are supported, while `delete`/rename-shaped operations fail closed. Every modification is bound to exact current-worktree bytes, never substituted from HEAD. A directory/non-Git workspace uses the same operation schema with `create`, `modify`, and `delete`. Neither branch modifies files or initializes Git. The proposal and its applied history persist to `<config>.controlled-patches.json`.

## `prepare_project_instructions`

Input: `workspace_id`.

Collects bounded root-level evidence from ordinary manifest names and root entries, extracts only explicit package scripts/Make targets, and prepares portable `AGENTS.md`/`PLANS.md` target bytes. It never scans credential files or invents commands. Missing files are created with one versioned Bridge-managed evidence block. Existing ordinary portable files preserve every byte outside that block; a later prepare replaces only the prior managed block instead of accumulating stale facts. `ALREADY_CURRENT` requires exactly one valid block whose complete deterministic bytes match current evidence. Malformed, duplicate, nested, or unsupported markers, plus symlinks, oversized/non-text content, machine-specific control-plane policy, and secret-risk text, return `HOLD_NEEDS_PROJECT_DECISION`.

When proposal work is needed, one existing controlled-patch task is started with `routing=auto`. The classifier sees only the bounded implementation objective; no model is called merely to route. The returned proposal is human-approvable only when a deterministic postimage review proves the proposed `AGENTS.md`/`PLANS.md` bytes exactly equal the locally derived targets. Project writes still require separate exact `APPLY` and existing controlled-write eligibility.

## `refine_controlled_patch`

Inputs: `patch_task_id`, `change_request`, and optional `routing` or `handoff_snapshot`.

Read-only refinement of a completed controlled proposal: returns a new complete proposal against the same Git base or filesystem preimages, preserving the source proposal. It creates a linked new routed task/thread with a bounded handoff snapshot; it never mutates the source thread's model. Requires the source task to be `completed` and the workspace type/base to remain compatible. No write authorization is required; it never modifies files.

## `apply_controlled_patch`

Inputs: `patch_task_id`, `confirmation`.

The single controlled-write checkpoint. Confirmation must equal `APPLY` exactly, the proposal must be known, completed, and not already applied, and the workspace must hold controlled-write permission. Clean Git behavior is unchanged: the tool rechecks the canonical Git root and exact base, then validates and runs fixed `git apply --check`/`git apply`. For an unstaged dirty Git proposal, it independently rechecks the same HEAD, a clean index, target tracking/absence, canonical paths, and exact current-worktree preimages; it then changes only reviewed targets through atomic file operations. Unrelated tracked/untracked work and the index remain untouched. A staged/index change, delete/rename, stale target, existing or newly created untracked target, symlink, traversal, or outside-root target fails closed. Directory/non-Git proposals use the same bounded operation engine and additionally support reviewed deletes. Before the first exact-preimage mutation Bridge writes a bounded mode-0600 recovery/audit record under `$STACK_ROOT/state/<workspace-id>/controlled-patches/`; a later failure rolls back earlier operations only when their after-hashes still match. It never initializes Git, tests, stages, commits, resets, stashes, cleans, checks out, pushes, publishes, or deploys.

## `bridge_capabilities`

No inputs.

Starts a short-lived Codex app-server capability probe and returns the Bridge/Codex versions, default automatic routing, and availability/`max` support for every logical role in the configured model registry, plus the enforced read-only/network/APPLY invariants. Any probe or compatibility failure is returned as a safe error with `max_ready: false`; no fallback model or lower effort is selected.

## Frozen identity-v2 migration operator entrypoint

The identity-v2 control-plane migration is not an MCP action. After separate Owner approval and runtime quiescence, the operator invokes `node dist/src/workspaces/apply-identity-v2-migration.js <proposal-id> APPLY <absolute-reviewed-artifact-directory>`. The command accepts only the frozen proposal ID, exact case-sensitive `APPLY`, and exact reviewed patch/config/registry hashes. Both write targets are derived from the installed Bridge layout; callers cannot select a target. A live Bridge runtime or another migration blocks the command, while the shared writer lock excludes registry persistence. Exact preimages and the crash-safe shared transaction are revalidated before either target is replaced. The command does not stop or restart the runtime.
