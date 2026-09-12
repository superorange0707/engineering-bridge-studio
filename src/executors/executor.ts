import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";
import type { CodexLogicalRole, CodexTaskMetadata } from "./codex-model-registry.js";

export type SandboxMode = "read-only" | "workspace-write";

export interface EvidenceChange { readonly path: string; readonly diff: string }
export type EvidenceResultReason =
  | "non_success"
  | "unsafe_action"
  | "unsafe_cwd"
  | "unsafe_path"
  | "secret_risk"
  | "missing_output"
  | "unsafe_output";
export interface EvidenceCommandResult {
  readonly state: "complete" | "truncated" | "withheld";
  readonly exit_code?: number;
  readonly output?: string;
  readonly reason?: EvidenceResultReason;
}
export interface ExecutorEvidence {
  readonly id: string;
  readonly type: "commandExecution" | "fileChange";
  readonly status: string;
  readonly command?: string;
  readonly result?: EvidenceCommandResult;
  readonly changes?: readonly EvidenceChange[];
}

export interface ExecutorRequest {
  readonly taskId: Id;
  readonly instruction: string;
  readonly sandbox?: SandboxMode;
  readonly threadId?: string | undefined;
  readonly logicalRole?: CodexLogicalRole | undefined;
  // Internal execution bound. MCP callers cannot choose it.
  readonly timeoutMs?: number | undefined;
  readonly onThreadStarted?: (threadId: string) => void;
  readonly onEvidence?: (evidence: readonly ExecutorEvidence[]) => void;
}

export type ExecutorResult =
  | { readonly kind: "completed" | "interrupted"; readonly output: string; readonly threadId?: string | undefined; readonly evidence?: readonly ExecutorEvidence[]; readonly metadata?: CodexTaskMetadata | undefined }
  | { readonly kind: "failed"; readonly error: SerializedError; readonly threadId?: string | undefined; readonly evidence?: readonly ExecutorEvidence[]; readonly metadata?: CodexTaskMetadata | undefined };

export interface Executor {
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
  steer?(instruction: string): Promise<void>;
  interrupt?(): Promise<void>;
}
