export const ERROR_CODES = [
  "INTERNAL_ERROR",
  "INVALID_STATE_TRANSITION",
  "UNKNOWN_WORKSPACE",
  "WORKSPACE_BOUNDARY_VIOLATION",
  "WORKSPACE_PRECONDITION_FAILED",
  "WORKSPACE_IDENTITY_MISMATCH",
  "WORKSPACE_IDENTITY_AMBIGUOUS",
  "WORKSPACE_SCAN_LIMIT_EXCEEDED",
  "CODEX_UNAVAILABLE",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_EXECUTION_FAILED",
  "CODEX_EXECUTION_TIMEOUT",
  "CONTROLLED_PROPOSAL_ORPHANED",
  "CONTROLLED_PROPOSAL_VALIDATION_FAILED",
  "CODEX_ROLE_MODEL_UNAVAILABLE",
  "CODEX_MAX_REASONING_UNAVAILABLE",
  "CODEX_ROLE_THREAD_MISMATCH",
  "INVALID_HANDOFF_SNAPSHOT",
  "DSH_UNAVAILABLE",
  "DSH_PROTOCOL_ERROR",
  "DSH_EXECUTION_FAILED"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedError {
  code: ErrorCode;
  message: string;
}

const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INTERNAL_ERROR: "The request could not be completed.",
  INVALID_STATE_TRANSITION: "The requested state transition is not allowed.",
  UNKNOWN_WORKSPACE: "The requested workspace is not registered.",
  WORKSPACE_BOUNDARY_VIOLATION: "The workspace boundary could not be verified.",
  WORKSPACE_PRECONDITION_FAILED: "The workspace preconditions were not met.",
  WORKSPACE_IDENTITY_MISMATCH: "The repository identity does not match the registered workspace.",
  WORKSPACE_IDENTITY_AMBIGUOUS: "More than one repository matches the registered workspace identity.",
  WORKSPACE_SCAN_LIMIT_EXCEEDED: "The approved-root repository scan exceeded its deterministic limit.",
  CODEX_UNAVAILABLE: "Codex is unavailable.",
  CODEX_PROTOCOL_ERROR: "Codex returned an invalid response.",
  CODEX_EXECUTION_FAILED: "Codex execution failed.",
  CODEX_EXECUTION_TIMEOUT: "Codex execution exceeded the controlled task deadline.",
  CONTROLLED_PROPOSAL_ORPHANED: "The controlled proposal was interrupted by a Bridge restart.",
  CONTROLLED_PROPOSAL_VALIDATION_FAILED: "The controlled proposal failed deterministic validation.",
  CODEX_ROLE_MODEL_UNAVAILABLE: "The required Codex role model is unavailable.",
  CODEX_MAX_REASONING_UNAVAILABLE: "The required Codex role model does not support Max reasoning.",
  CODEX_ROLE_THREAD_MISMATCH: "The Codex thread model does not match the recorded role.",
  INVALID_HANDOFF_SNAPSHOT: "The handoff snapshot is invalid or exceeds its size limits.",
  DSH_UNAVAILABLE: "DSH is unavailable.",
  DSH_PROTOCOL_ERROR: "DSH returned an invalid response.",
  DSH_EXECUTION_FAILED: "DSH execution failed."
};

function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

export class CoreError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CoreError";
  }
}

export function serializeError(error: unknown): SerializedError {
  const code = error instanceof CoreError && isErrorCode(error.code)
    ? error.code
    : "INTERNAL_ERROR";
  return {
    code,
    message: ERROR_MESSAGES[code]
  };
}
