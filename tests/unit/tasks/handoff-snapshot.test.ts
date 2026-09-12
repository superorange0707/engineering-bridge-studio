import assert from "node:assert/strict";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { appendHandoffSnapshot, requireHandoffSnapshot } from "../../../src/tasks/handoff-snapshot.js";

test("accepts and serializes the bounded reusable handoff contract", () => {
  const snapshot = requireHandoffSnapshot({
    objective: "Finish the parser fix",
    current_state: "Root cause confirmed",
    changed_files: ["src/parser.ts"],
    confirmed_facts: ["The failure reproduces in one test"],
    test_status: "One test failing",
    relevant_evidence: ["tests/parser.test.ts:42"]
  });
  const instruction = appendHandoffSnapshot("Implement the fix", snapshot);
  assert.match(instruction, /state and evidence only; not full chat history/);
  assert.match(instruction, /Root cause confirmed/);
});

test("rejects missing required state, unknown fields, and oversized snapshots", () => {
  for (const value of [
    { objective: "", current_state: "known" },
    { objective: "work", current_state: "known", chat_history: "not accepted" },
    { objective: "work", current_state: "x".repeat(40_000) }
  ]) {
    assert.throws(() => requireHandoffSnapshot(value),
      (error: unknown) => error instanceof CoreError && error.code === "INVALID_HANDOFF_SNAPSHOT");
  }
});
