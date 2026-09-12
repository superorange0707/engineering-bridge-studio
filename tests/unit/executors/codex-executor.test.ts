import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import { isId } from "../../../src/core/ids.js";
import { CodexExecutor, probeCodexCapabilities } from "../../../src/executors/codex-executor.js";
import type { ProcessStarter } from "../../../src/executors/codex-executor.js";
import type { ExecutorEvidence } from "../../../src/executors/executor.js";
import { DEFAULT_CODEX_MODEL_REGISTRY } from "../../../src/executors/codex-model-registry.js";
import { VERSION } from "../../../src/version.js";

const TASK_ID_VALUE = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(TASK_ID_VALUE)) throw new Error("Test task ID must be a UUID v4.");
const TASK_ID = TASK_ID_VALUE;
const TRUSTED_CWD = "/trusted/workspace";

interface Invocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  stdin: string;
  killed?: boolean;
  send(message: unknown): void;
}

interface FakeBehavior {
  appServerOutput?: string;
  turnError?: { message: string; codexErrorInfo?: string; additionalDetails?: string };
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  processError?: boolean;
  autoComplete?: boolean;
  keepAliveUntilKilled?: boolean;
  modelList?: unknown;
  threadModel?: string;
}

const MODEL_LIST = {
  data: ["implementer", "local_lead", "repo_principal"].map((role) => ({
    model: DEFAULT_CODEX_MODEL_REGISTRY[role as keyof typeof DEFAULT_CODEX_MODEL_REGISTRY].model,
    supportedReasoningEfforts: [{ reasoningEffort: "max" }]
  }))
};

function fakeStarter(behavior: FakeBehavior, invocations: Invocation[]): ProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let keepAlive: NodeJS.Timeout | undefined;
    if (behavior.keepAliveUntilKilled) keepAlive = setInterval(() => undefined, 1_000);
    const stopKeepAlive = (): void => {
      if (keepAlive === undefined) return;
      clearInterval(keepAlive);
      keepAlive = undefined;
    };
    const invocation: Invocation = {
      executable, args: [...args], options, stdin: "",
      send(message) { stdout.write(`${JSON.stringify(message)}\n`); }
    };
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        invocation.stdin += chunk.toString();
        if (behavior.appServerOutput !== undefined) {
          const message = JSON.parse(chunk.toString()) as {
            id?: number;
            method: string;
            params?: Record<string, unknown>;
          };
          if (message.id !== undefined) {
            let result: unknown = {};
            if (message.method === "initialize") result = { userAgent: "engineering-bridge/0.148.0 (test)" };
            if (message.method === "model/list") result = behavior.modelList ?? MODEL_LIST;
            if (message.method === "thread/start" || message.method === "thread/resume") {
              result = { thread: { id: "thread-1" }, model: behavior.threadModel ?? message.params?.model };
            }
            if (message.method === "turn/start") result = { turn: { id: "turn-1" } };
            queueMicrotask(() => {
              stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
              if (message.method === "turn/start" && behavior.autoComplete !== false) {
                stdout.write(`${JSON.stringify({ method: "item/completed", params: { item: { id: "message-1", type: "agentMessage", text: behavior.appServerOutput } } })}\n`);
                const status = behavior.turnError ? "failed" : "completed";
                stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status, error: behavior.turnError } } })}\n`);
              }
            });
          }
        }
        callback();
      }
    });
    invocations.push(invocation);
    Object.assign(child, { stdin, stdout, stderr, killed: false, kill() {
      stopKeepAlive();
      this.killed = true;
      invocation.killed = true;
      return true;
    } });

    queueMicrotask(() => {
      if (behavior.appServerOutput !== undefined) return;
      stopKeepAlive();
      if (behavior.processError === true) {
        child.emit("error", new Error("secret process error"));
        return;
      }
      stdout.end(behavior.stdout ?? "");
      stderr.end(behavior.stderr ?? "");
      child.emit("close", behavior.exitCode ?? 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

async function evidenceRun(
  workspaceRoot: string,
  onEvidence?: (evidence: readonly ExecutorEvidence[]) => void
): Promise<{ invocation: Invocation; pending: ReturnType<CodexExecutor["execute"]> }> {
  const invocations: Invocation[] = [];
  const pending = new CodexExecutor(
    workspaceRoot,
    fakeStarter({ appServerOutput: "", autoComplete: false }, invocations),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead",
    ...(onEvidence === undefined ? {} : { onEvidence }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  return { invocation, pending };
}

function completeEvidenceRun(invocation: Invocation): void {
  invocation.send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });
}

test("uses the fixed safe invocation and returns agent text", async () => {
  const invocations: Invocation[] = [];
  const hostEnvironment = {
    PATH: "/bin",
    HOME: "/home/test",
    CODEX_HOME: "/codex/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    USER: "tester",
    LOGNAME: "tester-log",
    OPENAI_API_KEY: "secret-api-key",
    HTTP_PROXY: "secret-proxy",
    SSH_AUTH_SOCK: "secret-ssh",
    EMPTY_ALLOWED: ""
  };
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({
    appServerOutput: "final answer"
  }, invocations), hostEnvironment);
  const instruction = "  exact prompt\nwith $() and `quotes`  ";

  const result = await executor.execute({ taskId: TASK_ID, instruction, logicalRole: "local_lead" });
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "final answer");
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(invocation.options.env, {
    PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex/test", TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8", LC_ALL: "C", USER: "tester", LOGNAME: "tester-log",
    ENGINEERING_BRIDGE_EXECUTOR_CHILD: "1"
  });
  const messages = invocation.stdin.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages[0], { id: 1, method: "initialize", params: { clientInfo: { name: "engineering-bridge", version: VERSION } } });
  assert.deepEqual(messages[1], { method: "initialized", params: {} });
  assert.deepEqual(messages[2], { id: 2, method: "model/list", params: { includeHidden: true, limit: 100 } });
  assert.deepEqual(messages[3], { id: 3, method: "thread/start", params: {
    cwd: TRUSTED_CWD, approvalPolicy: "never", sandbox: "read-only",
    model: "gpt-5.6-terra", serviceName: "engineering-bridge-auto-router"
  } });
  assert.deepEqual(messages[4], { id: 4, method: "turn/start", params: {
    threadId: "thread-1", input: [{ type: "text", text: instruction }], cwd: TRUSTED_CWD,
    approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
    model: "gpt-5.6-terra", effort: "max", summary: "concise"
  } });
  assert.equal(invocation.args.includes(instruction), false);
});

test("unrelated thread and turn completion cannot accept an executor run", async () => {
  const { invocation, pending } = await evidenceRun(TRUSTED_CWD);
  let completed = false;
  void pending.then(() => { completed = true; });
  invocation.send({ method: "turn/completed", params: { threadId: "other-thread", turn: { id: "turn-1", status: "completed" } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "old-turn", status: "completed" } } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  completeEvidenceRun(invocation);
  assert.equal((await pending).kind, "completed");
});

test("unsupported reverse RPC fails without granting a tool or approval", async () => {
  const { invocation, pending } = await evidenceRun(TRUSTED_CWD);
  invocation.send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "unexpected" } });
  const result = await pending;
  assert.equal(result.kind, "failed");
  assert.ok(invocation.stdin.includes("Unsupported executor request"));
  assert.equal(invocation.stdin.includes('"decision":"accept"'), false);
});

test("the JSONL frame limit counts UTF-8 bytes before parsing complete frames", async () => {
  const invocations: Invocation[] = [];
  // 22M UTF-16 code units are below the limit, but their UTF-8 bytes exceed it.
  const result = await new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "中".repeat(22 * 1024 * 1024) }, invocations), {})
    .execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, "CODEX_PROTOCOL_ERROR");
  assert.equal(invocations[0]?.killed, true);
});

test("isolated execution excludes shared temporary directories from writable roots", async () => {
  const invocations: Invocation[] = [];
  const result = await new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "done" }, invocations), {}).execute({
    taskId: TASK_ID, instruction: "run an experiment", logicalRole: "implementer", sandbox: "workspace-write"
  });
  assert.equal(result.kind, "completed");
  const messages = invocations[0]!.stdin.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.find((message) => message.method === "thread/start").params.sandbox, "workspace-write");
  assert.deepEqual(messages.find((message) => message.method === "turn/start").params.sandboxPolicy, {
    type: "workspaceWrite", writableRoots: [TRUSTED_CWD], networkAccess: false,
    excludeSlashTmp: true, excludeTmpdirEnvVar: true
  });
});

test("a bounded Codex execution times out, kills its child, and returns a structured failure", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(
    TRUSTED_CWD,
    fakeStarter({ appServerOutput: "", autoComplete: false, keepAliveUntilKilled: true }, invocations),
    {}
  );

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "bounded proposal",
    logicalRole: "local_lead",
    timeoutMs: 10
  });

  assert.deepEqual(result, {
    kind: "failed",
    error: {
      code: "CODEX_EXECUTION_TIMEOUT",
      message: "Codex execution exceeded the controlled task deadline."
    }
  });
  assert.equal(invocations[0]?.killed, true);
  await assert.rejects(executor.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("exposes the validated native thread before the turn completes", async () => {
  const invocations: Invocation[] = [];
  const threadIds: string[] = [];
  const pending = new CodexExecutor(TRUSTED_CWD, fakeStarter({
    appServerOutput: "",
    autoComplete: false
  }, invocations), {}).execute({
    taskId: TASK_ID,
    instruction: "inspect",
    logicalRole: "local_lead",
    onThreadStarted: (threadId) => { threadIds.push(threadId); }
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(threadIds, ["thread-1"]);
  completeEvidenceRun(invocations[0]!);
  assert.equal((await pending).threadId, "thread-1");
});

test("does not expose a thread whose model violates thread integrity", async () => {
  const invocations: Invocation[] = [];
  const threadIds: string[] = [];
  const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({
    appServerOutput: "",
    threadModel: "wrong-model"
  }, invocations), {}).execute({
    taskId: TASK_ID,
    instruction: "inspect",
    logicalRole: "local_lead",
    onThreadStarted: (threadId) => { threadIds.push(threadId); }
  });

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, "CODEX_ROLE_THREAD_MISMATCH");
  assert.deepEqual(threadIds, []);
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/start"'), false);
});

test("routes logical roles through only the configured exact models with max reasoning", async () => {
  for (const role of ["implementer", "local_lead", "repo_principal"] as const) {
    const invocations: Invocation[] = [];
    const result = await new CodexExecutor(TRUSTED_CWD,
      fakeStarter({ appServerOutput: "done" }, invocations), {})
      .execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: role });
    assert.equal(result.kind, "completed");
    assert.deepEqual(result.metadata, {
      logicalRole: role,
      model: DEFAULT_CODEX_MODEL_REGISTRY[role].model,
      reasoningEffort: "max",
      codexVersion: "0.148.0"
    });
    const messages = invocations[0]!.stdin.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    const thread = messages.find(({ method }) => method === "thread/start");
    const turn = messages.find(({ method }) => method === "turn/start");
    assert.equal(thread?.params.model, DEFAULT_CODEX_MODEL_REGISTRY[role].model);
    assert.equal(turn?.params.model, DEFAULT_CODEX_MODEL_REGISTRY[role].model);
    assert.equal(turn?.params.effort, "max");
    assert.equal(turn?.params.summary, "concise");
  }
});

test("a future model generation is replaced through registry configuration only", async () => {
  const registry = {
    implementer: { model: "future-luna", effort: "max", summary: "concise" },
    local_lead: { model: "future-terra", effort: "max", summary: "concise" },
    repo_principal: { model: "future-sol", effort: "max", summary: "concise" }
  } as const;
  const invocations: Invocation[] = [];
  const modelList = { data: Object.values(registry).map(({ model }) => ({
    model,
    supportedReasoningEfforts: [{ reasoningEffort: "max" }]
  })) };
  const result = await new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "done", modelList }, invocations), {}, process.platform, registry)
    .execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  assert.equal(result.metadata?.model, "future-terra");
  assert.match(invocations[0]?.stdin ?? "", /"model":"future-terra"/);
  assert.equal(invocations[0]?.stdin.includes("gpt-5.6"), false);
});

test("execution validates every configured role before creating a selected-role thread", async () => {
  const invocations: Invocation[] = [];
  const result = await new CodexExecutor(TRUSTED_CWD,
    fakeStarter({
      appServerOutput: "",
      modelList: { data: MODEL_LIST.data.filter(({ model }) => model !== "gpt-5.6-sol") }
    }, invocations), {})
    .execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "implementer" });

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, "CODEX_ROLE_MODEL_UNAVAILABLE");
  assert.equal(invocations[0]?.stdin.includes('"method":"thread/start"'), false);
});

test("fails closed when the exact role model or max reasoning is unavailable", async () => {
  const cases = [
    {
      modelList: { data: MODEL_LIST.data.filter(({ model }) => model !== "gpt-5.6-sol") },
      code: "CODEX_ROLE_MODEL_UNAVAILABLE"
    },
    {
      modelList: { data: MODEL_LIST.data.map((entry) => entry.model === "gpt-5.6-sol"
        ? { ...entry, supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }
        : entry) },
      code: "CODEX_MAX_REASONING_UNAVAILABLE"
    },
    {
      modelList: { data: MODEL_LIST.data.map((entry) => entry.model === "gpt-5.6-sol"
        ? { ...entry, hidden: true }
        : entry) },
      code: "CODEX_ROLE_MODEL_UNAVAILABLE"
    }
  ] as const;
  for (const { modelList, code } of cases) {
    const invocations: Invocation[] = [];
    const result = await new CodexExecutor(TRUSTED_CWD,
      fakeStarter({ appServerOutput: "", modelList }, invocations), {})
      .execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "repo_principal" });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.equal(result.error.code, code);
    assert.equal(invocations[0]?.stdin.includes('"method":"thread/start"'), false);
    assert.equal(invocations[0]?.stdin.includes('"method":"turn/start"'), false);
  }
});

test("fails closed if a resumed or new thread reports a different model", async () => {
  const result = await new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "", threadModel: "gpt-5.6-terra" }, []), {})
    .execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "repo_principal" });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, "CODEX_ROLE_THREAD_MISMATCH");
});

test("rejects a Codex execution without a role before spawning", async () => {
  const invocations: Invocation[] = [];
  const result = await new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "done" }, invocations), {})
    .execute({ taskId: TASK_ID, instruction: "inspect" });
  assert.equal(result.kind, "failed");
  assert.equal(invocations.length, 0);
});

test("capability probe includes hidden models and reports exact max readiness", async () => {
  const invocations: Invocation[] = [];
  const capabilities = await probeCodexCapabilities(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "" }, invocations), {});
  assert.equal(capabilities.codexVersion, "0.148.0");
  assert.equal(capabilities.maxReady, true);
  assert.deepEqual(Object.keys(capabilities.roles), ["implementer", "local_lead", "repo_principal"]);
  assert.ok(Object.values(capabilities.roles).every(({ available, maxSupported, effort }) =>
    available && maxSupported && effort === "max"));
  assert.equal(invocations[0]?.stdin.includes('"method":"model/list","params":{"includeHidden":true,"limit":100}'), true);
});

test("controls require turn/started readiness and reset between turns", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});

  const firstExecution = executor.execute({ taskId: TASK_ID, instruction: "first", logicalRole: "local_lead" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(executor.steer("too soon"), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  await assert.rejects(executor.interrupt(), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/steer"'), false);
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), false);

  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "other-turn", status: "inProgress" } } });
  await assert.rejects(executor.interrupt(), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), false);

  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  await executor.steer("continue");
  await executor.interrupt();
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/steer"'), true);
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), true);

  invocations[0]?.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  await firstExecution;
  await assert.rejects(executor.interrupt(), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");

  const secondExecution = executor.execute({ taskId: TASK_ID, threadId: "thread-1", instruction: "second", logicalRole: "local_lead" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(executor.steer("too soon again"), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[1]?.stdin.includes('"method":"turn/steer"'), false);
  invocations[1]?.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  await secondExecution;
});

test("maps a thrown spawn and a process error to unavailable", async () => {
  const throwing: ProcessStarter = () => { throw new Error("secret spawn details"); };
  const thrown = await new CodexExecutor(TRUSTED_CWD, throwing, {}).execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });
  const emitted = await new CodexExecutor(TRUSTED_CWD, fakeStarter({ processError: true }, []), {})
    .execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });

  for (const result of [thrown, emitted]) {
    assert.deepEqual(result, {
      kind: "failed",
      error: { code: "CODEX_UNAVAILABLE", message: "Codex is unavailable." }
    });
  }
});

test("rejects malformed JSONL, missing messages, and malformed message structure", async () => {
  const outputs = [
    "not-json secret raw line",
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })
  ];
  for (const stdout of outputs) {
    const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({ stdout }, []), {})
      .execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });
    assert.deepEqual(result, {
      kind: "failed",
      error: { code: "CODEX_PROTOCOL_ERROR", message: "Codex returned an invalid response." }
    });
    assert.equal(JSON.stringify(result).includes("secret raw line"), false);
  }
});

test("nonzero exit discards partial output and stderr details", async () => {
  const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({
    stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "secret partial" } }),
    stderr: "secret stderr /private/path",
    exitCode: 7
  }, []), {}).execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret partial"), false);
  assert.equal(serialized.includes("secret stderr"), false);
  assert.equal(serialized.includes("/private/path"), false);
});

test("reports an allowlisted failed-turn reason without exposing raw error details", async () => {
  const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({
    appServerOutput: "",
    turnError: {
      message: "secret upstream message /private/path",
      codexErrorInfo: "serverOverloaded",
      additionalDetails: "secret diagnostics"
    }
  }, []), {}).execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });

  assert.deepEqual(result, {
    kind: "failed",
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed: the selected model is at capacity."
    },
    threadId: "thread-1",
    evidence: [],
    metadata: {
      logicalRole: "local_lead", model: "gpt-5.6-terra", reasoningEffort: "max", codexVersion: "0.148.0"
    }
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret upstream message"), false);
  assert.equal(serialized.includes("/private/path"), false);
  assert.equal(serialized.includes("secret diagnostics"), false);
});

test("an interrupted turn keeps the last completed agent text as real partial output", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { item: { id: "message-1", type: "agentMessage", text: "partial answer" } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });

  assert.deepEqual(await pending, {
    kind: "interrupted",
    output: "partial answer",
    threadId: "thread-1",
    evidence: [],
    metadata: {
      logicalRole: "local_lead", model: "gpt-5.6-terra", reasoningEffort: "max", codexVersion: "0.148.0"
    }
  });
});

test("captures only final safe output and enriches the existing command evidence ID", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-codex-evidence-read-")));
  const readme = join(root, "README.md");
  writeFileSync(readme, "repository facts\n");
  const emissions: Array<readonly ExecutorEvidence[]> = [];
  const { invocation, pending } = await evidenceRun(root, (items) => { emissions.push(items); });
  const item = {
    id: "command-read",
    type: "commandExecution",
    command: "read README.md",
    cwd: root,
    commandActions: [{ type: "read", command: "read README.md", name: "read", path: readme }]
  };

  invocation.send({ method: "item/started", params: { item: { ...item, status: "inProgress" } } });
  invocation.send({
    method: "item/commandExecution/outputDelta",
    params: { itemId: "command-read", delta: "streamed output must not be retained" }
  });
  invocation.send({ method: "item/completed", params: { item: {
    ...item, status: "completed", exitCode: 0, aggregatedOutput: "repository facts\n"
  } } });
  completeEvidenceRun(invocation);

  const result = await pending;
  assert.equal(result.kind, "completed");
  assert.equal(emissions.length, 2);
  assert.equal(emissions[0]?.length, 1);
  assert.equal(emissions[0]?.[0]?.id, "command-read");
  assert.equal(emissions[0]?.[0]?.result, undefined);
  assert.equal(emissions[1]?.length, 1);
  assert.deepEqual(emissions[1]?.[0]?.result, {
    state: "complete", exit_code: 0, output: "repository facts\n"
  });
  assert.deepEqual(result.evidence, emissions[1]);
  assert.equal(JSON.stringify(result.evidence).includes("streamed output"), false);
});

test("turns an evidence persistence callback failure into a safe terminal error", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    logicalRole: "local_lead",
    onEvidence: () => { throw new Error("secret persistence details"); }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { item: {
    id: "command-callback-failure", type: "commandExecution", status: "completed", command: "inspect"
  } } });

  const result = await pending;
  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "INTERNAL_ERROR", message: "The request could not be completed." }
  });
  assert.equal(invocation.killed, true);
  assert.equal(JSON.stringify(result).includes("secret persistence details"), false);
  await assert.rejects(executor.interrupt(),
    (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("admits completed listFiles and exact-file search results inside the canonical workspace", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-codex-evidence-search-")));
  const manifest = join(root, "package.json");
  writeFileSync(manifest, "{\"scripts\":{\"test\":\"node --test\"}}\n");
  const { invocation, pending } = await evidenceRun(root);
  const cases = [{
    id: "command-list",
    command: "list root",
    commandActions: [{ type: "listFiles", command: "list root", path: null }],
    aggregatedOutput: "README.md\npackage.json\n"
  }, {
    id: "command-search",
    command: "search package manifest",
    commandActions: [{ type: "search", command: "search package manifest", path: "package.json", query: "test" }],
    aggregatedOutput: "scripts.test=node --test\n"
  }];
  for (const item of cases) {
    invocation.send({ method: "item/completed", params: { item: {
      ...item, type: "commandExecution", status: "completed", cwd: root, exitCode: 0
    } } });
  }
  completeEvidenceRun(invocation);

  const result = await pending;
  assert.equal(result.kind, "completed");
  assert.deepEqual(result.evidence?.map(({ id, result: commandResult }) => ({ id, result: commandResult })), [
    { id: "command-list", result: { state: "complete", exit_code: 0, output: "README.md\npackage.json\n" } },
    { id: "command-search", result: { state: "complete", exit_code: 0, output: "scripts.test=node --test\n" } }
  ]);
});

test("withholds directory, root, and missing-path content searches and directory reads", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-codex-evidence-search-scope-")));
  writeFileSync(join(root, ".env"), "TOKEN=must-not-escape\n");
  const { invocation, pending } = await evidenceRun(root);
  const cases = [{
    id: "search-null",
    commandActions: [{ type: "search", command: "search root", path: null, query: "TOKEN" }]
  }, {
    id: "search-directory",
    commandActions: [{ type: "search", command: "search directory", path: root, query: "TOKEN" }]
  }, {
    id: "read-directory",
    commandActions: [{ type: "read", command: "read directory", name: "read", path: root }]
  }];
  for (const item of cases) invocation.send({ method: "item/completed", params: { item: {
    ...item, type: "commandExecution", status: "completed", command: item.id, cwd: root, exitCode: 0,
    aggregatedOutput: "TOKEN=must-not-escape\n"
  } } });
  completeEvidenceRun(invocation);

  const result = await pending;
  assert.deepEqual(result.evidence?.map(({ id, result: commandResult }) => ({ id, result: commandResult })),
    cases.map(({ id }) => ({ id, result: { state: "withheld", exit_code: 0, reason: "unsafe_path" } })));
  assert.equal(JSON.stringify(result.evidence).includes("must-not-escape"), false);
});

test("withholds outputs whose action, scope, status, source, or text safety is not proven", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-codex-evidence-withhold-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "bridge-codex-evidence-outside-")));
  const outsideFile = join(outside, "outside.txt");
  mkdirSync(join(root, ".git"));
  const secretFiles = [
    ".env.local", "auth.json", "credentials.store", "runtime-key.txt", "private.pem",
    ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".git/config"
  ]
    .map((name) => join(root, name));
  const safeFile = join(root, "README.md");
  const escape = join(root, "escape.txt");
  writeFileSync(outsideFile, "outside\n");
  for (const secretFile of secretFiles) writeFileSync(secretFile, "credential material\n");
  writeFileSync(safeFile, "safe\n");
  symlinkSync(outsideFile, escape);
  const { invocation, pending } = await evidenceRun(root);
  const read = (path: string) => [{ type: "read", command: "read", name: "read", path }];
  const cases = [{ id: "outside", cwd: root, commandActions: read(outsideFile), status: "completed", exitCode: 0,
    aggregatedOutput: "outside", reason: "unsafe_path" },
  { id: "symlink", cwd: root, commandActions: read(escape), status: "completed", exitCode: 0,
    aggregatedOutput: "outside", reason: "unsafe_path" },
  { id: "mutation", cwd: root, commandActions: [{ type: "write", command: "write" }], status: "completed",
    exitCode: 0, aggregatedOutput: "wrote", reason: "unsafe_action" },
  { id: "environment", cwd: root, commandActions: [{ type: "unknown", command: "printenv" }],
    status: "completed", exitCode: 0, aggregatedOutput: "environment material", reason: "unsafe_action" },
  ...secretFiles.map((secretFile, index) => ({
    id: `secret-${index}`, cwd: root, commandActions: read(secretFile), status: "completed", exitCode: 0,
    aggregatedOutput: `secret material ${index}`, reason: "secret_risk"
  })),
  { id: "failed", cwd: root, commandActions: read(safeFile), status: "failed", exitCode: 1,
    aggregatedOutput: "failed command secret", reason: "non_success" },
  { id: "declined", cwd: root, commandActions: read(safeFile), status: "declined",
    aggregatedOutput: "declined command secret", reason: "non_success" },
  { id: "cwd", cwd: outside, commandActions: read(safeFile), status: "completed", exitCode: 0,
    aggregatedOutput: "wrong cwd", reason: "unsafe_cwd" },
  { id: "control", cwd: root, commandActions: read(safeFile), status: "completed", exitCode: 0,
    aggregatedOutput: "unsafe\u001b[31m", reason: "unsafe_output" }];

  for (const item of cases) invocation.send({ method: "item/completed", params: { item: {
    id: item.id, type: "commandExecution", command: `inspect ${item.id}`, cwd: item.cwd,
    commandActions: item.commandActions, status: item.status, ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    aggregatedOutput: item.aggregatedOutput
  } } });
  completeEvidenceRun(invocation);

  const result = await pending;
  assert.equal(result.kind, "completed");
  assert.deepEqual(result.evidence?.map(({ id, result: commandResult }) => ({
    id, state: commandResult?.state, exit_code: commandResult?.exit_code, reason: commandResult?.reason,
    has_output: commandResult?.output !== undefined
  })), cases.map(({ id, exitCode, reason }) => ({
    id, state: "withheld", ...(exitCode === undefined ? { exit_code: undefined } : { exit_code: exitCode }),
    reason, has_output: false
  })));
  const serialized = JSON.stringify(result.evidence);
  assert.equal(serialized.includes("failed command secret"), false);
  assert.equal(serialized.includes("declined command secret"), false);
  assert.equal(serialized.includes("environment material"), false);
  assert.equal(serialized.includes("secret material"), false);
});

test("marks admitted command output over 16,384 characters as deterministically truncated", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-codex-evidence-truncate-")));
  const readme = join(root, "README.md");
  writeFileSync(readme, "safe\n");
  const { invocation, pending } = await evidenceRun(root);
  invocation.send({ method: "item/completed", params: { item: {
    id: "command-long", type: "commandExecution", status: "completed", command: "read README.md",
    cwd: root, commandActions: [{ type: "read", command: "read", name: "read", path: readme }],
    exitCode: 0, aggregatedOutput: "x".repeat(16_385)
  } } });
  completeEvidenceRun(invocation);

  const result = await pending;
  const commandResult = result.evidence?.[0]?.result;
  assert.equal(commandResult?.state, "truncated");
  assert.equal(commandResult?.exit_code, 0);
  assert.equal(commandResult?.output?.length, 16_384);
  assert.match(commandResult?.output ?? "", /\n\[truncated\]$/u);
});

test("marks oversized evidence strings with a visible truncation marker inside the bound", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { item: { id: "cmd-1", type: "commandExecution", status: "completed", command: "c".repeat(20_000) } } });
  invocation.send({ method: "item/completed", params: { item: { id: "change-1", type: "fileChange", status: "completed", changes: [{ path: "p".repeat(20_000), diff: "d".repeat(20_000) }] } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  const evidence = result.evidence ?? [];
  assert.equal(evidence.length, 2);
  // The marker takes its own slot inside the 16_384 budget: 16_372 content
  // bytes plus "\n[truncated]" (marker length 11 plus the separator).
  const command = evidence.find(({ id }) => id === "cmd-1");
  assert.equal(command?.command, `${"c".repeat(16_372)}\n[truncated]`);
  assert.ok((command?.command?.length ?? 0) <= 16_384);
  const change = evidence.find(({ id }) => id === "change-1");
  assert.equal(change?.changes?.[0]?.path, `${"p".repeat(16_372)}\n[truncated]`);
  assert.equal(change?.changes?.[0]?.diff, `${"d".repeat(16_372)}\n[truncated]`);
  assert.ok((change?.changes?.[0]?.path.length ?? 0) <= 16_384);
  assert.ok((change?.changes?.[0]?.diff.length ?? 0) <= 16_384);
});

test("marks an oversized changes list with an in-bound truncation entry and an accurate omitted count", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  const changes = Array.from({ length: 55 }, (_, index) => ({ path: `file-${index}.txt`, diff: `diff ${index}` }));
  invocation.send({ method: "item/completed", params: { item: { id: "change-1", type: "fileChange", status: "completed", changes } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  const change = result.evidence?.find(({ id }) => id === "change-1");
  // 49 real entries plus the marker fit the 50-entry bound; 55 - 49 = 6
  // real changes are omitted and the count says so.
  assert.equal(change?.changes?.length, 50);
  assert.deepEqual(change?.changes?.[0], { path: "file-0.txt", diff: "diff 0" });
  assert.deepEqual(change?.changes?.[48], { path: "file-48.txt", diff: "diff 48" });
  assert.deepEqual(change?.changes?.[49], { path: "[truncated: 6 additional changes omitted]", diff: "" });
});

test("reports evidence evicted by the count limit through an in-budget synthetic drop item", async () => {
  const invocations: Invocation[] = [];
  const emissions: Array<readonly ExecutorEvidence[]> = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({
    taskId: TASK_ID,
    instruction: "x", logicalRole: "local_lead",
    onEvidence: (items) => { emissions.push(items); }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  for (let index = 1; index <= 55; index += 1) {
    invocation.send({ method: "item/completed", params: { item: { id: `cmd-${index}`, type: "commandExecution", status: "completed", command: `command ${index}` } } });
  }
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  const evidence = result.evidence ?? [];
  // The marker reserves one of the 50 slots: 49 real entries plus the marker.
  assert.equal(evidence.length, 50);
  assert.equal(evidence[0]?.id, "cmd-7");
  assert.equal(evidence[48]?.id, "cmd-55");
  const drop = evidence[49];
  assert.equal(drop?.id, "evidence-drop");
  assert.equal(drop?.type, "commandExecution");
  assert.match(drop?.command ?? "", /6 evidence item\(s\) dropped: evidence limit exceeded/u);

  // 55 real entries arrived; 49 are shown, so exactly 6 were dropped, and
  // every onEvidence emission respects the 50-item budget.
  assert.equal(emissions.length, 55);
  assert.equal(emissions[49]?.length, 50);
  assert.equal(emissions[49]?.[50], undefined);
  assert.equal(emissions[50]?.length, 50);
  assert.equal(emissions[50]?.[49]?.id, "evidence-drop");
  assert.equal(emissions[54]?.length, 50);
  assert.equal(emissions[54]?.[0]?.id, "cmd-7");
  assert.equal(emissions[54]?.[49]?.id, "evidence-drop");
});

test("passes untruncated evidence fields through unchanged", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { item: { id: "cmd-1", type: "commandExecution", status: "completed", command: "ls -la" } } });
  invocation.send({ method: "item/completed", params: { item: { id: "change-1", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", diff: "+1 line" }] } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  assert.deepEqual(result.evidence, [
    { id: "cmd-1", type: "commandExecution", status: "completed", command: "ls -la",
      result: { state: "withheld", reason: "non_success" } },
    { id: "change-1", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", diff: "+1 line" }] }
  ]);
});

test("does not cap agent message text or the final output", async () => {
  const longText = "t".repeat(30_000);
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x", logicalRole: "local_lead" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { item: { id: "message-1", type: "agentMessage", text: longText } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  assert.equal(result.output, longText);
});

// ---------------------------------------------------------------------------
// Windows command resolution (platform seam = "win32").
// ---------------------------------------------------------------------------

function windowsDirectory(): string {
  return mkdtempSync(join(tmpdir(), "bridge-codex-win-"));
}

test("win32: a real codex.exe on PATH is spawned directly with the fixed args", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.exe"), "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  assert.equal(result.kind, "completed");
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, join(dir, "codex.exe"));
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
});

test("win32: an npm codex.cmd shim resolves to the official bin/codex.js and runs under Node", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.cmd"), "");
  const binJs = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  assert.equal(result.kind, "completed");
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
});

test("win32: a local node_modules/.bin codex.cmd shim also resolves to bin/codex.js under Node", async () => {
  const dir = windowsDirectory();
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "codex.cmd"), "");
  const binJs = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: binDir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
});

test("win32: a codex.cmd shim without a derivable target fails closed through the bare fallback, never a shell", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.cmd"), "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  const invocation = invocations[0];
  assert.ok(invocation);
  // No cmd.exe, no ComSpec, no shell command text: the original bare "codex"
  // spawn is kept, which maps to CODEX_UNAVAILABLE on a real Windows machine.
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
});

test("win32: a shell-like instruction never reaches the argv of the Node launcher", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.cmd"), "");
  const binJs = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");
  const instruction = "inspect & echo pwned > marker.txt | 100%! \"中文 测试\"";

  await executor.execute({ taskId: TASK_ID, instruction, logicalRole: "local_lead" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "app-server", "--stdio"]);
  assert.equal(invocation.args.some((arg) => arg.includes("&") || arg.includes("|") || arg.includes("%")), false);
  // The instruction travels only over JSON-RPC stdin, as one JSON text field.
  const messages = invocation.stdin.trim().split("\n").map((line) => JSON.parse(line));
  const turnStart = messages.find((message) => message.method === "turn/start") as
    { params?: { input?: Array<{ text?: string }> } } | undefined;
  assert.equal(turnStart?.params?.input?.[0]?.text, instruction);
});

test("win32: a real codex.exe is preferred over a codex.cmd shim even when the shim dir comes first", async () => {
  const shimDir = windowsDirectory();
  const exeDir = windowsDirectory();
  writeFileSync(join(shimDir, "codex.cmd"), "");
  const exe = join(exeDir, "codex.exe");
  writeFileSync(exe, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: `${shimDir};${exeDir}` }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  assert.equal(invocations[0]?.executable, exe);
});

test("win32: no resolvable command keeps the original bare spawn (which maps to CODEX_UNAVAILABLE on Windows)", async () => {
  const dir = windowsDirectory();
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
});

test("POSIX: a Windows-style codex.exe layout on PATH does not change the bare spawn", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.exe"), "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }); // default platform is the running (non-Windows) one

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
});

test("win32: a spawned command that does not resolve still maps to CODEX_UNAVAILABLE", async () => {
  const dir = windowsDirectory();
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ processError: true }, []),
    { PATH: dir }, "win32");

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect", logicalRole: "local_lead" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "CODEX_UNAVAILABLE", message: "Codex is unavailable." }
  });
});
