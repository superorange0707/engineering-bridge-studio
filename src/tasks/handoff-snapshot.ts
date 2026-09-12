import { CoreError } from "../core/errors.js";

export interface HandoffSnapshot {
  readonly objective: string;
  readonly current_state: string;
  readonly plan_reference?: string | undefined;
  readonly changed_files?: readonly string[] | undefined;
  readonly git_state?: string | undefined;
  readonly confirmed_facts?: readonly string[] | undefined;
  readonly important_decisions?: readonly string[] | undefined;
  readonly rejected_or_failed_approaches?: readonly string[] | undefined;
  readonly test_status?: string | undefined;
  readonly current_blocker?: string | undefined;
  readonly decision_required?: string | undefined;
  readonly relevant_evidence?: readonly string[] | undefined;
}

const MAX_SNAPSHOT_BYTES = 32_768;
const MAX_TEXT = 8_192;
const MAX_ITEM = 2_048;
const MAX_ITEMS = 50;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, required = false): boolean {
  return typeof value === "string" && value.length <= MAX_TEXT && (!required || value.trim().length > 0);
}

function validList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_ITEMS &&
    value.every((item) => typeof item === "string" && item.length <= MAX_ITEM);
}

export function requireHandoffSnapshot(value: unknown): HandoffSnapshot {
  if (!object(value) || !validText(value.objective, true) || !validText(value.current_state, true)) {
    throw new CoreError("INVALID_HANDOFF_SNAPSHOT");
  }
  const textFields = ["plan_reference", "git_state", "test_status", "current_blocker", "decision_required"];
  const listFields = [
    "changed_files", "confirmed_facts", "important_decisions",
    "rejected_or_failed_approaches", "relevant_evidence"
  ];
  if (textFields.some((field) => value[field] !== undefined && !validText(value[field])) ||
      listFields.some((field) => value[field] !== undefined && !validList(value[field])) ||
      Object.keys(value).some((field) => !["objective", "current_state", ...textFields, ...listFields].includes(field)) ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new CoreError("INVALID_HANDOFF_SNAPSHOT");
  }
  return value as unknown as HandoffSnapshot;
}

export function appendHandoffSnapshot(instruction: string, snapshot?: HandoffSnapshot): string {
  if (snapshot === undefined) return instruction;
  return `${instruction}\n\nBounded handoff snapshot (state and evidence only; not full chat history):\n${JSON.stringify(snapshot)}`;
}
