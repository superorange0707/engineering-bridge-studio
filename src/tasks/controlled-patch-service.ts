import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";

import { CoreError, ERROR_CODES, serializeError } from "../core/errors.js";
import type { SerializedError } from "../core/errors.js";
import { isId } from "../core/ids.js";
import type { Id } from "../core/ids.js";
import {
  CODEX_LOGICAL_ROLES,
  DEFAULT_CODEX_MODEL_REGISTRY
} from "../executors/codex-model-registry.js";
import type { CodexLogicalRole, CodexModelRegistry } from "../executors/codex-model-registry.js";
import { routeCodexTask } from "../executors/codex-routing.js";
import type { CodexRouting, CodexRoutingReason, CodexRoutingRule } from "../executors/codex-routing.js";
import type { ExecutorEvidence } from "../executors/executor.js";
import { VERSION } from "../version.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import type { WorkspaceType } from "../workspaces/repository-identity.js";
import { requireHandoffSnapshot } from "./handoff-snapshot.js";
import type { HandoffSnapshot } from "./handoff-snapshot.js";
import {
  boundExecutorEvidence,
  executorEvidenceWithinLimit,
  validateExecutorEvidence,
  RegisteredWorkspaceTaskService
} from "./registered-workspace-task-service.js";

export type GitStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

// Minimal exit-code-observing git result: the caller must be able to tell a
// genuine failure from an expected nonzero exit (HEAD detection only).
type GitExit = { readonly code: number; readonly stdout: string };

export type ProposalBase =
  | { readonly kind: "commit"; readonly head: string }
  | { readonly kind: "worktree"; readonly head: string }
  | { readonly kind: "unborn" }
  | { readonly kind: "filesystem" };

export type WorkspaceTypeResolver = (
  workspaceId: string
) => WorkspaceType | Promise<WorkspaceType>;

type Proposal = {
  workspaceId: string;
  workspaceRoot: string;
  base: ProposalBase;
  state: "proposed" | "applying" | "applied";
  taskState: "running" | "completed" | "failed";
  lifecycle: ControlledProposalLifecycle;
  failure: SerializedError | undefined;
  parentTaskId: Id | undefined;
  output: string | undefined;
  requestedRouting: CodexRouting;
  logicalRole: CodexLogicalRole;
  routingReason: CodexRoutingReason;
  routingMatchedRule: CodexRoutingRule;
  routingMatchedFactors: readonly string[];
  routingIgnoredGuardFactors: readonly string[];
  routingTransition: "escalation" | "de_escalation" | "handoff" | undefined;
  handoffSnapshot: HandoffSnapshot | undefined;
  model: string;
  reasoningEffort: "max";
  bridgeVersion: string;
  codexVersion: string | undefined;
  threadId: string | undefined;
  evidence: readonly ExecutorEvidence[] | undefined;
  proposalReview: DirectoryProposalReview | undefined;
  projectInstruction: ProjectInstructionExpectation | undefined;
  projectInstructionReview: ProjectInstructionProposalReview | undefined;
  executor: "codex";
};

type RetainedProposal = Proposal & { taskId: Id };
type RetainedState = { proposals: RetainedProposal[]; appliedTaskIds: Id[] };

type FilesystemOperation =
  | { readonly operation: "create"; readonly path: string; readonly content: string }
  | { readonly operation: "modify"; readonly path: string; readonly beforeSha256: string; readonly content: string }
  | { readonly operation: "delete"; readonly path: string; readonly beforeSha256: string };

type PreparedFilesystemOperation = FilesystemOperation & {
  readonly target: string;
  readonly before: Buffer | undefined;
  readonly mode: number | undefined;
  readonly device: string | undefined;
  readonly inode: string | undefined;
  readonly hardlinkCount: number | undefined;
  readonly strictMetadata: boolean;
};

export type GitWorktreeTargetOrigin =
  | "TRACKED_WORKTREE"
  | "EXISTING_UNTRACKED_WORKTREE"
  | "ABSENT";

type WorktreeTargetMetadata = {
  readonly mode: number;
  readonly device: string;
  readonly inode: string;
  readonly hardlinkCount: number;
};

interface FilesystemAuditEntry {
  readonly operation: FilesystemOperation["operation"];
  readonly path: string;
  readonly before_sha256: string | null;
  readonly after_sha256: string | null;
}

interface FilesystemRecoveryRecord {
  readonly version: 1;
  readonly patch_task_id: Id;
  readonly workspace_id: string;
  readonly canonical_workspace_root: string;
  readonly status: "prepared" | "applied" | "rolled_back" | "rollback_failed";
  readonly operations: readonly (FilesystemAuditEntry & { readonly before_content_base64?: string })[];
}

export type ProposalReviewStatus = "PASS" | "FAIL" | "UNVERIFIED";

export type ControlledProposalLifecycleStage =
  | "CREATED"
  | "MODEL_RUNNING"
  | "MODEL_OUTPUT_READY"
  | "PROPOSAL_VALIDATING"
  | "READY"
  | "FAILED";

export interface ControlledProposalLifecycle {
  readonly stage: ControlledProposalLifecycleStage;
  readonly started_at: string;
  readonly deadline_at: string;
  readonly model_turn_started: boolean;
  readonly model_turn_completed: boolean;
  readonly proposal_bytes_received: number;
  readonly parse_status: ProposalReviewStatus;
  readonly validation_stage: "PENDING" | "SCHEMA" | "WORKSPACE" | "OPERATIONS" | "COMPLETE";
  readonly terminal_transition?: "READY" | "FAILED";
  readonly failure_code?: SerializedError["code"];
}

export interface ProjectInstructionTarget {
  readonly path: "AGENTS.md" | "PLANS.md";
  readonly operation: "create" | "modify";
  readonly before_sha256?: string | undefined;
  readonly content: string;
}

interface ProjectInstructionExpectation {
  readonly evidence_sha256: string;
  readonly targets: readonly ProjectInstructionTarget[];
}

export interface ProjectInstructionProposalReview {
  readonly status: "READY" | "HOLD_NEEDS_PROJECT_DECISION";
  readonly human_approvable: boolean;
  readonly evidence_sha256: string;
  readonly exact_target_bytes: boolean;
  readonly target_sha256: Readonly<Record<string, string>>;
}

export interface DirectoryProposalOperationReview {
  readonly operation: FilesystemOperation["operation"];
  readonly path: string;
  readonly normalized_path_status: ProposalReviewStatus;
  readonly target_within_root: ProposalReviewStatus;
  readonly parent_path_symlink_status: ProposalReviewStatus;
  readonly target_symlink_status: ProposalReviewStatus;
  readonly target_exists: boolean | null;
  readonly target_kind: "absent" | "file" | "directory" | "symlink" | "other" | "unverified";
  readonly proposal_preimage_sha256: string | null;
  readonly current_target_sha256: string | null;
  readonly preimage_match: boolean | null;
  readonly precondition_status: ProposalReviewStatus;
  readonly target_origin?: GitWorktreeTargetOrigin;
  readonly target_mode?: number | null;
  readonly target_device?: string | null;
  readonly target_inode?: string | null;
  readonly target_hardlink_count?: number | null;
}

export interface DirectoryProposalReview {
  readonly status: ProposalReviewStatus;
  readonly human_approvable: boolean;
  readonly workspace_id: string;
  readonly workspace_type: WorkspaceType;
  readonly proposal_schema_status: ProposalReviewStatus;
  readonly canonical_root_status: ProposalReviewStatus;
  readonly workspace_type_status: ProposalReviewStatus;
  readonly operation_limits_status: ProposalReviewStatus;
  readonly operations: readonly DirectoryProposalOperationReview[];
  readonly apply_revalidation_required: true;
}

export interface ControlledProposalDiagnostic {
  readonly controlled_proposal_status: "READY" | "BLOCKED";
  readonly controlled_proposal_reason:
    | "DIRECTORY_EXACT_PREIMAGE"
    | "CLEAN_GIT"
    | "UNSTAGED_DIRTY_WORKTREE_SUPPORTED"
    | "INDEX_DIRTY"
    | "WORKSPACE_PRECONDITION_FAILED";
}

const CONTROLLED_PATCH_STATE_VERSION = 5;
const MAX_APPLIED_PROPOSAL_HISTORY = 100;
const MAX_FAILED_PROPOSAL_HISTORY = 100;
const MAX_FILESYSTEM_OPERATIONS = 50;
const MAX_FILESYSTEM_BYTES = 4 * 1024 * 1024;
const MAX_ROUTING_FACTORS = 20;
const DEFAULT_PROPOSAL_TIMEOUT_MS = 30 * 60 * 1000;

const PATCH_INSTRUCTION = (changeRequest: string, base: ProposalBase): string => {
  if (usesExactPreimageOperations(base)) {
    const workspace = base.kind === "worktree"
      ? "The workspace is a Git repository with legitimate unstaged tracked changes. The index is clean."
      : "The workspace is not a Git repository.";
    const deletionRule = base.kind === "worktree"
      ? " Delete operations are not supported for a dirty Git worktree."
      : "";
    return `You are preparing a proposed change for human review. The workspace is read-only. ${workspace}
Return only one strict JSON object, without Markdown fences or commentary, using this schema:
{"version":1,"operations":[{"operation":"create","path":"relative/file.txt","content":"complete UTF-8 text"},{"operation":"modify","path":"relative/existing.txt","before_sha256":"64 lowercase hex characters","content":"complete replacement UTF-8 text"},{"operation":"delete","path":"relative/obsolete.txt","before_sha256":"64 lowercase hex characters"}]}
Include only the operations required by the request. Every path must be a normalized relative path beneath the canonical workspace root. For every modify or delete, compute before_sha256 from the exact current worktree file bytes; never substitute HEAD bytes.${deletionRule} Do not use symlinks, absolute paths, parent traversal, binary content, or more than ${MAX_FILESYSTEM_OPERATIONS} operations. This proposal must not modify files, initialize Git, alter the index, stage, reset, stash, clean, checkout, run network operations, commit, push, publish, or deploy.

Change request:
${changeRequest}`;
  }
  const scope = base.kind === "unborn"
    ? "The workspace is a newly created Git repository with no commits yet (unborn repository state). There are no tracked files to modify, so the proposed change must only add ordinary text files using new file mode 100644."
    : "Modify existing tracked regular text files, or add ordinary text files using new file mode 100644.";
  return `You are preparing a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, deletions, renames or copies, mode changes, symlinks, or submodules. ${scope}

Change request:
${changeRequest}`;
};

const REFINEMENT_INSTRUCTION = (base: ProposalBase, sourceDiff: string, changeRequest: string): string => {
  if (usesExactPreimageOperations(base)) {
    const deletionRule = base.kind === "worktree" ? " Delete operations remain unsupported." : "";
    return `You are refining an exact-preimage file-operation proposal for human review. The workspace is read-only.
Return only one COMPLETE strict JSON object relative to the same current file preimages, without Markdown fences or commentary, using the original version-1 operations schema. Preserve unrelated source-proposal semantics. Every modify/delete must carry the exact current worktree before_sha256; never substitute HEAD bytes.${deletionRule} Do not use symlinks, absolute paths, parent traversal, binary content, or more than ${MAX_FILESYSTEM_OPERATIONS} operations. Do not modify files, initialize Git, alter the index, stage, reset, stash, clean, checkout, use the network, commit, push, publish, or deploy.

Complete source proposal JSON:
${sourceDiff}

Refinement request:
${changeRequest}`;
  }
  const baseClause = base.kind === "commit"
    ? `Output a COMPLETE final unified diff relative to the SAME original base_head ${base.head}, not an incremental patch against the source proposal.`
    : "The workspace is a newly created Git repository with no commits yet (unborn repository state); the refined proposal must still only add ordinary text files using new file mode 100644, and must remain relative to the same unborn base.";
  const scope = base.kind === "unborn"
    ? "There are no tracked files to modify, so the proposed change must only add ordinary text files using new file mode 100644."
    : "Modify existing tracked regular text files, or add ordinary text files using new file mode 100644.";
  return `You are refining a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, deletions, renames or copies, mode changes, symlinks, or submodules. ${scope}

Treat the source proposal below as the reviewed baseline. Fix only the requested issues and preserve all unrelated proposal semantics. ${baseClause} Do not redo the original task.

Complete source proposal diff:
${sourceDiff}

Refinement request:
${changeRequest}`;
};

export class ControlledPatchService {
  private readonly proposals = new Map<Id, Proposal>();
  private appliedProposalTaskIds: Id[] = [];
  private failedProposalTaskIds: Id[] = [];
  private recoveryPending = false;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly tasks: RegisteredWorkspaceTaskService,
    private readonly startProcess: GitStarter = spawn,
    private readonly stateFilePath?: string,
    private readonly modelRegistry: CodexModelRegistry = DEFAULT_CODEX_MODEL_REGISTRY,
    private readonly workspaceType: WorkspaceTypeResolver = () => "git_workspace",
    private readonly projectStateRoot?: string,
    private readonly proposalTimeoutMs: number = DEFAULT_PROPOSAL_TIMEOUT_MS
  ) {
    if (!Number.isSafeInteger(proposalTimeoutMs) || proposalTimeoutMs <= 0) {
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  async load(readOnly = false): Promise<void> {
    this.recoveryPending = false;
    if (this.stateFilePath === undefined) return;
    if (this.proposals.size !== 0) throw new CoreError("INTERNAL_ERROR");
    let source: string;
    try {
      source = await readFile(this.stateFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CoreError("INTERNAL_ERROR");
    }

    let retainedState: RetainedState;
    try {
      // Global failures (unreadable JSON, bad envelope/version, invalid
      // applied_task_ids, identity ambiguity, applied-history contradictions)
      // still fail the whole load; only per-record problems are quarantined
      // inside parseRetainedState.
      retainedState = parseRetainedState(JSON.parse(source), this.registry);
    } catch {
      throw new CoreError("INTERNAL_ERROR");
    }

    let recoveredOrphan = false;
    for (const { taskId, ...retained } of retainedState.proposals) {
      const proposal: Proposal = retained.taskState === "running"
        ? {
          ...retained,
          taskState: "failed",
          lifecycle: failedLifecycle(retained.lifecycle, "CONTROLLED_PROPOSAL_ORPHANED"),
          failure: serializeError(new CoreError("CONTROLLED_PROPOSAL_ORPHANED"))
        }
        : retained;
      if (retained.taskState === "running") recoveredOrphan = true;
      const restoredState = proposal.state === "applying" ? "proposed" : proposal.state;
      this.proposals.set(taskId, { ...proposal, state: restoredState });
      const metadata = proposal.codexVersion === undefined ? undefined : {
        logicalRole: proposal.logicalRole,
        model: proposal.model,
        reasoningEffort: proposal.reasoningEffort,
        codexVersion: proposal.codexVersion
      } as const;
      if (proposal.taskState === "completed") {
        this.tasks.restoreControlledPatchTask(taskId, proposal.output!, restoredState !== "applied",
          proposal.workspaceId, proposal.requestedRouting, proposal.logicalRole, proposal.routingReason,
          proposal.routingMatchedRule, proposal.routingMatchedFactors, proposal.routingIgnoredGuardFactors,
          proposal.threadId!, metadata!, proposal.evidence, proposal.parentTaskId, proposal.handoffSnapshot,
          proposal.routingTransition);
      } else {
        this.tasks.restoreFailedControlledPatchTask(taskId, proposal.failure!, proposal.workspaceId,
          proposal.requestedRouting, proposal.logicalRole, proposal.routingReason,
          proposal.routingMatchedRule, proposal.routingMatchedFactors, proposal.routingIgnoredGuardFactors,
          proposal.threadId, metadata, proposal.evidence, proposal.parentTaskId, proposal.handoffSnapshot,
          proposal.routingTransition);
        this.failedProposalTaskIds.push(taskId);
      }
    }
    this.appliedProposalTaskIds = retainedState.appliedTaskIds;
    this.trimFailedProposals();
    if (recoveredOrphan) {
      this.recoveryPending = true;
      if (!readOnly) {
        await this.persist();
        this.recoveryPending = false;
      }
    }
  }

  async recover(): Promise<void> {
    if (!this.recoveryPending) return;
    await this.persist();
    this.recoveryPending = false;
  }

  proposalReview(taskId: unknown): DirectoryProposalReview | undefined {
    if (!isId(taskId)) return undefined;
    const proposal = this.proposals.get(taskId);
    if (proposal === undefined) return undefined;
    return proposal.proposalReview ?? unverifiedDirectoryReview(
      proposal.workspaceId,
      proposal.base.kind === "filesystem" ? "directory_workspace" : "git_workspace"
    );
  }

  proposalLifecycle(taskId: unknown): ControlledProposalLifecycle | undefined {
    return isId(taskId) ? this.proposals.get(taskId)?.lifecycle : undefined;
  }

  hasActiveWork(): boolean {
    return [...this.proposals.values()].some(({ state, taskState }) =>
      state === "applying" || taskState === "running");
  }

  async diagnose(workspaceId: string): Promise<ControlledProposalDiagnostic> {
    let state: ProposalBase | "index_dirty";
    try {
      const workspaceRoot = this.registry.resolve(workspaceId);
      state = await this.inspectWorkspaceForProposal(workspaceId, workspaceRoot);
    } catch {
      return {
        controlled_proposal_status: "BLOCKED",
        controlled_proposal_reason: "WORKSPACE_PRECONDITION_FAILED"
      };
    }
    if (state === "index_dirty") {
      return { controlled_proposal_status: "BLOCKED", controlled_proposal_reason: "INDEX_DIRTY" };
    }
    return {
      controlled_proposal_status: "READY",
      controlled_proposal_reason: state.kind === "filesystem"
        ? "DIRECTORY_EXACT_PREIMAGE"
        : state.kind === "worktree" ? "UNSTAGED_DIRTY_WORKTREE_SUPPORTED" : "CLEAN_GIT"
    };
  }

  projectInstructionReview(taskId: unknown): ProjectInstructionProposalReview | undefined {
    if (!isId(taskId)) return undefined;
    return this.proposals.get(taskId)?.projectInstructionReview;
  }

  async generate(request: {
    workspace_id: string;
    change_request: string;
    routing?: CodexRouting;
    parent_task_id?: string;
    handoff_snapshot?: HandoffSnapshot;
  }): Promise<{ taskId: Id; baseHead: string | null }> {
    // Generating a proposal is read-only analysis: any registered workspace
    // may propose; only APPLY requires controlled-write authorization.
    const workspaceRoot = this.registry.resolve(request.workspace_id);
    const base = await this.verifyWorkspace(request.workspace_id, workspaceRoot);
    return this.startProposal(request.workspace_id, workspaceRoot, base, request.routing ?? "auto",
      request.change_request, PATCH_INSTRUCTION(request.change_request, base),
      request.parent_task_id as Id | undefined, request.handoff_snapshot);
  }

  async generateProjectInstructions(request: {
    workspace_id: string;
    evidence_sha256: string;
    targets: readonly ProjectInstructionTarget[];
  }): Promise<{ taskId: Id; baseHead: string | null }> {
    if (!isSha256(request.evidence_sha256) || request.targets.length === 0 || request.targets.length > 2 ||
        request.targets.reduce((bytes, target) => bytes + Buffer.byteLength(target.content, "utf8"), 0) >
          MAX_FILESYSTEM_BYTES ||
        new Set(request.targets.map(({ path }) => path)).size !== request.targets.length ||
        request.targets.some((target) => !["AGENTS.md", "PLANS.md"].includes(target.path) ||
          !["create", "modify"].includes(target.operation) || !isTextContent(target.content) ||
          (target.operation === "create") !== (target.before_sha256 === undefined) ||
          (target.before_sha256 !== undefined && !isSha256(target.before_sha256)))) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const workspaceRoot = this.registry.resolve(request.workspace_id);
    const base = await this.verifyWorkspace(request.workspace_id, workspaceRoot);
    const expectation: ProjectInstructionExpectation = {
      evidence_sha256: request.evidence_sha256,
      targets: request.targets
    };
    const exactTargets = JSON.stringify(request.targets.map(({ path, operation, before_sha256, content }) => ({
      path, operation, ...(before_sha256 === undefined ? {} : { before_sha256 }), content
    })));
    const instruction = `${PATCH_INSTRUCTION("Prepare only the portable project instruction targets supplied below.", base)}\n\n` +
      `The complete exact target specification is this JSON array. The proposed postimage bytes must match every content string exactly, and no other path may change:\n${exactTargets}`;
    return this.startProposal(request.workspace_id, workspaceRoot, base, "auto",
      "Implement one bounded documentation-only change to AGENTS.md and PLANS.md.", instruction,
      undefined, undefined, expectation);
  }

  async refine(request: {
    patch_task_id: string;
    change_request: string;
    routing?: CodexRouting;
    handoff_snapshot?: HandoffSnapshot;
  }): Promise<{ taskId: Id; baseHead: string | null }> {
    const proposal = this.proposals.get(request.patch_task_id as Id);
    const sourceResult = this.tasks.result(request.patch_task_id);
    if (proposal === undefined || sourceResult === undefined || sourceResult.state !== "completed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }

    const currentBase = await this.verifyWorkspace(proposal.workspaceId, proposal.workspaceRoot);
    if (!sameBase(currentBase, proposal.base)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const handoffSnapshot = request.handoff_snapshot ?? {
      objective: request.change_request,
      current_state: "A completed controlled-patch proposal is being refined into a new complete proposal.",
      plan_reference: request.patch_task_id,
      git_state: hasHead(proposal.base)
        ? `base_head=${proposal.base.head}`
        : proposal.base.kind === "unborn" ? "base_head=unborn" : "not_a_git_repository",
      test_status: "Not run by Engineering Bridge.",
      relevant_evidence: [`parent_patch_task_id=${request.patch_task_id}`]
    };
    return this.startProposal(proposal.workspaceId, proposal.workspaceRoot, proposal.base, request.routing ?? "auto",
      request.change_request, REFINEMENT_INSTRUCTION(proposal.base, sourceResult.output, request.change_request),
      request.patch_task_id as Id, handoffSnapshot);
  }

  async apply(request: { patch_task_id: string; confirmation: string }): Promise<{
    patch_task_id: Id;
    applied: true;
    changed_paths: string[];
    backend?: "git" | "filesystem" | "worktree";
    rollback_reference?: string;
    audit?: readonly FilesystemAuditEntry[];
  }> {
    if (request.confirmation !== "APPLY") throw new CoreError("INVALID_STATE_TRANSITION");
    const proposal = this.proposals.get(request.patch_task_id as Id);
    if (proposal === undefined || proposal.state !== "proposed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    if (proposal.taskState === "failed") throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    // APPLY is the single controlled-write authorization checkpoint: the
    // workspace must currently hold controlled-write permission.
    if (this.registry.resolveWritable(proposal.workspaceId) !== proposal.workspaceRoot) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const result = this.tasks.result(request.patch_task_id);
    if (result === undefined || result.state !== "completed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    if (usesExactPreimageOperations(proposal.base) && proposal.proposalReview?.status !== "PASS") {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    if (proposal.projectInstruction !== undefined && proposal.projectInstructionReview?.status !== "READY") {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }

    proposal.state = "applying";
    try {
      await this.persist();
      const currentBase = await this.verifyWorkspace(proposal.workspaceId, proposal.workspaceRoot);
      // Unborn proposals require the repository to still be unborn: if the user
      // created the first commit meanwhile, this proposal must be rejected.
      if (!sameBase(currentBase, proposal.base)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      if (usesExactPreimageOperations(proposal.base)) {
        const applied = await this.applyFilesystemProposal(
          proposal,
          request.patch_task_id as Id,
          result.output,
          proposal.base.kind === "worktree" ? proposal.base.head : undefined
        );
        proposal.state = "applied";
        this.appliedProposalTaskIds.push(request.patch_task_id as Id);
        this.trimAppliedProposals();
        this.tasks.unpinTask(request.patch_task_id as Id);
        await this.persist();
        return {
          patch_task_id: request.patch_task_id as Id,
          applied: true,
          backend: proposal.base.kind === "worktree" ? "worktree" : "filesystem",
          ...applied
        };
      }
      const targets = parsePatch(result.output);
      for (const target of targets) {
        if (proposal.base.kind === "unborn") {
          // No tracked files exist in an unborn repository, so only pure
          // additions are verifiable; modified targets cannot be checked.
          if (target.kind !== "added") failPatch();
        } else {
          if (!hasHead(proposal.base)) failPatch();
          const entry = await this.git(proposal.workspaceRoot, ["ls-tree", proposal.base.head, "--", target.path]);
          if (target.kind === "modified") {
            if (!/^(100644|100755) blob [0-9a-f]+\t[^\n]+\n?$/u.test(entry)) failPatch();
            continue;
          }
          if (entry.length !== 0) failPatch();
        }
        const indexEntry = await this.git(proposal.workspaceRoot, ["ls-files", "--stage", "--", target.path]);
        if (indexEntry.length !== 0 || await pathExists(resolve(proposal.workspaceRoot, target.path))) failPatch();
      }
      await this.git(proposal.workspaceRoot, ["apply", "--check", "--recount", "--unidiff-zero"], result.output);
      await this.git(proposal.workspaceRoot, ["apply", "--recount", "--unidiff-zero"], result.output);
      proposal.state = "applied";
      this.appliedProposalTaskIds.push(request.patch_task_id as Id);
      this.trimAppliedProposals();
      this.tasks.unpinTask(request.patch_task_id as Id);
      await this.persist();
      return { patch_task_id: request.patch_task_id as Id, applied: true, changed_paths: targets.map(({ path }) => path) };
    } catch (error) {
      if (proposal.state === "applying") {
        proposal.state = "proposed";
        await this.persist();
      }
      throw error;
    }
  }

  private async startProposal(
    workspaceId: string,
    workspaceRoot: string,
    base: ProposalBase,
    routing: CodexRouting,
    routingInput: string,
    instruction: string,
    parentTaskId?: Id,
    handoffSnapshot?: HandoffSnapshot,
    projectInstruction?: ProjectInstructionExpectation
  ): Promise<{ taskId: Id; baseHead: string | null }> {
    if (parentTaskId !== undefined && handoffSnapshot === undefined) {
      throw new CoreError("INVALID_HANDOFF_SNAPSHOT");
    }
    const snapshot = handoffSnapshot === undefined ? undefined : requireHandoffSnapshot(handoffSnapshot);
    const selection = routeCodexTask(routing, routingInput);
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + this.proposalTimeoutMs);
    const { taskId } = this.tasks.runTask({
      workspace_id: workspaceId,
      instruction,
      executor: "codex",
      routing,
      routing_input: routingInput,
      ...(parentTaskId === undefined ? {} : { parent_task_id: parentTaskId }),
      ...(snapshot === undefined ? {} : { handoff_snapshot: snapshot })
    }, normalizeTrailingLf, async (result) => {
      const proposal = this.proposals.get(result.id);
      if (proposal === undefined) throw new CoreError("INTERNAL_ERROR");
      if (result.state === "failed") {
        proposal.taskState = "failed";
        proposal.failure = result.error;
        proposal.threadId = result.threadId ?? proposal.threadId;
        proposal.codexVersion = result.metadata?.codexVersion ?? proposal.codexVersion;
        proposal.evidence = boundExecutorEvidence(result.evidence) ?? proposal.evidence;
        proposal.lifecycle = failedLifecycle(proposal.lifecycle, result.error.code);
        this.failedProposalTaskIds.push(result.id);
        this.trimFailedProposals();
        await this.persist();
        this.tasks.unpinTask(result.id);
        return;
      }
      if (result.threadId === undefined || result.metadata === undefined ||
          result.metadata.logicalRole !== proposal.logicalRole || result.metadata.model !== proposal.model ||
          result.metadata.reasoningEffort !== "max" || result.metadata.codexVersion.length === 0) {
        proposal.taskState = "failed";
        proposal.failure = serializeError(new CoreError("CODEX_ROLE_THREAD_MISMATCH"));
        proposal.lifecycle = failedLifecycle(proposal.lifecycle, "CODEX_ROLE_THREAD_MISMATCH");
        this.failedProposalTaskIds.push(result.id);
        this.trimFailedProposals();
        await this.persist();
        this.tasks.unpinTask(result.id);
        throw new CoreError("CODEX_ROLE_THREAD_MISMATCH");
      }
      proposal.output = result.output;
      proposal.threadId = result.threadId;
      proposal.codexVersion = result.metadata.codexVersion;
      proposal.evidence = boundExecutorEvidence(result.evidence);
      proposal.lifecycle = {
        ...proposal.lifecycle,
        stage: "MODEL_OUTPUT_READY",
        model_turn_started: true,
        model_turn_completed: true,
        proposal_bytes_received: Buffer.byteLength(result.output, "utf8")
      };
      await this.persist();
      try {
        proposal.lifecycle = {
          ...proposal.lifecycle,
          stage: "PROPOSAL_VALIDATING",
          validation_stage: "SCHEMA"
        };
        await this.persist();
        proposal.proposalReview = usesExactPreimageOperations(proposal.base)
          ? await this.reviewFilesystemProposal(proposal, result.output)
          : await this.reviewGitProposal(proposal, result.output);
        proposal.lifecycle = {
          ...proposal.lifecycle,
          parse_status: proposal.proposalReview.proposal_schema_status,
          validation_stage: proposal.proposalReview.status === "PASS" ? "COMPLETE" : "OPERATIONS"
        };
        proposal.projectInstructionReview = projectInstruction === undefined
          ? undefined
          : await this.reviewProjectInstructionProposal(proposal, result.output, projectInstruction);
        if (proposal.proposalReview.status !== "PASS" ||
            proposal.projectInstructionReview?.status === "HOLD_NEEDS_PROJECT_DECISION") {
          throw new CoreError("CONTROLLED_PROPOSAL_VALIDATION_FAILED");
        }
        proposal.taskState = "completed";
        proposal.failure = undefined;
        proposal.lifecycle = readyLifecycle(proposal.lifecycle);
        await this.persist();
      } catch (error) {
        const failure = error instanceof CoreError ? error : new CoreError("CONTROLLED_PROPOSAL_VALIDATION_FAILED");
        proposal.taskState = "failed";
        proposal.failure = serializeError(failure);
        proposal.lifecycle = failedLifecycle(proposal.lifecycle, failure.code);
        this.failedProposalTaskIds.push(result.id);
        this.trimFailedProposals();
        await this.persist().catch((): void => {});
        this.tasks.unpinTask(result.id);
        throw failure;
      }
    }, {
      timeoutMs: this.proposalTimeoutMs,
      onThreadStarted: (threadId) => {
        const proposal = this.proposals.get(taskId);
        if (proposal === undefined || proposal.taskState !== "running") return;
        proposal.threadId = threadId;
        proposal.lifecycle = {
          ...proposal.lifecycle,
          stage: "MODEL_RUNNING",
          model_turn_started: true
        };
      }
    });
    const role = this.modelRegistry[selection.logicalRole];
    const routingTransition = this.tasks.taskView(taskId)?.routingTransition;
    this.proposals.set(taskId, {
      workspaceId,
      workspaceRoot,
      base,
      state: "proposed",
      taskState: "running",
      lifecycle: {
        stage: "CREATED",
        started_at: startedAt.toISOString(),
        deadline_at: deadlineAt.toISOString(),
        model_turn_started: false,
        model_turn_completed: false,
        proposal_bytes_received: 0,
        parse_status: "UNVERIFIED",
        validation_stage: "PENDING"
      },
      failure: undefined,
      parentTaskId,
      output: undefined,
      requestedRouting: selection.requestedRouting,
      logicalRole: selection.logicalRole,
      routingReason: selection.reason,
      routingMatchedRule: selection.matchedRule,
      routingMatchedFactors: selection.matchedFactors,
      routingIgnoredGuardFactors: selection.ignoredGuardFactors,
      routingTransition,
      handoffSnapshot: snapshot,
      model: role.model,
      reasoningEffort: role.effort,
      bridgeVersion: VERSION,
      codexVersion: undefined,
      threadId: undefined,
      evidence: undefined,
      proposalReview: undefined,
      projectInstruction,
      projectInstructionReview: undefined,
      executor: "codex"
    });
    this.tasks.pinTask(taskId);
    try {
      await this.persist();
    } catch (error) {
      await this.tasks.controlTask(taskId, "interrupt").catch((): void => {});
      this.proposals.delete(taskId);
      this.tasks.unpinTask(taskId);
      throw error;
    }
    return { taskId, baseHead: hasHead(base) ? base.head : null };
  }

  private trimAppliedProposals(): void {
    const appliedTaskIds = this.appliedProposalTaskIds.filter(
      (taskId) => this.proposals.get(taskId)?.state === "applied"
    );
    const evictedTaskIds = appliedTaskIds.slice(
      0,
      Math.max(0, appliedTaskIds.length - MAX_APPLIED_PROPOSAL_HISTORY)
    );
    for (const taskId of evictedTaskIds) this.proposals.delete(taskId);
    this.appliedProposalTaskIds = appliedTaskIds.slice(-MAX_APPLIED_PROPOSAL_HISTORY);
  }

  private trimFailedProposals(): void {
    const failedTaskIds = this.failedProposalTaskIds.filter(
      (taskId) => this.proposals.get(taskId)?.taskState === "failed"
    );
    const evictedTaskIds = failedTaskIds.slice(
      0,
      Math.max(0, failedTaskIds.length - MAX_FAILED_PROPOSAL_HISTORY)
    );
    for (const taskId of evictedTaskIds) this.proposals.delete(taskId);
    this.failedProposalTaskIds = failedTaskIds.slice(-MAX_FAILED_PROPOSAL_HISTORY);
  }

  private persist(): Promise<void> {
    if (this.stateFilePath === undefined) return Promise.resolve();
    const proposals: unknown[] = [];
    for (const [taskId, proposal] of this.proposals) {
      if (proposal.evidence !== undefined && !executorEvidenceWithinLimit(proposal.evidence)) {
        throw new CoreError("INTERNAL_ERROR");
      }
      proposals.push({
        task_id: taskId,
        workspace_id: proposal.workspaceId,
        workspace_root: proposal.workspaceRoot,
        base_head: hasHead(proposal.base) ? proposal.base.head : null,
        ...(proposal.base.kind === "unborn" ? { unborn: true } : {}),
        ...(proposal.base.kind === "filesystem" ? { filesystem: true } : {}),
        ...(proposal.base.kind === "worktree" ? { worktree: true } : {}),
        state: proposal.state,
        task_state: proposal.taskState,
        lifecycle: proposal.lifecycle,
        ...(proposal.failure === undefined ? {} : { failure: proposal.failure }),
        ...(proposal.parentTaskId === undefined ? {} : { parent_task_id: proposal.parentTaskId }),
        routing: proposal.requestedRouting,
        logical_role: proposal.logicalRole,
        routing_reason: proposal.routingReason,
        routing_matched_rule: proposal.routingMatchedRule,
        routing_matched_factors: proposal.routingMatchedFactors,
        routing_ignored_guard_factors: proposal.routingIgnoredGuardFactors,
        ...(proposal.routingTransition === undefined ? {} : { routing_transition: proposal.routingTransition }),
        ...(proposal.handoffSnapshot === undefined ? {} : { handoff_snapshot: proposal.handoffSnapshot }),
        model: proposal.model,
        reasoning_effort: proposal.reasoningEffort,
        bridge_version: proposal.bridgeVersion,
        ...(proposal.codexVersion === undefined ? {} : { codex_version: proposal.codexVersion }),
        ...(proposal.threadId === undefined ? {} : { thread_id: proposal.threadId }),
        ...(proposal.evidence === undefined ? {} : { evidence: proposal.evidence }),
        ...(proposal.proposalReview === undefined ? {} : { proposal_review: proposal.proposalReview }),
        ...(proposal.projectInstruction === undefined ? {} : { project_instruction: proposal.projectInstruction }),
        ...(proposal.projectInstructionReview === undefined
          ? {}
          : { project_instruction_review: proposal.projectInstructionReview }),
        executor: proposal.executor,
        ...(proposal.output === undefined ? {} : { output: proposal.output })
      });
    }
    const contents = `${JSON.stringify({
      version: CONTROLLED_PATCH_STATE_VERSION,
      applied_task_ids: this.appliedProposalTaskIds,
      proposals
    }, null, 2)}\n`;
    const write = this.persistenceQueue.then(() => this.replaceStateFile(contents));
    this.persistenceQueue = write.catch((): void => {});
    return write;
  }

  private async replaceStateFile(contents: string): Promise<void> {
    const stateFilePath = this.stateFilePath!;
    const temporaryPath = `${stateFilePath}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, stateFilePath);
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  private async reviewFilesystemProposal(
    proposal: Proposal,
    output: string
  ): Promise<DirectoryProposalReview> {
    const reviewWorkspaceType: WorkspaceType = proposal.base.kind === "worktree"
      ? "git_workspace"
      : "directory_workspace";
    let operations: FilesystemOperation[];
    try {
      operations = parseFilesystemProposal(output);
    } catch {
      return directoryReview(
        proposal.workspaceId, reviewWorkspaceType, "FAIL", "FAIL", "UNVERIFIED", "UNVERIFIED", []
      );
    }

    let canonicalRootStatus: ProposalReviewStatus;
    let workspaceTypeStatus: ProposalReviewStatus;
    try {
      const root = resolve(proposal.workspaceRoot);
      const registeredRoot = this.registry.resolve(proposal.workspaceId);
      const [canonical, metadata, hasGitMarker, currentWorkspaceType, currentBase] = await Promise.all([
        realpath(root), lstat(root), reviewHasGitControlMarkerAtOrAbove(root),
        this.workspaceType(proposal.workspaceId),
        this.inspectWorkspaceForProposal(proposal.workspaceId, proposal.workspaceRoot)
      ]);
      canonicalRootStatus = canonical === root && metadata.isDirectory() && !metadata.isSymbolicLink()
        ? "PASS"
        : "FAIL";
      const expectedWorkspaceType = proposal.base.kind === "worktree"
        ? "git_workspace"
        : "directory_workspace";
      workspaceTypeStatus = registeredRoot === proposal.workspaceRoot &&
        currentWorkspaceType === expectedWorkspaceType &&
        (expectedWorkspaceType === "git_workspace" ? hasGitMarker : !hasGitMarker) &&
        currentBase !== "index_dirty" && sameBase(currentBase, proposal.base) ? "PASS" : "FAIL";
    } catch (error) {
      canonicalRootStatus = reviewErrorStatus(error);
      workspaceTypeStatus = "UNVERIFIED";
    }
    if (canonicalRootStatus !== "PASS" || workspaceTypeStatus !== "PASS") {
      return directoryReview(
        proposal.workspaceId,
        reviewWorkspaceType,
        aggregateReviewStatus(canonicalRootStatus, workspaceTypeStatus),
        "PASS",
        canonicalRootStatus,
        workspaceTypeStatus,
        []
      );
    }

    const inspected: Array<{
      review: DirectoryProposalOperationReview;
      bytes: number | null;
      metadata: WorktreeTargetMetadata | null;
    }> = [];
    let boundedBytes = 0;
    let operationLimitsStatus: ProposalReviewStatus = "PASS";
    let remainingBytes = MAX_FILESYSTEM_BYTES;
    for (const operation of operations) {
      let result = await this.reviewFilesystemOperation(proposal.workspaceRoot, operation, remainingBytes);
      if (proposal.base.kind === "worktree") {
        result = await this.reviewGitWorktreeOperation(proposal, operation, result);
      }
      inspected.push(result);
      if (result.bytes === null) {
        operationLimitsStatus = aggregateReviewStatus(operationLimitsStatus, "UNVERIFIED");
        remainingBytes = 0;
      } else {
        boundedBytes += result.bytes;
        remainingBytes = Math.max(0, MAX_FILESYSTEM_BYTES - boundedBytes);
      }
    }
    if (boundedBytes > MAX_FILESYSTEM_BYTES) operationLimitsStatus = "FAIL";
    const reviews = inspected.map(({ review }) => review);
    return directoryReview(
      proposal.workspaceId,
      reviewWorkspaceType,
      aggregateReviewStatus(
        canonicalRootStatus,
        workspaceTypeStatus,
        operationLimitsStatus,
        ...reviews.map(({ precondition_status }) => precondition_status)
      ),
      "PASS",
      canonicalRootStatus,
      workspaceTypeStatus,
      reviews,
      operationLimitsStatus
    );
  }

  private async reviewGitProposal(
    proposal: Proposal,
    output: string
  ): Promise<DirectoryProposalReview> {
    let targets: PatchTarget[];
    try {
      if (Buffer.byteLength(output, "utf8") > MAX_FILESYSTEM_BYTES) failPatch();
      targets = parsePatch(output);
      if (targets.length > MAX_FILESYSTEM_OPERATIONS) failPatch();
    } catch {
      return directoryReview(
        proposal.workspaceId, "git_workspace", "FAIL", "FAIL", "UNVERIFIED", "UNVERIFIED", []
      );
    }

    let canonicalRootStatus: ProposalReviewStatus = "UNVERIFIED";
    let workspaceTypeStatus: ProposalReviewStatus = "UNVERIFIED";
    try {
      const root = resolve(proposal.workspaceRoot);
      const [canonical, metadata, currentWorkspaceType, currentBase] = await Promise.all([
        realpath(root), lstat(root), this.workspaceType(proposal.workspaceId),
        this.inspectWorkspaceForProposal(proposal.workspaceId, proposal.workspaceRoot)
      ]);
      canonicalRootStatus = canonical === root && metadata.isDirectory() && !metadata.isSymbolicLink() &&
        this.registry.resolve(proposal.workspaceId) === root ? "PASS" : "FAIL";
      workspaceTypeStatus = currentWorkspaceType === "git_workspace" && currentBase !== "index_dirty" &&
        sameBase(currentBase, proposal.base) ? "PASS" : "FAIL";
      if (canonicalRootStatus === "PASS" && workspaceTypeStatus === "PASS") {
        await this.git(proposal.workspaceRoot, ["apply", "--check", "--recount", "--unidiff-zero"], output);
      }
    } catch (error) {
      canonicalRootStatus = canonicalRootStatus === "PASS" ? canonicalRootStatus : reviewErrorStatus(error);
      workspaceTypeStatus = "UNVERIFIED";
    }
    if (canonicalRootStatus !== "PASS" || workspaceTypeStatus !== "PASS") {
      return directoryReview(
        proposal.workspaceId,
        "git_workspace",
        aggregateReviewStatus(canonicalRootStatus, workspaceTypeStatus),
        "PASS",
        canonicalRootStatus,
        workspaceTypeStatus,
        []
      );
    }

    const reviews: DirectoryProposalOperationReview[] = [];
    let operationLimitsStatus: ProposalReviewStatus = "PASS";
    let remainingBytes = MAX_FILESYSTEM_BYTES - Buffer.byteLength(output, "utf8");
    for (const target of targets) {
      try {
        const operation: FilesystemOperation = target.kind === "added"
          ? { operation: "create", path: target.path, content: "" }
          : {
            operation: "modify",
            path: target.path,
            beforeSha256: sha256(await readOrdinaryCanonicalFile(resolve(proposal.workspaceRoot, target.path))),
            content: ""
          };
        const inspected = await this.reviewFilesystemOperation(proposal.workspaceRoot, operation, remainingBytes);
        const [headEntry, indexEntry, targetDiff] = await Promise.all([
          hasHead(proposal.base)
            ? this.git(proposal.workspaceRoot, ["ls-tree", proposal.base.head, "--", target.path])
            : Promise.resolve(""),
          this.git(proposal.workspaceRoot, ["ls-files", "--stage", "--", target.path]),
          this.gitResult(proposal.workspaceRoot, ["diff", "--quiet", "--", target.path])
        ]);
        const trackedHead = /^(100644|100755) blob [0-9a-f]+\t[^\n]+\n?$/u.test(headEntry);
        const trackedIndex = /^(100644|100755) [0-9a-f]+ 0\t[^\n]+\n?$/u.test(indexEntry);
        const gitTargetValid = target.kind === "modified"
          ? trackedHead && trackedIndex && targetDiff.code === 0
          : headEntry.length === 0 && indexEntry.length === 0 && targetDiff.code === 0;
        const review = gitTargetValid
          ? inspected.review
          : { ...inspected.review, precondition_status: "FAIL" as const };
        reviews.push(review);
        if (inspected.bytes === null) {
          operationLimitsStatus = aggregateReviewStatus(operationLimitsStatus, "UNVERIFIED");
          remainingBytes = 0;
        } else {
          remainingBytes = Math.max(0, remainingBytes - inspected.bytes);
        }
      } catch {
        reviews.push(unverifiedOperationReview(
          target.kind === "added"
            ? { operation: "create", path: target.path, content: "" }
            : { operation: "modify", path: target.path, beforeSha256: "0".repeat(64), content: "" },
          "UNVERIFIED"
        ));
        operationLimitsStatus = aggregateReviewStatus(operationLimitsStatus, "UNVERIFIED");
      }
    }
    const status = aggregateReviewStatus(
      canonicalRootStatus,
      workspaceTypeStatus,
      operationLimitsStatus,
      ...reviews.map(({ precondition_status }) => precondition_status)
    );
    return directoryReview(
      proposal.workspaceId,
      "git_workspace",
      status,
      "PASS",
      canonicalRootStatus,
      workspaceTypeStatus,
      reviews,
      operationLimitsStatus
    );
  }

  private async reviewGitWorktreeOperation(
    proposal: Proposal,
    operation: FilesystemOperation,
    result: {
      review: DirectoryProposalOperationReview;
      bytes: number | null;
      metadata: WorktreeTargetMetadata | null;
    }
  ): Promise<{
    review: DirectoryProposalOperationReview;
    bytes: number | null;
    metadata: WorktreeTargetMetadata | null;
  }> {
    if (result.review.precondition_status !== "PASS" || proposal.base.kind !== "worktree") return result;
    if (operation.operation === "delete") {
      return { ...result, review: { ...result.review, precondition_status: "FAIL" } };
    }
    try {
      const [headEntry, indexEntry, untrackedEntry, ignored] = await Promise.all([
        this.git(proposal.workspaceRoot, ["ls-tree", proposal.base.head, "--", operation.path]),
        this.git(proposal.workspaceRoot, ["ls-files", "--stage", "--", operation.path]),
        this.git(proposal.workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", operation.path]),
        this.gitResult(proposal.workspaceRoot, ["check-ignore", "--quiet", "--", operation.path])
      ]);
      if (![0, 1].includes(ignored.code)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      const trackedInHead = /^(100644|100755) blob [0-9a-f]+\t[^\n]+\n?$/u;
      const trackedInIndex = /^(100644|100755) [0-9a-f]+ 0\t[^\n]+\n?$/u;
      let origin: GitWorktreeTargetOrigin | undefined;
      if (operation.operation === "modify" && trackedInHead.test(headEntry) && trackedInIndex.test(indexEntry)) {
        origin = "TRACKED_WORKTREE";
      } else if (operation.operation === "modify" && headEntry.length === 0 && indexEntry.length === 0 &&
          ignored.code === 1 && untrackedEntry === `${operation.path}\0` &&
          result.metadata?.hardlinkCount === 1) {
        origin = "EXISTING_UNTRACKED_WORKTREE";
      } else if (operation.operation === "create" && headEntry.length === 0 && indexEntry.length === 0 &&
          ignored.code === 1 && untrackedEntry.length === 0) {
        origin = "ABSENT";
      }
      if (origin === undefined) {
        return { ...result, review: { ...result.review, precondition_status: "FAIL" } };
      }
      const metadata = result.metadata;
      const retainedMetadata = origin === "EXISTING_UNTRACKED_WORKTREE" ? metadata : null;
      return {
        ...result,
        review: {
          ...result.review,
          target_origin: origin,
          target_mode: retainedMetadata?.mode ?? null,
          target_device: retainedMetadata?.device ?? null,
          target_inode: retainedMetadata?.inode ?? null,
          target_hardlink_count: retainedMetadata?.hardlinkCount ?? null
        }
      };
    } catch {
      return { ...result, review: { ...result.review, precondition_status: "UNVERIFIED" } };
    }
  }

  private async reviewProjectInstructionProposal(
    proposal: Proposal,
    output: string,
    expectation: ProjectInstructionExpectation
  ): Promise<ProjectInstructionProposalReview> {
    const targetSha256 = Object.fromEntries(expectation.targets.map(({ path, content }) =>
      [path, sha256(Buffer.from(content, "utf8"))]));
    try {
      const proposed = usesExactPreimageOperations(proposal.base)
        ? Object.fromEntries(parseFilesystemProposal(output).map((operation) => {
            if (operation.operation === "delete") failPatch();
            return [operation.path, operation.content];
          }))
        : await proposedGitPostimages(proposal.workspaceRoot, output);
      const preconditions = await projectInstructionPreconditionsMatch(proposal.workspaceRoot, expectation.targets);
      const exact = preconditions &&
        (!usesExactPreimageOperations(proposal.base) || proposal.proposalReview?.status === "PASS") &&
        Object.keys(proposed).length === expectation.targets.length &&
        expectation.targets.every((target) => proposed[target.path] === target.content);
      return {
        status: exact ? "READY" : "HOLD_NEEDS_PROJECT_DECISION",
        human_approvable: exact,
        evidence_sha256: expectation.evidence_sha256,
        exact_target_bytes: exact,
        target_sha256: targetSha256
      };
    } catch {
      return {
        status: "HOLD_NEEDS_PROJECT_DECISION",
        human_approvable: false,
        evidence_sha256: expectation.evidence_sha256,
        exact_target_bytes: false,
        target_sha256: targetSha256
      };
    }
  }

  private async reviewFilesystemOperation(
    workspaceRoot: string,
    operation: FilesystemOperation,
    remainingBytes: number
  ): Promise<{
    review: DirectoryProposalOperationReview;
    bytes: number | null;
    metadata: WorktreeTargetMetadata | null;
  }> {
    let target: string;
    try {
      target = resolveFilesystemTarget(workspaceRoot, operation.path);
    } catch {
      return {
        review: unverifiedOperationReview(operation, "FAIL"),
        bytes: null,
        metadata: null
      };
    }

    let parentStatus: ProposalReviewStatus;
    try {
      const parent = dirname(target);
      const [canonicalParent, metadata] = await Promise.all([realpath(parent), lstat(parent)]);
      parentStatus = canonicalParent === parent && metadata.isDirectory() && !metadata.isSymbolicLink()
        ? "PASS"
        : "FAIL";
    } catch (error) {
      parentStatus = reviewErrorStatus(error);
    }

    let targetExists: boolean | null = null;
    let targetKind: DirectoryProposalOperationReview["target_kind"] = "unverified";
    let targetSymlinkStatus: ProposalReviewStatus = "UNVERIFIED";
    let exceedsByteLimit = false;
    let current: Buffer | undefined;
    let targetMetadata: WorktreeTargetMetadata | null = null;
    try {
      const metadata = await lstat(target);
      targetExists = true;
      targetKind = metadata.isSymbolicLink()
        ? "symlink"
        : metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other";
      if (metadata.isSymbolicLink()) {
        targetSymlinkStatus = "FAIL";
      } else if (parentStatus === "PASS" && metadata.isFile()) {
        try {
          const canonicalTarget = await realpath(target);
          if (canonicalTarget !== target) targetSymlinkStatus = "FAIL";
          else {
            targetSymlinkStatus = "PASS";
            targetMetadata = {
              mode: metadata.mode & 0o777,
              device: String(metadata.dev),
              inode: String(metadata.ino),
              hardlinkCount: metadata.nlink
            };
            const replacementBytes = operation.operation === "modify"
              ? Buffer.byteLength(operation.content, "utf8")
              : 0;
            exceedsByteLimit = replacementBytes > remainingBytes ||
              metadata.size > remainingBytes - replacementBytes;
            if (!exceedsByteLimit) current = await readFile(target);
          }
        } catch (error) {
          targetSymlinkStatus = reviewErrorStatus(error);
        }
      } else if (parentStatus === "PASS") {
        targetSymlinkStatus = "PASS";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        targetExists = false;
        targetKind = "absent";
        targetSymlinkStatus = parentStatus;
      } else {
        targetSymlinkStatus = reviewErrorStatus(error);
      }
    }

    const proposalPreimage = operation.operation === "create" ? null : operation.beforeSha256;
    const currentSha = current === undefined ? null : sha256(current);
    const preimageMatch = proposalPreimage === null || currentSha === null
      ? null
      : proposalPreimage === currentSha;
    let operationStatus: ProposalReviewStatus;
    if (parentStatus === "UNVERIFIED" || targetExists === null || targetSymlinkStatus === "UNVERIFIED") {
      operationStatus = "UNVERIFIED";
    } else if (parentStatus === "FAIL" || targetSymlinkStatus === "FAIL" || exceedsByteLimit) {
      operationStatus = "FAIL";
    } else if (operation.operation === "create") {
      operationStatus = targetExists === false ? "PASS" : "FAIL";
    } else {
      operationStatus = targetKind === "file" && preimageMatch === true ? "PASS" : "FAIL";
    }
    const bytes = exceedsByteLimit
      ? MAX_FILESYSTEM_BYTES + 1
      : operation.operation === "create"
      ? Buffer.byteLength(operation.content, "utf8")
      : current === undefined
        ? null
        : current.byteLength + (operation.operation === "modify"
          ? Buffer.byteLength(operation.content, "utf8")
          : 0);
    return {
      review: {
        operation: operation.operation,
        path: operation.path,
        normalized_path_status: "PASS",
        target_within_root: "PASS",
        parent_path_symlink_status: parentStatus,
        target_symlink_status: targetSymlinkStatus,
        target_exists: targetExists,
        target_kind: targetKind,
        proposal_preimage_sha256: proposalPreimage,
        current_target_sha256: currentSha,
        preimage_match: preimageMatch,
        precondition_status: operationStatus
      },
      bytes,
      metadata: targetMetadata
    };
  }

  private async applyFilesystemProposal(
    proposal: Proposal,
    taskId: Id,
    output: string,
    gitHead?: string
  ): Promise<{
    changed_paths: string[];
    rollback_reference?: string;
    audit: readonly FilesystemAuditEntry[];
  }> {
    const operations = parseFilesystemProposal(output);
    if (gitHead !== undefined) {
      await this.requireGitWorktreeTargets(proposal, operations);
    }
    const prepared = await this.prepareFilesystemOperations(proposal.workspaceRoot, operations, proposal);
    const audit = prepared.map((operation): FilesystemAuditEntry => ({
      operation: operation.operation,
      path: operation.path,
      before_sha256: operation.before === undefined ? null : sha256(operation.before),
      after_sha256: operation.operation === "delete" ? null : sha256(Buffer.from(operation.content, "utf8"))
    }));
    const recovery: FilesystemRecoveryRecord = {
      version: 1,
      patch_task_id: taskId,
      workspace_id: proposal.workspaceId,
      canonical_workspace_root: proposal.workspaceRoot,
      status: "prepared",
      operations: prepared.map((operation, index) => ({
        ...audit[index]!,
        ...(operation.before === undefined
          ? {}
          : { before_content_base64: operation.before.toString("base64") })
      }))
    };
    const rollbackReference = await this.writeRecoveryRecord(recovery);
    const applied: PreparedFilesystemOperation[] = [];
    try {
      for (const operation of prepared) {
        if (gitHead !== undefined) {
          await this.requireGitWorktreeApplyState(proposal.workspaceId, proposal.workspaceRoot, gitHead);
          await this.requireGitWorktreeTarget(proposal, operation);
        }
        await this.revalidateFilesystemOperation(proposal.workspaceRoot, operation);
        if (operation.operation === "delete") {
          await unlink(operation.target);
        } else if (operation.operation === "create") {
          await this.createFilesystemFile(operation.target, Buffer.from(operation.content, "utf8"), 0o644);
        } else {
          await this.replaceFilesystemFile(operation.target, Buffer.from(operation.content, "utf8"), operation.mode!);
        }
        applied.push(operation);
      }
      if (gitHead !== undefined) {
        await this.requireGitWorktreeApplyState(proposal.workspaceId, proposal.workspaceRoot, gitHead);
      }
      for (const [index, operation] of prepared.entries()) {
        if (operation.operation === "delete") {
          if (await pathExists(operation.target)) failPatch();
          continue;
        }
        const after = await readOrdinaryCanonicalFile(operation.target);
        if (sha256(after) !== audit[index]!.after_sha256) failPatch();
      }
      await this.writeRecoveryRecord({ ...recovery, status: "applied" }, rollbackReference);
      return {
        changed_paths: operations.map(({ path }) => path),
        ...(rollbackReference === undefined ? {} : { rollback_reference: rollbackReference }),
        audit
      };
    } catch (error) {
      try {
        await this.rollbackFilesystemOperations(applied);
        await this.writeRecoveryRecord({ ...recovery, status: "rolled_back" }, rollbackReference);
      } catch {
        await this.writeRecoveryRecord({ ...recovery, status: "rollback_failed" }, rollbackReference).catch(() => undefined);
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      throw error instanceof CoreError ? error : new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
  }

  private async requireGitWorktreeTargets(
    proposal: Proposal,
    operations: readonly FilesystemOperation[]
  ): Promise<void> {
    for (const operation of operations) {
      await this.requireGitWorktreeTarget(proposal, operation);
    }
  }

  private async requireGitWorktreeTarget(proposal: Proposal, operation: FilesystemOperation): Promise<void> {
    if (proposal.base.kind !== "worktree" || proposal.proposalReview?.status !== "PASS") failPatch();
    const retained = proposal.proposalReview.operations.find(({ path }) => path === operation.path);
    if (retained === undefined || retained.operation !== operation.operation ||
        retained.precondition_status !== "PASS") failPatch();
    const current = await this.reviewGitWorktreeOperation(
      proposal,
      operation,
      await this.reviewFilesystemOperation(proposal.workspaceRoot, operation, MAX_FILESYSTEM_BYTES)
    );
    if (current.review.precondition_status !== "PASS") failPatch();
    if (retained.target_origin === undefined) {
      if (!["TRACKED_WORKTREE", "ABSENT"].includes(current.review.target_origin ?? "")) failPatch();
    } else if (current.review.target_origin !== retained.target_origin ||
        retained.target_origin === "EXISTING_UNTRACKED_WORKTREE" && (
          current.review.target_mode !== retained.target_mode ||
          current.review.target_device !== retained.target_device ||
          current.review.target_inode !== retained.target_inode ||
          current.review.target_hardlink_count !== retained.target_hardlink_count
        )) {
      failPatch();
    }
  }

  private async requireGitWorktreeApplyState(
    workspaceId: string,
    workspaceRoot: string,
    head: string
  ): Promise<void> {
    const current = await this.inspectWorkspaceForProposal(workspaceId, workspaceRoot);
    if (current === "index_dirty" || !sameBase(current, { kind: "worktree", head })) failPatch();
  }

  private async prepareFilesystemOperations(
    workspaceRoot: string,
    operations: readonly FilesystemOperation[],
    proposal: Proposal
  ): Promise<PreparedFilesystemOperation[]> {
    const prepared: PreparedFilesystemOperation[] = [];
    let boundedBytes = 0;
    for (const operation of operations) {
      const target = resolveFilesystemTarget(workspaceRoot, operation.path);
      await requireCanonicalParent(workspaceRoot, target);
      if (operation.operation === "create") {
        if (await pathExists(target)) failPatch();
        const content = Buffer.from(operation.content, "utf8");
        boundedBytes += content.byteLength;
        prepared.push({
          ...operation,
          target,
          before: undefined,
          mode: undefined,
          device: undefined,
          inode: undefined,
          hardlinkCount: undefined,
          strictMetadata: false
        });
      } else {
        let metadata;
        let canonicalTarget: string;
        let before: Buffer;
        try {
          metadata = await lstat(target);
          canonicalTarget = await realpath(target);
          before = await readFile(target);
        } catch {
          failPatch();
        }
        if (!metadata.isFile() || metadata.isSymbolicLink() || canonicalTarget !== target ||
            sha256(before) !== operation.beforeSha256) failPatch();
        boundedBytes += before.byteLength;
        if (operation.operation === "modify") boundedBytes += Buffer.byteLength(operation.content, "utf8");
        prepared.push({
          ...operation,
          target,
          before,
          mode: metadata.mode & 0o777,
          device: String(metadata.dev),
          inode: String(metadata.ino),
          hardlinkCount: metadata.nlink,
          strictMetadata: proposal.base.kind === "worktree" && proposal.proposalReview?.operations
            .find(({ path }) => path === operation.path)?.target_origin === "EXISTING_UNTRACKED_WORKTREE"
        });
      }
      if (boundedBytes > MAX_FILESYSTEM_BYTES) failPatch();
    }
    return prepared;
  }

  private async revalidateFilesystemOperation(
    workspaceRoot: string,
    operation: PreparedFilesystemOperation
  ): Promise<void> {
    await requireCanonicalParent(workspaceRoot, operation.target);
    if (operation.operation === "create") {
      if (await pathExists(operation.target)) failPatch();
      return;
    }
    let metadata;
    let canonicalTarget: string;
    let current: Buffer;
    try {
      metadata = await lstat(operation.target);
      canonicalTarget = await realpath(operation.target);
      current = await readFile(operation.target);
    } catch {
      failPatch();
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || canonicalTarget !== operation.target ||
        sha256(current) !== operation.beforeSha256 || operation.strictMetadata && (
          (metadata.mode & 0o777) !== operation.mode || String(metadata.dev) !== operation.device ||
          String(metadata.ino) !== operation.inode || metadata.nlink !== operation.hardlinkCount
        )) failPatch();
  }

  private async rollbackFilesystemOperations(operations: readonly PreparedFilesystemOperation[]): Promise<void> {
    for (const operation of [...operations].reverse()) {
      if (operation.before === undefined) {
        const current = await readOrdinaryCanonicalFile(operation.target);
        if (operation.operation !== "create" || sha256(current) !== sha256(Buffer.from(operation.content, "utf8"))) {
          failPatch();
        }
        await unlink(operation.target);
      } else if (operation.operation === "delete") {
        if (await pathExists(operation.target)) failPatch();
        await this.createFilesystemFile(operation.target, operation.before, operation.mode!);
      } else {
        const current = await readOrdinaryCanonicalFile(operation.target);
        if (sha256(current) !== sha256(Buffer.from(operation.content, "utf8"))) failPatch();
        await this.replaceFilesystemFile(operation.target, operation.before, operation.mode!);
      }
    }
  }

  private async createFilesystemFile(target: string, contents: Buffer, mode: number): Promise<void> {
    const temporaryPath = `${target}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { flag: "wx", mode });
      await link(temporaryPath, target);
      await unlink(temporaryPath);
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
  }

  private async replaceFilesystemFile(target: string, contents: Buffer, mode: number): Promise<void> {
    const temporaryPath = `${target}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { flag: "wx", mode });
      await rename(temporaryPath, target);
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
  }

  private async writeRecoveryRecord(
    record: FilesystemRecoveryRecord,
    existingPath?: string
  ): Promise<string | undefined> {
    if (this.projectStateRoot === undefined) return undefined;
    const workspaceDirectory = isId(record.workspace_id)
      ? record.workspace_id
      : `legacy-${sha256(Buffer.from(record.workspace_id, "utf8"))}`;
    const directory = join(this.projectStateRoot, workspaceDirectory, "controlled-patches");
    const target = existingPath ?? join(directory, `${record.patch_task_id}.json`);
    const temporaryPath = `${target}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600
      });
      await rename(temporaryPath, target);
      return target;
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  private async verifyWorkspace(workspaceId: string, workspaceRoot: string): Promise<ProposalBase> {
    const state = await this.inspectWorkspaceForProposal(workspaceId, workspaceRoot);
    if (state === "index_dirty") throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return state;
  }

  private async inspectWorkspaceForProposal(
    workspaceId: string,
    workspaceRoot: string
  ): Promise<ProposalBase | "index_dirty"> {
    const workspaceType = await this.workspaceType(workspaceId);
    if (workspaceType === "directory_workspace") {
      let canonical: string;
      try {
        canonical = await realpath(resolve(workspaceRoot));
      } catch {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      if (canonical !== resolve(workspaceRoot) || !(await lstat(canonical)).isDirectory()) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      if (await hasGitControlMarkerAtOrAbove(canonical)) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      return { kind: "filesystem" };
    }
    const topLevel = (await this.git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim();
    let canonicalTopLevel: string;
    let canonicalWorkspaceRoot: string;
    try {
      [canonicalTopLevel, canonicalWorkspaceRoot] = await Promise.all([
        realpath(resolve(topLevel)),
        realpath(resolve(workspaceRoot))
      ]);
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    if (canonicalTopLevel !== canonicalWorkspaceRoot) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const base = await this.detectBase(workspaceRoot);
    if (base.kind === "unborn") {
      return (await this.git(workspaceRoot, ["ls-files", "--stage"])).length === 0
        ? base
        : "index_dirty";
    }
    const index = await this.gitResult(workspaceRoot, ["diff", "--cached", "--quiet", "--"]);
    if (index.code === 1) return "index_dirty";
    if (index.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const worktree = await this.gitResult(workspaceRoot, ["diff", "--quiet", "--"]);
    if (worktree.code === 0) return base;
    if (worktree.code === 1) return { kind: "worktree", head: base.head };
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }

  // Distinguishes the three possible HEAD states without ever inferring "unborn"
  // from a bare nonzero exit or a catch-all failure. A repository is genuinely
  // unborn only when all of the following hold (stable, machine-decidable Git
  // primitives):
  //   1. `git rev-parse --verify --quiet HEAD` exits non-zero: HEAD does not
  //      resolve to a commit.
  //   2. `git symbolic-ref --quiet HEAD` exits zero and names a refs/heads/<branch>
  //      ref: HEAD is a symbolic branch ref, not detached, malformed, or absent.
  //   3. `git rev-parse --verify --quiet refs/heads/<branch>` exits non-zero:
  //      that branch has no commit yet (unborn branch state).
  // Any other combination — spawn/IO failures, detached or non-branch HEAD, or a
  // branch that resolves while HEAD does not — fails closed as
  // WORKSPACE_PRECONDITION_FAILED instead of being guessed as unborn.
  private async detectBase(
    workspaceRoot: string
  ): Promise<Extract<ProposalBase, { kind: "commit" | "unborn" }>> {
    const head = await this.gitResult(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code === 0) {
      const value = head.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      return { kind: "commit", head: value };
    }
    const symbolicRef = await this.gitResult(workspaceRoot, ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolicRef.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const branch = symbolicRef.stdout.trim();
    if (!/^refs\/heads\/[^\s]+$/u.test(branch)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const branchHead = await this.gitResult(workspaceRoot, ["rev-parse", "--verify", "--quiet", branch]);
    if (branchHead.code === 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return { kind: "unborn" };
  }

  private git(cwd: string, args: readonly string[], input?: string): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.startProcess("git", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        reject(new CoreError("WORKSPACE_PRECONDITION_FAILED"));
        return;
      }
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.resume();
      child.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.on("close", (code) => code === 0
        ? resolveOutput(stdout)
        : reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.stdin.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.stdin.end(input);
    });
  }

  // Exit-code-observing sibling of git(), used only for HEAD detection: it
  // resolves with the exit code and stdout instead of rejecting on nonzero, so
  // detectBase can prove the unborn state instead of assuming it. All other
  // calls keep using git(), which rejects on any nonzero exit.
  private gitResult(cwd: string, args: readonly string[], input?: string): Promise<GitExit> {
    return new Promise((resolveOutput, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.startProcess("git", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        reject(new CoreError("WORKSPACE_PRECONDITION_FAILED"));
        return;
      }
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.resume();
      child.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.on("close", (code) => resolveOutput({ code: code ?? -1, stdout }));
      child.stdin.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.stdin.end(input);
    });
  }
}

function aggregateReviewStatus(...statuses: readonly ProposalReviewStatus[]): ProposalReviewStatus {
  if (statuses.includes("FAIL")) return "FAIL";
  return statuses.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
}

function directoryReview(
  workspaceId: string,
  workspaceType: WorkspaceType,
  status: ProposalReviewStatus,
  proposalSchemaStatus: ProposalReviewStatus,
  canonicalRootStatus: ProposalReviewStatus,
  workspaceTypeStatus: ProposalReviewStatus,
  operations: readonly DirectoryProposalOperationReview[],
  operationLimitsStatus: ProposalReviewStatus = "UNVERIFIED"
): DirectoryProposalReview {
  return {
    status,
    human_approvable: status === "PASS",
    workspace_id: workspaceId,
    workspace_type: workspaceType,
    proposal_schema_status: proposalSchemaStatus,
    canonical_root_status: canonicalRootStatus,
    workspace_type_status: workspaceTypeStatus,
    operation_limits_status: operationLimitsStatus,
    operations,
    apply_revalidation_required: true
  };
}

function unverifiedDirectoryReview(workspaceId: string, workspaceType: WorkspaceType): DirectoryProposalReview {
  return directoryReview(
    workspaceId, workspaceType, "UNVERIFIED", "UNVERIFIED", "UNVERIFIED", "UNVERIFIED", []
  );
}

function unverifiedOperationReview(
  operation: FilesystemOperation,
  status: ProposalReviewStatus
): DirectoryProposalOperationReview {
  return {
    operation: operation.operation,
    path: operation.path,
    normalized_path_status: status,
    target_within_root: status,
    parent_path_symlink_status: "UNVERIFIED",
    target_symlink_status: "UNVERIFIED",
    target_exists: null,
    target_kind: "unverified",
    proposal_preimage_sha256: operation.operation === "create" ? null : operation.beforeSha256,
    current_target_sha256: null,
    preimage_match: null,
    precondition_status: status
  };
}

function reviewErrorStatus(error: unknown): ProposalReviewStatus {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && ["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"].includes(code)
    ? "UNVERIFIED"
    : "FAIL";
}

async function reviewHasGitControlMarkerAtOrAbove(path: string): Promise<boolean> {
  let current = path;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function readyLifecycle(lifecycle: ControlledProposalLifecycle): ControlledProposalLifecycle {
  return {
    ...lifecycle,
    stage: "READY",
    model_turn_started: true,
    model_turn_completed: true,
    parse_status: "PASS",
    validation_stage: "COMPLETE",
    terminal_transition: "READY"
  };
}

function failedLifecycle(
  lifecycle: ControlledProposalLifecycle,
  failureCode: SerializedError["code"]
): ControlledProposalLifecycle {
  return {
    ...lifecycle,
    stage: "FAILED",
    terminal_transition: "FAILED",
    failure_code: failureCode
  };
}

function legacyReadyLifecycle(
  output: string,
  review: DirectoryProposalReview | undefined
): ControlledProposalLifecycle {
  return {
    stage: "READY",
    started_at: "1970-01-01T00:00:00.000Z",
    deadline_at: "1970-01-01T00:00:00.000Z",
    model_turn_started: true,
    model_turn_completed: true,
    proposal_bytes_received: Buffer.byteLength(output, "utf8"),
    parse_status: review?.proposal_schema_status ?? "UNVERIFIED",
    validation_stage: review?.status === "PASS" ? "COMPLETE" : "PENDING",
    terminal_transition: "READY"
  };
}

function parseControlledProposalLifecycle(value: unknown): ControlledProposalLifecycle | undefined {
  const allowedKeys = [
    "stage", "started_at", "deadline_at", "model_turn_started", "model_turn_completed",
    "proposal_bytes_received", "parse_status", "validation_stage", "terminal_transition", "failure_code"
  ];
  if (!isObject(value) || !Object.keys(value).every((key) => allowedKeys.includes(key)) ||
      !["stage", "started_at", "deadline_at", "model_turn_started", "model_turn_completed",
        "proposal_bytes_received", "parse_status", "validation_stage"].every((key) => key in value) ||
      !["CREATED", "MODEL_RUNNING", "MODEL_OUTPUT_READY", "PROPOSAL_VALIDATING", "READY", "FAILED"]
    .includes(value.stage as string) || typeof value.started_at !== "string" ||
      typeof value.deadline_at !== "string" || Number.isNaN(Date.parse(value.started_at)) ||
      Number.isNaN(Date.parse(value.deadline_at)) || Date.parse(value.deadline_at) < Date.parse(value.started_at) ||
      typeof value.model_turn_started !== "boolean" || typeof value.model_turn_completed !== "boolean" ||
      typeof value.proposal_bytes_received !== "number" ||
      !Number.isSafeInteger(value.proposal_bytes_received) || value.proposal_bytes_received < 0 ||
      !["PASS", "FAIL", "UNVERIFIED"].includes(value.parse_status as string) ||
      !["PENDING", "SCHEMA", "WORKSPACE", "OPERATIONS", "COMPLETE"]
        .includes(value.validation_stage as string) ||
      (value.terminal_transition !== undefined && !["READY", "FAILED"].includes(value.terminal_transition as string)) ||
      (value.failure_code !== undefined && !ERROR_CODES.includes(value.failure_code as SerializedError["code"]))) {
    return undefined;
  }
  if ((value.stage === "READY") !== (value.terminal_transition === "READY") ||
      (value.stage === "FAILED") !== (value.terminal_transition === "FAILED") ||
      (value.stage === "FAILED") !== (value.failure_code !== undefined) ||
      value.model_turn_completed && !value.model_turn_started) return undefined;
  return value as unknown as ControlledProposalLifecycle;
}

function parseRetainedFailure(value: unknown): SerializedError | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, ["code", "message"]) ||
      !ERROR_CODES.includes(value.code as SerializedError["code"]) || typeof value.message !== "string") {
    return undefined;
  }
  const expected = serializeError(new CoreError(value.code as SerializedError["code"]));
  return value.message === expected.message ? expected : undefined;
}

// Strictly parses the retained controlled-patch state. Global invariants always
// fail closed with INTERNAL_ERROR; a single proposal record that cannot be
// safely restored is quarantined instead, so one bad record cannot brick the
// whole server. Quarantine never weakens the replay/duplicate-APPLY judgment:
// a quarantined record is dropped from the in-memory map (it can never be
// refined or APPLYed again), its task is never restored, and any
// applied_task_ids entry that referenced it is dropped with it, keeping the
// applied history exactly equal to the surviving applied proposals.
function parseRetainedState(value: unknown, registry: RegisteredWorkspaceRegistry): RetainedState {
  // 1. Strict envelope: an unreadable or unsupported top-level state fails the
  //    whole load, never a per-record quarantine.
  if (!isObject(value) || ![2, 3, 4, CONTROLLED_PATCH_STATE_VERSION].includes(value.version as number) ||
      !Array.isArray(value.applied_task_ids) || !Array.isArray(value.proposals)) {
    throw new CoreError("INTERNAL_ERROR");
  }

  // 2. Strict applied_task_ids list: the list itself is a global invariant
  //    (well-formed ids, no duplicates, bounded history).
  if (!value.applied_task_ids.every(isId)) throw new CoreError("INTERNAL_ERROR");
  const appliedTaskIds = value.applied_task_ids as Id[];
  if (appliedTaskIds.length > MAX_APPLIED_PROPOSAL_HISTORY ||
      new Set(appliedTaskIds).size !== appliedTaskIds.length) {
    throw new CoreError("INTERNAL_ERROR");
  }

  // 3. Record-level parse with per-record quarantine.
  const proposals: RetainedProposal[] = [];
  const quarantinedTaskIds = new Set<Id>();
  const taskIdOccurrences = new Map<Id, number>();
  for (const item of value.proposals) {
    // A duplicated task id makes proposal identity ambiguous even when one of
    // the duplicates is otherwise broken (one copy could say "applied" while
    // the other says "proposed"), so it always fails closed.
    if (isObject(item) && isId(item.task_id)) {
      const occurrences = (taskIdOccurrences.get(item.task_id) ?? 0) + 1;
      taskIdOccurrences.set(item.task_id, occurrences);
      if (occurrences > 1) throw new CoreError("INTERNAL_ERROR");
    }
    const proposal = parseRetainedProposal(item, value.version as number);
    if (proposal === undefined) {
      if (isObject(item) && isId(item.task_id)) quarantinedTaskIds.add(item.task_id);
      continue;
    }
    // A proposal whose workspace is no longer registered (or whose root no
    // longer matches the registry) can be neither safely restored nor APPLYed:
    // quarantine it instead of failing the whole load.
    if (!registryMatches(registry, proposal.workspaceId, proposal.workspaceRoot)) {
      quarantinedTaskIds.add(proposal.taskId);
      continue;
    }
    proposals.push(proposal);
  }

  // 4. parent/refine relationship invariants over surviving proposals. The
  //    parent link is audit lineage only: a dangling parent (quarantined or
  //    never persisted) is allowed, but a surviving parent whose workspace or
  //    base contradicts the child fails closed.
  const byTaskId = new Map<Id, RetainedProposal>();
  for (const proposal of proposals) byTaskId.set(proposal.taskId, proposal);
  for (const proposal of proposals) {
    if (proposal.parentTaskId === undefined) continue;
    if (proposal.parentTaskId === proposal.taskId) throw new CoreError("INTERNAL_ERROR");
    const parent = byTaskId.get(proposal.parentTaskId);
    if (parent !== undefined && (parent.workspaceId !== proposal.workspaceId ||
        parent.workspaceRoot !== proposal.workspaceRoot ||
        !sameBase(proposal.base, parent.base))) {
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  // 5. Applied-history cross-invariant over survivors: applied_task_ids must
  //    equal exactly the surviving applied proposals. A quarantined record
  //    takes its own applied_task_ids entry with it, so dropping a bad applied
  //    record never leaves a dangling applied id behind; an applied id with no
  //    proposal record at all still fails closed.
  const survivingAppliedTaskIds = appliedTaskIds.filter((taskId) => !quarantinedTaskIds.has(taskId));
  const survivingAppliedTaskIdSet = new Set(survivingAppliedTaskIds);
  const appliedProposals = proposals.filter(({ state }) => state === "applied");
  if (appliedProposals.length !== survivingAppliedTaskIds.length ||
      appliedProposals.some(({ taskId }) => !survivingAppliedTaskIdSet.has(taskId))) {
    throw new CoreError("INTERNAL_ERROR");
  }
  return { proposals, appliedTaskIds: survivingAppliedTaskIds };
}

// Parses a single retained proposal record. Returns undefined for a record that
// cannot be safely restored because its own fields are malformed; the caller
// quarantines such records. Any failure here is strictly record-local: no
// global invariant (identity, applied history, replay safety) is affected by
// dropping the record.
function parseRetainedProposal(item: unknown, version: number): RetainedProposal | undefined {
  if (!isObject(item) || !isId(item.task_id) ||
      typeof item.workspace_id !== "string" || item.workspace_id.length === 0 ||
      typeof item.workspace_root !== "string" ||
      (item.unborn !== undefined && typeof item.unborn !== "boolean") ||
      (item.filesystem !== undefined && typeof item.filesystem !== "boolean") ||
      (item.worktree !== undefined && typeof item.worktree !== "boolean") ||
      !["proposed", "applying", "applied"].includes(item.state as string) ||
      (item.parent_task_id !== undefined && !isId(item.parent_task_id)) ||
      !["auto", ...CODEX_LOGICAL_ROLES].includes(item.routing as CodexRouting) ||
      !CODEX_LOGICAL_ROLES.includes(item.logical_role as CodexLogicalRole) ||
      !["explicit_override", "high_risk_or_architectural", "bounded_implementation", "default_quality_route"]
        .includes(item.routing_reason as CodexRoutingReason) ||
      (item.routing_matched_rule !== undefined &&
        !["explicit_override", "positive_high_risk_intent", "bounded_implementation", "quality_fallback",
          "legacy_unverified"]
          .includes(item.routing_matched_rule as CodexRoutingRule)) ||
      (item.routing_matched_factors !== undefined && !isRoutingFactors(item.routing_matched_factors)) ||
      (item.routing_ignored_guard_factors !== undefined &&
        !isRoutingFactors(item.routing_ignored_guard_factors)) ||
      (item.routing_transition !== undefined &&
        !["escalation", "de_escalation", "handoff"].includes(item.routing_transition as string)) ||
      typeof item.model !== "string" || item.reasoning_effort !== "max" ||
      typeof item.bridge_version !== "string" || item.bridge_version.length === 0 ||
      (item.codex_version !== undefined &&
        (typeof item.codex_version !== "string" || item.codex_version.length === 0)) ||
      (item.thread_id !== undefined && (typeof item.thread_id !== "string" || item.thread_id.length === 0)) ||
      item.executor !== "codex" || (item.output !== undefined && typeof item.output !== "string")) {
    return undefined;
  }
  let base: ProposalBase;
  try {
    base = parseProposalBase(item);
  } catch {
    return undefined;
  }
  let handoffSnapshot: HandoffSnapshot | undefined;
  try {
    handoffSnapshot = item.handoff_snapshot === undefined
      ? undefined
      : requireHandoffSnapshot(item.handoff_snapshot);
  } catch {
    return undefined;
  }
  const requestedRouting = item.routing as CodexRouting;
  const logicalRole = item.logical_role as CodexLogicalRole;
  const routingReason = item.routing_reason as CodexRoutingReason;
  const routingMatchedRule = (item.routing_matched_rule ?? "legacy_unverified") as CodexRoutingRule;
  const routingMatchedFactors = (item.routing_matched_factors ?? []) as string[];
  const routingIgnoredGuardFactors = (item.routing_ignored_guard_factors ?? []) as string[];
  const evidence = item.evidence === undefined ? undefined : validateExecutorEvidence(item.evidence);
  const proposalReview = item.proposal_review === undefined
    ? undefined
    : parseDirectoryProposalReview(item.proposal_review, item.workspace_id);
  const projectInstruction = item.project_instruction === undefined
    ? undefined
    : parseProjectInstructionExpectation(item.project_instruction);
  const projectInstructionReview = item.project_instruction_review === undefined
    ? undefined
    : parseProjectInstructionProposalReview(item.project_instruction_review, projectInstruction);
  const legacy = version < CONTROLLED_PATCH_STATE_VERSION;
  const taskState = legacy ? "completed" : item.task_state;
  const lifecycle = legacy
    ? legacyReadyLifecycle(item.output as string, proposalReview)
    : parseControlledProposalLifecycle(item.lifecycle);
  const failure = legacy ? undefined : parseRetainedFailure(item.failure);
  const terminalShapeValid = taskState === "running"
    ? item.output === undefined && item.failure === undefined && lifecycle?.terminal_transition === undefined
    : taskState === "completed"
      ? typeof item.output === "string" && item.failure === undefined &&
        typeof item.codex_version === "string" && typeof item.thread_id === "string" &&
        lifecycle?.stage === "READY" && lifecycle.terminal_transition === "READY"
      : taskState === "failed"
        ? failure !== undefined && lifecycle?.stage === "FAILED" && lifecycle.terminal_transition === "FAILED"
        : false;
  if ((requestedRouting === "auto" && routingReason === "explicit_override") ||
      (requestedRouting !== "auto" &&
        (requestedRouting !== logicalRole || routingReason !== "explicit_override")) ||
      (routingMatchedRule !== "legacy_unverified" && routingMatchedRule !== routingRuleForReason(routingReason)) ||
      (routingMatchedRule === "legacy_unverified" &&
        (routingMatchedFactors.length !== 0 || routingIgnoredGuardFactors.length !== 0)) ||
      (item.parent_task_id !== undefined && handoffSnapshot === undefined) ||
      (item.evidence !== undefined && evidence === undefined) ||
      (item.proposal_review !== undefined && proposalReview === undefined) ||
      (proposalReview !== undefined && proposalReview.workspace_type !==
        (base.kind === "filesystem" ? "directory_workspace" : "git_workspace")) ||
      (item.project_instruction !== undefined && projectInstruction === undefined) ||
      (item.project_instruction_review !== undefined && projectInstructionReview === undefined) ||
      (projectInstructionReview !== undefined && projectInstruction === undefined) ||
      (!legacy && lifecycle === undefined) || !terminalShapeValid ||
      (item.state === "applied" && taskState !== "completed")) {
    return undefined;
  }
  return {
    taskId: item.task_id,
    workspaceId: item.workspace_id,
    workspaceRoot: item.workspace_root,
    base,
    state: item.state as Proposal["state"],
    taskState: taskState as Proposal["taskState"],
    lifecycle: lifecycle!,
    failure,
    parentTaskId: item.parent_task_id as Id | undefined,
    output: item.output as string | undefined,
    requestedRouting,
    logicalRole,
    routingReason,
    routingMatchedRule,
    routingMatchedFactors,
    routingIgnoredGuardFactors,
    routingTransition: item.routing_transition as Proposal["routingTransition"],
    handoffSnapshot,
    model: item.model,
    reasoningEffort: item.reasoning_effort,
    bridgeVersion: item.bridge_version,
    codexVersion: item.codex_version as string | undefined,
    threadId: item.thread_id as string | undefined,
    evidence,
    proposalReview,
    projectInstruction,
    projectInstructionReview,
    executor: item.executor
  };
}

function parseProjectInstructionExpectation(value: unknown): ProjectInstructionExpectation | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, ["evidence_sha256", "targets"]) ||
      !isSha256(value.evidence_sha256) || !Array.isArray(value.targets) ||
      value.targets.length === 0 || value.targets.length > 2) return undefined;
  const targets: ProjectInstructionTarget[] = [];
  const paths = new Set<string>();
  for (const item of value.targets) {
    if (!isObject(item) || !hasOnlyKeys(item, item.operation === "create"
      ? ["path", "operation", "content"]
      : ["path", "operation", "before_sha256", "content"]) ||
        !["AGENTS.md", "PLANS.md"].includes(item.path as string) ||
        paths.has(item.path as string) || !["create", "modify"].includes(item.operation as string) ||
        typeof item.content !== "string" || !isTextContent(item.content) ||
        (item.before_sha256 !== undefined && !isSha256(item.before_sha256)) ||
        (item.operation === "create") !== (item.before_sha256 === undefined)) return undefined;
    const target: ProjectInstructionTarget = {
      path: item.path as ProjectInstructionTarget["path"],
      operation: item.operation as ProjectInstructionTarget["operation"],
      ...(item.before_sha256 === undefined ? {} : { before_sha256: item.before_sha256 as string }),
      content: item.content
    };
    paths.add(target.path);
    targets.push(target);
  }
  if (targets.reduce((bytes, target) => bytes + Buffer.byteLength(target.content, "utf8"), 0) >
      MAX_FILESYSTEM_BYTES) return undefined;
  return { evidence_sha256: value.evidence_sha256, targets };
}

function parseProjectInstructionProposalReview(
  value: unknown,
  expectation: ProjectInstructionExpectation | undefined
): ProjectInstructionProposalReview | undefined {
  if (expectation === undefined || !isObject(value) || !hasOnlyKeys(value, [
    "status", "human_approvable", "evidence_sha256", "exact_target_bytes", "target_sha256"
  ]) || !["READY", "HOLD_NEEDS_PROJECT_DECISION"].includes(value.status as string) ||
      value.human_approvable !== (value.status === "READY") ||
      value.exact_target_bytes !== (value.status === "READY") ||
      value.evidence_sha256 !== expectation.evidence_sha256 || !isObject(value.target_sha256)) return undefined;
  const expectedHashes = Object.fromEntries(expectation.targets.map(({ path, content }) =>
    [path, sha256(Buffer.from(content, "utf8"))]));
  if (JSON.stringify(value.target_sha256) !== JSON.stringify(expectedHashes)) return undefined;
  return value as unknown as ProjectInstructionProposalReview;
}

function registryMatches(
  registry: RegisteredWorkspaceRegistry,
  workspaceId: string,
  workspaceRoot: string
): boolean {
  try {
    return registry.resolve(workspaceId) === workspaceRoot;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function routingRuleForReason(reason: CodexRoutingReason): CodexRoutingRule {
  if (reason === "explicit_override") return "explicit_override";
  if (reason === "high_risk_or_architectural") return "positive_high_risk_intent";
  return reason === "bounded_implementation" ? "bounded_implementation" : "quality_fallback";
}

function isRoutingFactors(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ROUTING_FACTORS &&
    value.every((factor) => typeof factor === "string" && factor.length > 0 && factor.length <= 128);
}

function isReviewStatus(value: unknown): value is ProposalReviewStatus {
  return value === "PASS" || value === "FAIL" || value === "UNVERIFIED";
}

function parseDirectoryProposalReview(
  value: unknown,
  workspaceId: string
): DirectoryProposalReview | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "status", "human_approvable", "workspace_id", "workspace_type", "proposal_schema_status", "canonical_root_status",
    "workspace_type_status", "operation_limits_status", "operations", "apply_revalidation_required"
  ]) || !isReviewStatus(value.status) || value.human_approvable !== (value.status === "PASS") ||
      value.workspace_id !== workspaceId ||
      !["directory_workspace", "git_workspace"].includes(value.workspace_type as string) ||
      !isReviewStatus(value.proposal_schema_status) ||
      !isReviewStatus(value.canonical_root_status) || !isReviewStatus(value.workspace_type_status) ||
      !isReviewStatus(value.operation_limits_status) || value.apply_revalidation_required !== true ||
      !Array.isArray(value.operations) || value.operations.length > MAX_FILESYSTEM_OPERATIONS) return undefined;
  const operations: DirectoryProposalOperationReview[] = [];
  const paths = new Set<string>();
  for (const item of value.operations) {
    if (!isObject(item)) return undefined;
    const baseKeys = [
      "operation", "path", "normalized_path_status", "target_within_root", "parent_path_symlink_status",
      "target_symlink_status", "target_exists", "target_kind", "proposal_preimage_sha256",
      "current_target_sha256", "preimage_match", "precondition_status"
    ];
    const provenanceKeys = [
      ...baseKeys, "target_origin", "target_mode", "target_device", "target_inode", "target_hardlink_count"
    ];
    const hasProvenance = hasOnlyKeys(item, provenanceKeys);
    if ((!hasOnlyKeys(item, baseKeys) && !hasProvenance) ||
        !["create", "modify", "delete"].includes(item.operation as string) ||
        typeof item.path !== "string" || !safePath(item.path) || paths.has(item.path) ||
        !isReviewStatus(item.normalized_path_status) || !isReviewStatus(item.target_within_root) ||
        !isReviewStatus(item.parent_path_symlink_status) || !isReviewStatus(item.target_symlink_status) ||
        (item.target_exists !== null && typeof item.target_exists !== "boolean") ||
        !["absent", "file", "directory", "symlink", "other", "unverified"].includes(item.target_kind as string) ||
        (item.proposal_preimage_sha256 !== null && !isSha256(item.proposal_preimage_sha256)) ||
        (item.current_target_sha256 !== null && !isSha256(item.current_target_sha256)) ||
        (item.preimage_match !== null && typeof item.preimage_match !== "boolean") ||
        !isReviewStatus(item.precondition_status)) return undefined;
    if (hasProvenance && (
      !["TRACKED_WORKTREE", "EXISTING_UNTRACKED_WORKTREE", "ABSENT"].includes(item.target_origin as string) ||
      (item.target_mode !== null && (!Number.isInteger(item.target_mode) ||
        (item.target_mode as number) < 0 || (item.target_mode as number) > 0o777)) ||
      (item.target_device !== null && (typeof item.target_device !== "string" ||
        !/^\d+$/u.test(item.target_device))) ||
      (item.target_inode !== null && (typeof item.target_inode !== "string" || !/^\d+$/u.test(item.target_inode))) ||
      (item.target_hardlink_count !== null && (!Number.isInteger(item.target_hardlink_count) ||
        (item.target_hardlink_count as number) < 1))
    )) return undefined;
    if (hasProvenance) {
      const absent = item.target_origin === "ABSENT";
      const untracked = item.target_origin === "EXISTING_UNTRACKED_WORKTREE";
      if (absent !== (item.operation === "create") || (absent
        ? item.target_mode !== null || item.target_device !== null || item.target_inode !== null ||
          item.target_hardlink_count !== null
        : item.operation !== "modify" || (untracked
          ? item.target_mode === null || item.target_device === null || item.target_inode === null ||
            item.target_hardlink_count !== 1
          : item.target_mode !== null || item.target_device !== null || item.target_inode !== null ||
            item.target_hardlink_count !== null))) {
        return undefined;
      }
    }
    if ((item.operation === "create") !== (item.proposal_preimage_sha256 === null)) return undefined;
    const expectedMatch = item.proposal_preimage_sha256 === null || item.current_target_sha256 === null
      ? null
      : item.proposal_preimage_sha256 === item.current_target_sha256;
    if (item.preimage_match !== expectedMatch) return undefined;
    if (item.precondition_status === "PASS" && (
      item.normalized_path_status !== "PASS" || item.target_within_root !== "PASS" ||
      item.parent_path_symlink_status !== "PASS" || item.target_symlink_status !== "PASS" ||
      (item.operation === "create"
        ? item.target_exists !== false || item.target_kind !== "absent" ||
          item.current_target_sha256 !== null || item.preimage_match !== null
        : item.target_exists !== true || item.target_kind !== "file" ||
          item.current_target_sha256 === null || item.preimage_match !== true)
    )) return undefined;
    paths.add(item.path);
    operations.push(item as unknown as DirectoryProposalOperationReview);
  }
  if (value.status === "PASS" && (value.proposal_schema_status !== "PASS" ||
      value.canonical_root_status !== "PASS" || value.workspace_type_status !== "PASS" ||
      value.operation_limits_status !== "PASS" || operations.length === 0 ||
      operations.some(({ precondition_status }) => precondition_status !== "PASS"))) return undefined;
  return { ...value, operations } as unknown as DirectoryProposalReview;
}

function normalizeTrailingLf(output: string): string {
  return `${output.replace(/\n*$/u, "")}\n`;
}

type PatchTarget = { path: string; kind: "modified" | "added" };

async function proposedGitPostimages(workspaceRoot: string, patch: string): Promise<Record<string, string>> {
  const targets = parsePatch(patch);
  const sections = patch.split(/(?=^diff --git )/gmu).filter(Boolean);
  if (sections.length !== targets.length) failPatch();
  const proposed: Record<string, string> = {};
  for (const [index, target] of targets.entries()) {
    const section = sections[index]!;
    const current = target.kind === "added"
      ? ""
      : (await readOrdinaryCanonicalFile(resolve(workspaceRoot, target.path))).toString("utf8");
    proposed[target.path] = applyUnifiedSection(current, section);
  }
  return proposed;
}

async function projectInstructionPreconditionsMatch(
  workspaceRoot: string,
  targets: readonly ProjectInstructionTarget[]
): Promise<boolean> {
  for (const target of targets) {
    const path = resolve(workspaceRoot, target.path);
    if (target.operation === "create") {
      if (await pathExists(path)) return false;
      continue;
    }
    if (target.before_sha256 === undefined) return false;
    try {
      if (sha256(await readOrdinaryCanonicalFile(path)) !== target.before_sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function applyUnifiedSection(current: string, section: string): string {
  if ((current !== "" && !current.endsWith("\n")) || section.includes("\\ No newline at end of file")) failPatch();
  const source = current === "" ? [] : current.slice(0, -1).split("\n");
  const lines = section.replace(/\n*$/u, "").split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) failPatch();
  const result: string[] = [];
  let sourceIndex = 0;
  let index = firstHunk;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index]!);
    if (header === null) failPatch();
    const oldStart = Number(header[1]);
    const expectedSourceIndex = oldStart === 0 ? 0 : oldStart - 1;
    if (expectedSourceIndex < sourceIndex || expectedSourceIndex > source.length) failPatch();
    result.push(...source.slice(sourceIndex, expectedSourceIndex));
    sourceIndex = expectedSourceIndex;
    index += 1;
    let consumed = 0;
    let produced = 0;
    while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
      const line = lines[index]!;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (source[sourceIndex] !== value) failPatch();
        result.push(value);
        sourceIndex += 1;
        consumed += 1;
        produced += 1;
      } else if (marker === "-") {
        if (source[sourceIndex] !== value) failPatch();
        sourceIndex += 1;
        consumed += 1;
      } else if (marker === "+") {
        result.push(value);
        produced += 1;
      } else {
        failPatch();
      }
      index += 1;
    }
    // Generation and APPLY both use git apply --recount, so the semantic
    // parser likewise derives hunk sizes from the body instead of trusting
    // stale header counts emitted by a model.
    if (consumed === 0 && produced === 0) failPatch();
  }
  result.push(...source.slice(sourceIndex));
  return `${result.join("\n")}\n`;
}

function parsePatch(patch: string): PatchTarget[] {
  if (!patch.startsWith("diff --git ") || patch.includes("GIT binary patch") ||
      patch.includes("Binary files ") || /^(old mode|new mode|deleted file mode|similarity index|rename (from|to)|copy (from|to)) /mu.test(patch)) {
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
  const lines = patch.split("\n");
  const targets: PatchTarget[] = [];
  let index = 0;
  while (index < lines.length && lines[index] !== "") {
    const header = lines[index];
    if (header === undefined || !header.startsWith("diff --git ")) failPatch();
    const match = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(header);
    if (match === null || match[1] !== match[2] || !safePath(match[1]!)) failPatch();
    const path = match[1]!;
    index += 1;
    const start = index;
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")) index += 1;
    const section = lines.slice(start, index).join("\n");
    const newFileModes = section.match(/^new file mode .*$/gmu) ?? [];
    const oldHeaders = section.match(/^--- .*$/gmu) ?? [];
    const newHeaders = section.match(/^\+\+\+ .*$/gmu) ?? [];
    const addition = newFileModes.length > 0;
    if (addition) {
      if (newFileModes.length !== 1 || newFileModes[0] !== "new file mode 100644" ||
          !section.startsWith("new file mode 100644\n") ||
          oldHeaders.length !== 1 || oldHeaders[0] !== "--- /dev/null" ||
          newHeaders.length !== 1 || newHeaders[0] !== `+++ b/${path}` ||
          !section.includes(`--- /dev/null\n+++ b/${path}\n`)) failPatch();
    } else if (oldHeaders.length !== 1 || oldHeaders[0] !== `--- a/${path}` ||
               newHeaders.length !== 1 || newHeaders[0] !== `+++ b/${path}` ||
               !section.includes(`--- a/${path}\n+++ b/${path}\n`)) {
      failPatch();
    }
    if (!/^@@ /mu.test(section)) failPatch();
    targets.push({ path, kind: addition ? "added" : "modified" });
  }
  if (targets.length === 0 || new Set(targets.map(({ path }) => path)).size !== targets.length) failPatch();
  return targets;
}

function parseFilesystemProposal(source: string): FilesystemOperation[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    failPatch();
  }
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.operations) ||
      !hasOnlyKeys(value, ["version", "operations"]) || value.operations.length === 0 ||
      value.operations.length > MAX_FILESYSTEM_OPERATIONS) failPatch();
  const operations: FilesystemOperation[] = [];
  const paths = new Set<string>();
  for (const item of value.operations) {
    if (!isObject(item) || typeof item.operation !== "string" || typeof item.path !== "string" ||
        !safePath(item.path) || paths.has(item.path)) failPatch();
    paths.add(item.path);
    if (item.operation === "create") {
      if (!hasOnlyKeys(item, ["operation", "path", "content"]) || !isTextContent(item.content)) failPatch();
      operations.push({ operation: "create", path: item.path, content: item.content });
    } else if (item.operation === "modify") {
      if (!hasOnlyKeys(item, ["operation", "path", "before_sha256", "content"]) ||
          !isSha256(item.before_sha256) || !isTextContent(item.content)) failPatch();
      operations.push({
        operation: "modify", path: item.path, beforeSha256: item.before_sha256, content: item.content
      });
    } else if (item.operation === "delete") {
      if (!hasOnlyKeys(item, ["operation", "path", "before_sha256"]) || !isSha256(item.before_sha256)) failPatch();
      operations.push({ operation: "delete", path: item.path, beforeSha256: item.before_sha256 });
    } else {
      failPatch();
    }
  }
  return operations;
}

function resolveFilesystemTarget(workspaceRoot: string, relativePath: string): string {
  if (!safePath(relativePath)) failPatch();
  const target = resolve(workspaceRoot, ...relativePath.split("/"));
  if (!target.startsWith(`${workspaceRoot}${sep}`)) failPatch();
  return target;
}

async function requireCanonicalParent(workspaceRoot: string, target: string): Promise<void> {
  try {
    const [canonicalRoot, canonicalParent] = await Promise.all([
      realpath(workspaceRoot),
      realpath(dirname(target))
    ]);
    if (canonicalRoot !== workspaceRoot || canonicalParent !== dirname(target) ||
        !target.startsWith(`${canonicalRoot}${sep}`)) failPatch();
    const metadata = await lstat(canonicalParent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) failPatch();
  } catch (error) {
    if (error instanceof CoreError) throw error;
    failPatch();
  }
}

async function readOrdinaryCanonicalFile(path: string): Promise<Buffer> {
  try {
    const [metadata, canonical, contents] = await Promise.all([lstat(path), realpath(path), readFile(path)]);
    if (!metadata.isFile() || metadata.isSymbolicLink() || canonical !== path) failPatch();
    return contents;
  } catch (error) {
    if (error instanceof CoreError) throw error;
    failPatch();
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isTextContent(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hasGitControlMarkerAtOrAbove(path: string): Promise<boolean> {
  let current = path;
  while (true) {
    if (await pathExists(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    failPatch();
  }
}

function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").includes("..") && posix.normalize(path) === path && path !== "/dev/null";
}

function failPatch(): never {
  throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
}

// Strictly parses the persisted base-state fields. A proposal base is either a
// real commit (base_head = <hex>), exact-preimage Git worktree
// (base_head = <hex>, worktree = true), unborn repository state
// (base_head = null, unborn = true), or a non-Git filesystem proposal. Every
// other combination is invalid
// retained state and is rejected like the existing invalid-record handling.
function parseProposalBase(item: Record<string, unknown>): ProposalBase {
  if (item.filesystem === true) {
    if (item.base_head !== null || item.unborn === true || item.worktree === true) {
      throw new CoreError("INTERNAL_ERROR");
    }
    return { kind: "filesystem" };
  }
  if (item.unborn === true) {
    if (item.base_head !== null || item.worktree === true) throw new CoreError("INTERNAL_ERROR");
    return { kind: "unborn" };
  }
  if (typeof item.base_head !== "string" || !/^[0-9a-f]{40,64}$/u.test(item.base_head)) {
    throw new CoreError("INTERNAL_ERROR");
  }
  return item.worktree === true
    ? { kind: "worktree", head: item.base_head }
    : { kind: "commit", head: item.base_head };
}

function sameBase(current: ProposalBase, expected: ProposalBase): boolean {
  if (current.kind === "filesystem") return expected.kind === "filesystem";
  if (current.kind === "unborn") return expected.kind === "unborn";
  return hasHead(expected) && current.head === expected.head;
}

function usesExactPreimageOperations(base: ProposalBase): boolean {
  return base.kind === "filesystem" || base.kind === "worktree";
}

function hasHead(base: ProposalBase): base is Extract<ProposalBase, { head: string }> {
  return base.kind === "commit" || base.kind === "worktree";
}
