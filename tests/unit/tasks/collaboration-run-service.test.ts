import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, linkSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CoreError, serializeError } from "../../../src/core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { CollaborationContractSchema } from "../../../src/tasks/collaboration-contract.js";
import {
  CollaborationRunService,
  COLLABORATION_INTERRUPT_WAIT_MS,
  DEFAULT_COLLABORATION_DEADLINE_MS
} from "../../../src/tasks/collaboration-run-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

function fixture(): { source: string; state: string; registry: RegisteredWorkspaceRegistry } {
  const root = mkdtempSync(join(tmpdir(), "engineering-bridge-collaboration-"));
  const source = join(root, "source");
  const state = join(root, "state");
  mkdirSync(source);
  writeFileSync(join(root, "marker.txt"), "outside\n");
  writeFileSync(join(source, "idea.md"), "background\n");
  return { source, state, registry: new RegisteredWorkspaceRegistry([{ id: "workspace", root: source }]) };
}

function contract(expected = ["result.json"] as readonly string[]) {
  return CollaborationContractSchema.parse({
    domain: "engineering",
    objective: "run a bounded deterministic check",
    plan: ["execute the check and record its result"],
    acceptance_criteria: ["the declared artifact exists"],
    expected_artifacts: expected
  });
}

function fakeExecutor(output: string, write = true): (root: string) => Executor {
  return (root) => ({
    async execute(request: ExecutorRequest): Promise<ExecutorResult> {
      if (write) {
        writeFileSync(join(root, "experiment.mjs"),
          `import { writeFileSync } from "node:fs"; writeFileSync("result.json", ${JSON.stringify(output)});\n`);
        execFileSync(process.execPath, ["experiment.mjs"], { cwd: root });
      }
      request.onEvidence?.([{
        id: "command-1", type: "commandExecution", status: "completed", command: "node check.mjs",
        result: { state: "complete", exit_code: 0, output: "ok" }
      }]);
      return { kind: "completed", output: "bounded execution report" };
    }
  });
}

async function waitFor(
  service: CollaborationRunService,
  runId: string,
  states: readonly string[]
): Promise<ReturnType<CollaborationRunService["get"]>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = service.get(runId);
    if (view !== undefined && states.includes(view.state)) return view;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`run ${runId} did not reach ${states.join(", ")}`);
}

test("executes declared work in scratch, records hashes, and leaves the source untouched", async () => {
  const { source, state, registry } = fixture();
  const service = new CollaborationRunService(state, registry, fakeExecutor('{"ok":true}\n'));
  const started = await service.start({
    workspace_id: "workspace",
    contract: contract(),
    input_files: ["idea.md"]
  });
  assert.equal(started.state, "queued");
  const finished = await waitFor(service, started.run_id, ["awaiting_review"]);
  assert.equal(finished?.ready, true);
  assert.equal(finished?.state, "awaiting_review");
  assert.equal(finished?.input_files[0]?.path, "idea.md");
  assert.equal(finished?.artifacts[0]?.path, "result.json");
  assert.equal(finished?.artifacts[0]?.sha256,
    createHash("sha256").update('{"ok":true}\n').digest("hex"));
  const artifact = await service.readArtifact(started.run_id, "result.json");
  assert.equal(artifact.content, '{"ok":true}\n');
  assert.equal(readFileSync(join(source, "idea.md"), "utf8"), "background\n");
  assert.equal(readFileSync(join(source, "../marker.txt"), "utf8"), "outside\n");
  assert.equal((service.list("workspace")[0] as { objective: string }).objective,
    "run a bounded deterministic check");
});

test("review and restart preserve the compact history and prevent replay", async () => {
  const { state, registry } = fixture();
  let executions = 0;
  const service = new CollaborationRunService(state, registry, (root) => ({
    async execute(): Promise<ExecutorResult> {
      executions += 1;
      writeFileSync(join(root, "result.json"), "accepted\n");
      return { kind: "completed", output: "done" };
    }
  }));
  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(service, started.run_id, ["awaiting_review"]);
  await service.review({ run_id: started.run_id, decision: "accept", feedback: "The evidence is sufficient." });
  assert.equal(executions, 1);

  const restarted = new CollaborationRunService(state, registry, () => {
    throw new Error("restart must not replay Codex");
  });
  await restarted.load();
  assert.equal(restarted.get(started.run_id)?.state, "accepted");
  const history = restarted.list("workspace");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.objective, "run a bounded deterministic check");
  assert.equal("contract" in (history[0] as object), false);
  const artifact = await restarted.readArtifact(started.run_id, "result.json");
  assert.equal(artifact.content, "accepted\n");
});

test("serializes concurrent review decisions so only one can win", async () => {
  const { state, registry } = fixture();
  const service = new CollaborationRunService(state, registry, fakeExecutor("review\n"));
  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(service, started.run_id, ["awaiting_review"]);
  const results = await Promise.allSettled([
    service.review({ run_id: started.run_id, decision: "accept", feedback: "accept" }),
    service.review({ run_id: started.run_id, decision: "reject", feedback: "reject" })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("does not turn an interrupted run into awaiting_review during artifact collection", async () => {
  const { state, registry } = fixture();
  const service = new CollaborationRunService(state, registry, (root) => ({
    async execute(): Promise<ExecutorResult> {
      writeFileSync(join(root, "result.json"), "slow-collection\n");
      return { kind: "completed", output: "done" };
    }
  }));
  const internals = service as unknown as { collectArtifacts: Function };
  const original = internals.collectArtifacts;
  let collecting = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  internals.collectArtifacts = async (manifest: unknown, workdir: string) => {
    collecting = true;
    await gate;
    return original.call(service, manifest, workdir);
  };
  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  for (let attempt = 0; attempt < 200 && !collecting; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(collecting, true);
  const interrupted = await service.interrupt(started.run_id);
  assert.equal(interrupted.state, "interrupted");
  release();
  const finished = await waitFor(service, started.run_id, ["interrupted"]);
  assert.equal(finished?.state, "interrupted");
});

test("bounds a hung interrupt hook and preserves artifacts from a late executor result", async () => {
  const { state, registry } = fixture();
  let releaseExecution!: () => void;
  const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
  let interruptCalls = 0;
  let executorStarted = false;
  const service = new CollaborationRunService(state, registry, (root) => {
    executorStarted = true;
    return {
      async execute(): Promise<ExecutorResult> {
        writeFileSync(join(root, "result.json"), "partial\n");
        await executionGate;
        return { kind: "completed", output: "late report" };
      },
      async interrupt(): Promise<void> {
        interruptCalls += 1;
        await new Promise<void>(() => undefined);
      }
    };
  });
  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(service, started.run_id, ["running"]);
  for (let attempt = 0; attempt < 200 && !executorStarted; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(executorStarted, true);

  const began = Date.now();
  const pending = await Promise.all([
    service.interrupt(started.run_id),
    service.interrupt(started.run_id)
  ]);
  assert.ok(Date.now() - began < COLLABORATION_INTERRUPT_WAIT_MS + 3_000);
  assert.equal(interruptCalls, 1);
  assert.equal(pending[0]?.state, "interrupting");
  assert.equal(pending[1]?.state, "interrupting");
  assert.equal(pending[0]?.ready, false);
  assert.equal(JSON.parse(readFileSync(join(state, "runs", started.run_id, "manifest.json"), "utf8")).state,
    "interrupting");

  releaseExecution();
  const finished = await waitFor(service, started.run_id, ["interrupted"]);
  assert.equal(finished?.partial_output, "late report");
  assert.equal(finished?.artifacts[0]?.path, "result.json");
  assert.equal((await service.readArtifact(started.run_id, "result.json")).content, "partial\n");

  const repeated = await service.interrupt(started.run_id);
  assert.equal(repeated.state, "interrupted");
  assert.equal(interruptCalls, 1);
});

test("recovers persisted interrupting intent without replay and keeps interrupt idempotent", async () => {
  const { state, registry } = fixture();
  let interruptCalls = 0;
  let executorStarted = false;
  const service = new CollaborationRunService(state, registry, () => {
    executorStarted = true;
    return {
      async execute(): Promise<ExecutorResult> { return new Promise(() => undefined); },
      async interrupt(): Promise<void> {
        interruptCalls += 1;
      }
    };
  });
  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(service, started.run_id, ["running"]);
  for (let attempt = 0; attempt < 200 && !executorStarted; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(executorStarted, true);

  const first = service.interrupt(started.run_id);
  const second = service.interrupt(started.run_id);
  assert.equal(service.get(started.run_id)?.state, "interrupting");
  assert.equal(JSON.parse(readFileSync(join(state, "runs", started.run_id, "manifest.json"), "utf8")).state,
    "interrupting");
  await assert.rejects(
    service.start({ workspace_id: "workspace", contract: contract() }),
    (error: unknown) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION"
  );

  const restarted = new CollaborationRunService(state, registry, () => {
    throw new Error("restarted interrupting work must not replay");
  });
  await restarted.load();
  assert.equal(restarted.get(started.run_id)?.state, "interrupted");
  assert.equal(restarted.get(started.run_id)?.ready, true);

  const [firstView, secondView] = await Promise.all([first, second]);
  assert.equal(firstView.state, "interrupting");
  assert.equal(secondView.state, "interrupting");
  assert.equal(interruptCalls, 1);
  assert.equal((await service.interrupt(started.run_id)).state, "interrupting");
  assert.equal(interruptCalls, 1);
});

test("interrupts a queued run without starting an executor", async () => {
  const { state, registry } = fixture();
  let executions = 0;
  const service = new CollaborationRunService(state, registry, () => ({
    async execute(): Promise<ExecutorResult> {
      executions += 1;
      return { kind: "completed", output: "must not run" };
    }
  }));
  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  const interrupted = await service.interrupt(started.run_id);
  assert.equal(interrupted.state, "interrupted");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executions, 0);
});

test("request_id makes retries idempotent and rejects changed retry payloads", async () => {
  const { state, registry } = fixture();
  let executions = 0;
  const service = new CollaborationRunService(state, registry, (root) => ({
    async execute(): Promise<ExecutorResult> {
      executions += 1;
      writeFileSync(join(root, "result.json"), "retry\n");
      return { kind: "completed", output: "done" };
    }
  }));
  const requestId = "0c7e1dc0-e4ab-4eb8-9339-9fd28c6a0e3c";
  const first = await service.start({ workspace_id: "workspace", request_id: requestId, contract: contract() });
  const retry = await service.start({ workspace_id: "workspace", request_id: requestId, contract: contract() });
  assert.equal(retry.run_id, first.run_id);
  assert.equal(executions, 0);
  await waitFor(service, first.run_id, ["awaiting_review"]);
  assert.equal(executions, 1);
  await assert.rejects(
    service.start({ workspace_id: "workspace", request_id: requestId, contract: contract(["other.json"]) }),
    (error: unknown) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION"
  );
});

test("rejects unsafe inputs, symlinks, hardlinks, and tampered artifacts", async () => {
  const { source, state, registry } = fixture();
  writeFileSync(join(source, "real.txt"), "data\n");
  symlinkSync("real.txt", join(source, "symlink.txt"));
  linkSync(join(source, "real.txt"), join(source, "hardlink.txt"));
  const service = new CollaborationRunService(state, registry, fakeExecutor("ok\n"));

  await assert.rejects(
    service.start({ workspace_id: "workspace", contract: contract(), input_files: ["../escape.txt"] }),
    (error: unknown) => error instanceof CoreError && error.code === "WORKSPACE_BOUNDARY_VIOLATION"
  );
  await assert.rejects(
    service.start({ workspace_id: "workspace", contract: contract(), input_files: ["symlink.txt"] }),
    (error: unknown) => error instanceof CoreError && error.code === "CONTROLLED_PROPOSAL_VALIDATION_FAILED"
  );
  await assert.rejects(
    service.start({ workspace_id: "workspace", contract: contract(), input_files: ["hardlink.txt"] }),
    (error: unknown) => error instanceof CoreError && error.code === "CONTROLLED_PROPOSAL_VALIDATION_FAILED"
  );

  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(service, started.run_id, ["awaiting_review"]);
  const workdir = join(state, "runs", started.run_id, "workdir");
  writeFileSync(join(workdir, "result.json"), "tampered\n");
  await assert.rejects(service.readArtifact(started.run_id, "result.json"), (error: unknown) =>
    error instanceof CoreError && error.code === "CONTROLLED_PROPOSAL_VALIDATION_FAILED");
  assert.equal(lstatSync(join(source, "real.txt")).isFile(), true);
});

test("recovers a running run as interrupted and records executor failures", async () => {
  const first = fixture();
  const running = new CollaborationRunService(first.state, first.registry, () => ({
    async execute(): Promise<ExecutorResult> { return new Promise(() => undefined); }
  }), undefined, { deadlineMs: DEFAULT_COLLABORATION_DEADLINE_MS });
  const started = await running.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(running, started.run_id, ["running"]);
  const recovered = new CollaborationRunService(first.state, first.registry, () => {
    throw new Error("must not replay recovered work");
  });
  await recovered.load();
  assert.equal(recovered.get(started.run_id)?.state, "interrupted");

  const failedFixture = fixture();
  const failedService = new CollaborationRunService(failedFixture.state, failedFixture.registry, () => ({
    async execute(): Promise<ExecutorResult> {
      return { kind: "failed", error: serializeError(new CoreError("CODEX_EXECUTION_FAILED")) };
    }
  }));
  const failed = await failedService.start({ workspace_id: "workspace", contract: contract() });
  const view = await waitFor(failedService, failed.run_id, ["failed"]);
  assert.equal(view?.error?.code, "CODEX_EXECUTION_FAILED");
  await assert.rejects(failedService.review({ run_id: failed.run_id, decision: "accept", feedback: "accept" }));
});

test("read-only recovery inspects an active run without writing, then writable upgrade recovers it once", async () => {
  const first = fixture();
  const seed = new CollaborationRunService(first.state, first.registry, fakeExecutor("seed\n"));
  const started = await seed.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(seed, started.run_id, ["awaiting_review"]);

  const manifestPath = join(first.state, "runs", started.run_id, "manifest.json");
  const persisted = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  persisted.state = "running";
  delete persisted.completed_at;
  delete persisted.output;
  persisted.artifacts = [];
  delete persisted.review;
  writeFileSync(manifestPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  const beforeRecovery = readFileSync(manifestPath, "utf8");
  let replayed = false;
  const readOnly = new CollaborationRunService(first.state, first.registry, () => {
    replayed = true;
    throw new Error("recovery must never replay the executor");
  });
  await readOnly.load(true);
  assert.equal(readFileSync(manifestPath, "utf8"), beforeRecovery);
  assert.equal(readOnly.get(started.run_id)?.state, "running");

  await readOnly.recover();
  assert.equal(replayed, false);
  assert.equal(readOnly.get(started.run_id)?.state, "interrupted");
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).state, "interrupted");

  const recoveredBytes = readFileSync(manifestPath, "utf8");
  await readOnly.recover();
  assert.equal(readFileSync(manifestPath, "utf8"), recoveredBytes);
});

test("corrupt manifests fail closed", async () => {
  const { state, registry } = fixture();
  const service = new CollaborationRunService(state, registry, fakeExecutor("ok\n"));
  const started = await service.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(service, started.run_id, ["awaiting_review"]);
  writeFileSync(join(state, "runs", started.run_id, "manifest.json"), "{corrupt\n");
  const restarted = new CollaborationRunService(state, registry, fakeExecutor("replay\n"));
  await assert.rejects(restarted.load(), (error: unknown) =>
    error instanceof CoreError && error.code === "INTERNAL_ERROR");
});

test("skips an orphan run directory and rejects a parent invariant forged in a manifest", async () => {
  const orphan = fixture();
  const orphanId = "0c7e1dc0-e4ab-4eb8-9339-9fd28c6a0e3d";
  mkdirSync(join(orphan.state, "runs", orphanId, "workdir"), { recursive: true });
  const orphanService = new CollaborationRunService(orphan.state, orphan.registry, fakeExecutor("ok\n"));
  await orphanService.load();
  assert.deepEqual(orphanService.list("workspace"), []);

  const persistent = fixture();
  const service = new CollaborationRunService(persistent.state, persistent.registry, fakeExecutor("ok\n"));
  const parent = await service.start({ workspace_id: "workspace", contract: contract() });
  await waitFor(service, parent.run_id, ["awaiting_review"]);
  await service.review({ run_id: parent.run_id, decision: "accept", feedback: "accepted" });
  const manifestPath = join(persistent.state, "runs", parent.run_id, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.parent_run_id = "0c7e1dc0-e4ab-4eb8-9339-9fd28c6a0e3e";
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const restarted = new CollaborationRunService(persistent.state, persistent.registry, fakeExecutor("replay\n"));
  await assert.rejects(restarted.load(), (error: unknown) =>
    error instanceof CoreError && error.code === "INTERNAL_ERROR");
});

test("rejects a symlinked runtime state root before creating storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "engineering-bridge-collaboration-state-link-"));
  const target = join(root, "target");
  const alias = join(root, "alias");
  mkdirSync(target);
  symlinkSync(target, alias);
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root: root }]);
  const service = new CollaborationRunService(alias, registry, fakeExecutor("ok\n"));
  await assert.rejects(service.load(), (error: unknown) =>
    error instanceof CoreError && error.code === "WORKSPACE_BOUNDARY_VIOLATION");
});

test("rejects replacement symlinks at every component of a finished run's storage path", async () => {
  for (const component of ["workdir", "run", "runs", "state"] as const) {
    const { state, registry } = fixture();
    const service = new CollaborationRunService(state, registry, fakeExecutor("original\n"));
    const started = await service.start({ workspace_id: "workspace", contract: contract() });
    await waitFor(service, started.run_id, ["awaiting_review"]);
    const paths = { workdir: join(state, "runs", started.run_id, "workdir"),
      run: join(state, "runs", started.run_id), runs: join(state, "runs"), state };
    const external = join(dirname(state), `external-${component}`);
    renameSync(paths[component], external);
    symlinkSync(external, paths[component]);
    await assert.rejects(service.readArtifact(started.run_id, "result.json"), (error: unknown) =>
      error instanceof CoreError && error.code === "WORKSPACE_PRECONDITION_FAILED");
  }
});

test("rejects multi-run parent cycles and overlapping persisted inputs/outputs on reload", async () => {
  const { state, registry } = fixture();
  const service = new CollaborationRunService(state, registry, fakeExecutor("original\n"));
  const ids: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const started = await service.start({ workspace_id: "workspace", contract: contract() });
    await waitFor(service, started.run_id, ["awaiting_review"]);
    await service.review({ run_id: started.run_id, decision: "accept", feedback: "checked" });
    ids.push(started.run_id);
  }
  const paths = ids.map((id) => join(state, "runs", id, "manifest.json"));
  const originals = paths.map((path) => readFileSync(path, "utf8"));
  paths.forEach((path, index) => {
    const manifest = JSON.parse(originals[index]!);
    manifest.parent_run_id = ids[1 - index];
    writeFileSync(path, JSON.stringify(manifest));
  });
  await assert.rejects(new CollaborationRunService(state, registry).load(), (error: unknown) =>
    error instanceof CoreError && error.code === "INTERNAL_ERROR");
  paths.forEach((path, index) => writeFileSync(path, originals[index]!));
  const overlapping = JSON.parse(originals[0]!);
  overlapping.input_files = [{ path: "result.json", bytes: 0, source_sha256: "0".repeat(64) }];
  writeFileSync(paths[0]!, JSON.stringify(overlapping));
  await assert.rejects(new CollaborationRunService(state, registry).load(), (error: unknown) =>
    error instanceof CoreError && error.code === "INTERNAL_ERROR");
});
