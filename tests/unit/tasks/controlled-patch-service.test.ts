import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  symlinkSync, truncateSync, unlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { DEFAULT_CODEX_MODEL_REGISTRY } from "../../../src/executors/codex-model-registry.js";
import { ControlledPatchService } from "../../../src/tasks/controlled-patch-service.js";
import type { GitStarter } from "../../../src/tasks/controlled-patch-service.js";
import {
  MAX_EXECUTOR_EVIDENCE_TEXT,
  RegisteredWorkspaceTaskService
} from "../../../src/tasks/registered-workspace-task-service.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "../../../src/workspaces/workspace-onboarding-service.js";
import { VERSION } from "../../../src/version.js";
import type { WorkspaceType } from "../../../src/workspaces/repository-identity.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-patch-")));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "note.txt"), "before\n");
  git(root, "add", "note.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

function fixture(
  root: string,
  execute: Executor["execute"],
  startProcess?: GitStarter,
  stateFilePath?: string,
  workspaceType: WorkspaceType = "git_workspace",
  projectStateRoot?: string,
  proposalTimeoutMs?: number
): {
  controlled: ControlledPatchService;
  tasks: RegisteredWorkspaceTaskService;
} {
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => {
      const result = await execute(request);
      if (request.logicalRole === undefined) return result;
      return {
        ...result,
        threadId: result.threadId ?? "thread-test",
        metadata: result.metadata ?? {
          logicalRole: request.logicalRole,
          model: DEFAULT_CODEX_MODEL_REGISTRY[request.logicalRole].model,
          reasoningEffort: "max",
          codexVersion: "0.148.0"
        }
      };
    }
  }));
  const controlled = new ControlledPatchService(
    registry,
    tasks,
    startProcess ?? spawn,
    stateFilePath,
    DEFAULT_CODEX_MODEL_REGISTRY,
    () => workspaceType,
    projectStateRoot,
    proposalTimeoutMs
  );
  return { controlled, tasks };
}

function retainedStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "engineering-bridge-state-")), "controlled-patches.json");
}

async function terminal(tasks: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (["queued", "running"].includes(tasks.status(taskId)?.state ?? "")) {
    await new Promise<void>((done) => setImmediate(done));
  }
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

function codexCompletion(request: ExecutorRequest, output: string): ExecutorResult {
  assert.ok(request.logicalRole);
  return {
    kind: "completed",
    output,
    threadId: "thread-test",
    metadata: {
      logicalRole: request.logicalRole,
      model: DEFAULT_CODEX_MODEL_REGISTRY[request.logicalRole].model,
      reasoningEffort: "max",
      codexVersion: "0.148.0"
    }
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function filesystemProposal(operations: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({ version: 1, operations }, null, 2)}\n`;
}

const RETAINED_CODEX_METADATA = {
  routing: "local_lead",
  logical_role: "local_lead",
  routing_reason: "explicit_override",
  model: "gpt-5.6-terra",
  reasoning_effort: "max",
  bridge_version: VERSION,
  codex_version: "0.148.0",
  thread_id: "thread-test",
  executor: "codex"
} as const;

const CODEX_TASK_METADATA = {
  threadId: "thread-test",
  metadata: {
    logicalRole: "local_lead",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    codexVersion: "0.148.0"
  }
} as const;

const validPatch = `diff --git a/note.txt b/note.txt
index 90be1f3..3b18e51 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-before
+after
`;

const additionPatch = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+added
`;

function instructionAddition(path: "AGENTS.md" | "PLANS.md", content: string): string {
  const lines = content.slice(0, -1).split("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

test("exact Git project-instruction proposal review persists and APPLY changes only reviewed targets", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const agents = "# AGENTS.md\n\nPortable.\n";
  const plans = "# PLANS.md\n\n## Objective\n";
  const output = `${instructionAddition("AGENTS.md", agents)}${instructionAddition("PLANS.md", plans)}`;
  const first = fixture(root, async (request) => codexCompletion(request, output), undefined, stateFilePath);
  const generated = await first.controlled.generateProjectInstructions({
    workspace_id: "workspace",
    evidence_sha256: "a".repeat(64),
    targets: [
      { path: "AGENTS.md", operation: "create", content: agents },
      { path: "PLANS.md", operation: "create", content: plans }
    ]
  });
  await terminal(first.tasks, generated.taskId);
  assert.equal(first.controlled.projectInstructionReview(generated.taskId)?.status, "READY");
  const restarted = fixture(root, async () => { throw new Error("must not execute"); }, undefined, stateFilePath);
  await restarted.controlled.load();
  assert.equal(restarted.controlled.projectInstructionReview(generated.taskId)?.status, "READY");
  const applied = await restarted.controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["AGENTS.md", "PLANS.md"]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), agents);
  assert.equal(readFileSync(join(root, "PLANS.md"), "utf8"), plans);
});

test("exact Git project-instruction review accepts only the approved append postimage", async () => {
  const root = repository();
  writeFileSync(join(root, "AGENTS.md"), "# Existing\n");
  git(root, "add", "AGENTS.md");
  git(root, "commit", "-qm", "instructions");
  const target = "# Existing\n\nSupplement\n";
  const output = `diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,3 @@\n # Existing\n+\n+Supplement\n`;
  const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, output));
  const generated = await controlled.generateProjectInstructions({
    workspace_id: "workspace",
    evidence_sha256: "b".repeat(64),
    targets: [{ path: "AGENTS.md", operation: "modify", before_sha256: hash("# Existing\n"), content: target }]
  });
  await terminal(tasks, generated.taskId);
  assert.equal(controlled.projectInstructionReview(generated.taskId)?.status, "READY");
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Existing\n");
});

const markdownFencePatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,7 +1,7 @@",
  " # Example",
  " ",
  " ```sh",
  " echo ok",
  " ```",
  " ",
  "-before",
  "+after",
  ""
].join("\n");

const staleHunkCountPatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -4,7 +4,7 @@ echo ok",
  " ```",
  " ",
  "-before",
  "+after",
  ""
].join("\n");

const zeroContextPatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -7 +7 @@",
  "-before",
  "+after",
  ""
].join("\n");

test("restores a completed generated proposal for task_result after restart", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, generated.taskId);
  assert.equal(first.controlled.proposalReview(generated.taskId)?.status, "PASS");
  assert.equal(first.controlled.proposalReview(generated.taskId)?.human_approvable, true);
  assert.equal(first.controlled.proposalReview(generated.taskId)?.operations.length, 1);
  const persisted = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<Record<string, unknown>>;
  };
  assert.deepEqual({
    routing: persisted.proposals[0]?.routing,
    logical_role: persisted.proposals[0]?.logical_role,
    routing_reason: persisted.proposals[0]?.routing_reason,
    model: persisted.proposals[0]?.model,
    reasoning_effort: persisted.proposals[0]?.reasoning_effort,
    bridge_version: persisted.proposals[0]?.bridge_version,
    codex_version: persisted.proposals[0]?.codex_version,
    thread_id: persisted.proposals[0]?.thread_id,
    executor: persisted.proposals[0]?.executor
  }, RETAINED_CODEX_METADATA);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();

  assert.deepEqual(restarted.tasks.taskView(generated.taskId), {
    taskId: generated.taskId,
    state: "completed",
    executor: "codex",
    routing: "local_lead",
    logicalRole: "local_lead",
    routingReason: "explicit_override",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    codexVersion: "0.148.0",
    threadId: "thread-test",
    ready: true,
    output: validPatch
  });
});

test("restart converts a durably retained running proposal into a structured orphan failure", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const pending = new Promise<ExecutorResult>(() => {});
  const first = fixture(root, () => pending, undefined, stateFilePath);
  const generated = await first.controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  const before = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; task_state: string; lifecycle: { stage: string } }>;
  };
  assert.deepEqual(before.proposals.map(({ task_id, task_state, lifecycle }) => ({
    task_id, task_state, stage: lifecycle.stage
  })), [{ task_id: generated.taskId, task_state: "running", stage: "CREATED" }]);

  const restarted = fixture(
    root, async () => { throw new Error("orphan recovery must not execute"); }, undefined, stateFilePath
  );
  const beforeRecovery = readFileSync(stateFilePath, "utf8");
  await restarted.controlled.load(true);
  assert.equal(readFileSync(stateFilePath, "utf8"), beforeRecovery);
  await restarted.controlled.recover();

  assert.equal(restarted.tasks.taskView(generated.taskId)?.state, "failed");
  const orphanResult = restarted.tasks.result(generated.taskId);
  assert.equal(orphanResult?.state, "failed");
  assert.deepEqual(orphanResult?.state === "failed" ? orphanResult.error : undefined, {
    code: "CONTROLLED_PROPOSAL_ORPHANED",
    message: "The controlled proposal was interrupted by a Bridge restart."
  });
  assert.equal(restarted.controlled.proposalLifecycle(generated.taskId)?.stage, "FAILED");
  assert.equal(restarted.controlled.proposalLifecycle(generated.taskId)?.failure_code,
    "CONTROLLED_PROPOSAL_ORPHANED");
  const after = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_state: string; lifecycle: { stage: string } }>;
  };
  assert.deepEqual(after.proposals.map(({ task_state, lifecycle }) => ({ task_state, stage: lifecycle.stage })),
    [{ task_state: "failed", stage: "FAILED" }]);
});

test("malformed model output reaches a structured terminal validation failure", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(
    root, async (request) => codexCompletion(request, "not a controlled proposal")
  );
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);

  assert.equal(tasks.taskView(generated.taskId)?.state, "failed");
  const malformedResult = tasks.result(generated.taskId);
  assert.equal(malformedResult?.state, "failed");
  assert.deepEqual(malformedResult?.state === "failed" ? malformedResult.error : undefined, {
    code: "CONTROLLED_PROPOSAL_VALIDATION_FAILED",
    message: "The controlled proposal failed deterministic validation."
  });
  assert.equal(controlled.proposalReview(generated.taskId)?.status, "FAIL");
  assert.equal(controlled.proposalLifecycle(generated.taskId)?.stage, "FAILED");
});

test("validator exceptions reach a structured terminal failure instead of leaving a running task", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  let workspaceTypeCalls = 0;
  const controlled = new ControlledPatchService(
    registry, tasks, spawn, undefined, DEFAULT_CODEX_MODEL_REGISTRY,
    async () => {
      workspaceTypeCalls += 1;
      if (workspaceTypeCalls > 1) throw new Error("validator fixture failure");
      return "git_workspace" as const;
    }
  );
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);

  assert.equal(tasks.taskView(generated.taskId)?.state, "failed");
  const validatorResult = tasks.result(generated.taskId);
  assert.equal(validatorResult?.state === "failed" ? validatorResult.error.code : undefined,
    "CONTROLLED_PROPOSAL_VALIDATION_FAILED");
  assert.equal(controlled.proposalLifecycle(generated.taskId)?.terminal_transition, "FAILED");
});

test("refines a restored proposal with its parent relationship and original base HEAD retained", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, source.taskId);

  const refinedPatch = validPatch.replace("+after", "+refined after");
  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: refinedPatch }),
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const refined = await restarted.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording", routing: "repo_principal"
  });
  await terminal(restarted.tasks, refined.taskId);

  assert.equal(refined.baseHead, source.baseHead);
  assert.deepEqual(restarted.tasks.result(source.taskId), {
    id: source.taskId,
    state: "completed",
    output: validPatch,
    ...CODEX_TASK_METADATA
  });
  assert.equal(restarted.tasks.result(refined.taskId)?.metadata?.logicalRole, "repo_principal");
  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; base_head: string; parent_task_id?: string }>;
  };
  const retainedSource = state.proposals.find(({ task_id }) => task_id === source.taskId);
  const retainedRefinement = state.proposals.find(({ task_id }) => task_id === refined.taskId);
  assert.equal(retainedSource?.base_head, source.baseHead);
  assert.equal(retainedRefinement?.base_head, source.baseHead);
  assert.equal(retainedRefinement?.parent_task_id, source.taskId);
});

test("applies a refined proposal after restart without rerunning generation", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  let executions = 0;
  const refinedPatch = validPatch.replace("+after", "+refined after");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: executions++ === 0 ? validPatch : refinedPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, source.taskId);
  const refined = await first.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording", routing: "local_lead"
  });
  await terminal(first.tasks, refined.taskId);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const applied = await restarted.controlled.apply({
    patch_task_id: refined.taskId,
    confirmation: "APPLY"
  });

  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined after\n");
});

test("fails safely on malformed retained state", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  writeFileSync(stateFilePath, "{not json}\n");
  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );

  await expectCode(() => restarted.controlled.load(), "INTERNAL_ERROR");
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "before\n");
  assert.equal(readFileSync(stateFilePath, "utf8"), "{not json}\n");
});

test("fails generation before exposure when the initial durable marker cannot be retained", async () => {
  const root = repository();
  const stateFilePath = join(retainedStateFile(), "missing", "controlled-patches.json");
  const current = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  await expectCode(() => current.controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  }), "INTERNAL_ERROR");
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "before\n");
});

test("recovers an interrupted applying proposal as retryable after restart", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, generated.taskId);

  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; state: string }>;
  };
  const retainedProposal = state.proposals.find(({ task_id }) => task_id === generated.taskId);
  assert.ok(retainedProposal);
  retainedProposal.state = "applying";
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const proposals = (restarted.controlled as unknown as {
    proposals: Map<string, { state: string }>;
  }).proposals;
  assert.equal(proposals.get(generated.taskId)?.state, "proposed");

  const applied = await restarted.controlled.apply({
    patch_task_id: generated.taskId,
    confirmation: "APPLY"
  });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("generation records base metadata, binds the task, and keeps Codex instruction read-only", async () => {
  const root = repository();
  let instruction = "";
  const gitCalls: Array<{ executable: string; args: readonly string[]; shell: unknown }> = [];
  const starter: GitStarter = (executable, args, options) => {
    gitCalls.push({ executable, args, shell: options.shell });
    return spawn(executable, args, options);
  };
  const { controlled, tasks } = fixture(root, async (request) => {
    instruction = request.instruction;
    return { kind: "completed", output: validPatch };
  }, starter);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" });
  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
  await Promise.resolve();
  assert.match(instruction, /Return only a unified textual Git diff/);
  await terminal(tasks, generated.taskId);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.ok(gitCalls.every((call) => call.executable === "git" && call.shell === false));
  assert.deepEqual(gitCalls.slice(-2).map((call) => call.args), [
    ["apply", "--check", "--recount", "--unidiff-zero"],
    ["apply", "--recount", "--unidiff-zero"]
  ]);
  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "INVALID_STATE_TRANSITION"
  );
});

test("refines a complete multi-file proposal without changing its source and applies the complete replacement", async () => {
  const root = repository();
  const sourcePatch = `${validPatch}${additionPatch}`;
  const refinedPatch = sourcePatch
    .replace("+after\n", "+refined\n")
    .replace("+added\n", "+refined added\n");
  const instructions: string[] = [];
  const { controlled, tasks } = fixture(root, async (request) => {
    instructions.push(request.instruction);
    return { kind: "completed", output: instructions.length === 1 ? sourcePatch : refinedPatch };
  });

  const source = await controlled.generate({ workspace_id: "workspace", change_request: "implement original multi-file change", routing: "local_lead" });
  await terminal(tasks, source.taskId);
  const sourceResult = tasks.result(source.taskId);
  const refined = await controlled.refine({
    patch_task_id: source.taskId,
    change_request: "fix note wording", routing: "local_lead"
  });
  await terminal(tasks, refined.taskId);

  assert.notEqual(refined.taskId, source.taskId);
  assert.equal(refined.baseHead, source.baseHead);
  const refinementInstruction = instructions[1]!;
  assert.ok(refinementInstruction.includes(sourcePatch));
  assert.match(refinementInstruction, /Treat the source proposal below as the reviewed baseline/);
  assert.match(refinementInstruction, /Fix only the requested issues and preserve all unrelated proposal semantics/);
  assert.match(refinementInstruction, /COMPLETE final unified diff relative to the SAME original base_head/);
  assert.match(refinementInstruction, /not an incremental patch against the source proposal/);
  assert.doesNotMatch(refinementInstruction, /implement original multi-file change/);
  assert.deepEqual(tasks.result(source.taskId), sourceResult);

  const applied = await controlled.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt", "added.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined\n");
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "refined added\n");
});

test("rejects missing, non-completed, and HEAD-drifted refinement sources without starting Codex", async () => {
  const root = repository();
  let finish!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { finish = done; });
  let executions = 0;
  const { controlled, tasks } = fixture(root, () => {
    executions += 1;
    return pending;
  });
  const source = await controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" });
  await Promise.resolve();

  await expectCode(() => controlled.refine({
    patch_task_id: "missing",
    change_request: "refine", routing: "local_lead"
  }), "INVALID_STATE_TRANSITION");
  await expectCode(() => controlled.refine({
    patch_task_id: source.taskId,
    change_request: "refine", routing: "local_lead"
  }), "INVALID_STATE_TRANSITION");
  assert.equal(executions, 1);

  finish({ kind: "completed", output: validPatch });
  await terminal(tasks, source.taskId);
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => controlled.refine({
    patch_task_id: source.taskId,
    change_request: "refine", routing: "local_lead"
  }), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(executions, 1);
});

test("accepts a normal absolute Git top-level path", async () => {
  const root = repository();
  const { controlled } = fixture(root, async () => ({ kind: "completed", output: validPatch }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" });

  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
});

test("accepts a symlink alias that resolves to the same Git top-level", async () => {
  const root = repository();
  const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-alias-")));
  const alias = join(aliasParent, "workspace-alias");
  symlinkSync(root, alias, "dir");
  const { controlled } = fixture(alias, async () => ({ kind: "completed", output: validPatch }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" });

  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
});

test("rejects a different directory, a Git subdirectory, and a missing workspace", async () => {
  const root = repository();
  const other = repository();
  const nested = join(root, "nested");
  mkdirSync(nested);

  for (const invalidRoot of [other, nested, join(root, "missing")]) {
    const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root: invalidRoot, allow_write: true }]);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, (executable, args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && invalidRoot === other) {
        return spawn(executable, args, { ...options, cwd: root });
      }
      return spawn(executable, args, options);
    });
    await expectCode(
      () => controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("stores and applies a controlled patch normalized to one trailing LF", async () => {
  const root = repository();
  const patchWithoutFinalLf = validPatch.slice(0, -1);
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "completed",
    output: patchWithoutFinalLf
  }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "completed",
    output: validPatch,
    ...CODEX_TASK_METADATA
  });
  await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("applies a valid patch when Markdown context contains fenced code", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add Markdown fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: markdownFencePatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change Markdown", routing: "local_lead" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\n");
});

test("recounts stale hunk line counts in a valid generated patch", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add generated patch fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: staleHunkCountPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change generated patch", routing: "local_lead" });
  await terminal(tasks, generated.taskId);
  const staleReview = controlled.proposalReview(generated.taskId);
  assert.equal(staleReview?.status, "PASS", JSON.stringify(staleReview));

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\n");
});

test("applies a valid generated patch with zero context", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\ntail\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add zero-context fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: zeroContextPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change one line", routing: "local_lead" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\ntail\n");
});

test("adds an absent 100644 text file", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: additionPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["added.txt"]);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
});

test("applies a mixed modification and 100644 text addition", async () => {
  const root = repository();
  const mixedPatch = `${validPatch}${additionPatch}`;
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: mixedPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change and add", routing: "local_lead" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["note.txt", "added.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
});

test("directory proposals persist executor evidence and deterministic PASS review metadata", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-review-")));
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "README.md"), "before\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "README.md",
    before_sha256: hash("before\n"),
    content: "after\n"
  }]);
  const evidence = [{
    id: "command-1",
    type: "commandExecution" as const,
    status: "completed",
    command: "inspect README.md and package.json",
    result: { state: "complete" as const, exit_code: 0, output: "README.md\nscripts.test=node --test\n" }
  }];
  const first = fixture(
    root,
    async () => ({ kind: "completed", output, evidence }),
    undefined,
    stateFile,
    "directory_workspace"
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "Add one README Testing section without changing migrations",
    routing: "auto"
  });
  await terminal(first.tasks, generated.taskId);

  assert.deepEqual(first.tasks.taskView(generated.taskId)?.evidence, evidence);
  assert.deepEqual(first.controlled.proposalReview(generated.taskId), {
    status: "PASS",
    human_approvable: true,
    workspace_id: "workspace",
    workspace_type: "directory_workspace",
    proposal_schema_status: "PASS",
    canonical_root_status: "PASS",
    workspace_type_status: "PASS",
    operation_limits_status: "PASS",
    operations: [{
      operation: "modify",
      path: "README.md",
      normalized_path_status: "PASS",
      target_within_root: "PASS",
      parent_path_symlink_status: "PASS",
      target_symlink_status: "PASS",
      target_exists: true,
      target_kind: "file",
      proposal_preimage_sha256: hash("before\n"),
      current_target_sha256: hash("before\n"),
      preimage_match: true,
      precondition_status: "PASS"
    }],
    apply_revalidation_required: true
  });
  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
    proposals: Array<Record<string, unknown>>;
  };
  assert.deepEqual(persisted.proposals[0]?.evidence, evidence);
  assert.equal(JSON.stringify(persisted.proposals[0]?.evidence), JSON.stringify(evidence));
  assert.equal((persisted.proposals[0]?.proposal_review as { status?: unknown }).status, "PASS");
  assert.equal(persisted.proposals[0]?.routing_matched_rule, "bounded_implementation");

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFile,
    "directory_workspace"
  );
  await restarted.controlled.load();
  assert.deepEqual(restarted.tasks.taskView(generated.taskId)?.evidence, evidence);
  assert.equal(restarted.controlled.proposalReview(generated.taskId)?.status, "PASS");
});

test("oversized command and diff evidence is bounded before persistence and survives restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-evidence-fields-")));
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "README.md"), "before\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "README.md",
    before_sha256: hash("before\n"),
    content: "after\n"
  }]);
  const evidence = [{
    id: "command-oversize",
    type: "commandExecution" as const,
    status: "completed",
    command: "x".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1),
    result: { state: "complete" as const, exit_code: 0,
      output: "z".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1) }
  }, {
    id: "diff-oversize",
    type: "fileChange" as const,
    status: "completed",
    changes: [{ path: "README.md", diff: "y".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1) }]
  }];
  const first = fixture(
    root,
    async () => ({ kind: "completed", output, evidence }),
    undefined,
    stateFile,
    "directory_workspace"
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace", change_request: "change one README line", routing: "auto"
  });
  await terminal(first.tasks, generated.taskId);

  const live = first.tasks.taskView(generated.taskId)?.evidence;
  assert.equal(live?.[0]?.command?.length, MAX_EXECUTOR_EVIDENCE_TEXT);
  assert.match(live?.[0]?.command ?? "", /\[truncated\]$/u);
  assert.equal(live?.[0]?.result?.state, "truncated");
  assert.equal(live?.[0]?.result?.output?.length, MAX_EXECUTOR_EVIDENCE_TEXT);
  assert.match(live?.[0]?.result?.output ?? "", /\[truncated\]$/u);
  assert.equal(live?.[1]?.changes?.[0]?.diff.length, MAX_EXECUTOR_EVIDENCE_TEXT);
  assert.match(live?.[1]?.changes?.[0]?.diff ?? "", /\[truncated\]$/u);
  const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
    proposals: Array<{ evidence?: unknown }>;
  };
  assert.deepEqual(persisted.proposals[0]?.evidence, live);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFile,
    "directory_workspace"
  );
  await restarted.controlled.load();
  assert.deepEqual(restarted.tasks.taskView(generated.taskId)?.evidence, live);
});

test("legacy directory proposals without review metadata are UNVERIFIED and not APPLY-eligible", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-unverified-")));
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "note.txt"), "before\n");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: filesystemProposal([{
      operation: "modify", path: "note.txt", before_sha256: hash("before\n"), content: "after\n"
    }]) }),
    undefined,
    stateFile,
    "directory_workspace"
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "auto"
  });
  await terminal(first.tasks, generated.taskId);
  const retained = JSON.parse(readFileSync(stateFile, "utf8")) as {
    proposals: Array<Record<string, unknown>>;
  };
  delete retained.proposals[0]?.proposal_review;
  delete retained.proposals[0]?.evidence;
  delete retained.proposals[0]?.routing_matched_rule;
  delete retained.proposals[0]?.routing_matched_factors;
  delete retained.proposals[0]?.routing_ignored_guard_factors;
  writeFileSync(stateFile, `${JSON.stringify(retained, null, 2)}\n`);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFile,
    "directory_workspace"
  );
  await restarted.controlled.load();
  assert.equal(restarted.controlled.proposalReview(generated.taskId)?.status, "UNVERIFIED");
  assert.equal(restarted.controlled.proposalReview(generated.taskId)?.human_approvable, false);
  assert.equal(restarted.tasks.taskView(generated.taskId)?.routingMatchedRule, "legacy_unverified");
  await expectCode(
    () => restarted.controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "before\n");
});

test("retained proposals exceeding the aggregate evidence byte ceiling are quarantined", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-evidence-ceiling-")));
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "note.txt"), "before\n");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: filesystemProposal([{
      operation: "modify", path: "note.txt", before_sha256: hash("before\n"), content: "after\n"
    }]) }),
    undefined,
    stateFile,
    "directory_workspace"
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, generated.taskId);
  const retained = JSON.parse(readFileSync(stateFile, "utf8")) as {
    proposals: Array<Record<string, unknown>>;
  };
  retained.proposals[0]!.evidence = Array.from({ length: 50 }, (_, index) => ({
    id: `command-${index}`,
    type: "commandExecution",
    status: "completed",
    command: "x".repeat(16_384)
  }));
  writeFileSync(stateFile, `${JSON.stringify(retained, null, 2)}\n`);

  const restarted = fixture(
    root,
    async () => { throw new Error("quarantined tasks must not execute"); },
    undefined,
    stateFile,
    "directory_workspace"
  );
  await restarted.controlled.load();
  assert.equal(restarted.tasks.taskView(generated.taskId), undefined);
  assert.equal(restarted.controlled.proposalReview(generated.taskId), undefined);
});

test("retained proposals violating result bounds or status/exit semantics are quarantined", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-evidence-field-")));
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "note.txt"), "before\n");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: filesystemProposal([{
      operation: "modify", path: "note.txt", before_sha256: hash("before\n"), content: "after\n"
    }]) }),
    undefined,
    stateFile,
    "directory_workspace"
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, generated.taskId);
  const original = JSON.parse(readFileSync(stateFile, "utf8")) as {
    proposals: Array<Record<string, unknown>>;
  };
  const invalidEvidence = [[{
    id: "command-oversize", type: "commandExecution", status: "completed", command: "inspect",
    result: { state: "complete", exit_code: 0, output: "x".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1) }
  }], [{
    id: "failed-complete", type: "commandExecution", status: "failed", command: "inspect",
    result: { state: "complete", exit_code: 0, output: "must not survive" }
  }], [{
    id: "nonzero-complete", type: "commandExecution", status: "completed", command: "inspect",
    result: { state: "complete", exit_code: 1, output: "must not survive" }
  }], [{
    id: "declined-truncated", type: "commandExecution", status: "declined", command: "inspect",
    result: { state: "truncated", exit_code: 0, output: "must not survive\n[truncated]" }
  }]];

  for (const evidence of invalidEvidence) {
    const retained = structuredClone(original);
    retained.proposals[0]!.evidence = evidence;
    writeFileSync(stateFile, `${JSON.stringify(retained, null, 2)}\n`);
    const restarted = fixture(
      root,
      async () => { throw new Error("quarantined tasks must not execute"); },
      undefined,
      stateFile,
      "directory_workspace"
    );
    await restarted.controlled.load();
    assert.equal(restarted.tasks.taskView(generated.taskId), undefined);
    assert.equal(restarted.controlled.proposalReview(generated.taskId), undefined);
  }
});

test("non-Git APPLY modifies, creates, and deletes only reviewed files with audit and bounded recovery material", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-patch-")));
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-project-state-")));
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "modify.txt"), "before\n");
  writeFileSync(join(root, "delete.txt"), "remove me\n");
  const output = filesystemProposal([
    { operation: "modify", path: "modify.txt", before_sha256: hash("before\n"), content: "after\n" },
    { operation: "create", path: "created.txt", content: "created\n" },
    { operation: "delete", path: "delete.txt", before_sha256: hash("remove me\n") }
  ]);
  let instruction = "";
  const { controlled, tasks } = fixture(root, async (request) => {
    instruction = request.instruction;
    return { kind: "completed", output };
  }, undefined, stateFile, "directory_workspace", stateRoot);

  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "update directory files", routing: "local_lead"
  });
  assert.equal(generated.baseHead, null);
  assert.match(instruction, /strict JSON object/);
  assert.doesNotMatch(instruction, /git init/i);
  await terminal(tasks, generated.taskId);
  assert.equal(readFileSync(join(root, "modify.txt"), "utf8"), "before\n");
  assert.equal(existsSync(join(root, "created.txt")), false);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["modify.txt", "created.txt", "delete.txt"]);
  assert.equal(applied.backend, "filesystem");
  assert.equal(readFileSync(join(root, "modify.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(root, "created.txt"), "utf8"), "created\n");
  assert.equal(existsSync(join(root, "delete.txt")), false);
  assert.deepEqual(applied.audit, [
    { operation: "modify", path: "modify.txt", before_sha256: hash("before\n"), after_sha256: hash("after\n") },
    { operation: "create", path: "created.txt", before_sha256: null, after_sha256: hash("created\n") },
    { operation: "delete", path: "delete.txt", before_sha256: hash("remove me\n"), after_sha256: null }
  ]);
  assert.equal(typeof applied.rollback_reference, "string");
  const recovery = JSON.parse(readFileSync(applied.rollback_reference!, "utf8")) as {
    status: string;
    operations: Array<{ before_content_base64?: string }>;
  };
  assert.equal(recovery.status, "applied");
  assert.equal(Buffer.from(recovery.operations[0]!.before_content_base64!, "base64").toString("utf8"), "before\n");
  assert.equal(Buffer.from(recovery.operations[2]!.before_content_base64!, "base64").toString("utf8"), "remove me\n");
});

test("non-Git APPLY rejects a stale SHA-256 preimage without changing any file", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-stale-")));
  writeFileSync(join(root, "note.txt"), "before\n");
  const output = filesystemProposal([
    { operation: "modify", path: "note.txt", before_sha256: hash("before\n"), content: "after\n" }
  ]);
  const { controlled, tasks } = fixture(
    root, async () => ({ kind: "completed", output }), undefined, undefined, "directory_workspace"
  );
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);
  assert.equal(controlled.proposalReview(generated.taskId)?.status, "PASS");
  writeFileSync(join(root, "note.txt"), "changed after review\n");

  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "changed after review\n");
});

test("a deterministically stale directory proposal is marked FAIL and is never APPLY-eligible", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-review-stale-")));
  writeFileSync(join(root, "note.txt"), "current\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "note.txt",
    before_sha256: hash("stale\n"),
    content: "after\n"
  }]);
  const { controlled, tasks } = fixture(
    root, async () => ({ kind: "completed", output }), undefined, undefined, "directory_workspace"
  );
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);

  const review = controlled.proposalReview(generated.taskId);
  assert.equal(review?.status, "FAIL");
  assert.equal(review?.human_approvable, false);
  assert.equal(review?.operations[0]?.current_target_sha256, hash("current\n"));
  assert.equal(review?.operations[0]?.preimage_match, false);
  assert.equal(review?.operations[0]?.precondition_status, "FAIL");
  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "current\n");
});

test("directory review rejects an oversized target from metadata before reading or hashing it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-oversized-")));
  const target = join(root, "large.txt");
  writeFileSync(target, "");
  truncateSync(target, 4 * 1024 * 1024 + 1);
  const output = filesystemProposal([{
    operation: "modify",
    path: "large.txt",
    before_sha256: "0".repeat(64),
    content: "after\n"
  }]);
  const { controlled, tasks } = fixture(
    root, async () => ({ kind: "completed", output }), undefined, undefined, "directory_workspace"
  );
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change large file", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);

  const review = controlled.proposalReview(generated.taskId);
  assert.equal(review?.status, "FAIL");
  assert.equal(review?.human_approvable, false);
  assert.equal(review?.operation_limits_status, "FAIL");
  assert.equal(review?.operations[0]?.current_target_sha256, null);
  assert.equal(review?.operations[0]?.preimage_match, null);
  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("non-Git APPLY rejects traversal, absolute/outside paths, target symlinks, and symlink parents", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-boundary-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-outside-")));
  writeFileSync(join(outside, "outside.txt"), "outside\n");
  symlinkSync(join(outside, "outside.txt"), join(root, "target-link.txt"));
  symlinkSync(outside, join(root, "parent-link"), "dir");
  const invalidOperations: Record<string, unknown>[][] = [
    [{ operation: "create", path: "../escape.txt", content: "x" }],
    [{ operation: "create", path: join(outside, "absolute.txt"), content: "x" }],
    [{ operation: "modify", path: "target-link.txt", before_sha256: hash("outside\n"), content: "x" }],
    [{ operation: "create", path: "parent-link/escape.txt", content: "x" }]
  ];

  for (const operations of invalidOperations) {
    const { controlled, tasks } = fixture(
      root,
      async () => ({ kind: "completed", output: filesystemProposal(operations) }),
      undefined,
      undefined,
      "directory_workspace"
    );
    const generated = await controlled.generate({
      workspace_id: "workspace", change_request: "unsafe write", routing: "local_lead"
    });
    await terminal(tasks, generated.taskId);
    assert.equal(controlled.proposalReview(generated.taskId)?.status, "FAIL");
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
  assert.equal(readFileSync(join(outside, "outside.txt"), "utf8"), "outside\n");
  assert.equal(existsSync(join(outside, "escape.txt")), false);
  assert.equal(existsSync(join(outside, "absolute.txt")), false);
});

test("non-Git APPLY automatically rolls back earlier writes when a later atomic replacement fails", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-rollback-")));
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-rollback-state-")));
  writeFileSync(join(root, "first.txt"), "first before\n");
  writeFileSync(join(root, "second.txt"), "second before\n");
  const output = filesystemProposal([
    { operation: "modify", path: "first.txt", before_sha256: hash("first before\n"), content: "first after\n" },
    { operation: "modify", path: "second.txt", before_sha256: hash("second before\n"), content: "second after\n" }
  ]);
  const { controlled, tasks } = fixture(
    root, async () => ({ kind: "completed", output }), undefined, retainedStateFile(),
    "directory_workspace", stateRoot
  );
  const internal = controlled as unknown as {
    replaceFilesystemFile(target: string, contents: Buffer, mode: number): Promise<void>;
  };
  const originalReplace = internal.replaceFilesystemFile.bind(controlled);
  let calls = 0;
  internal.replaceFilesystemFile = async (target, contents, mode) => {
    calls += 1;
    if (calls === 2) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    await originalReplace(target, contents, mode);
  };
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change both", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);

  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(readFileSync(join(root, "first.txt"), "utf8"), "first before\n");
  assert.equal(readFileSync(join(root, "second.txt"), "utf8"), "second before\n");
  const recoveryPath = join(stateRoot, `legacy-${hash("workspace")}`, "controlled-patches", `${generated.taskId}.json`);
  assert.equal((JSON.parse(readFileSync(recoveryPath, "utf8")) as { status: string }).status, "rolled_back");
});

test("a directory proposal fails after Git appears and subsequent proposals use the unchanged Git path", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-directory-to-git-patch-")));
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  let workspaceType: WorkspaceType = "directory_workspace";
  const instructions: string[] = [];
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => {
      instructions.push(request.instruction);
      return codexCompletion(request, workspaceType === "directory_workspace"
        ? filesystemProposal([{ operation: "create", path: "plain.txt", content: "plain\n" }])
        : additionPatch);
    }
  }));
  const controlled = new ControlledPatchService(
    registry, tasks, spawn, undefined, DEFAULT_CODEX_MODEL_REGISTRY, () => workspaceType
  );
  const directoryProposal = await controlled.generate({
    workspace_id: "workspace", change_request: "create plain file", routing: "local_lead"
  });
  await terminal(tasks, directoryProposal.taskId);
  execFileSync("git", ["init", "-q"], { cwd: root });
  workspaceType = "git_workspace";

  await expectCode(
    () => controlled.apply({ patch_task_id: directoryProposal.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(existsSync(join(root, "plain.txt")), false);
  const gitProposal = await controlled.generate({
    workspace_id: "workspace", change_request: "add Git file", routing: "local_lead"
  });
  await terminal(tasks, gitProposal.taskId);
  assert.match(instructions[1]!, /unified textual Git diff/);
  await controlled.apply({ patch_task_id: gitProposal.taskId, confirmation: "APPLY" });
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
});

test("existing Git controlled APPLY remains on git apply without filesystem recovery artifacts", async () => {
  const root = repository();
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-git-state-")));
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const starter: GitStarter = (executable, args, options) => {
    mutableCalls.push([...args]);
    return spawn(executable, args, options);
  };
  const { controlled, tasks } = fixture(
    root, async () => ({ kind: "completed", output: validPatch }), starter, undefined, "git_workspace", stateRoot
  );
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);
  const result = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.equal(result.backend, undefined);
  assert.equal(result.rollback_reference, undefined);
  assert.deepEqual(mutableCalls.slice(-2), [
    ["apply", "--check", "--recount", "--unidiff-zero"],
    ["apply", "--recount", "--unidiff-zero"]
  ]);
  assert.equal(existsSync(join(stateRoot, `legacy-${hash("workspace")}`)), false);
});

test("rejects addition targets already present in base HEAD, the worktree, or the index", async () => {
  for (const state of ["tracked", "untracked", "index"] as const) {
    const root = repository();
    const path = state === "tracked" ? "note.txt" : "added.txt";
    const patch = additionPatch.replaceAll("added.txt", path);
    if (state === "untracked") writeFileSync(join(root, path), "collision\n");
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: patch }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
    await terminal(tasks, generated.taskId);
    if (state === "index") {
      writeFileSync(join(root, path), "indexed\n");
      git(root, "add", path);
    }
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("rejects unsafe or structurally invalid additions", async () => {
  const invalidPatches = [
    additionPatch.replace("new file mode 100644", "new file mode 100755"),
    additionPatch.replace("new file mode 100644", "new file mode 120000"),
    additionPatch.replace("new file mode 100644", "new file mode 160000"),
    additionPatch.replace("index 0000000..3e75765", "GIT binary patch\nliteral 0\nHcmV?d00001"),
    additionPatch.replace("new file mode 100644", "deleted file mode 100644").replace("--- /dev/null", "--- a/added.txt").replace("+++ b/added.txt", "+++ /dev/null"),
    additionPatch.replace("new file mode 100644", "similarity index 100%\nrename from old.txt\nrename to added.txt"),
    additionPatch.replace("new file mode 100644", "similarity index 100%\ncopy from old.txt\ncopy to added.txt"),
    `${additionPatch}${additionPatch}`,
    additionPatch.replace("diff --git a/added.txt b/added.txt", "diff --git added.txt added.txt"),
    additionPatch.replace("+++ b/added.txt", "+++ b/other.txt"),
    additionPatch.replaceAll("added.txt", "../added.txt")
  ];

  for (const output of invalidPatches) {
    const root = repository();
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
    await terminal(tasks, generated.taskId);
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("collapses extra trailing LFs in controlled patch results", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "completed",
    output: `${validPatch}\n\n`
  }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "completed",
    output: validPatch,
    ...CODEX_TASK_METADATA
  });
});

test("requires exact confirmation and a successfully completed generation task", async () => {
  const root = repository();
  let finish!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { finish = done; });
  const { controlled, tasks } = fixture(root, () => pending);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change", routing: "local_lead" });
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "apply" }), "INVALID_STATE_TRANSITION");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "INVALID_STATE_TRANSITION");
  finish({ kind: "failed", error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." } });
  await terminal(tasks, generated.taskId);
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("retains a structured terminal proposal failure when its model execution fails", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change", routing: "local_lead" });
  await terminal(tasks, generated.taskId);

  assert.equal(controlled.proposalLifecycle(generated.taskId)?.stage, "FAILED");
  assert.equal(controlled.proposalLifecycle(generated.taskId)?.failure_code, "CODEX_EXECUTION_FAILED");
  assert.equal(tasks.result(generated.taskId)?.state, "failed");
});

test("dirty Git worktree applies an exact-preimage target and preserves unrelated tracked, untracked, and index state", async () => {
  const root = repository();
  writeFileSync(join(root, "target.txt"), "target before\n");
  writeFileSync(join(root, "unrelated.txt"), "unrelated committed\n");
  git(root, "add", "target.txt", "unrelated.txt");
  git(root, "commit", "-qm", "add dirty-worktree fixtures");
  writeFileSync(join(root, "unrelated.txt"), "unrelated user work\n");
  writeFileSync(join(root, "scratch.txt"), "untracked user work\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "target.txt",
    before_sha256: hash("target before\n"),
    content: "target after\n"
  }]);
  const gitInvocations: string[][] = [];
  let instruction = "";
  const { controlled, tasks } = fixture(root, async (request) => {
    instruction = request.instruction;
    return codexCompletion(request, output);
  }, (executable, args, options) => {
    gitInvocations.push([...args]);
    return spawn(executable, args, options);
  });
  const indexBefore = git(root, "ls-files", "--stage");
  const unrelatedBefore = readFileSync(join(root, "unrelated.txt"));
  const untrackedBefore = readFileSync(join(root, "scratch.txt"));

  assert.deepEqual(await controlled.diagnose("workspace"), {
    controlled_proposal_status: "READY",
    controlled_proposal_reason: "UNSTAGED_DIRTY_WORKTREE_SUPPORTED"
  });
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change target only", routing: "local_lead"
  });
  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
  assert.match(instruction, /strict JSON object/u);
  assert.match(instruction, /never substitute HEAD bytes/u);
  await terminal(tasks, generated.taskId);
  assert.equal(controlled.proposalReview(generated.taskId)?.workspace_type, "git_workspace");
  assert.equal(controlled.proposalReview(generated.taskId)?.status, "PASS");

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.equal(applied.backend, "worktree");
  assert.deepEqual(applied.changed_paths, ["target.txt"]);
  assert.equal(readFileSync(join(root, "target.txt"), "utf8"), "target after\n");
  assert.deepEqual(readFileSync(join(root, "unrelated.txt")), unrelatedBefore);
  assert.deepEqual(readFileSync(join(root, "scratch.txt")), untrackedBefore);
  assert.equal(git(root, "ls-files", "--stage"), indexBefore);
  assert.equal(git(root, "diff", "--cached", "--quiet", "--"), "");
  const forbidden = new Set(["add", "commit", "reset", "stash", "clean", "checkout"]);
  assert.equal(gitInvocations.some((args) => forbidden.has(args[0] ?? "")), false);
});

test("dirty tracked proposal target binds current worktree bytes rather than HEAD bytes", async () => {
  const root = repository();
  writeFileSync(join(root, "note.txt"), "legitimate current work\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "note.txt",
    before_sha256: hash("legitimate current work\n"),
    content: "reviewed result\n"
  }]);
  const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, output));

  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "refine the current note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);
  const review = controlled.proposalReview(generated.taskId);
  assert.equal(review?.status, "PASS");
  assert.equal(review?.operations[0]?.proposal_preimage_sha256, hash("legitimate current work\n"));
  assert.equal(review?.operations[0]?.current_target_sha256, hash("legitimate current work\n"));
  await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "reviewed result\n");
});

test("dirty worktree reviews and applies one existing non-ignored untracked target without disturbing Git or unrelated work", async () => {
  const root = repository();
  writeFileSync(join(root, "note.txt"), "unrelated tracked work\n");
  writeFileSync(join(root, "untracked-target.txt"), "untracked before\n");
  writeFileSync(join(root, "scratch.txt"), "unrelated untracked work\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "untracked-target.txt",
    before_sha256: hash("untracked before\n"),
    content: "untracked after\n"
  }]);
  const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, output));
  const headBefore = git(root, "rev-parse", "HEAD");
  const indexBefore = git(root, "ls-files", "--stage");
  const trackedBefore = readFileSync(join(root, "note.txt"));
  const untrackedBefore = readFileSync(join(root, "scratch.txt"));

  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change existing untracked target", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);
  const review = controlled.proposalReview(generated.taskId);
  assert.equal(review?.status, "PASS");
  assert.deepEqual(review?.operations[0], {
    operation: "modify",
    path: "untracked-target.txt",
    normalized_path_status: "PASS",
    target_within_root: "PASS",
    parent_path_symlink_status: "PASS",
    target_symlink_status: "PASS",
    target_exists: true,
    target_kind: "file",
    proposal_preimage_sha256: hash("untracked before\n"),
    current_target_sha256: hash("untracked before\n"),
    preimage_match: true,
    precondition_status: "PASS",
    target_origin: "EXISTING_UNTRACKED_WORKTREE",
    target_mode: lstatSync(join(root, "untracked-target.txt")).mode & 0o777,
    target_device: String(lstatSync(join(root, "untracked-target.txt")).dev),
    target_inode: String(lstatSync(join(root, "untracked-target.txt")).ino),
    target_hardlink_count: 1
  });

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(applied.backend, "worktree");
  assert.deepEqual(applied.changed_paths, ["untracked-target.txt"]);
  assert.equal(readFileSync(join(root, "untracked-target.txt"), "utf8"), "untracked after\n");
  assert.deepEqual(readFileSync(join(root, "note.txt")), trackedBefore);
  assert.deepEqual(readFileSync(join(root, "scratch.txt")), untrackedBefore);
  assert.equal(git(root, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(root, "ls-files", "--stage"), indexBefore);
});

test("existing untracked target APPLY rejects stale bytes, deletion, replacement, symlink, hardlink, mode, and ignore state", async () => {
  const cases: Array<{ name: string; mutate: (root: string) => void }> = [
    { name: "bytes", mutate: (root) => writeFileSync(join(root, "untracked-target.txt"), "stale bytes\n") },
    { name: "deleted", mutate: (root) => unlinkSync(join(root, "untracked-target.txt")) },
    { name: "replaced", mutate: (root) => {
      renameSync(join(root, "untracked-target.txt"), join(root, "old-target.txt"));
      writeFileSync(join(root, "untracked-target.txt"), "untracked before\n");
    } },
    { name: "symlink", mutate: (root) => {
      unlinkSync(join(root, "untracked-target.txt"));
      symlinkSync("note.txt", join(root, "untracked-target.txt"));
    } },
    { name: "hardlink", mutate: (root) => linkSync(
      join(root, "untracked-target.txt"), join(root, "untracked-alias.txt")
    ) },
    { name: "mode", mutate: (root) => chmodSync(join(root, "untracked-target.txt"), 0o755) },
    { name: "ignored", mutate: (root) => writeFileSync(
      join(root, ".git", "info", "exclude"), "untracked-target.txt\n", { flag: "a" }
    ) }
  ];
  for (const item of cases) {
    const root = repository();
    writeFileSync(join(root, "note.txt"), "unrelated tracked work\n");
    writeFileSync(join(root, "untracked-target.txt"), "untracked before\n");
    const output = filesystemProposal([{
      operation: "modify",
      path: "untracked-target.txt",
      before_sha256: hash("untracked before\n"),
      content: "untracked after\n"
    }]);
    const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, output));
    const generated = await controlled.generate({
      workspace_id: "workspace", change_request: `stale ${item.name}`, routing: "local_lead"
    });
    await terminal(tasks, generated.taskId);
    assert.equal(controlled.proposalReview(generated.taskId)?.status, "PASS", item.name);
    item.mutate(root);
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("existing untracked target staged after proposal fails closed without changing the staged index", async () => {
  const root = repository();
  writeFileSync(join(root, "note.txt"), "unrelated tracked work\n");
  writeFileSync(join(root, "untracked-target.txt"), "untracked before\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "untracked-target.txt",
    before_sha256: hash("untracked before\n"),
    content: "untracked after\n"
  }]);
  const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, output));
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change untracked target", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);
  git(root, "add", "untracked-target.txt");
  const indexAfterUserStage = git(root, "ls-files", "--stage");

  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(git(root, "ls-files", "--stage"), indexAfterUserStage);
  assert.equal(readFileSync(join(root, "untracked-target.txt"), "utf8"), "untracked before\n");
});

test("ignored or already-hardlinked untracked modify targets fail proposal review", async () => {
  for (const unsafe of ["ignored", "hardlink"] as const) {
    const root = repository();
    writeFileSync(join(root, "note.txt"), "unrelated tracked work\n");
    writeFileSync(join(root, "untracked-target.txt"), "untracked before\n");
    if (unsafe === "ignored") {
      writeFileSync(join(root, ".git", "info", "exclude"), "untracked-target.txt\n", { flag: "a" });
    } else {
      linkSync(join(root, "untracked-target.txt"), join(root, "untracked-alias.txt"));
    }
    const output = filesystemProposal([{
      operation: "modify",
      path: "untracked-target.txt",
      before_sha256: hash("untracked before\n"),
      content: "untracked after\n"
    }]);
    const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, output));
    const generated = await controlled.generate({
      workspace_id: "workspace", change_request: `reject ${unsafe}`, routing: "local_lead"
    });
    await terminal(tasks, generated.taskId);
    assert.equal(controlled.proposalReview(generated.taskId)?.status, "FAIL", unsafe);
    assert.equal(readFileSync(join(root, "untracked-target.txt"), "utf8"), "untracked before\n");
  }
});

test("existing untracked target provenance survives persistence and restart", async () => {
  const root = repository();
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "note.txt"), "unrelated tracked work\n");
  writeFileSync(join(root, "untracked-target.txt"), "untracked before\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "untracked-target.txt",
    before_sha256: hash("untracked before\n"),
    content: "untracked after\n"
  }]);
  const first = fixture(root, async (request) => codexCompletion(request, output), undefined, stateFile);
  const generated = await first.controlled.generate({
    workspace_id: "workspace", change_request: "change untracked target", routing: "local_lead"
  });
  await terminal(first.tasks, generated.taskId);
  assert.equal(first.controlled.proposalReview(generated.taskId)?.operations[0]?.target_origin,
    "EXISTING_UNTRACKED_WORKTREE");

  const restarted = fixture(root, async () => { throw new Error("must not execute"); }, undefined, stateFile);
  await restarted.controlled.load();
  assert.equal(restarted.controlled.proposalReview(generated.taskId)?.operations[0]?.target_origin,
    "EXISTING_UNTRACKED_WORKTREE");
  const applied = await restarted.controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(applied.backend, "worktree");
  assert.equal(readFileSync(join(root, "untracked-target.txt"), "utf8"), "untracked after\n");
});

test("dirty Git exact-preimage APPLY fails if a target changes after proposal generation", async () => {
  const root = repository();
  writeFileSync(join(root, "note.txt"), "legitimate current work\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "note.txt",
    before_sha256: hash("legitimate current work\n"),
    content: "reviewed result\n"
  }]);
  const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, output));
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "note.txt"), "changed after proposal\n");

  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "changed after proposal\n");
});

test("dirty Git worktree never overwrites an existing or newly-created untracked target", async () => {
  const existingRoot = repository();
  writeFileSync(join(existingRoot, "note.txt"), "unrelated dirty\n");
  writeFileSync(join(existingRoot, "added.txt"), "existing untracked\n");
  const existing = fixture(
    existingRoot,
    async (request) => codexCompletion(request, filesystemProposal([
      { operation: "create", path: "added.txt", content: "proposal\n" }
    ]))
  );
  const existingProposal = await existing.controlled.generate({
    workspace_id: "workspace", change_request: "add file", routing: "local_lead"
  });
  await terminal(existing.tasks, existingProposal.taskId);
  assert.equal(existing.controlled.proposalReview(existingProposal.taskId)?.status, "FAIL");
  await expectCode(
    () => existing.controlled.apply({ patch_task_id: existingProposal.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(readFileSync(join(existingRoot, "added.txt"), "utf8"), "existing untracked\n");

  const lateRoot = repository();
  writeFileSync(join(lateRoot, "note.txt"), "unrelated dirty\n");
  const late = fixture(
    lateRoot,
    async (request) => codexCompletion(request, filesystemProposal([
      { operation: "create", path: "added.txt", content: "proposal\n" }
    ]))
  );
  const lateProposal = await late.controlled.generate({
    workspace_id: "workspace", change_request: "add file", routing: "local_lead"
  });
  await terminal(late.tasks, lateProposal.taskId);
  assert.equal(late.controlled.proposalReview(lateProposal.taskId)?.status, "PASS");
  writeFileSync(join(lateRoot, "added.txt"), "created after proposal\n");
  await expectCode(
    () => late.controlled.apply({ patch_task_id: lateProposal.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(readFileSync(join(lateRoot, "added.txt"), "utf8"), "created after proposal\n");
});

test("staged Git state blocks controlled proposals without suggesting workspace repair", async () => {
  const root = repository();
  writeFileSync(join(root, "note.txt"), "staged user work\n");
  git(root, "add", "note.txt");
  const { controlled } = fixture(root, async (request) => codexCompletion(request, validPatch));

  assert.deepEqual(await controlled.diagnose("workspace"), {
    controlled_proposal_status: "BLOCKED",
    controlled_proposal_reason: "INDEX_DIRTY"
  });
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "change", routing: "local_lead" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("a clean Git proposal still applies when unrelated unstaged work appears later", async () => {
  const root = repository();
  writeFileSync(join(root, "unrelated.txt"), "committed\n");
  git(root, "add", "unrelated.txt");
  git(root, "commit", "-qm", "add unrelated fixture");
  const { controlled, tasks } = fixture(root, async (request) => codexCompletion(request, validPatch));
  const generated = await controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "unrelated.txt"), "new unrelated user work\n");

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(applied.backend, undefined);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(root, "unrelated.txt"), "utf8"), "new unrelated user work\n");
});

test("dirty Git worktree proposal survives persistence and restart with its exact review", async () => {
  const root = repository();
  const stateFile = retainedStateFile();
  writeFileSync(join(root, "note.txt"), "current user work\n");
  const output = filesystemProposal([{
    operation: "modify",
    path: "note.txt",
    before_sha256: hash("current user work\n"),
    content: "reviewed result\n"
  }]);
  const first = fixture(
    root, async (request) => codexCompletion(request, output), undefined, stateFile
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace", change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, generated.taskId);
  assert.equal(first.controlled.proposalReview(generated.taskId)?.status, "PASS");

  const restarted = fixture(
    root, async () => { throw new Error("must not execute"); }, undefined, stateFile
  );
  await restarted.controlled.load();
  assert.equal(restarted.controlled.proposalReview(generated.taskId)?.workspace_type, "git_workspace");
  assert.equal(restarted.controlled.proposalReview(generated.taskId)?.status, "PASS");
  const applied = await restarted.controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(applied.backend, "worktree");
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "reviewed result\n");
});

test("dirty Git worktree rejects delete and rename-shaped target operations", async () => {
  const root = repository();
  writeFileSync(join(root, "note.txt"), "dirty current work\n");
  const deletion = fixture(
    root,
    async (request) => codexCompletion(request, filesystemProposal([
      { operation: "delete", path: "note.txt", before_sha256: hash("dirty current work\n") }
    ]))
  );
  const deletionProposal = await deletion.controlled.generate({
    workspace_id: "workspace", change_request: "delete note", routing: "local_lead"
  });
  await terminal(deletion.tasks, deletionProposal.taskId);
  assert.equal(deletion.controlled.proposalReview(deletionProposal.taskId)?.status, "FAIL");

  renameSync(join(root, "note.txt"), join(root, "renamed.txt"));
  const rename = fixture(
    root,
    async (request) => codexCompletion(request, filesystemProposal([
      { operation: "create", path: "renamed.txt", content: "dirty current work\n" }
    ]))
  );
  const renameProposal = await rename.controlled.generate({
    workspace_id: "workspace", change_request: "rename note", routing: "local_lead"
  });
  await terminal(rename.tasks, renameProposal.taskId);
  assert.equal(rename.controlled.proposalReview(renameProposal.taskId)?.status, "FAIL");
});

test("rejects staged workspaces, changed HEAD, and malformed or out-of-scope patches", async () => {
  const dirtyRoot = repository();
  writeFileSync(join(dirtyRoot, "note.txt"), "dirty\n");
  git(dirtyRoot, "add", "note.txt");
  const dirty = fixture(dirtyRoot, async () => ({ kind: "completed", output: validPatch })).controlled;
  await expectCode(() => dirty.generate({ workspace_id: "workspace", change_request: "change", routing: "local_lead" }), "WORKSPACE_PRECONDITION_FAILED");

  for (const output of ["```diff\n" + validPatch + "```", validPatch.replaceAll("note.txt", "new.txt")]) {
    const root = repository();
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change", routing: "local_lead" });
    await terminal(tasks, generated.taskId);
    await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
  }

  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: validPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change", routing: "local_lead" });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("bounds applied proposal history without evicting live proposed or applying proposals", async () => {
  const root = repository();
  let next = 0;
  const { controlled, tasks } = fixture(root, async () => {
    const path = `added-${next++}.txt`;
    return { kind: "completed", output: additionPatch.replaceAll("added.txt", path) };
  });
  const appliedTaskIds: string[] = [];

  for (let index = 0; index < 101; index += 1) {
    const proposal = await controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
    await terminal(tasks, proposal.taskId);
    await controlled.apply({ patch_task_id: proposal.taskId, confirmation: "APPLY" });
    appliedTaskIds.push(proposal.taskId);
    git(root, "add", ".");
    git(root, "commit", "-qm", `apply ${index}`);
  }

  const proposals = (controlled as unknown as { proposals: Map<string, { state: string }> }).proposals;
  assert.equal(proposals.has(appliedTaskIds[0]!), false);
  for (const taskId of appliedTaskIds.slice(1)) assert.equal(proposals.get(taskId)?.state, "applied");

  const live = await controlled.generate({ workspace_id: "workspace", change_request: "add live file", routing: "local_lead" });
  const applying = await controlled.generate({ workspace_id: "workspace", change_request: "add applying file", routing: "local_lead" });
  proposals.get(applying.taskId)!.state = "applying";
  assert.equal(proposals.size, 102);

  await terminal(tasks, live.taskId);
  assert.equal((await controlled.apply({ patch_task_id: live.taskId, confirmation: "APPLY" })).applied, true);
  assert.equal(proposals.get(applying.taskId)?.state, "applying");
});

test("generates and refines proposals for an unborn repository with an explicit unborn instruction", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const instructions: string[] = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => {
      instructions.push(request.instruction);
      return codexCompletion(request, additionPatch);
    }
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
  assert.equal(generated.baseHead, null);
  await terminal(tasks, generated.taskId);
  const generateInstruction = instructions[0] ?? "";
  assert.match(generateInstruction, /unborn repository state/u);
  assert.match(generateInstruction, /only add ordinary text files using new file mode 100644/u);
  // No fake HEAD: never "Base HEAD: null" or a fabricated SHA. (The embedded
  // source diff legitimately contains "/dev/null" headers.)
  assert.equal(generateInstruction.includes("Base HEAD: null"), false);
  assert.equal(/\bbase_head\s+null\b/u.test(generateInstruction), false);
  assert.equal(/\b[0-9a-f]{40}\b/u.test(generateInstruction), false);

  const refined = await controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust", routing: "local_lead" });
  assert.equal(refined.baseHead, null);
  await terminal(tasks, refined.taskId);
  const refinementInstruction = instructions[1] ?? "";
  assert.match(refinementInstruction, /unborn repository state/u);
  assert.match(refinementInstruction, /only add ordinary text files using new file mode 100644/u);
  assert.equal(refinementInstruction.includes("Base HEAD: null"), false);
  assert.equal(/\bbase_head\s+null\b/u.test(refinementInstruction), false);
  assert.equal(/\b[0-9a-f]{40}\b/u.test(refinementInstruction), false);
});

test("applies an unborn proposal while the repository stays unborn and does not stage files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, additionPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
  await terminal(tasks, generated.taskId);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.equal(applied.applied, true);
  assert.deepEqual(applied.changed_paths, ["added.txt"]);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
  // git apply without --index never stages the new file.
  assert.equal(git(root, "ls-files", "--stage").trim(), "");
});

test("rejects an unborn proposal once the repository gains its first commit", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, additionPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, "add", "seed.txt");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "commit", "-qm", "first commit");

  // Both refine and APPLY must reject the stale unborn proposal.
  await expectCode(() => controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust", routing: "local_lead" }), "WORKSPACE_PRECONDITION_FAILED");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("rejects unborn modified targets and targets that already exist as untracked files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const modified = await controlled.generate({ workspace_id: "workspace", change_request: "modify", routing: "local_lead" });
  await terminal(tasks, modified.taskId);
  await expectCode(() => controlled.apply({ patch_task_id: modified.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");

  const conflictingTasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, additionPatch)
  }));
  const conflicting = new ControlledPatchService(registry, conflictingTasks);
  const generated = await conflicting.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" });
  await terminal(conflictingTasks, generated.taskId);
  writeFileSync(join(root, "added.txt"), "user content\n");
  await expectCode(() => conflicting.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("retained-state loader accepts old and new commit bases and quarantines illegal base combinations", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const oldRecord = {
    version: 2,
    applied_task_ids: [],
    proposals: [{
      task_id: "00000000-0000-4000-8000-000000000001",
      workspace_id: "workspace",
      workspace_root: root,
      ...RETAINED_CODEX_METADATA,
      base_head: head,
      state: "proposed",
      output: validPatch
    }]
  };
  writeFileSync(stateFilePath, `${JSON.stringify(oldRecord, null, 2)}\n`);
  const oldTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async (request) => codexCompletion(request, validPatch) }));
  const oldLoaded = new ControlledPatchService(registry, oldTasks, undefined, stateFilePath);
  await oldLoaded.load();
  const oldProposals = (oldLoaded as unknown as { proposals: Map<string, { base: { kind: string; head?: string } }> }).proposals;
  assert.equal(oldProposals.get("00000000-0000-4000-8000-000000000001")?.base.kind, "commit");

  const newCommitRecord = {
    ...oldRecord,
    proposals: [{ ...oldRecord.proposals[0]!, unborn: false }]
  };
  writeFileSync(stateFilePath, `${JSON.stringify(newCommitRecord, null, 2)}\n`);
  const newCommitTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async (request) => codexCompletion(request, validPatch) }));
  const newCommitLoaded = new ControlledPatchService(registry, newCommitTasks, undefined, stateFilePath);
  await newCommitLoaded.load();
  assert.equal(
    (newCommitLoaded as unknown as { proposals: Map<string, { base: { kind: string; head?: string } }> }).proposals
      .get("00000000-0000-4000-8000-000000000001")?.base.kind,
    "commit"
  );

  const unbornRoot = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-state-")));
  git(unbornRoot, "init", "-q");
  const unbornStateFilePath = retainedStateFile();
  writeFileSync(unbornStateFilePath, `${JSON.stringify({
    version: 2,
    applied_task_ids: [],
    proposals: [{
      task_id: "00000000-0000-4000-8000-000000000002",
      workspace_id: "unborn-workspace",
      workspace_root: unbornRoot,
      ...RETAINED_CODEX_METADATA,
      base_head: null,
      unborn: true,
      state: "proposed",
      output: additionPatch
    }]
  }, null, 2)}\n`);
  const unbornRegistry = new RegisteredWorkspaceRegistry([{ id: "unborn-workspace", root: unbornRoot, allow_write: true }]);
  const unbornTasks = new RegisteredWorkspaceTaskService(unbornRegistry, () => ({ execute: async (request) => codexCompletion(request, additionPatch) }));
  const unbornLoaded = new ControlledPatchService(unbornRegistry, unbornTasks, undefined, unbornStateFilePath);
  await unbornLoaded.load();
  assert.equal(
    (unbornLoaded as unknown as { proposals: Map<string, { base: { kind: string } }> }).proposals
      .get("00000000-0000-4000-8000-000000000002")?.base.kind,
    "unborn"
  );

  // Restart recovery: the restored unborn proposal can still be refined and applied.
  const refined = await unbornLoaded.refine({ patch_task_id: "00000000-0000-4000-8000-000000000002", change_request: "adjust", routing: "local_lead" });
  assert.equal(refined.baseHead, null);
  await terminal(unbornTasks, refined.taskId);
  const restoredApplied = await unbornLoaded.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.equal(restoredApplied.applied, true);
  assert.equal(readFileSync(join(unbornRoot, "added.txt"), "utf8"), "added\n");

  for (const [baseHead, unborn] of [[null, false], [head, true], [null, undefined]] as const) {
    // JSON.stringify drops the undefined key: [null, undefined] is exactly the
    // "base_head null with no unborn field" illegal combination. Each illegal
    // base makes only that proposal unrecoverable, so it is quarantined while
    // the rest of the state still loads.
    writeFileSync(stateFilePath, `${JSON.stringify({
      version: 2,
      applied_task_ids: [],
      proposals: [{
        task_id: "00000000-0000-4000-8000-000000000003",
        workspace_id: "workspace",
        workspace_root: root,
        ...RETAINED_CODEX_METADATA,
        base_head: baseHead,
        unborn,
        state: "proposed",
        output: validPatch
      }]
    }, null, 2)}\n`);
    const invalidTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async (request) => codexCompletion(request, validPatch) }));
    const invalid = new ControlledPatchService(registry, invalidTasks, undefined, stateFilePath);
    await invalid.load();
    const proposals = (invalid as unknown as { proposals: Map<string, unknown> }).proposals;
    assert.equal(proposals.has("00000000-0000-4000-8000-000000000003"), false);
  }
});

test("generation needs no write authorization; APPLY does, and AUTHORIZE afterwards enables the same proposal", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([]);
  const catalog = new ManagedWorkspaceCatalog(undefined);
  await catalog.load();
  const { id } = await catalog.registerOnce(root);
  registry.registerManaged(id, root);
  const onboarding = new WorkspaceOnboardingService(registry, catalog, []);
  const stateFilePath = retainedStateFile();
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, additionPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);

  // Any registered workspace can generate a read-only proposal.
  const generated = await controlled.generate({ workspace_id: id, change_request: "add file", routing: "local_lead" });
  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
  await terminal(tasks, generated.taskId);

  // Refinement is also read-only analysis: no write authorization needed.
  const refined = await controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust", routing: "local_lead" });
  assert.equal(refined.baseHead, git(root, "rev-parse", "HEAD").trim());
  await terminal(tasks, refined.taskId);

  // APPLY still requires controlled-write authorization.
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");

  // AUTHORIZE the managed workspace, then the SAME proposal applies.
  const authorized = await onboarding.authorizeWrite(id);
  assert.deepEqual(authorized, { workspace_id: id, allow_write: true });
  assert.equal(registry.resolveWritable(id), root);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");

  // Restart recovery: the authorized state round-trips through the catalog and registry.
  const reloadedRegistry = new RegisteredWorkspaceRegistry([]);
  for (const entry of catalog.entries()) reloadedRegistry.registerManaged(entry.id, entry.root, entry.allowWrite);
  assert.equal(reloadedRegistry.resolveWritable(id), root);
});

test("HEAD detection fails closed: a git helper spawn failure in a real unborn repo is not inferred as unborn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, additionPatch)
  }));
  // The repository is genuinely unborn, but the HEAD probe cannot even spawn:
  // that must fail closed, never be guessed as unborn.
  const starter: GitStarter = (executable, args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet" && args[3] === "HEAD") {
      throw new Error("simulated git spawn failure");
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a nonzero rev-parse without unborn proof is not inferred as unborn", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  // rev-parse HEAD exits non-zero exactly as in an unborn repo, but the branch
  // symbolic ref resolves to a real commit: an inconsistent reference state,
  // not an unborn branch.
  const starter: GitStarter = (executable, args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet" && args[3] === "HEAD") {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a detached-style unresolvable HEAD is not inferred as unborn", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  // HEAD cannot resolve and there is no symbolic branch ref behind it (as with
  // a missing or detached HEAD): without a branch ref, unborn is unproven.
  const starter: GitStarter = (executable, args, options) => {
    if (args.includes("--quiet")) {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "change note", routing: "local_lead" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a non-branch symbolic HEAD is not inferred as unborn", async () => {
  // A real repository whose HEAD symbolic ref points outside refs/heads/: git
  // reports no resolvable HEAD, but this is not an unborn branch state.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/tags/nonexistent\n");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, additionPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "add file", routing: "local_lead" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

function retainedRecord(
  taskId: string,
  root: string,
  head: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    task_id: taskId,
    workspace_id: "workspace",
    workspace_root: root,
    ...RETAINED_CODEX_METADATA,
    base_head: head,
    state: "proposed",
    output: validPatch,
    ...overrides
  };
}

function writeRetainedState(stateFilePath: string, state: unknown): void {
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}

test("quarantines a single malformed proposal field while restoring the valid proposal", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const goodId = "00000000-0000-4000-8000-000000000001";
  const badId = "00000000-0000-4000-8000-000000000002";
  const badVariants: Array<Record<string, unknown>> = [
    { state: "bogus" },
    { output: 42 },
    { base_head: "not-a-hex" },
    { unborn: "yes" },
    { workspace_id: "" },
    { workspace_root: 42 },
    { parent_task_id: "not-a-uuid" }
  ];

  for (const badFields of badVariants) {
    const stateFilePath = retainedStateFile();
    writeRetainedState(stateFilePath, {
      version: 2,
      applied_task_ids: [],
      proposals: [
        retainedRecord(goodId, root, head),
        retainedRecord(badId, root, head, badFields)
      ]
    });
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await controlled.load();

    const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
    assert.deepEqual([...proposals.keys()], [goodId]);
    assert.equal(tasks.taskView(goodId)?.state, "completed");
    // The quarantined record is unreachable through every proposal surface.
    assert.equal(tasks.taskView(badId), undefined);
    assert.equal(tasks.result(badId), undefined);
    await expectCode(() => controlled.refine({
      patch_task_id: badId,
      change_request: "improve", routing: "local_lead"
    }), "INVALID_STATE_TRANSITION");
    await expectCode(() => controlled.apply({
      patch_task_id: badId,
      confirmation: "APPLY"
    }), "INVALID_STATE_TRANSITION");
  }
});

test("quarantines a proposal with an invalid task id without touching the valid proposals", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 2,
    applied_task_ids: [],
    proposals: [
      retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
      retainedRecord("not-a-uuid", root, head),
      retainedRecord("00000000-0000-4000-8000-000000000003", root, head)
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.deepEqual(
    [...proposals.keys()],
    ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000003"]
  );
  assert.equal(proposals.size, 2);
});

test("quarantines proposals whose workspace is unregistered or whose root moved, keeping the rest", async () => {
  const root = repository();
  const other = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const otherHead = git(other, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 2,
    applied_task_ids: [],
    proposals: [
      retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
      // Unregistered workspace: registry.resolve throws UNKNOWN_WORKSPACE.
      retainedRecord("00000000-0000-4000-8000-000000000002", other, otherHead, { workspace_id: "ghost" }),
      // Registered id whose persisted root no longer matches the registry.
      retainedRecord("00000000-0000-4000-8000-000000000003", other, otherHead)
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.deepEqual([...proposals.keys()], ["00000000-0000-4000-8000-000000000001"]);
  assert.equal(tasks.taskView("00000000-0000-4000-8000-000000000001")?.state, "completed");
  for (const skipped of ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]) {
    assert.equal(proposals.has(skipped), false);
    assert.equal(tasks.taskView(skipped), undefined);
    await expectCode(() => controlled.apply({ patch_task_id: skipped, confirmation: "APPLY" }), "INVALID_STATE_TRANSITION");
  }
});

test("a single bad proposal record does not prevent Bridge startup", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const badStates: unknown[] = [
    { version: 2, applied_task_ids: [], proposals: [retainedRecord("00000000-0000-4000-8000-000000000001", root, head, { output: 42 })] },
    { version: 2, applied_task_ids: [], proposals: [null] }
  ];
  for (const state of badStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await controlled.load();

    const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
    assert.equal(proposals.size, 0);
    const appliedProposalTaskIds = (controlled as unknown as { appliedProposalTaskIds: string[] }).appliedProposalTaskIds;
    assert.deepEqual(appliedProposalTaskIds, []);
  }
});

test("drops the applied history entry of a quarantined applied proposal and keeps the rest not re-appliable", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const badAppliedId = "00000000-0000-4000-8000-000000000001";
  const goodAppliedId = "00000000-0000-4000-8000-000000000002";
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 2,
    applied_task_ids: [badAppliedId, goodAppliedId],
    proposals: [
      // Malformed output makes this applied record unrecoverable: it and its
      // applied_task_ids entry are quarantined together.
      retainedRecord(badAppliedId, root, head, { state: "applied", output: 42 }),
      retainedRecord(goodAppliedId, root, head, { state: "applied" })
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, { state: string }> }).proposals;
  assert.deepEqual([...proposals.keys()], [goodAppliedId]);
  assert.equal(proposals.get(goodAppliedId)?.state, "applied");
  const appliedProposalTaskIds = (controlled as unknown as { appliedProposalTaskIds: string[] }).appliedProposalTaskIds;
  assert.deepEqual(appliedProposalTaskIds, [goodAppliedId]);
  // The surviving applied proposal must not become re-appliable.
  await expectCode(() => controlled.apply({
    patch_task_id: goodAppliedId,
    confirmation: "APPLY"
  }), "INVALID_STATE_TRANSITION");
});

test("retained state fails closed: unsupported version and invalid top-level structure", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const invalidStates: unknown[] = [
    { version: 6, applied_task_ids: [], proposals: [retainedRecord("00000000-0000-4000-8000-000000000001", root, head)] },
    { version: 2, proposals: [] },
    { version: 2, applied_task_ids: [], proposals: "nope" }
  ];
  for (const state of invalidStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: applied_task_ids itself is invalid", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const stateFilePath = retainedStateFile();
  const invalidAppliedLists: unknown[] = [
    "nope",
    [123],
    ["not-a-uuid"],
    [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001"
    ]
  ];
  for (const appliedTaskIds of invalidAppliedLists) {
    writeRetainedState(stateFilePath, { version: 2, applied_task_ids: appliedTaskIds, proposals: [] });
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: duplicate proposal task ids are ambiguous even with a broken duplicate", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const duplicateStates: unknown[] = [
    // Two otherwise valid records with the same task id.
    {
      version: 2,
      applied_task_ids: [],
      proposals: [
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head)
      ]
    },
    // One broken duplicate could claim a different applied state than the
    // valid record, so the duplicate id always fails closed.
    {
      version: 2,
      applied_task_ids: [],
      proposals: [
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head, { state: "applied", output: 42 })
      ]
    }
  ];
  for (const state of duplicateStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: applied_task_ids contradicts the surviving proposal states", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const contradictoryStates: unknown[] = [
    // Applied history claims a proposal the record says is only proposed.
    {
      version: 2,
      applied_task_ids: [firstId],
      proposals: [retainedRecord(firstId, root, head)]
    },
    // A proposal claims to be applied but is missing from applied history.
    {
      version: 2,
      applied_task_ids: [],
      proposals: [retainedRecord(firstId, root, head, { state: "applied" })]
    },
    // Applied history claims a proposal stuck in the interrupted applying state.
    {
      version: 2,
      applied_task_ids: [firstId, secondId],
      proposals: [
        retainedRecord(firstId, root, head, { state: "applied" }),
        retainedRecord(secondId, root, head, { state: "applying" })
      ]
    }
  ];
  for (const state of contradictoryStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: an applied id with no backing proposal record at all", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 2,
    applied_task_ids: ["00000000-0000-4000-8000-000000000001"],
    proposals: []
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await expectCode(() => controlled.load(), "INTERNAL_ERROR");
});

test("keeps a child proposal usable when its parent record is quarantined", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const parentId = "00000000-0000-4000-8000-000000000001";
  const childId = "00000000-0000-4000-8000-000000000002";
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 2,
    applied_task_ids: [],
    proposals: [
      // Bad parent record: quarantined on its own merits.
      retainedRecord(parentId, root, head, { state: "bogus" }),
      retainedRecord(childId, root, head, {
        parent_task_id: parentId,
        handoff_snapshot: { objective: "refine", current_state: "parent proposal completed" }
      })
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => codexCompletion(request, validPatch)
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, { parentTaskId?: string }> }).proposals;
  assert.deepEqual([...proposals.keys()], [childId]);
  // The dangling parent link (audit lineage only) is retained and harmless.
  assert.equal(proposals.get(childId)?.parentTaskId, parentId);
  assert.equal(tasks.taskView(childId)?.state, "completed");
  const refined = await controlled.refine({ patch_task_id: childId, change_request: "improve", routing: "local_lead" });
  await terminal(tasks, refined.taskId);
  const applied = await controlled.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("retained state fails closed: a surviving parent contradicts the child workspace or base", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([
    { id: "workspace", root, allow_write: true },
    { id: "other", root, allow_write: true }
  ]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const parentId = "00000000-0000-4000-8000-000000000001";
  const childId = "00000000-0000-4000-8000-000000000002";
  const stateFilePath = retainedStateFile();
  const inconsistentChildren: Array<Record<string, unknown>> = [
    // Child base differs from the surviving parent's base.
    {
      parent_task_id: parentId,
      handoff_snapshot: { objective: "refine", current_state: "parent proposal completed" },
      base_head: "1111111111111111111111111111111111111111"
    },
    // Child workspace differs from the surviving parent's workspace.
    {
      parent_task_id: parentId,
      handoff_snapshot: { objective: "refine", current_state: "parent proposal completed" },
      workspace_id: "other"
    }
  ];
  for (const childOverrides of inconsistentChildren) {
    writeRetainedState(stateFilePath, {
      version: 2,
      applied_task_ids: [],
      proposals: [
        retainedRecord(parentId, root, head),
        retainedRecord(childId, root, head, childOverrides)
      ]
    });
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async (request) => codexCompletion(request, validPatch)
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("keeps a refine chain usable across restart when refining a restored child", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const refinedPatch = validPatch.replace("+after", "+refined after");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note", routing: "local_lead"
  });
  await terminal(first.tasks, source.taskId);
  const refined = await first.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording", routing: "local_lead"
  });
  await terminal(first.tasks, refined.taskId);

  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: refinedPatch }),
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  // Refining the restored child, not the source: the chain stays usable.
  const refined2 = await restarted.controlled.refine({
    patch_task_id: refined.taskId,
    change_request: "polish", routing: "local_lead"
  });
  await terminal(restarted.tasks, refined2.taskId);

  assert.equal(refined2.baseHead, source.baseHead);
  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; parent_task_id?: string }>;
  };
  assert.equal(state.proposals.find(({ task_id }) => task_id === refined2.taskId)?.parent_task_id, refined.taskId);
  const applied = await restarted.controlled.apply({ patch_task_id: refined2.taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined after\n");
});
