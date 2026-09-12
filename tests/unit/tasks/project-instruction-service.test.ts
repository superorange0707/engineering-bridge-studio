import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Executor } from "../../../src/executors/executor.js";
import { DEFAULT_CODEX_MODEL_REGISTRY } from "../../../src/executors/codex-model-registry.js";
import { newId } from "../../../src/core/ids.js";
import { ControlledPatchService } from "../../../src/tasks/controlled-patch-service.js";
import { ProjectInstructionService } from "../../../src/tasks/project-instruction-service.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { inspectWorkspace } from "../../../src/workspaces/repository-identity.js";

async function fixture(root: string, execute: Executor["execute"]) {
  const inspected = await inspectWorkspace(root);
  const id = newId();
  const catalog = new ManagedWorkspaceCatalog();
  await catalog.registerOnce(inspected.root, {
    id,
    workspaceType: inspected.workspaceType,
    filesystem: inspected.filesystem,
    allowWrite: true,
    source: "managed"
  });
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged(id, inspected.root, true);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute }));
  const controlled = new ControlledPatchService(
    registry,
    tasks,
    undefined,
    undefined,
    DEFAULT_CODEX_MODEL_REGISTRY,
    () => inspected.workspaceType
  );
  return { id, tasks, controlled, service: new ProjectInstructionService(registry, catalog, controlled) };
}

async function terminal(tasks: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (["queued", "running"].includes(tasks.status(taskId)?.state ?? "")) {
    await new Promise<void>((done) => setImmediate(done));
  }
}

async function reviewed(controlled: ControlledPatchService, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && controlled.projectInstructionReview(taskId) === undefined; attempt += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
}

interface ExactTarget {
  readonly path: "AGENTS.md" | "PLANS.md";
  readonly operation: "create" | "modify";
  readonly before_sha256?: string;
  readonly content: string;
}

function exactTargets(instruction: string): ExactTarget[] {
  const marker = "The proposed postimage bytes must match every content string exactly, and no other path may change:";
  return JSON.parse(instruction.slice(instruction.indexOf(marker) + marker.length).trim()) as ExactTarget[];
}

function target(targets: readonly ExactTarget[], path: ExactTarget["path"]): ExactTarget {
  const found = targets.find((candidate) => candidate.path === path);
  assert.ok(found, `missing ${path}`);
  return found;
}

function markerCount(content: string, marker: "BEGIN" | "END"): number {
  return content.split(`<!-- ${marker} engineering-bridge-project-evidence:v1 -->`).length - 1;
}

function outsideManagedBlock(content: string): string {
  const begin = content.indexOf("<!-- BEGIN engineering-bridge-project-evidence:v1 -->");
  const endMarker = "<!-- END engineering-bridge-project-evidence:v1 -->";
  const end = content.indexOf(endMarker, begin) + endMarker.length;
  assert.ok(begin >= 0 && end >= endMarker.length);
  return `${content.slice(0, begin)}${content.slice(end)}`;
}

function materialize(root: string, targets: readonly ExactTarget[]): void {
  for (const proposed of targets) writeFileSync(join(root, proposed.path), proposed.content);
}

function exactFilesystemExecutor(observed: string[]): Executor["execute"] {
  return async (request) => {
    observed.push(request.instruction);
    const targets = exactTargets(request.instruction);
    return {
      kind: "completed",
      output: `${JSON.stringify({ version: 1, operations: targets })}\n`,
      threadId: "thread-project-instructions",
      metadata: {
        logicalRole: request.logicalRole!,
        model: DEFAULT_CODEX_MODEL_REGISTRY[request.logicalRole!].model,
        reasoningEffort: "max",
        codexVersion: "0.148.0"
      }
    };
  };
}

test("new directory project gets exact portable AGENTS/PLANS proposal with evidenced commands only", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "example",
    description: "Example package.",
    packageManager: "pnpm@9.0.0",
    scripts: { test: "node --test", deploy: "unsafe", typecheck: "tsc --noEmit" }
  }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const observed: string[] = [];
  const { id, tasks, controlled, service } = await fixture(root, exactFilesystemExecutor(observed));

  const result = await service.prepare(id);
  assert.equal(result.status, "READY");
  assert.deepEqual(result.evidenced_commands, ["pnpm test", "pnpm typecheck"]);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(existsSync(join(root, "PLANS.md")), false);
  await terminal(tasks, result.task_id!);
  await reviewed(controlled, result.task_id!);
  assert.ok(controlled.projectInstructionReview(result.task_id), JSON.stringify(tasks.taskView(result.task_id)));
  assert.deepEqual(controlled.projectInstructionReview(result.task_id), {
    status: "READY",
    human_approvable: true,
    evidence_sha256: result.evidence_sha256,
    exact_target_bytes: true,
    target_sha256: {
      "AGENTS.md": controlled.projectInstructionReview(result.task_id)!.target_sha256["AGENTS.md"],
      "PLANS.md": controlled.projectInstructionReview(result.task_id)!.target_sha256["PLANS.md"]
    }
  });
  assert.doesNotMatch(observed[0]!, /\/Users\/|gpt-5|controlled APPLY/u);
  assert.match(observed[0]!, /pnpm test/u);
  assert.doesNotMatch(observed[0]!, /pnpm deploy/u);
  for (const proposed of exactTargets(observed[0]!)) {
    assert.equal(markerCount(proposed.content, "BEGIN"), 1);
    assert.equal(markerCount(proposed.content, "END"), 1);
    assert.match(proposed.content, new RegExp(`evidence-sha256:${result.evidence_sha256}`, "u"));
  }
});

test("ordinary existing AGENTS/PLANS bytes are preserved and receive one managed block", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-existing-"));
  const existingAgents = "# Existing AGENTS\n\nKeep this project rule.\n \n";
  const existingPlans = "# Existing PLANS\n\nKeep this plan.\n";
  writeFileSync(join(root, "AGENTS.md"), existingAgents);
  writeFileSync(join(root, "PLANS.md"), existingPlans);
  const observed: string[] = [];
  const { id, tasks, controlled, service } = await fixture(root, exactFilesystemExecutor(observed));
  const result = await service.prepare(id);
  await terminal(tasks, result.task_id!);
  await reviewed(controlled, result.task_id!);
  assert.ok(controlled.projectInstructionReview(result.task_id), JSON.stringify(tasks.taskView(result.task_id)));
  const targets = exactTargets(observed[0]!);
  assert.equal(target(targets, "AGENTS.md").content.startsWith(existingAgents), true);
  assert.equal(target(targets, "PLANS.md").content.startsWith(existingPlans), true);
  assert.equal(markerCount(target(targets, "AGENTS.md").content, "BEGIN"), 1);
  assert.equal(markerCount(target(targets, "PLANS.md").content, "BEGIN"), 1);
  assert.equal(controlled.projectInstructionReview(result.task_id)?.status, "READY");
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), existingAgents);
  assert.equal(readFileSync(join(root, "PLANS.md"), "utf8"), existingPlans);
});

test("identical second prepare is ALREADY_CURRENT without another proposal turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-current-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@9.0.0", scripts: { test: "node --test" }
  }));
  const observed: string[] = [];
  const { id, tasks, service } = await fixture(root, exactFilesystemExecutor(observed));
  const first = await service.prepare(id);
  await terminal(tasks, first.task_id!);
  materialize(root, exactTargets(observed[0]!));

  const second = await service.prepare(id);
  assert.equal(second.status, "ALREADY_CURRENT");
  assert.equal(second.task_id, undefined);
  assert.deepEqual(second.proposed_targets, []);
  assert.equal(observed.length, 1);
});

test("changed evidence replaces one managed block and removes stale Bridge commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-refresh-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@9.0.0", scripts: { test: "node --test" }
  }));
  const observed: string[] = [];
  const { id, tasks, service } = await fixture(root, exactFilesystemExecutor(observed));
  const first = await service.prepare(id);
  await terminal(tasks, first.task_id!);
  const firstTargets = exactTargets(observed[0]!);
  materialize(root, firstTargets);
  const originalAgents = target(firstTargets, "AGENTS.md").content;
  const userPrefix = "User-maintained note.\n\n";
  writeFileSync(join(root, "AGENTS.md"), `${userPrefix}${originalAgents}`);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    packageManager: "npm@10.0.0", scripts: { test: "node --test" }
  }));

  const second = await service.prepare(id);
  await terminal(tasks, second.task_id!);
  const secondTargets = exactTargets(observed[1]!);
  const nextAgents = target(secondTargets, "AGENTS.md").content;
  assert.equal(second.status, "READY");
  assert.equal(markerCount(nextAgents, "BEGIN"), 1);
  assert.equal(markerCount(nextAgents, "END"), 1);
  assert.match(nextAgents, /npm test/u);
  assert.doesNotMatch(nextAgents, /pnpm test/u);
  assert.equal(outsideManagedBlock(nextAgents), `${userPrefix}${outsideManagedBlock(originalAgents)}`);
});

test("user edits outside a current managed block remain byte-identical without duplication", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-user-edit-"));
  const observed: string[] = [];
  const { id, tasks, service } = await fixture(root, exactFilesystemExecutor(observed));
  const first = await service.prepare(id);
  await terminal(tasks, first.task_id!);
  materialize(root, exactTargets(observed[0]!));
  const current = readFileSync(join(root, "AGENTS.md"), "utf8");
  const edited = `User-maintained preface.\n\n${current}`;
  writeFileSync(join(root, "AGENTS.md"), edited);

  const second = await service.prepare(id);
  assert.equal(second.status, "ALREADY_CURRENT");
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), edited);
  assert.equal(markerCount(edited, "BEGIN"), 1);
  assert.equal(observed.length, 1);
});

test("managed-block tampering is repaired despite an unchanged evidence marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-tamper-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@9.0.0", scripts: { test: "node --test" }
  }));
  const observed: string[] = [];
  const { id, tasks, service } = await fixture(root, exactFilesystemExecutor(observed));
  const first = await service.prepare(id);
  await terminal(tasks, first.task_id!);
  const original = target(exactTargets(observed[0]!), "AGENTS.md").content;
  materialize(root, exactTargets(observed[0]!));
  writeFileSync(join(root, "AGENTS.md"), original.replace("pnpm test", "pnpm test --tampered"));

  const second = await service.prepare(id);
  await terminal(tasks, second.task_id!);
  const repaired = target(exactTargets(observed[1]!), "AGENTS.md").content;
  assert.equal(second.status, "READY");
  assert.equal(repaired, original);
  assert.doesNotMatch(repaired, /--tampered/u);
  assert.equal(markerCount(repaired, "BEGIN"), 1);
});

test("duplicate managed blocks fail closed before a proposal turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-duplicate-"));
  const block = "<!-- BEGIN engineering-bridge-project-evidence:v1 -->\n" +
    "<!-- evidence-sha256:" + "a".repeat(64) + " -->\n" +
    "<!-- END engineering-bridge-project-evidence:v1 -->";
  writeFileSync(join(root, "AGENTS.md"), `${block}\n${block}\n`);
  const observed: string[] = [];
  const { id, service } = await fixture(root, exactFilesystemExecutor(observed));
  const result = await service.prepare(id);
  assert.equal(result.status, "HOLD_NEEDS_PROJECT_DECISION");
  assert.equal(result.hold_reason, "AMBIGUOUS_MANAGED_BLOCK");
  assert.deepEqual(observed, []);
});

test("malformed BEGIN/END structures fail closed before a proposal turn", async () => {
  for (const [name, content] of [
    ["begin", "<!-- BEGIN engineering-bridge-project-evidence:v1 -->\n"],
    ["end", "<!-- END engineering-bridge-project-evidence:v1 -->\n"],
    ["nested", "<!-- BEGIN engineering-bridge-project-evidence:v1 -->\n<!-- BEGIN engineering-bridge-project-evidence:v1 -->\n<!-- END engineering-bridge-project-evidence:v1 -->\n<!-- END engineering-bridge-project-evidence:v1 -->\n"]
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `bridge-project-instructions-malformed-${name}-`));
    writeFileSync(join(root, "AGENTS.md"), content);
    const observed: string[] = [];
    const { id, service } = await fixture(root, exactFilesystemExecutor(observed));
    const result = await service.prepare(id);
    assert.equal(result.status, "HOLD_NEEDS_PROJECT_DECISION");
    assert.equal(result.hold_reason, "AMBIGUOUS_MANAGED_BLOCK");
    assert.deepEqual(observed, []);
  }
});

test("unsupported managed-block versions fail closed before a proposal turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-version-"));
  writeFileSync(join(root, "PLANS.md"), "<!-- BEGIN engineering-bridge-project-evidence:v2 -->\n" +
    "<!-- evidence-sha256:" + "b".repeat(64) + " -->\n" +
    "<!-- END engineering-bridge-project-evidence:v2 -->\n");
  const observed: string[] = [];
  const { id, service } = await fixture(root, exactFilesystemExecutor(observed));
  const result = await service.prepare(id);
  assert.equal(result.status, "HOLD_NEEDS_PROJECT_DECISION");
  assert.equal(result.hold_reason, "AMBIGUOUS_MANAGED_BLOCK");
  assert.deepEqual(observed, []);
});

test("existing machine-specific control-plane instructions fail closed before a model task", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-hold-"));
  writeFileSync(join(root, "AGENTS.md"), "Use workspace_id and /Users/example/control-plane.\n");
  const observed: string[] = [];
  const { id, service } = await fixture(root, exactFilesystemExecutor(observed));
  const result = await service.prepare(id);
  assert.equal(result.status, "HOLD_NEEDS_PROJECT_DECISION");
  assert.equal(result.hold_reason, "EXISTING_INSTRUCTION_CONFLICT");
  assert.equal(result.task_id, undefined);
  assert.deepEqual(observed, []);
});

test("an untracked existing instruction target in a Git workspace is held instead of overwritten", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-untracked-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "AGENTS.md"), "# Local instructions\n");
  const observed: string[] = [];
  const { id, service } = await fixture(root, exactFilesystemExecutor(observed));
  const result = await service.prepare(id);
  assert.equal(result.status, "HOLD_NEEDS_PROJECT_DECISION");
  assert.equal(result.hold_reason, "UNSAFE_INSTRUCTION_TARGET");
  assert.deepEqual(observed, []);
});

test("proposal review rejects output whose postimage differs from deterministic target bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-mismatch-"));
  const { id, tasks, controlled, service } = await fixture(root, async (request) => ({
    kind: "completed",
    output: `${JSON.stringify({ version: 1, operations: [
      { operation: "create", path: "AGENTS.md", content: "different\n" }
    ] })}\n`,
    threadId: "thread-mismatch",
    metadata: {
      logicalRole: request.logicalRole!,
      model: DEFAULT_CODEX_MODEL_REGISTRY[request.logicalRole!].model,
      reasoningEffort: "max",
      codexVersion: "0.148.0"
    }
  }));
  const result = await service.prepare(id);
  await terminal(tasks, result.task_id!);
  await reviewed(controlled, result.task_id!);
  assert.equal(controlled.projectInstructionReview(result.task_id)?.status, "HOLD_NEEDS_PROJECT_DECISION");
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
});

test("project instruction proposal uses auto routing and bounded implementation role", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-routing-"));
  const observed: string[] = [];
  const { id, tasks, service } = await fixture(root, exactFilesystemExecutor(observed));
  const result = await service.prepare(id);
  await terminal(tasks, result.task_id!);
  const view = tasks.taskView(result.task_id)!;
  assert.equal(view.routing, "auto");
  assert.equal(view.logicalRole, "implementer");
  assert.equal(view.reasoningEffort, "max");
});

test("evidence digest is deterministic for unchanged bounded repository state", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-project-instructions-digest-"));
  mkdirSync(join(root, "src"));
  const observed: string[] = [];
  const { id, service } = await fixture(root, exactFilesystemExecutor(observed));
  const first = await service.prepare(id);
  const second = await service.prepare(id);
  assert.equal(first.evidence_sha256, second.evidence_sha256);
  assert.match(first.evidence_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(createHash("sha256").update(first.evidence_sha256).digest("hex").length, 64);
});
