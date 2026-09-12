import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CoreError, serializeError } from "../core/errors.js";
import { VERSION } from "../version.js";
import { isWithin } from "../workspaces/repository-identity.js";
import { resolveCommand } from "./command-resolution.js";
import {
  DEFAULT_CODEX_MODEL_REGISTRY,
  registryAvailability,
  requireModelRegistry,
  taskMetadata
} from "./codex-model-registry.js";
import type {
  CodexLogicalRole,
  CodexModelRegistry,
  CodexRoleAvailability,
  CodexTaskMetadata
} from "./codex-model-registry.js";
import type {
  EvidenceCommandResult,
  EvidenceResultReason,
  Executor,
  ExecutorEvidence,
  ExecutorRequest,
  ExecutorResult
} from "./executor.js";

export type ProcessStarter = (executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
const ENVIRONMENT_ALLOWLIST = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"] as const;
const MAX_EVIDENCE = 50;
const MAX_TEXT = 16_384;
const MAX_JSONL_FRAME = 64 * 1024 * 1024;
const CAPABILITY_TIMEOUT_MS = 20_000;
// Official npm target of the Codex CLI, derived from a codex.cmd shim's
// location so a Windows npm install can be launched through Node directly
// (never through a shell).
const CODEX_NODE_TARGET = ["@openai", "codex", "bin", "codex.js"] as const;
// Machine- and human-readable marker appended to any bounded evidence string
// that was cut by MAX_TEXT, and the basis of the synthetic change/evidence
// entries that make list and count truncation visible.
const TRUNCATION_MARKER = "[truncated]";
const UNSAFE_OUTPUT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/u;
const SECRET_PATH_PART = /^(?:\.codex|\.ssh|\.aws|\.gnupg|\.git|\.npmrc|\.netrc|\.pypirc|\.git-credentials|auth(?:\.json)?|credentials?(?:\..*)?|cookies?(?:\..*)?|sessions?(?:\..*)?|secrets?(?:\..*)?|runtime[-_.]?keys?(?:\..*)?|tunnel[-_.]?(?:runtime[-_.]?)?keys?(?:\..*)?|private[-_.]?keys?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:key|pem|p12|pfx))$/u;

function failure(code: "INTERNAL_ERROR" | "CODEX_UNAVAILABLE" | "CODEX_PROTOCOL_ERROR" |
  "CODEX_EXECUTION_FAILED" | "CODEX_EXECUTION_TIMEOUT"): ExecutorResult {
  return { kind: "failed", error: serializeError(new CoreError(code)) };
}
function failedTurn(turn: Record<string, unknown>): ExecutorResult {
  const error = object(turn.error) ? turn.error : undefined;
  if (error?.codexErrorInfo === "serverOverloaded") {
    return {
      kind: "failed",
      error: {
        code: "CODEX_EXECUTION_FAILED",
        message: "Codex execution failed: the selected model is at capacity."
      }
    };
  }
  return failure("CODEX_EXECUTION_FAILED");
}
function environment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_ALLOWLIST) if (host[key]) result[key] = host[key];
  // A native executor may inherit the user's installed plugins. Its Bridge
  // front door rejects this marker to prevent recursively delegating to itself.
  result.ENGINEERING_BRIDGE_EXECUTOR_CHILD = "1";
  return result;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function codexVersion(initializeResult: unknown): string {
  if (!object(initializeResult) || typeof initializeResult.userAgent !== "string") {
    throw new CoreError("CODEX_PROTOCOL_ERROR");
  }
  const match = /^[^/]+\/([0-9]+(?:\.[0-9]+)*)\b/u.exec(initializeResult.userAgent);
  if (match?.[1] === undefined) throw new CoreError("CODEX_PROTOCOL_ERROR");
  return match[1];
}
function startCodex(
  workspaceRoot: string,
  startProcess: ProcessStarter,
  hostEnvironment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform
): ChildProcessWithoutNullStreams {
  const options: SpawnOptionsWithoutStdio = {
    cwd: workspaceRoot, shell: false, stdio: ["pipe", "pipe", "pipe"], env: environment(hostEnvironment)
  };
  const resolved = resolveCommand(hostEnvironment, "codex", { nodeTarget: CODEX_NODE_TARGET, platform });
  if (resolved.kind === "direct") return startProcess(resolved.executable, ["app-server", "--stdio"], options);
  if (resolved.kind === "node-launcher") {
    return startProcess(process.execPath, [resolved.scriptPath, "app-server", "--stdio"], options);
  }
  return startProcess("codex", ["app-server", "--stdio"], options);
}
function bounded(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_TEXT) return value;
  // The marker must fit inside the MAX_TEXT budget: its length plus the
  // newline separator is deducted from the retained content, so the final
  // string never exceeds MAX_TEXT.
  const retained = MAX_TEXT - TRUNCATION_MARKER.length - 1;
  return `${value.slice(0, retained)}\n${TRUNCATION_MARKER}`;
}
function secretRiskPath(path: string): boolean {
  return path.toLowerCase().replaceAll("\\", "/").split("/").some((part) =>
    /^\.env(?:\.|$)/u.test(part) || SECRET_PATH_PART.test(part));
}
function withheld(reason: EvidenceResultReason, exitCode?: number): EvidenceCommandResult {
  return { state: "withheld", ...(exitCode === undefined ? {} : { exit_code: exitCode }), reason };
}
function commandResult(item: Record<string, unknown>, status: string, workspaceRoot: string): EvidenceCommandResult {
  const exitCode = typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode)
    ? item.exitCode
    : undefined;
  if (status !== "completed" || exitCode !== 0) return withheld("non_success", exitCode);
  if (!Array.isArray(item.commandActions) || item.commandActions.length === 0) {
    return withheld("unsafe_action", exitCode);
  }
  let canonicalRoot: string;
  let canonicalCwd: string;
  try {
    canonicalRoot = realpathSync(workspaceRoot);
    if (typeof item.cwd !== "string" || !isAbsolute(item.cwd)) return withheld("unsafe_cwd", exitCode);
    canonicalCwd = realpathSync(item.cwd);
  } catch {
    return withheld("unsafe_cwd", exitCode);
  }
  if (!isWithin(canonicalRoot, canonicalCwd)) return withheld("unsafe_cwd", exitCode);
  for (const action of item.commandActions) {
    if (!object(action) || !["read", "listFiles", "search"].includes(action.type as string)) {
      return withheld("unsafe_action", exitCode);
    }
    const actionType = action.type as "read" | "listFiles" | "search";
    let declaredPath: string | undefined;
    if (actionType === "read" || actionType === "search") {
      if (typeof action.path !== "string") return withheld("unsafe_path", exitCode);
      declaredPath = action.path;
    } else if (action.path !== undefined && action.path !== null) {
      if (typeof action.path !== "string") return withheld("unsafe_action", exitCode);
      declaredPath = action.path;
    }
    if (declaredPath !== undefined && declaredPath.trim() === "") {
      return withheld("unsafe_path", exitCode);
    }
    const candidate = declaredPath === undefined
      ? canonicalCwd
      : isAbsolute(declaredPath) ? declaredPath : resolve(canonicalCwd, declaredPath);
    let canonicalPath: string;
    let targetIsFile: boolean;
    let targetIsDirectory: boolean;
    try {
      canonicalPath = realpathSync(candidate);
      const target = statSync(canonicalPath);
      targetIsFile = target.isFile();
      targetIsDirectory = target.isDirectory();
      if (!targetIsFile && !targetIsDirectory) return withheld("unsafe_path", exitCode);
    } catch { return withheld("unsafe_path", exitCode); }
    if (!isWithin(canonicalRoot, canonicalPath)) return withheld("unsafe_path", exitCode);
    if ((declaredPath !== undefined && secretRiskPath(declaredPath)) || secretRiskPath(canonicalPath)) {
      return withheld("secret_risk", exitCode);
    }
    if ((actionType === "read" || actionType === "search") && !targetIsFile) {
      return withheld("unsafe_path", exitCode);
    }
    if (actionType === "listFiles" && !targetIsDirectory) {
      return withheld("unsafe_path", exitCode);
    }
  }
  if (typeof item.aggregatedOutput !== "string") return withheld("missing_output", exitCode);
  if (UNSAFE_OUTPUT.test(item.aggregatedOutput)) return withheld("unsafe_output", exitCode);
  const output = bounded(item.aggregatedOutput);
  return {
    state: output === item.aggregatedOutput ? "complete" : "truncated",
    exit_code: exitCode,
    output
  };
}

export interface CodexCapabilitySnapshot {
  readonly codexVersion: string;
  readonly roles: Readonly<Record<CodexLogicalRole, CodexRoleAvailability>>;
  readonly maxReady: boolean;
}

export async function probeCodexCapabilities(
  workspaceRoot: string,
  startProcess: ProcessStarter = spawn,
  hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
  registry: CodexModelRegistry = DEFAULT_CODEX_MODEL_REGISTRY
): Promise<CodexCapabilitySnapshot> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = startCodex(workspaceRoot, startProcess, hostEnvironment, platform);
  } catch {
    throw new CoreError("CODEX_UNAVAILABLE");
  }
  let nextId = 1;
  let buffer = "";
  let failed: Error | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error): void => {
    failed = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    if (!child.killed) child.kill();
  };
  const call = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (failed) { reject(failed); return; }
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (failed) return;
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      if (newline > MAX_JSONL_FRAME) { fail(new CoreError("CODEX_PROTOCOL_ERROR")); return; }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_FRAME) { fail(new CoreError("CODEX_PROTOCOL_ERROR")); return; }
      let message: unknown;
      try { message = JSON.parse(line); } catch { fail(new CoreError("CODEX_PROTOCOL_ERROR")); return; }
      if (!object(message) || typeof message.id !== "number" || !("result" in message || "error" in message)) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      "error" in message ? waiter.reject(new CoreError("CODEX_PROTOCOL_ERROR")) : waiter.resolve(message.result);
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_JSONL_FRAME) fail(new CoreError("CODEX_PROTOCOL_ERROR"));
  });
  child.on("error", () => fail(new CoreError("CODEX_UNAVAILABLE")));
  child.stdin.on("error", () => fail(new CoreError("CODEX_UNAVAILABLE")));
  child.stdout.on("error", () => fail(new CoreError("CODEX_UNAVAILABLE")));
  child.on("close", () => fail(new CoreError("CODEX_PROTOCOL_ERROR")));
  const deadline = setTimeout(() => fail(new CoreError("CODEX_EXECUTION_TIMEOUT")), CAPABILITY_TIMEOUT_MS);
  deadline.unref();
  try {
    const initialized = await call("initialize", { clientInfo: { name: "engineering-bridge", version: VERSION } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const roles = registryAvailability(
      await call("model/list", { includeHidden: true, limit: 100 }),
      registry
    );
    return {
      codexVersion: codexVersion(initialized),
      roles,
      maxReady: Object.values(roles).every(({ available, maxSupported }) => available && maxSupported)
    };
  } finally {
    clearTimeout(deadline);
    if (!child.killed) child.kill();
  }
}

export class CodexExecutor implements Executor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private threadId?: string;
  private turnId: string | undefined;
  private startedTurnId: string | undefined;
  private nextId = 1;
  private pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: () => void }>();

  constructor(private readonly workspaceRoot: string, private readonly startProcess: ProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly registry: CodexModelRegistry = DEFAULT_CODEX_MODEL_REGISTRY) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    if (request.logicalRole === undefined) {
      return { kind: "failed", error: serializeError(new CoreError("INVALID_STATE_TRANSITION")) };
    }
    this.turnId = undefined;
    this.startedTurnId = undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = startCodex(this.workspaceRoot, this.startProcess, this.hostEnvironment, this.platform);
      this.child = child;
    } catch { return failure("CODEX_UNAVAILABLE"); }

    const evidence = new Map<string, ExecutorEvidence>();
    let evidenceDropped = 0;
    let output = "";
    let buffer = "";
    let terminal: ((result: ExecutorResult) => void) | undefined;
    let terminalPromise!: Promise<ExecutorResult>;
    terminalPromise = new Promise((resolve) => { terminal = resolve; });
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let metadata: CodexTaskMetadata | undefined;
    const finish = (result: ExecutorResult): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      for (const waiter of this.pending.values()) waiter.reject();
      this.pending.clear();
      terminal?.(result);
      if (this.child === child) {
        this.child = undefined;
        this.turnId = undefined;
        this.startedTurnId = undefined;
      }
      if (!child.killed) child.kill();
    };
    if (request.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        finish(failure("CODEX_PROTOCOL_ERROR"));
        return terminalPromise;
      }
      deadline = setTimeout(() => finish(failure("CODEX_EXECUTION_TIMEOUT")), request.timeoutMs);
      deadline.unref();
    }
    const unavailable = (): void => finish(failure("CODEX_UNAVAILABLE"));
    // The evidence view a supervisor receives. Real evidence and the synthetic
    // evidence-drop marker together never exceed MAX_EVIDENCE: the marker only
    // appears once real entries were evicted, and the eviction loop above
    // reserves its slot within the same budget. Rebuilt from a single counter,
    // it can never grow evidence unboundedly.
    const visibleEvidence = (): readonly ExecutorEvidence[] => {
      const items = [...evidence.values()];
      return evidenceDropped === 0
        ? items
        : [...items, {
          id: "evidence-drop",
          type: "commandExecution",
          status: "completed",
          command: `${evidenceDropped} evidence item(s) dropped: evidence limit exceeded`
        }];
    };
    child.on("error", unavailable);
    child.stdin.on("error", unavailable);
    child.stdout.on("error", unavailable);
    child.stderr.on("error", unavailable);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        if (newline > MAX_JSONL_FRAME) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_JSONL_FRAME) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        let message: unknown;
        try { message = JSON.parse(line); } catch { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (!object(message)) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (typeof message.id === "number" && ("result" in message || "error" in message)) {
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id);
            if (waiter.method === "turn/start" && object(message.result) && object(message.result.turn) &&
                typeof message.result.turn.id === "string") this.turnId = message.result.turn.id;
            "error" in message ? waiter.reject() : waiter.resolve(message.result);
          }
          continue;
        }
        if ("id" in message) {
          // This executor uses approvalPolicy=never and has no reverse RPC tool
          // harness. Reject unsupported server requests rather than hanging.
          child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported executor request" } })}\n`);
          finish(failure("CODEX_PROTOCOL_ERROR"));
          return;
        }
        if (typeof message.method !== "string" || !object(message.params)) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (typeof message.params.threadId === "string" && message.params.threadId !== this.threadId) continue;
        if (typeof message.params.turnId === "string" && message.params.turnId !== this.turnId) continue;
        if (message.method === "turn/started") {
          const turn = object(message.params.turn) ? message.params.turn : message.params;
          if (message.params.threadId === this.threadId && typeof turn.id === "string" && (!this.turnId || turn.id === this.turnId)) this.startedTurnId = turn.id;
        }
        const item = object(message.params.item) ? message.params.item : undefined;
        if ((message.method === "item/started" || message.method === "item/completed") && item) {
          if (item.type === "agentMessage") {
            if (message.method === "item/completed" && typeof item.text !== "string") { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
            if (typeof item.text === "string") output = item.text;
          }
          const id = typeof item.id === "string" ? item.id : undefined;
          if (id && (item.type === "commandExecution" || item.type === "fileChange")) {
            const status = typeof item.status === "string" ? item.status : message.method === "item/started" ? "inProgress" : "completed";
            let entry: ExecutorEvidence;
            if (item.type === "commandExecution") {
              const previous = evidence.get(id);
              const command = bounded(item.command) ||
                (previous?.type === "commandExecution" ? previous.command ?? "" : "");
              entry = {
                id,
                type: item.type,
                status,
                command,
                ...(message.method === "item/completed"
                  ? { result: commandResult(item, status, this.workspaceRoot) }
                  : {})
              };
            }
            else {
              const rawChanges = Array.isArray(item.changes) ? item.changes : [];
              // The 50-entry bound includes the synthetic truncation marker: a
              // truncated list keeps 49 real entries and spends the 50th slot
              // on the marker, so the final list never exceeds the bound.
              const kept = rawChanges.length > 50 ? 49 : 50;
              const changes = rawChanges.slice(0, kept).filter(object).map((c) => ({ path: bounded(c.path), diff: bounded(c.diff) }));
              if (rawChanges.length > 50) {
                // omitted counts exactly the real changes that were never
                // returned to the supervisor.
                changes.push({ path: `[truncated: ${rawChanges.length - kept} additional changes omitted]`, diff: "" });
              }
              entry = { id, type: item.type, status, changes };
            }
            evidence.set(id, entry);
            // The MAX_EVIDENCE budget includes the evidence-drop marker: once
            // any drop has happened the marker reserves one slot within the
            // same budget, so the final visible list never exceeds
            // MAX_EVIDENCE entries.
            while (evidence.size + (evidenceDropped > 0 ? 1 : 0) > MAX_EVIDENCE) {
              evidence.delete(evidence.keys().next().value as string);
              evidenceDropped += 1;
            }
            try {
              request.onEvidence?.(visibleEvidence());
            } catch {
              // Persistence is a supervisor concern. Do not let a storage
              // failure escape the stream callback and terminate the Bridge;
              // return only the fixed public error and stop the child.
              finish(failure("INTERNAL_ERROR"));
              return;
            }
          }
        }
        if (message.method === "turn/completed") {
          const turn = object(message.params.turn) ? message.params.turn : message.params;
          if (message.params.threadId !== this.threadId || !this.turnId || turn.id !== this.turnId) continue;
          const status = turn.status;
          const common = {
            threadId: this.threadId,
            evidence: visibleEvidence(),
            ...(metadata === undefined ? {} : { metadata })
          };
          if (status === "failed") finish({ ...failedTurn(turn), ...common });
          else if (status === "interrupted") finish({ kind: "interrupted", output, ...common });
          else if (status === "completed") finish({ kind: "completed", output, ...common });
          else finish(failure("CODEX_PROTOCOL_ERROR"));
          if (settled) return;
        }
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_JSONL_FRAME) finish(failure("CODEX_PROTOCOL_ERROR"));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (buffer.trim()) { try { JSON.parse(buffer); } catch { finish(failure("CODEX_PROTOCOL_ERROR")); return; } }
      finish(code === 0 ? failure("CODEX_PROTOCOL_ERROR") : failure("CODEX_EXECUTION_FAILED"));
    });

    try {
      const initializeResult = await this.call("initialize", { clientInfo: { name: "engineering-bridge", version: VERSION } });
      this.notify("initialized", {});
      metadata = taskMetadata(request.logicalRole, codexVersion(initializeResult), this.registry);
      const modelList = await this.call("model/list", { includeHidden: true, limit: 100 });
      requireModelRegistry(modelList, this.registry);
      const role = this.registry[request.logicalRole];
      const sandbox = request.sandbox ?? "read-only";
      const threadParams: Record<string, unknown> = {
        cwd: this.workspaceRoot, approvalPolicy: "never", sandbox, model: role.model
      };
      if (request.threadId) threadParams.threadId = request.threadId;
      else threadParams.serviceName = "engineering-bridge-auto-router";
      const threadResult = await this.call(request.threadId ? "thread/resume" : "thread/start", threadParams);
      if (!object(threadResult) || !object(threadResult.thread) || typeof threadResult.thread.id !== "string") throw new Error();
      if (threadResult.model !== role.model) throw new CoreError("CODEX_ROLE_THREAD_MISMATCH");
      this.threadId = threadResult.thread.id;
      request.onThreadStarted?.(this.threadId);
      const sandboxPolicy = sandbox === "workspace-write"
        ? { type: "workspaceWrite", writableRoots: [this.workspaceRoot], networkAccess: false,
          excludeSlashTmp: true, excludeTmpdirEnvVar: true }
        : { type: "readOnly", networkAccess: false };
      const turnResult = await this.call("turn/start", {
        threadId: this.threadId, input: [{ type: "text", text: request.instruction }], cwd: this.workspaceRoot,
        approvalPolicy: "never", sandboxPolicy, model: role.model, effort: role.effort, summary: role.summary
      });
      if (!object(turnResult) || !object(turnResult.turn) || typeof turnResult.turn.id !== "string") throw new Error();
      this.turnId = turnResult.turn.id;
      if (this.startedTurnId !== this.turnId) this.startedTurnId = undefined;
    } catch (error) {
      if (!settled) {
        const roleError = error instanceof CoreError && [
          "CODEX_ROLE_MODEL_UNAVAILABLE", "CODEX_MAX_REASONING_UNAVAILABLE", "CODEX_ROLE_THREAD_MISMATCH"
        ].includes(error.code);
        finish(roleError
          ? { kind: "failed", error: serializeError(error), ...(metadata === undefined ? {} : { metadata }) }
          : failure("CODEX_PROTOCOL_ERROR"));
      }
    }
    return terminalPromise;
  }

  async steer(instruction: string): Promise<void> {
    if (!this.threadId || !this.startedTurnId) throw new CoreError("INVALID_STATE_TRANSITION");
    await this.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.startedTurnId, input: [{ type: "text", text: instruction }] });
  }
  async interrupt(): Promise<void> {
    if (!this.threadId || !this.startedTurnId) throw new CoreError("INVALID_STATE_TRANSITION");
    await this.call("turn/interrupt", { threadId: this.threadId, turnId: this.startedTurnId });
  }
  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.stdin.destroyed) { reject(); return; }
      this.pending.set(id, { method, resolve, reject: () => reject(new Error()) });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  private notify(method: string, params: unknown): void { this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`); }
}
