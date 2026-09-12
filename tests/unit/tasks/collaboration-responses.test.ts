import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import type { Id } from "../../../src/core/ids.js";
import { artifactPage, historyPage, MAX_ARTIFACT_CHUNK_BYTES } from "../../../src/tasks/collaboration-responses.js";

const runId = randomUUID() as Id;
function artifact(bytes: Buffer, text: boolean) {
  return {
    run_id: runId, path: "result.txt", bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(text ? { content: bytes.toString("utf8") } : { content_base64: bytes.toString("base64") })
  };
}

test("artifact pages reconstruct UTF-8 split across boundaries and binary without changing the complete hash", () => {
  for (const [bytes, text] of [[Buffer.from("a中🙂z"), true], [Buffer.from([0, 255, 128, 42]), false]] as const) {
    const saved = artifact(bytes, text);
    let offset: number | null = 0;
    const pieces: Buffer[] = [];
    while (offset !== null) {
      const page = artifactPage(saved, offset, 2);
      assert.equal(page.sha256, saved.sha256);
      assert.equal(page.bytes, bytes.length);
      assert.equal(page.offset_bytes, offset);
      assert.ok(page.chunk_bytes <= 2);
      assert.equal(page.eof, page.next_offset_bytes === null);
      pieces.push("content_base64" in page
        ? Buffer.from(page.content_base64, "base64") : Buffer.from(page.content, "utf8"));
      offset = page.next_offset_bytes;
    }
    assert.deepEqual(Buffer.concat(pieces), bytes);
  }
});

test("artifact responses are bounded, handle empty files and reject invalid offsets or lengths", () => {
  const saved = artifact(Buffer.alloc(MAX_ARTIFACT_CHUNK_BYTES + 5, 97), true);
  const first = artifactPage(saved);
  assert.equal(first.chunk_bytes, MAX_ARTIFACT_CHUNK_BYTES);
  assert.equal(first.next_offset_bytes, MAX_ARTIFACT_CHUNK_BYTES);
  assert.equal(first.eof, false);
  const last = artifactPage(saved, first.next_offset_bytes);
  assert.ok("content" in last);
  assert.equal(last.content, "aaaaa");
  const empty = artifactPage(artifact(Buffer.alloc(0), true));
  assert.ok("content" in empty);
  assert.equal(empty.content, "");
  assert.equal(empty.eof, true);
  assert.throws(() => artifactPage(saved, -1));
  assert.throws(() => artifactPage(saved, saved.bytes + 1));
  assert.throws(() => artifactPage(saved, 0, MAX_ARTIFACT_CHUNK_BYTES + 1));
  assert.throws(() => artifactPage({ ...saved, bytes: 1 }));
});

test("history pages bound summaries, preserve order and expose full-contract retrieval IDs", () => {
  const runs = Array.from({ length: 55 }, (_, index) => ({
    run_id: randomUUID() as Id, workspace_id: runId, state: "accepted" as const,
    objective: `${index}: ${"x".repeat(8192)}`, created_at: new Date().toISOString()
  }));
  const first = historyPage(runs);
  assert.equal(first.total, 55);
  assert.equal(first.runs.length, 20);
  assert.equal(first.next_offset, 20);
  assert.equal(first.runs[0]?.run_id, runs[0]?.run_id);
  assert.ok((first.runs[0]?.objective.length ?? Infinity) < 550);
  assert.match(first.runs[0]?.objective ?? "", /\[truncated\]$/);
  const last = historyPage(runs, 40);
  assert.equal(last.runs.length, 15);
  assert.equal(last.next_offset, null);
  assert.equal(historyPage(runs, 55).runs.length, 0);
  assert.throws(() => historyPage(runs, 0, 51));
});
