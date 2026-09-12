import { isId, newId } from "../core/ids.js";
import { serializeError } from "../core/errors.js";
import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";
import { CoreError } from "../core/errors.js";
import type {
  EvidenceCommandResult,
  EvidenceResultReason,
  Executor,
  ExecutorEvidence
} from "../executors/executor.js";
import { DEFAULT_CODEX_MODEL_REGISTRY } from "../executors/codex-model-registry.js";
import type {
  CodexLogicalRole,
  CodexModelRegistry,
  CodexTaskMetadata
} from "../executors/codex-model-registry.js";
import { routeCodexTask, routingTransition } from "../executors/codex-routing.js";
import type { CodexRouting, CodexRoutingReason, CodexRoutingRule } from "../executors/codex-routing.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import { appendHandoffSnapshot, requireHandoffSnapshot } from "./handoff-snapshot.js";
import type { HandoffSnapshot } from "./handoff-snapshot.js";

export type ExecutorName = "codex" | "dsh";

export interface RegisteredWorkspaceTaskRequest {
  readonly workspace_id: string;
  readonly instruction: string;
  readonly executor?: ExecutorName;
  readonly routing?: CodexRouting;
  readonly parent_task_id?: string;
  readonly handoff_snapshot?: HandoffSnapshot;
  // Internal classifier input for wrapped task prompts such as controlled
  // patches. It is deliberately not exposed by the MCP schema.
  readonly routing_input?: string;
}

type NormalizedRegisteredWorkspaceTaskRequest =
  & Omit<RegisteredWorkspaceTaskRequest,
    "executor" | "routing" | "parent_task_id" | "handoff_snapshot" | "routing_input">
  & (
    | {
      readonly executor: "codex";
      readonly requestedRouting: CodexRouting;
      readonly logicalRole: CodexLogicalRole;
      readonly routingReason: CodexRoutingReason;
      readonly routingMatchedRule: CodexRoutingRule;
      readonly routingMatchedFactors: readonly string[];
      readonly routingIgnoredGuardFactors: readonly string[];
      readonly parentTaskId?: Id;
      readonly handoffSnapshot?: HandoffSnapshot;
      readonly routingTransition?: "escalation" | "de_escalation" | "handoff";
    }
    | {
      readonly executor: "dsh";
      readonly requestedRouting?: never;
      readonly logicalRole?: never;
      readonly routingReason?: never;
      readonly routingMatchedRule?: never;
      readonly routingMatchedFactors?: never;
      readonly routingIgnoredGuardFactors?: never;
      readonly parentTaskId?: never;
      readonly handoffSnapshot?: never;
      readonly routingTransition?: never;
    }
  );

export type RegisteredWorkspaceTaskResult =
  | {
    readonly id: Id;
    readonly state: "completed";
    readonly output: string;
    readonly threadId?: string | undefined;
    readonly evidence?: readonly ExecutorEvidence[] | undefined;
    readonly metadata?: CodexTaskMetadata | undefined;
  }
  | {
    readonly id: Id;
    readonly state: "failed";
    readonly error: SerializedError;
    // Present only when the executor returned genuine partial output for an
    // interrupted run; never for ordinary failures and never as completed
    // output. Empty partial output is omitted entirely.
    readonly partial_output?: string | undefined;
    readonly threadId?: string | undefined;
    readonly evidence?: readonly ExecutorEvidence[] | undefined;
    readonly metadata?: CodexTaskMetadata | undefined;
  };

export type ExecutorFactory = (executor: ExecutorName, workspaceRoot: string) => Executor;
export type CompletedOutputTransform = (output: string) => string;
export interface LegacyTaskOptions {
  readonly timeoutMs?: number;
  readonly onThreadStarted?: (threadId: string) => void;
}

export type RegisteredWorkspaceTaskState = "queued" | "running" | "completed" | "failed";

export type ControlledTaskState = RegisteredWorkspaceTaskState | "waiting_for_supervisor_review";
export interface ControlledTaskView {
  readonly taskId: Id;
  readonly state: ControlledTaskState;
  // The executor selection is fixed for the whole task lifetime. It is always
  // reported honestly: a Codex task may additionally expose its real native
  // app-server thread id, while a DSH task never gets a fabricated session or
  // thread id (DSH headless currently has no machine-resumable session seam).
  readonly executor: ExecutorName;
  readonly routing?: CodexRouting | undefined;
  readonly logicalRole?: CodexLogicalRole | undefined;
  readonly routingReason?: CodexRoutingReason | undefined;
  readonly routingMatchedRule?: CodexRoutingRule | undefined;
  readonly routingMatchedFactors?: readonly string[] | undefined;
  readonly routingIgnoredGuardFactors?: readonly string[] | undefined;
  readonly parentTaskId?: Id | undefined;
  readonly routingTransition?: "escalation" | "de_escalation" | "handoff" | undefined;
  readonly handoffSnapshot?: HandoffSnapshot | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: "max" | undefined;
  readonly codexVersion?: string | undefined;
  readonly threadId?: string | undefined;
  readonly ready?: boolean;
  readonly output?: string | undefined;
  readonly review_output?: string | undefined;
  readonly partial_output?: string | undefined;
  readonly evidence?: readonly ExecutorEvidence[];
  readonly error?: SerializedError | undefined;
}

type TaskRecord =
  | { state: "queued" | "running"; request: NormalizedRegisteredWorkspaceTaskRequest }
  | { state: "completed" | "failed"; request: NormalizedRegisteredWorkspaceTaskRequest; result: RegisteredWorkspaceTaskResult };

const MAX_TERMINAL_TASK_HISTORY = 100;
export const MAX_EXECUTOR_EVIDENCE_ITEMS = 50;
export const MAX_EXECUTOR_EVIDENCE_CHANGES = 50;
export const MAX_EXECUTOR_EVIDENCE_ID_OR_STATUS = 256;
export const MAX_EXECUTOR_EVIDENCE_TEXT = 16_384;
export const MAX_EXECUTOR_EVIDENCE_BYTES = 256 * 1024;
const EVIDENCE_TRUNCATION_MARKER = "[truncated]";
const EVIDENCE_RESULT_REASONS = new Set<EvidenceResultReason>([
  "non_success", "unsafe_action", "unsafe_cwd", "unsafe_path", "secret_risk", "missing_output", "unsafe_output"
]);
const UNSAFE_EVIDENCE_OUTPUT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/u;

function evidenceBytes(evidence: readonly ExecutorEvidence[]): number {
  return Buffer.byteLength(JSON.stringify(evidence), "utf8");
}

function evidenceEnvelopeWithinLimit(evidence: readonly ExecutorEvidence[]): boolean {
  return evidence.length <= MAX_EXECUTOR_EVIDENCE_ITEMS &&
    evidenceBytes(evidence) <= MAX_EXECUTOR_EVIDENCE_BYTES;
}

function evidenceObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyEvidenceKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedEvidenceText(value: string): string {
  if (value.length <= MAX_EXECUTOR_EVIDENCE_TEXT) return value;
  const retained = MAX_EXECUTOR_EVIDENCE_TEXT - EVIDENCE_TRUNCATION_MARKER.length - 1;
  return `${value.slice(0, retained)}\n${EVIDENCE_TRUNCATION_MARKER}`;
}

function normalizeCommandResult(
  value: unknown,
  parentStatus: string,
  strict: boolean
): EvidenceCommandResult | undefined {
  if (!evidenceObject(value) || !hasOnlyEvidenceKeys(value, ["state", "exit_code", "output", "reason"]) ||
      !["complete", "truncated", "withheld"].includes(value.state as string) ||
      (value.exit_code !== undefined && (typeof value.exit_code !== "number" || !Number.isSafeInteger(value.exit_code)))) {
    return undefined;
  }
  const exitCode = value.exit_code as number | undefined;
  if (value.state === "withheld") {
    if (value.output !== undefined || typeof value.reason !== "string" ||
        !EVIDENCE_RESULT_REASONS.has(value.reason as EvidenceResultReason)) return undefined;
    return { state: "withheld", ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      reason: value.reason as EvidenceResultReason };
  }
  if (parentStatus !== "completed" || exitCode !== 0) {
    if (strict) return undefined;
    return { state: "withheld", ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      reason: "non_success" };
  }
  if (typeof value.output !== "string" || value.reason !== undefined) {
    return undefined;
  }
  if (UNSAFE_EVIDENCE_OUTPUT.test(value.output)) {
    if (strict) return undefined;
    return { state: "withheld", ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      reason: "unsafe_output" };
  }
  if (strict && (value.output.length > MAX_EXECUTOR_EVIDENCE_TEXT ||
      (value.state === "truncated" && !value.output.endsWith(EVIDENCE_TRUNCATION_MARKER)))) return undefined;
  const output = boundedEvidenceText(value.output);
  return {
    state: output === value.output && value.state === "complete" ? "complete" : "truncated",
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    output
  };
}

function normalizeEvidenceItem(value: unknown, strict: boolean): ExecutorEvidence | undefined {
  if (!evidenceObject(value) || typeof value.id !== "string" ||
      value.id.length > MAX_EXECUTOR_EVIDENCE_ID_OR_STATUS ||
      typeof value.status !== "string" || value.status.length > MAX_EXECUTOR_EVIDENCE_ID_OR_STATUS) {
    return undefined;
  }
  if (value.type === "commandExecution") {
    if ((strict && !hasOnlyEvidenceKeys(value, ["id", "type", "status", "command", "result"])) ||
        (value.command !== undefined && typeof value.command !== "string")) return undefined;
    if (strict && typeof value.command === "string" &&
        value.command.length > MAX_EXECUTOR_EVIDENCE_TEXT) return undefined;
    const result = value.result === undefined
      ? undefined
      : normalizeCommandResult(value.result, value.status, strict);
    if (value.result !== undefined && result === undefined) return undefined;
    return {
      id: value.id,
      type: "commandExecution",
      status: value.status,
      ...(value.command === undefined ? {} : { command: boundedEvidenceText(value.command) }),
      ...(result === undefined ? {} : { result })
    };
  }
  if (value.type !== "fileChange" ||
      (strict && !hasOnlyEvidenceKeys(value, ["id", "type", "status", "changes"])) ||
      !Array.isArray(value.changes) ||
      (strict && value.changes.length > MAX_EXECUTOR_EVIDENCE_CHANGES)) return undefined;
  const sourceChanges = strict || value.changes.length <= MAX_EXECUTOR_EVIDENCE_CHANGES
    ? value.changes
    : value.changes.slice(0, MAX_EXECUTOR_EVIDENCE_CHANGES - 1);
  const changes: Array<{ path: string; diff: string }> = [];
  let dropped = value.changes.length - sourceChanges.length;
  for (const change of sourceChanges) {
    if (!evidenceObject(change) || (strict && !hasOnlyEvidenceKeys(change, ["path", "diff"])) ||
        typeof change.path !== "string" || typeof change.diff !== "string" ||
        (strict && (change.path.length > MAX_EXECUTOR_EVIDENCE_TEXT ||
          change.diff.length > MAX_EXECUTOR_EVIDENCE_TEXT))) {
      if (strict) return undefined;
      dropped += 1;
      continue;
    }
    changes.push({ path: boundedEvidenceText(change.path), diff: boundedEvidenceText(change.diff) });
  }
  if (dropped > 0) {
    changes.push({ path: EVIDENCE_TRUNCATION_MARKER, diff: `${dropped} change(s) dropped` });
  }
  return { id: value.id, type: "fileChange", status: value.status, changes };
}

function aggregateEvidence(evidence: readonly ExecutorEvidence[]): readonly ExecutorEvidence[] {
  if (evidenceEnvelopeWithinLimit(evidence)) return evidence;
  const retained: ExecutorEvidence[] = [];
  for (let index = 0; index < evidence.length; index += 1) {
    const remaining = evidence.length - index - 1;
    const marker: ExecutorEvidence = {
      id: "evidence-aggregate-drop",
      type: "commandExecution",
      status: "completed",
      command: `${remaining} evidence item(s) dropped: aggregate evidence byte limit exceeded`
    };
    const candidate = remaining === 0
      ? [...retained, evidence[index]!]
      : [...retained, evidence[index]!, marker];
    if (evidenceEnvelopeWithinLimit(candidate)) {
      retained.push(evidence[index]!);
      continue;
    }
    const dropped = evidence.length - index;
    return [...retained, { ...marker,
      command: `${dropped} evidence item(s) dropped: aggregate evidence byte limit exceeded` }];
  }
  return retained;
}

function normalizeExecutorEvidence(value: unknown, strict: boolean): readonly ExecutorEvidence[] | undefined {
  if (!Array.isArray(value) || (strict && value.length > MAX_EXECUTOR_EVIDENCE_ITEMS)) return undefined;
  const source = strict || value.length <= MAX_EXECUTOR_EVIDENCE_ITEMS
    ? value
    : value.slice(0, MAX_EXECUTOR_EVIDENCE_ITEMS - 1);
  const evidence: ExecutorEvidence[] = [];
  let dropped = value.length - source.length;
  for (const item of source) {
    const normalized = normalizeEvidenceItem(item, strict);
    if (normalized === undefined) {
      if (strict) return undefined;
      dropped += 1;
      continue;
    }
    evidence.push(normalized);
  }
  if (dropped > 0) {
    evidence.push({
      id: "evidence-structure-drop",
      type: "commandExecution",
      status: "completed",
      command: `${dropped} evidence item(s) dropped: structural evidence limit exceeded`
    });
  }
  return strict
    ? evidenceEnvelopeWithinLimit(evidence) ? evidence : undefined
    : aggregateEvidence(evidence);
}

export function validateExecutorEvidence(value: unknown): readonly ExecutorEvidence[] | undefined {
  return normalizeExecutorEvidence(value, true);
}

export function executorEvidenceWithinLimit(evidence: readonly ExecutorEvidence[]): boolean {
  return validateExecutorEvidence(evidence) !== undefined;
}

export function boundExecutorEvidence(
  evidence: readonly ExecutorEvidence[] | undefined
): readonly ExecutorEvidence[] | undefined {
  if (evidence === undefined || validateExecutorEvidence(evidence) !== undefined) return evidence;
  return normalizeExecutorEvidence(evidence, false);
}

export type TerminalTaskHandler = (result: RegisteredWorkspaceTaskResult) => void | Promise<void>;

function interruptedError(executor: ExecutorName): SerializedError {
  return serializeError(new CoreError(executor === "dsh" ? "DSH_EXECUTION_FAILED" : "CODEX_EXECUTION_FAILED"));
}

// Interrupt keeps the failed terminal state and its existing safe error, and
// additionally retains the executor's genuine partial output. Empty partial
// output (interrupt before anything was produced) is not fabricated: the field
// is simply omitted.
function normalizeRequest(request: RegisteredWorkspaceTaskRequest): NormalizedRegisteredWorkspaceTaskRequest {
  const executor = request.executor ?? "codex";
  if (executor === "codex") {
    if (request.parent_task_id !== undefined && !isId(request.parent_task_id)) {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    if (request.parent_task_id !== undefined && request.handoff_snapshot === undefined) {
      throw new CoreError("INVALID_HANDOFF_SNAPSHOT");
    }
    const handoffSnapshot = request.handoff_snapshot === undefined
      ? undefined
      : requireHandoffSnapshot(request.handoff_snapshot);
    const selection = routeCodexTask(request.routing, request.routing_input ?? request.instruction);
    return {
      workspace_id: request.workspace_id,
      instruction: request.instruction,
      executor,
      requestedRouting: selection.requestedRouting,
      logicalRole: selection.logicalRole,
      routingReason: selection.reason,
      routingMatchedRule: selection.matchedRule,
      routingMatchedFactors: selection.matchedFactors,
      routingIgnoredGuardFactors: selection.ignoredGuardFactors,
      ...(request.parent_task_id === undefined ? {} : { parentTaskId: request.parent_task_id }),
      ...(handoffSnapshot === undefined ? {} : { handoffSnapshot })
    };
  }
  if (request.routing === undefined && request.parent_task_id === undefined &&
      request.handoff_snapshot === undefined && request.routing_input === undefined) {
    return { workspace_id: request.workspace_id, instruction: request.instruction, executor };
  }
  throw new CoreError("INVALID_STATE_TRANSITION");
}

function metadataFields(
  request: NormalizedRegisteredWorkspaceTaskRequest,
  registry: CodexModelRegistry,
  metadata?: CodexTaskMetadata
): Pick<ControlledTaskView,
  "routing" | "logicalRole" | "routingReason" | "routingMatchedRule" | "routingMatchedFactors" |
  "routingIgnoredGuardFactors" | "parentTaskId" | "routingTransition" |
  "handoffSnapshot" | "model" | "reasoningEffort" | "codexVersion"> {
  if (request.executor === "dsh") return {};
  const role = registry[request.logicalRole];
  return {
    routing: request.requestedRouting,
    logicalRole: request.logicalRole,
    routingReason: request.routingReason,
    ...(request.requestedRouting === "auto" ? {
      routingMatchedRule: request.routingMatchedRule,
      routingMatchedFactors: request.routingMatchedFactors,
      routingIgnoredGuardFactors: request.routingIgnoredGuardFactors
    } : {}),
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    ...(request.routingTransition === undefined ? {} : { routingTransition: request.routingTransition }),
    ...(request.handoffSnapshot === undefined ? {} : { handoffSnapshot: request.handoffSnapshot }),
    model: metadata?.model ?? role.model,
    reasoningEffort: metadata?.reasoningEffort ?? role.effort,
    ...(metadata === undefined ? {} : { codexVersion: metadata.codexVersion })
  };
}

function interruptedTaskResult(
  taskId: Id,
  executor: ExecutorName,
  partialOutput: string,
  threadId?: string,
  metadata?: CodexTaskMetadata,
  evidence?: readonly ExecutorEvidence[]
): RegisteredWorkspaceTaskResult {
  const boundedEvidence = boundExecutorEvidence(evidence);
  const common = {
    ...(threadId === undefined ? {} : { threadId }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(boundedEvidence === undefined ? {} : { evidence: boundedEvidence })
  };
  if (partialOutput === "") {
    return { id: taskId, state: "failed", error: interruptedError(executor), ...common };
  }
  return { id: taskId, state: "failed", error: interruptedError(executor), partial_output: partialOutput, ...common };
}

export class RegisteredWorkspaceTaskService {
  private readonly tasks = new Map<Id, TaskRecord>();
  private readonly legacyExecutors = new Map<Id, Executor>();
  private readonly pinnedTaskIds = new Set<Id>();
  private legacyTerminalTaskIds: Id[] = [];

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly executorFactory: ExecutorFactory,
    private readonly modelRegistry: CodexModelRegistry = DEFAULT_CODEX_MODEL_REGISTRY
  ) {}

  runTask(
    request: RegisteredWorkspaceTaskRequest,
    completedOutputTransform?: CompletedOutputTransform,
    terminalTaskHandler?: TerminalTaskHandler,
    options?: LegacyTaskOptions
  ): { taskId: Id } {
    const normalizedRequest = this.normalizeAndLink(request);
    const taskId = newId();
    this.tasks.set(taskId, { state: "queued", request: normalizedRequest });
    queueMicrotask(() => void this.run(
      taskId, normalizedRequest, completedOutputTransform, terminalTaskHandler, options
    ));
    return { taskId };
  }

  pinTask(taskId: Id): void {
    this.pinnedTaskIds.add(taskId);
  }

  unpinTask(taskId: Id): void {
    this.pinnedTaskIds.delete(taskId);
    this.trimLegacyTerminalTasks();
  }

  restoreControlledPatchTask(
    taskId: Id,
    output: string,
    pinned: boolean,
    workspaceId: string,
    requestedRouting: CodexRouting,
    logicalRole: CodexLogicalRole,
    routingReason: CodexRoutingReason,
    routingMatchedRule: CodexRoutingRule,
    routingMatchedFactors: readonly string[],
    routingIgnoredGuardFactors: readonly string[],
    threadId: string,
    metadata: CodexTaskMetadata,
    evidence?: readonly ExecutorEvidence[],
    parentTaskId?: Id,
    handoffSnapshot?: HandoffSnapshot,
    restoredRoutingTransition?: "escalation" | "de_escalation" | "handoff"
  ): void {
    if (this.tasks.has(taskId) || this.interactive.has(taskId)) {
      throw new CoreError("INTERNAL_ERROR");
    }
    const request: NormalizedRegisteredWorkspaceTaskRequest = {
      workspace_id: workspaceId,
      instruction: "restored-controlled-patch",
      executor: "codex",
      requestedRouting,
      logicalRole,
      routingReason,
      routingMatchedRule,
      routingMatchedFactors,
      routingIgnoredGuardFactors,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      ...(handoffSnapshot === undefined ? {} : { handoffSnapshot }),
      ...(restoredRoutingTransition === undefined ? {} : { routingTransition: restoredRoutingTransition })
    };
    const result: RegisteredWorkspaceTaskResult = {
      id: taskId, state: "completed", output, threadId, metadata,
      ...(evidence === undefined ? {} : { evidence })
    };
    this.tasks.set(taskId, { state: "completed", request, result });
    this.legacyTerminalTaskIds.push(taskId);
    if (pinned) this.pinnedTaskIds.add(taskId);
    this.trimLegacyTerminalTasks();
  }

  restoreFailedControlledPatchTask(
    taskId: Id,
    error: SerializedError,
    workspaceId: string,
    requestedRouting: CodexRouting,
    logicalRole: CodexLogicalRole,
    routingReason: CodexRoutingReason,
    routingMatchedRule: CodexRoutingRule,
    routingMatchedFactors: readonly string[],
    routingIgnoredGuardFactors: readonly string[],
    threadId: string | undefined,
    metadata: CodexTaskMetadata | undefined,
    evidence?: readonly ExecutorEvidence[],
    parentTaskId?: Id,
    handoffSnapshot?: HandoffSnapshot,
    restoredRoutingTransition?: "escalation" | "de_escalation" | "handoff"
  ): void {
    if (this.tasks.has(taskId) || this.interactive.has(taskId)) throw new CoreError("INTERNAL_ERROR");
    const request: NormalizedRegisteredWorkspaceTaskRequest = {
      workspace_id: workspaceId,
      instruction: "restored-failed-controlled-patch",
      executor: "codex",
      requestedRouting,
      logicalRole,
      routingReason,
      routingMatchedRule,
      routingMatchedFactors,
      routingIgnoredGuardFactors,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      ...(handoffSnapshot === undefined ? {} : { handoffSnapshot }),
      ...(restoredRoutingTransition === undefined ? {} : { routingTransition: restoredRoutingTransition })
    };
    const result: RegisteredWorkspaceTaskResult = {
      id: taskId,
      state: "failed",
      error,
      ...(threadId === undefined ? {} : { threadId }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(evidence === undefined ? {} : { evidence })
    };
    this.tasks.set(taskId, { state: "failed", request, result });
    this.legacyTerminalTaskIds.push(taskId);
    this.trimLegacyTerminalTasks();
  }

  status(taskId: unknown): { taskId: Id; state: RegisteredWorkspaceTaskState } | undefined {
    if (!isId(taskId)) return undefined;
    const task = this.tasks.get(taskId);
    return task && { taskId, state: task.state };
  }

  result(taskId: unknown): RegisteredWorkspaceTaskResult | undefined {
    if (!isId(taskId)) return undefined;
    const task = this.tasks.get(taskId);
    return task?.state === "completed" || task?.state === "failed" ? task.result : undefined;
  }

  hasActiveWork(): boolean {
    for (const task of this.tasks.values()) {
      if (task.state === "queued" || task.state === "running") return true;
    }
    for (const task of this.interactive.values()) {
      if (task.state === "queued" || task.state === "running" ||
          task.state === "waiting_for_supervisor_review") return true;
    }
    return false;
  }

  startTask(request: RegisteredWorkspaceTaskRequest): { taskId: Id } {
    const normalizedRequest = this.normalizeAndLink(request);
    const taskId = newId();
    this.interactive.set(taskId, { state: "queued", request: normalizedRequest, evidence: [] });
    queueMicrotask(() => void this.executeInteractive(taskId));
    return { taskId };
  }

  taskView(taskId: unknown): ControlledTaskView | undefined {
    if (!isId(taskId)) return undefined;
    const record = this.interactive.get(taskId);
    if (!record) {
      const legacy = this.tasks.get(taskId);
      if (!legacy) return undefined;
      if (!("result" in legacy)) {
        return {
          taskId,
          state: legacy.state,
          executor: legacy.request.executor,
          ...metadataFields(legacy.request, this.modelRegistry),
          ready: false
        };
      }
      return legacy.result.state === "completed"
        ? {
          taskId,
          state: "completed",
          executor: legacy.request.executor,
          ...metadataFields(legacy.request, this.modelRegistry, legacy.result.metadata),
          ...(legacy.result.threadId === undefined ? {} : { threadId: legacy.result.threadId }),
          ...(legacy.result.evidence === undefined ? {} : { evidence: legacy.result.evidence }),
          ready: true,
          output: legacy.result.output
        }
        : {
          taskId,
          state: "failed",
          executor: legacy.request.executor,
          ...metadataFields(legacy.request, this.modelRegistry, legacy.result.metadata),
          ...(legacy.result.threadId === undefined ? {} : { threadId: legacy.result.threadId }),
          ...(legacy.result.evidence === undefined ? {} : { evidence: legacy.result.evidence }),
          ready: true,
          error: legacy.result.error,
          ...(legacy.result.partial_output === undefined ? {} : { partial_output: legacy.result.partial_output })
        };
    }
    const base: ControlledTaskView = {
      taskId,
      state: record.state,
      executor: record.request.executor,
      ...metadataFields(record.request, this.modelRegistry, record.metadata),
      evidence: record.evidence,
      ...(record.threadId === undefined ? {} : { threadId: record.threadId })
    };
    if (record.state === "queued" || record.state === "running") return { ...base, ready: false };
    if (record.state === "waiting_for_supervisor_review") return { ...base, ready: true, review_output: record.output };
    if (record.state === "completed") return { ...base, ready: true, output: record.output };
    return {
      ...base,
      ready: true,
      error: record.error,
      ...(record.partialOutput === undefined || record.partialOutput === ""
        ? {}
        : { partial_output: record.partialOutput })
    };
  }

  async controlTask(taskId: unknown, action: "continue" | "steer" | "interrupt" | "accept", instruction?: string): Promise<ControlledTaskView> {
    if (!isId(taskId)) throw new CoreError("INVALID_STATE_TRANSITION");
    const record = this.interactive.get(taskId);
    if (!record) {
      const legacy = this.tasks.get(taskId);
      const executor = this.legacyExecutors.get(taskId);
      if (legacy?.state !== "running" || executor === undefined ||
          !["steer", "interrupt"].includes(action)) throw new CoreError("INVALID_STATE_TRANSITION");
      if (action === "steer") {
        if (!instruction?.trim() || executor.steer === undefined) throw new CoreError("INVALID_STATE_TRANSITION");
        await executor.steer(instruction);
      } else {
        if (executor.interrupt === undefined) throw new CoreError("INVALID_STATE_TRANSITION");
        await executor.interrupt();
      }
      return this.taskView(taskId)!;
    }
    if (action === "accept") {
      if (record.state !== "waiting_for_supervisor_review") throw new CoreError("INVALID_STATE_TRANSITION");
      record.state = "completed";
      this.interactiveTerminalTaskIds.push(taskId);
      this.trimInteractiveTerminalTasks();
    } else if (action === "continue") {
      if (record.state !== "waiting_for_supervisor_review" || !instruction?.trim()) throw new CoreError("INVALID_STATE_TRANSITION");
      record.request = { ...record.request, instruction };
      record.state = "queued";
      queueMicrotask(() => void this.executeInteractive(taskId));
    } else if (action === "steer") {
      if (record.state !== "running" || !instruction?.trim() || !record.executor?.steer) throw new CoreError("INVALID_STATE_TRANSITION");
      await record.executor.steer(instruction);
    } else {
      if (record.state !== "running" || !record.executor?.interrupt) throw new CoreError("INVALID_STATE_TRANSITION");
      await record.executor.interrupt();
    }
    return this.taskView(taskId)!;
  }

  private readonly interactive = new Map<Id, {
    state: ControlledTaskState; request: NormalizedRegisteredWorkspaceTaskRequest; evidence: readonly ExecutorEvidence[];
    executor?: Executor | undefined; threadId?: string | undefined; output?: string | undefined;
    partialOutput?: string | undefined; error?: SerializedError | undefined; metadata?: CodexTaskMetadata | undefined;
  }>();
  private interactiveTerminalTaskIds: Id[] = [];

  private normalizeAndLink(request: RegisteredWorkspaceTaskRequest): NormalizedRegisteredWorkspaceTaskRequest {
    const normalized = normalizeRequest(request);
    if (normalized.executor === "dsh" || normalized.parentTaskId === undefined) return normalized;
    const parentRole = this.taskLogicalRole(normalized.parentTaskId);
    if (parentRole === undefined) throw new CoreError("INVALID_STATE_TRANSITION");
    return {
      ...normalized,
      routingTransition: routingTransition(parentRole, normalized.logicalRole)
    };
  }

  private taskLogicalRole(taskId: Id): CodexLogicalRole | undefined {
    const request = this.interactive.get(taskId)?.request ?? this.tasks.get(taskId)?.request;
    return request?.executor === "codex" ? request.logicalRole : undefined;
  }

  private async executeInteractive(taskId: Id): Promise<void> {
    const record = this.interactive.get(taskId);
    if (!record) return;
    record.state = "running";
    try {
      const registration = this.registry.resolveExecution(record.request.workspace_id);
      const executor = this.executorFactory(record.request.executor, registration.root);
      record.executor = executor;
      const instruction = record.request.executor === "codex" && record.threadId === undefined
        ? appendHandoffSnapshot(record.request.instruction, record.request.handoffSnapshot)
        : record.request.instruction;
      const result = await executor.execute({ taskId, instruction,
        sandbox: "read-only", threadId: record.threadId, logicalRole: record.request.logicalRole,
        ...(record.request.executor === "dsh" ? {} : { onThreadStarted: (threadId: string) => {
          if (record.state !== "running" || record.executor !== executor) return;
          if (record.threadId !== undefined && record.threadId !== threadId) {
            throw new CoreError("CODEX_ROLE_THREAD_MISMATCH");
          }
          record.threadId = threadId;
        } }),
        onEvidence: (items) => { record.evidence = boundExecutorEvidence(items) ?? []; } });
      record.executor = undefined;
      record.threadId = result.threadId ?? record.threadId;
      record.metadata = result.metadata ?? record.metadata;
      record.evidence = boundExecutorEvidence(result.evidence) ?? record.evidence;
      if (result.kind === "failed") { record.state = "failed"; record.error = result.error; }
      else if (result.kind === "interrupted") {
        // The failed terminal state and its safe error are unchanged; the
        // executor's genuine partial output is retained separately and never
        // treated as completed review output.
        record.partialOutput = result.output;
        record.output = undefined;
        record.state = "failed";
        record.error = interruptedError(record.request.executor);
      } else { record.state = "waiting_for_supervisor_review"; record.output = result.output; }
      if (record.state === "failed") this.recordInteractiveTerminalTask(taskId);
    } catch (error) {
      record.executor = undefined;
      record.state = "failed";
      record.error = serializeError(error);
      this.recordInteractiveTerminalTask(taskId);
    }
  }

  private async run(
    taskId: Id,
    request: NormalizedRegisteredWorkspaceTaskRequest,
    completedOutputTransform?: CompletedOutputTransform,
    terminalTaskHandler?: TerminalTaskHandler,
    options?: LegacyTaskOptions
  ): Promise<void> {
    this.tasks.set(taskId, { state: "running", request });
    try {
      const workspaceRoot = this.registry.resolve(request.workspace_id);
      const executor = this.executorFactory(request.executor, workspaceRoot);
      this.legacyExecutors.set(taskId, executor);
      const result = await executor.execute({
        taskId,
        instruction: request.executor === "codex"
          ? appendHandoffSnapshot(request.instruction, request.handoffSnapshot)
          : request.instruction,
        sandbox: "read-only",
        logicalRole: request.logicalRole,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(request.executor === "dsh" || options?.onThreadStarted === undefined
          ? {}
          : { onThreadStarted: options.onThreadStarted })
      });
      const evidence = boundExecutorEvidence(result.evidence);
      const taskResult: RegisteredWorkspaceTaskResult = result.kind === "completed"
        ? {
          id: taskId,
          state: "completed",
          output: completedOutputTransform === undefined
            ? result.output
            : completedOutputTransform(result.output),
          ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
          ...(evidence === undefined ? {} : { evidence }),
          ...(result.metadata === undefined ? {} : { metadata: result.metadata })
        }
        : result.kind === "failed"
          ? {
            id: taskId,
            state: "failed",
            error: result.error,
            ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
            ...(evidence === undefined ? {} : { evidence }),
            ...(result.metadata === undefined ? {} : { metadata: result.metadata })
          }
          : interruptedTaskResult(
            taskId, request.executor, result.output, result.threadId, result.metadata, evidence
          );
      await this.recordLegacyTerminalTask(taskId, taskResult, terminalTaskHandler);
    } catch (error) {
      const result: RegisteredWorkspaceTaskResult = {
        id: taskId,
        state: "failed",
        error: serializeError(error)
      };
      await this.recordLegacyTerminalTask(taskId, result);
    }
  }

  private async recordLegacyTerminalTask(
    taskId: Id,
    result: RegisteredWorkspaceTaskResult,
    terminalTaskHandler?: TerminalTaskHandler
  ): Promise<void> {
    await terminalTaskHandler?.(result);
    this.legacyExecutors.delete(taskId);
    const request = this.tasks.get(taskId)?.request;
    if (request === undefined) throw new CoreError("INTERNAL_ERROR");
    this.tasks.set(taskId, { state: result.state, request, result });
    this.legacyTerminalTaskIds.push(taskId);
    this.trimLegacyTerminalTasks();
  }

  private recordInteractiveTerminalTask(taskId: Id): void {
    this.interactiveTerminalTaskIds.push(taskId);
    this.trimInteractiveTerminalTasks();
  }

  private trimLegacyTerminalTasks(): void {
    const terminalTaskIds = this.legacyTerminalTaskIds.filter((taskId) => {
      const task = this.tasks.get(taskId);
      return task?.state === "completed" || task?.state === "failed";
    });
    const unpinnedTaskIds = terminalTaskIds.filter((taskId) => !this.pinnedTaskIds.has(taskId));
    const evictedTaskIds = new Set(unpinnedTaskIds.slice(
      0,
      Math.max(0, unpinnedTaskIds.length - MAX_TERMINAL_TASK_HISTORY)
    ));
    for (const taskId of evictedTaskIds) this.tasks.delete(taskId);
    this.legacyTerminalTaskIds = terminalTaskIds.filter((taskId) => !evictedTaskIds.has(taskId));
  }

  private trimInteractiveTerminalTasks(): void {
    const terminalTaskIds = this.interactiveTerminalTaskIds.filter((taskId) => {
      const task = this.interactive.get(taskId);
      return task?.state === "completed" || task?.state === "failed";
    });
    const evictedTaskIds = new Set(terminalTaskIds.slice(
      0,
      Math.max(0, terminalTaskIds.length - MAX_TERMINAL_TASK_HISTORY)
    ));
    for (const taskId of evictedTaskIds) this.interactive.delete(taskId);
    this.interactiveTerminalTaskIds = terminalTaskIds.filter((taskId) => !evictedTaskIds.has(taskId));
  }
}
