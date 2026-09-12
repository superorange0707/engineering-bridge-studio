import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import type { SerializedError } from "../../../src/core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { DshExecutor } from "../../../src/executors/dsh-executor.js";
import {
  boundExecutorEvidence,
  MAX_EXECUTOR_EVIDENCE_BYTES,
  MAX_EXECUTOR_EVIDENCE_CHANGES,
  MAX_EXECUTOR_EVIDENCE_ID_OR_STATUS,
  MAX_EXECUTOR_EVIDENCE_ITEMS,
  MAX_EXECUTOR_EVIDENCE_TEXT,
  RegisteredWorkspaceTaskService,
  validateExecutorEvidence
} from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";

function registry(): RegisteredWorkspaceRegistry {
  return new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Runs the real DshExecutor against a scripted child process, so interrupt
// tests observe the actual partial-stdout caching path.
function dshHarness(): {
  service: RegisteredWorkspaceTaskService;
  write: (chunk: string) => void;
  close: (code: number | null) => void;
} {
  let emitWrite: ((chunk: string) => void) | undefined;
  let emitClose: ((code: number | null) => void) | undefined;
  const service = new RegisteredWorkspaceTaskService(registry(), (executor, workspaceRoot) => {
    assert.equal(executor, "dsh");
    assert.equal(workspaceRoot, ROOT);
    return new DshExecutor(ROOT, () => {
      const child = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        killed: false,
        kill(signal?: string) {
          this.killed = true;
          return true;
        }
      });
      emitWrite = (chunk) => { stdout.write(chunk); };
      emitClose = (code) => {
        stdout.end();
        stderr.end();
        child.emit("close", code, null);
      };
      return child as unknown as ChildProcessWithoutNullStreams;
    });
  });
  return {
    service,
    write: (chunk) => emitWrite?.(chunk),
    close: (code) => emitClose?.(code)
  };
}

async function waitForTerminal(service: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (service.status(taskId)?.state === "queued" || service.status(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForInteractiveReady(service: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("returns immediately and exposes queued/running without a result", async () => {
  const pending = deferred<ExecutorResult>();
  const calls: ExecutorRequest[] = [];
  const executor: Executor = { execute: (request) => { calls.push(request); return pending.promise; } };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  assert.deepEqual(service.status(taskId), { taskId, state: "queued" });
  assert.equal(service.result(taskId), undefined);
  await Promise.resolve();
  assert.deepEqual(service.status(taskId), { taskId, state: "running" });
  assert.equal(service.result(taskId), undefined);
  assert.equal(calls[0]?.taskId, taskId);
  pending.resolve({ kind: "completed", output: "done" });
  await waitForTerminal(service, taskId);
});

test("defaults Codex to auto routing and rejects Codex routing fields for DSH", () => {
  let factories = 0;
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    factories += 1;
    throw new Error("must not create an executor");
  });
  const implicit = service.startTask({ workspace_id: "known", instruction: "inspect" });
  const explicit = service.startTask({ workspace_id: "known", instruction: "inspect", executor: "codex" });
  assert.equal(service.taskView(implicit.taskId)?.routing, "auto");
  assert.equal(service.taskView(implicit.taskId)?.logicalRole, "local_lead");
  assert.equal(service.taskView(explicit.taskId)?.logicalRole, "local_lead");
  assert.throws(() => service.startTask({
    workspace_id: "known", instruction: "inspect", executor: "dsh", routing: "local_lead"
  }), (error: unknown) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(factories, 0);
});

test("taskView polls a legacy runTask through completed output", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  assert.deepEqual(service.taskView(taskId), { taskId, state: "queued", executor: "codex",
    routing: "local_lead", logicalRole: "local_lead", routingReason: "explicit_override",
    model: "gpt-5.6-terra", reasoningEffort: "max", ready: false });
  await Promise.resolve();
  assert.deepEqual(service.taskView(taskId), { taskId, state: "running", executor: "codex",
    routing: "local_lead", logicalRole: "local_lead", routingReason: "explicit_override",
    model: "gpt-5.6-terra", reasoningEffort: "max", ready: false });

  pending.resolve({ kind: "completed", output: "proposal diff" });
  await waitForTerminal(service, taskId);

  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "completed",
    executor: "codex",
    routing: "local_lead",
    logicalRole: "local_lead",
    routingReason: "explicit_override",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    ready: true,
    output: "proposal diff"
  });
});

test("records completed output and preserves the instruction", async () => {
  const calls: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => { calls.push(request); return { kind: "completed", output: "exact output\n\n" }; }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const instruction = "  exact instruction\nwith bytes $()  ";
  const { taskId } = service.runTask({ workspace_id: "known", instruction, routing: "local_lead" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(calls, [{ taskId, instruction, sandbox: "read-only", logicalRole: "local_lead" }]);
  assert.deepEqual(service.status(taskId), { taskId, state: "completed" });
  assert.deepEqual(service.result(taskId), { id: taskId, state: "completed", output: "exact output\n\n" });
});

test("legacy controlled-task results preserve only executor-produced bounded evidence", async () => {
  const evidence = [{
    id: "command-1",
    type: "commandExecution" as const,
    status: "completed",
    command: "inspect README.md and package.json"
  }];
  let terminalEvidence: unknown;
  const executor: Executor = {
    execute: async () => ({ kind: "completed", output: "proposal", evidence })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "inspect", routing: "local_lead" },
    undefined,
    (result) => { terminalEvidence = result.evidence; }
  );

  await waitForTerminal(service, taskId);

  assert.equal(terminalEvidence, evidence);
  assert.deepEqual(terminalEvidence, evidence);
  assert.equal(JSON.stringify(terminalEvidence), JSON.stringify(evidence));
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "completed",
    output: "proposal",
    evidence
  });
  assert.deepEqual(service.taskView(taskId)?.evidence, evidence);
});

test("legacy and interactive task results enforce one aggregate evidence byte ceiling", async () => {
  const evidence = Array.from({ length: 50 }, (_, index) => ({
    id: `command-${index}`,
    type: "commandExecution" as const,
    status: "completed",
    command: "inspect",
    result: { state: "complete" as const, exit_code: 0, output: "x".repeat(16_384) }
  }));
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "done", evidence }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const legacy = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });
  await waitForTerminal(service, legacy.taskId);
  const retained = service.result(legacy.taskId)?.evidence;
  assert.ok(retained);
  assert.ok(Buffer.byteLength(JSON.stringify(retained), "utf8") <= MAX_EXECUTOR_EVIDENCE_BYTES);
  assert.equal(retained.at(-1)?.id, "evidence-aggregate-drop");

  const interactive = service.startTask({
    workspace_id: "known", instruction: "inspect", routing: "local_lead"
  });
  await waitForInteractiveReady(service, interactive.taskId);
  const exposed = service.taskView(interactive.taskId)?.evidence;
  assert.ok(exposed);
  assert.ok(Buffer.byteLength(JSON.stringify(exposed), "utf8") <= MAX_EXECUTOR_EVIDENCE_BYTES);
  assert.equal(exposed.at(-1)?.id, "evidence-aggregate-drop");
});

test("live evidence is structurally bounded before task exposure", async () => {
  const evidence = [{
    id: "command-oversize",
    type: "commandExecution" as const,
    status: "completed",
    command: "x".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1),
    result: { state: "complete" as const, exit_code: 0,
      output: "z".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1) }
  }, {
    id: "change-oversize",
    type: "fileChange" as const,
    status: "completed",
    changes: [{ path: "README.md", diff: "y".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1) }]
  }];
  const service = new RegisteredWorkspaceTaskService(registry(), () => ({
    execute: async () => ({ kind: "completed", output: "done", evidence })
  }));
  const { taskId } = service.startTask({
    workspace_id: "known", instruction: "inspect", routing: "local_lead"
  });
  await waitForInteractiveReady(service, taskId);

  const exposed = service.taskView(taskId)?.evidence;
  assert.equal(exposed?.[0]?.command?.length, MAX_EXECUTOR_EVIDENCE_TEXT);
  assert.match(exposed?.[0]?.command ?? "", /\[truncated\]$/u);
  assert.equal(exposed?.[0]?.result?.state, "truncated");
  assert.equal(exposed?.[0]?.result?.output?.length, MAX_EXECUTOR_EVIDENCE_TEXT);
  assert.match(exposed?.[0]?.result?.output ?? "", /\[truncated\]$/u);
  assert.equal(exposed?.[1]?.changes?.[0]?.diff.length, MAX_EXECUTOR_EVIDENCE_TEXT);
  assert.match(exposed?.[1]?.changes?.[0]?.diff ?? "", /\[truncated\]$/u);
});

test("the shared evidence contract bounds item, change, id, and status structure", () => {
  const tooManyItems = Array.from({ length: MAX_EXECUTOR_EVIDENCE_ITEMS + 1 }, (_, index) => ({
    id: `command-${index}`,
    type: "commandExecution" as const,
    status: "completed",
    command: "ok"
  }));
  const boundedItems = boundExecutorEvidence(tooManyItems);
  assert.equal(boundedItems?.length, MAX_EXECUTOR_EVIDENCE_ITEMS);
  assert.equal(boundedItems?.at(-1)?.id, "evidence-structure-drop");

  const boundedChanges = boundExecutorEvidence([{
    id: "changes",
    type: "fileChange",
    status: "completed",
    changes: Array.from({ length: MAX_EXECUTOR_EVIDENCE_CHANGES + 1 }, (_, index) => ({
      path: `file-${index}.txt`, diff: "ok"
    }))
  }]);
  assert.equal(boundedChanges?.[0]?.changes?.length, MAX_EXECUTOR_EVIDENCE_CHANGES);
  assert.equal(boundedChanges?.[0]?.changes?.at(-1)?.path, "[truncated]");

  const invalidIdentity = boundExecutorEvidence([{
    id: "x".repeat(MAX_EXECUTOR_EVIDENCE_ID_OR_STATUS + 1),
    type: "commandExecution",
    status: "completed",
    command: "ok"
  }, {
    id: "command-status",
    type: "commandExecution",
    status: "x".repeat(MAX_EXECUTOR_EVIDENCE_ID_OR_STATUS + 1),
    command: "ok"
  }]);
  assert.equal(invalidIdentity?.[0]?.id, "evidence-structure-drop");
  assert.match(invalidIdentity?.[0]?.command ?? "", /^2 evidence item\(s\) dropped/u);
  assert.ok(validateExecutorEvidence(boundedItems));
  assert.ok(validateExecutorEvidence(boundedChanges));
  assert.ok(validateExecutorEvidence(invalidIdentity));
});

test("the shared result contract enforces text safety and parent status/exit-code consistency", () => {
  const unsafeLive = boundExecutorEvidence([{
    id: "unsafe-output",
    type: "commandExecution",
    status: "completed",
    command: "inspect",
    result: { state: "complete", exit_code: 0, output: "unsafe\u001b[31m" }
  }]);
  assert.deepEqual(unsafeLive, [{
    id: "unsafe-output",
    type: "commandExecution",
    status: "completed",
    command: "inspect",
    result: { state: "withheld", exit_code: 0, reason: "unsafe_output" }
  }]);

  assert.equal(validateExecutorEvidence([{
    id: "oversize-result",
    type: "commandExecution",
    status: "completed",
    command: "inspect",
    result: { state: "complete", exit_code: 0, output: "x".repeat(MAX_EXECUTOR_EVIDENCE_TEXT + 1) }
  }]), undefined);
  assert.equal(validateExecutorEvidence([{
    id: "malformed-result",
    type: "commandExecution",
    status: "completed",
    command: "inspect",
    result: { state: "withheld", output: "must not coexist", reason: "secret_risk" }
  }]), undefined);

  const inconsistent = [{
    id: "failed-complete",
    type: "commandExecution" as const,
    status: "failed",
    command: "inspect",
    result: { state: "complete" as const, exit_code: 0, output: "must not escape" }
  }, {
    id: "nonzero-complete",
    type: "commandExecution" as const,
    status: "completed",
    command: "inspect",
    result: { state: "complete" as const, exit_code: 1, output: "must not escape" }
  }, {
    id: "declined-truncated",
    type: "commandExecution" as const,
    status: "declined",
    command: "inspect",
    result: { state: "truncated" as const, exit_code: 0, output: "must not escape\n[truncated]" }
  }];
  assert.deepEqual(boundExecutorEvidence(inconsistent), inconsistent.map(({ id, status, command, result }) => ({
    id, type: "commandExecution", status, command,
    result: { state: "withheld", exit_code: result.exit_code, reason: "non_success" }
  })));
  for (const item of inconsistent) assert.equal(validateExecutorEvidence([item]), undefined);

  const valid = [{
    id: "completed-success",
    type: "commandExecution" as const,
    status: "completed",
    command: "inspect",
    result: { state: "complete" as const, exit_code: 0, output: "safe output" }
  }];
  assert.deepEqual(validateExecutorEvidence(valid), valid);
});

test("applies a completed-output transform exactly once before storing the result", async () => {
  let transforms = 0;
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "raw" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "inspect", routing: "local_lead" },
    (output) => { transforms += 1; return `${output}-transformed`; }
  );

  await waitForTerminal(service, taskId);

  assert.equal(transforms, 1);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "completed",
    output: "raw-transformed"
  });
  assert.equal(transforms, 1);
});

test("awaits a terminal handler exactly once before exposing completed output", async () => {
  const release = deferred<void>();
  let handlerCalls = 0;
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "done" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "inspect", routing: "local_lead" },
    undefined,
    async (result) => {
      handlerCalls += 1;
      assert.equal(result.state, "completed");
      await release.promise;
    }
  );

  while (handlerCalls === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(handlerCalls, 1);
  assert.deepEqual(service.status(taskId), { taskId, state: "running" });
  assert.equal(service.result(taskId), undefined);

  release.resolve(undefined);
  await waitForTerminal(service, taskId);

  assert.equal(handlerCalls, 1);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "completed",
    output: "done"
  });
});

test("records executor failures", async () => {
  const error: SerializedError = {
    code: "CODEX_EXECUTION_FAILED",
    message: "Codex execution failed."
  };
  const executor: Executor = { execute: async () => ({ kind: "failed", error }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), { id: taskId, state: "failed", error });
});

test("records an interrupted legacy task as an execution failure", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed."
    },
    partial_output: "partial"
  });
});

test("records an interrupted DSH legacy task as DSH_EXECUTION_FAILED", async () => {
  let executorName: "codex" | "dsh" | undefined;
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), (name) => {
    executorName = name;
    return executor;
  });
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  await waitForTerminal(service, taskId);

  assert.equal(executorName, "dsh");
  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "DSH_EXECUTION_FAILED",
      message: "DSH execution failed."
    },
    partial_output: "partial"
  });
});

test("an interrupted legacy task without any partial output omits the field", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed."
    }
  });
});

test("records an interrupted interactive task as an execution failure without review output", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "codex",
    routing: "local_lead",
    logicalRole: "local_lead",
    routingReason: "explicit_override",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    ready: true,
    evidence: [],
    partial_output: "partial",
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed."
    }
  });
});

test("records an interrupted DSH interactive task as DSH_EXECUTION_FAILED", async () => {
  let executorName: "codex" | "dsh" | undefined;
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), (name) => {
    executorName = name;
    return executor;
  });
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(executorName, "dsh");
  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    partial_output: "partial",
    error: {
      code: "DSH_EXECUTION_FAILED",
      message: "DSH execution failed."
    }
  });
});

test("an interrupted interactive task without any partial output omits the field", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });
  await waitForInteractiveReady(service, taskId);

  const view = service.taskView(taskId);
  assert.ok(view);
  assert.equal(view.state, "failed");
  assert.equal("partial_output" in view, false);
  assert.deepEqual(view.error, {
    code: "CODEX_EXECUTION_FAILED",
    message: "Codex execution failed."
  });
});

test("control_task interrupt reaches the DSH executor with SIGTERM", async () => {
  const signals: string[] = [];
  let emitClose: ((code: number | null) => void) | undefined;
  const service = new RegisteredWorkspaceTaskService(registry(), (executor, workspaceRoot) => {
    assert.equal(executor, "dsh");
    assert.equal(workspaceRoot, ROOT);
    return new DshExecutor(ROOT, () => {
      const child = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        killed: false,
        kill(signal?: string) {
          this.killed = true;
          signals.push(signal ?? "SIGTERM");
          return true;
        }
      });
      emitClose = (code) => {
        stdout.end();
        stderr.end();
        child.emit("close", code, null);
      };
      return child as unknown as ChildProcessWithoutNullStreams;
    });
  });
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const view = await service.controlTask(taskId, "interrupt");
  assert.equal(view.state, "running");
  assert.deepEqual(signals, ["SIGTERM"]);

  emitClose?.(0);
  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    error: {
      code: "DSH_EXECUTION_FAILED",
      message: "DSH execution failed."
    }
  });
});

test("DSH interrupt keeps the cached partial stdout as partial_output on the failed view", async () => {
  const harness = dshHarness();
  const { taskId } = harness.service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (harness.service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  harness.write("partial answer");
  await harness.service.controlTask(taskId, "interrupt");
  harness.close(7);

  while (harness.service.taskView(taskId)?.state === "queued" || harness.service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(harness.service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    partial_output: "partial answer",
    error: {
      code: "DSH_EXECUTION_FAILED",
      message: "DSH execution failed."
    }
  });
});

test("DSH interrupt before any stdout omits partial_output", async () => {
  const harness = dshHarness();
  const { taskId } = harness.service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (harness.service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await harness.service.controlTask(taskId, "interrupt");
  harness.close(0);

  while (harness.service.taskView(taskId)?.state === "queued" || harness.service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const view = harness.service.taskView(taskId);
  assert.ok(view);
  assert.equal("partial_output" in view, false);
  assert.deepEqual(view, {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    error: {
      code: "DSH_EXECUTION_FAILED",
      message: "DSH execution failed."
    }
  });
});

test("a DSH failure without interrupt exposes neither partial output nor stdout", async () => {
  const harness = dshHarness();
  const { taskId } = harness.service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (harness.service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  harness.write("secret partial");
  harness.close(7);

  while (harness.service.taskView(taskId)?.state === "queued" || harness.service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const view = harness.service.taskView(taskId);
  assert.ok(view);
  assert.deepEqual(view, {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    error: {
      code: "DSH_EXECUTION_FAILED",
      message: "DSH execution failed."
    }
  });
  assert.equal(JSON.stringify(view).includes("secret partial"), false);
});

test("taskView exposes the native Codex thread id once one exists and keeps it after accept", async () => {
  const executor: Executor = {
    execute: async () => ({ kind: "completed", output: "done", threadId: "thread-1" })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const view = service.taskView(taskId);
  assert.equal(view?.executor, "codex");
  assert.equal(view?.threadId, "thread-1");

  await service.controlTask(taskId, "accept");
  assert.equal(service.taskView(taskId)?.executor, "codex");
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");
});

test("continue preserves the same native Codex thread id and passes it to the resumed turn", async () => {
  const requests: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => {
      requests.push(request);
      return { kind: "completed", output: `out:${request.instruction}`, threadId: "thread-1" };
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "first", routing: "local_lead" });
  await waitForInteractiveReady(service, taskId);
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");

  await service.controlTask(taskId, "continue", "second");
  await waitForInteractiveReady(service, taskId);

  assert.deepEqual(requests.map(({ threadId }) => threadId), [undefined, "thread-1"]);
  assert.deepEqual(requests.map(({ logicalRole }) => logicalRole), ["local_lead", "local_lead"]);
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");
});

test("cross-role routing creates a linked new task without reusing the parent native thread", async () => {
  const requests: ExecutorRequest[] = [];
  const service = new RegisteredWorkspaceTaskService(registry(), () => ({
    execute: async (request) => {
      requests.push(request);
      return {
        kind: "completed",
        output: "done",
        threadId: request.logicalRole === "implementer" ? "thread-parent" : "thread-child"
      };
    }
  }));
  const parent = service.startTask({
    workspace_id: "known",
    instruction: "Fix the one parser test",
    routing: "implementer"
  });
  await waitForInteractiveReady(service, parent.taskId);

  const snapshot = {
    objective: "Resolve the architectural blocker",
    current_state: "The bounded implementation exposed a cross-module invariant",
    changed_files: ["src/parser.ts"],
    test_status: "Parser test still failing"
  };
  const child = service.startTask({
    workspace_id: "known",
    instruction: "Review the architecture and decide the safe fix",
    routing: "repo_principal",
    parent_task_id: parent.taskId,
    handoff_snapshot: snapshot
  });
  await waitForInteractiveReady(service, child.taskId);

  const childView = service.taskView(child.taskId);
  assert.equal(childView?.parentTaskId, parent.taskId);
  assert.equal(childView?.routingTransition, "escalation");
  assert.deepEqual(childView?.handoffSnapshot, snapshot);
  assert.equal(requests[1]?.threadId, undefined);
  assert.equal(requests[1]?.logicalRole, "repo_principal");
  assert.match(requests[1]?.instruction ?? "", /cross-module invariant/);
});

test("a linked task fails before creation without both a known parent and bounded snapshot", async () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => ({
    execute: async () => ({ kind: "completed", output: "done" })
  }));
  const unknownParent = "00000000-0000-4000-8000-000000000001";
  assert.throws(() => service.startTask({
    workspace_id: "known", instruction: "continue", parent_task_id: unknownParent
  }), (error: unknown) => error instanceof CoreError && error.code === "INVALID_HANDOFF_SNAPSHOT");
  assert.throws(() => service.startTask({
    workspace_id: "known",
    instruction: "continue",
    parent_task_id: unknownParent,
    handoff_snapshot: { objective: "continue", current_state: "known" }
  }), (error: unknown) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("steer and accept preserve the recorded Codex role", async () => {
  const pending = deferred<ExecutorResult>();
  const steers: string[] = [];
  const executor: Executor = {
    execute: () => pending.promise,
    steer: async (instruction) => { steers.push(instruction); }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({
    workspace_id: "known", instruction: "inspect", executor: "codex", routing: "repo_principal"
  });
  while (service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await service.controlTask(taskId, "steer", "focus on safety");
  assert.deepEqual(steers, ["focus on safety"]);
  assert.equal(service.taskView(taskId)?.logicalRole, "repo_principal");

  pending.resolve({ kind: "completed", output: "done", threadId: "thread-sol" });
  await waitForInteractiveReady(service, taskId);
  await service.controlTask(taskId, "accept");
  assert.equal(service.taskView(taskId)?.logicalRole, "repo_principal");
  assert.equal(service.taskView(taskId)?.model, "gpt-5.6-sol");
  assert.equal(service.taskView(taskId)?.reasoningEffort, "max");
});

test("DSH taskView reports executor dsh without fabricating a thread id, across continue", async () => {
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "done" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), (name) => {
    assert.equal(name, "dsh");
    return executor;
  });
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "first", executor: "dsh" });
  await waitForInteractiveReady(service, taskId);

  assert.equal(service.taskView(taskId)?.executor, "dsh");
  assert.equal(service.taskView(taskId)?.threadId, undefined);

  await service.controlTask(taskId, "continue", "second");
  await waitForInteractiveReady(service, taskId);

  assert.equal(service.taskView(taskId)?.executor, "dsh");
  assert.equal(service.taskView(taskId)?.threadId, undefined);
});

test("thread id is omitted while the native thread does not exist yet", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  while (service.taskView(taskId)?.state !== "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(taskId)?.executor, "codex");
  assert.equal(service.taskView(taskId)?.threadId, undefined);

  pending.resolve({ kind: "completed", output: "done", threadId: "thread-1" });
  await waitForInteractiveReady(service, taskId);
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");
});

test("taskView exposes a validated native thread while its turn is still running", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = {
    execute: (request) => {
      request.onThreadStarted?.("thread-early");
      return pending.promise;
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  while (service.taskView(taskId)?.state !== "running" || service.taskView(taskId)?.threadId === undefined) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(taskId)?.ready, false);
  assert.equal(service.taskView(taskId)?.threadId, "thread-early");

  pending.resolve({ kind: "completed", output: "done", threadId: "thread-early" });
  await waitForInteractiveReady(service, taskId);
  assert.equal(service.taskView(taskId)?.threadId, "thread-early");
});

test("DSH cannot fabricate an early native thread id", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = {
    execute: (request) => {
      assert.equal(request.onThreadStarted, undefined);
      return pending.promise;
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (service.taskView(taskId)?.state !== "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(taskId)?.threadId, undefined);
  pending.resolve({ kind: "completed", output: "done" });
  await waitForInteractiveReady(service, taskId);
});

test("legacy controlled-patch taskView retains the native Codex thread id", async () => {
  const executor: Executor = {
    execute: async () => ({ kind: "completed", output: "diff", threadId: "thread-9" })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });
  await waitForTerminal(service, taskId);

  const view = service.taskView(taskId);
  assert.equal(view?.executor, "codex");
  assert.equal(view?.threadId, "thread-9");
});

test("control_task interrupt reaches a running legacy controlled-proposal executor and terminalizes it", async () => {
  let finish!: (result: ExecutorResult) => void;
  let interrupts = 0;
  const pending = new Promise<ExecutorResult>((resolve) => { finish = resolve; });
  const executor: Executor = {
    execute: () => pending,
    interrupt: async () => {
      interrupts += 1;
      finish({ kind: "interrupted", output: "bounded partial" });
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({
    workspace_id: "known", instruction: "proposal", routing: "local_lead"
  });
  while (service.taskView(taskId)?.state !== "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal((await service.controlTask(taskId, "interrupt")).state, "running");
  await waitForTerminal(service, taskId);

  assert.equal(interrupts, 1);
  assert.equal(service.taskView(taskId)?.state, "failed");
  assert.equal(service.taskView(taskId)?.partial_output, "bounded partial");
  await assert.rejects(service.controlTask(taskId, "continue", "retry"), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  await assert.rejects(service.controlTask(taskId, "accept"), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("interactive execution remains read-only when workspace writes are allowed", async () => {
  const calls: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => { calls.push(request); return { kind: "completed", output: "done" }; }
  };
  const writableRegistry = new RegisteredWorkspaceRegistry([
    { id: "known", root: ROOT, allow_write: true }
  ]);
  const service = new RegisteredWorkspaceTaskService(writableRegistry, () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sandbox, "read-only");
});

test("normalizes and fixes the executor selection for each interactive task", async () => {
  const calls: Array<{
    executor: "codex" | "dsh";
    workspaceRoot: string;
    instruction: string;
  }> = [];
  const service = new RegisteredWorkspaceTaskService(registry(), (executor, workspaceRoot) => ({
    execute: async (request) => {
      calls.push({ executor, workspaceRoot, instruction: request.instruction });
      return { kind: "completed", output: `${executor}:${request.instruction}` };
    }
  }));

  const omitted = service.startTask({ workspace_id: "known", instruction: "default", routing: "local_lead" });
  await waitForInteractiveReady(service, omitted.taskId);
  assert.equal(service.taskView(omitted.taskId)?.review_output, "codex:default");

  const explicitCodex = service.startTask({
    workspace_id: "known",
    instruction: "explicit", routing: "local_lead",
    executor: "codex"
  });
  await waitForInteractiveReady(service, explicitCodex.taskId);
  assert.equal(service.taskView(explicitCodex.taskId)?.review_output, "codex:explicit");

  const dsh = service.startTask({
    workspace_id: "known",
    instruction: "first",
    executor: "dsh"
  });
  await waitForInteractiveReady(service, dsh.taskId);
  assert.equal(service.taskView(dsh.taskId)?.review_output, "dsh:first");

  await service.controlTask(dsh.taskId, "continue", "second");
  await waitForInteractiveReady(service, dsh.taskId);
  assert.equal(service.taskView(dsh.taskId)?.review_output, "dsh:second");

  await service.controlTask(dsh.taskId, "accept");
  assert.equal(service.taskView(dsh.taskId)?.output, "dsh:second");
  assert.deepEqual(calls, [
    { executor: "codex", workspaceRoot: ROOT, instruction: "default" },
    { executor: "codex", workspaceRoot: ROOT, instruction: "explicit" },
    { executor: "dsh", workspaceRoot: ROOT, instruction: "first" },
    { executor: "dsh", workspaceRoot: ROOT, instruction: "second" }
  ]);
});

test("records an unknown workspace asynchronously without creating an executor", async () => {
  let factories = 0;
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    factories += 1;
    throw new Error("must not run");
  });
  const { taskId } = service.runTask({ workspace_id: "unknown", instruction: "inspect", routing: "local_lead" });

  assert.deepEqual(service.status(taskId), { taskId, state: "queued" });
  await waitForTerminal(service, taskId);

  assert.equal(factories, 0);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered."
    }
  });
});

test("returns undefined for invalid and unknown task ids", () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    throw new Error("must not run");
  });

  for (const taskId of [undefined, null, "invalid", "00000000-0000-4000-8000-000000000000"]) {
    assert.equal(service.status(taskId), undefined);
    assert.equal(service.result(taskId), undefined);
  }
});

test("only exposes supported states", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", routing: "local_lead" });
  const states = new Set<string>();

  states.add(service.status(taskId)!.state);

  await Promise.resolve();
  states.add(service.status(taskId)!.state);

  pending.resolve({ kind: "completed", output: "done" });
  await waitForTerminal(service, taskId);
  states.add(service.status(taskId)!.state);

  for (const state of states) assert.ok(["queued", "running", "completed", "failed"].includes(state));
});

test("retains only the newest 100 terminal records without evicting live task states", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = {
    execute: async (request) => request.instruction === "hold"
      ? pending.promise
      : { kind: "completed", output: "done" }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const queuedTaskId = "00000000-0000-4000-8000-000000000001";
  (service as unknown as { tasks: Map<string, { state: "queued" }> }).tasks.set(queuedTaskId, { state: "queued" });

  const { taskId: runningTaskId } = service.startTask({ workspace_id: "known", instruction: "hold", routing: "local_lead" });
  while (service.taskView(runningTaskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(runningTaskId)?.state, "running");

  const { taskId: reviewTaskId } = service.startTask({ workspace_id: "known", instruction: "review", routing: "local_lead" });
  while (["queued", "running"].includes(service.taskView(reviewTaskId)?.state ?? "")) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");

  const legacyTaskIds = Array.from({ length: 101 }, () =>
    service.runTask({ workspace_id: "known", instruction: "legacy", routing: "local_lead" }).taskId
  );
  await Promise.all(legacyTaskIds.map((taskId) => waitForTerminal(service, taskId)));
  assert.equal(service.status(legacyTaskIds[0]!), undefined);
  for (const taskId of legacyTaskIds.slice(1)) assert.equal(service.status(taskId)?.state, "completed");
  assert.equal(service.status(queuedTaskId)?.state, "queued");
  assert.equal(service.taskView(runningTaskId)?.state, "running");
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");

  const interactiveTaskIds: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    const { taskId } = service.startTask({ workspace_id: "known", instruction: "interactive", routing: "local_lead" });
    while (["queued", "running"].includes(service.taskView(taskId)?.state ?? "")) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await service.controlTask(taskId, "accept");
    interactiveTaskIds.push(taskId);
  }

  assert.equal(service.taskView(interactiveTaskIds[0]!), undefined);
  for (const taskId of interactiveTaskIds.slice(1)) assert.equal(service.taskView(taskId)?.state, "completed");
  assert.equal(service.status(queuedTaskId)?.state, "queued");
  assert.equal(service.taskView(runningTaskId)?.state, "running");
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");
});
