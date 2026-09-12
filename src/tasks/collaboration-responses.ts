import { isUtf8 } from "node:buffer";

import { CoreError } from "../core/errors.js";
import type { CollaborationRunService, CollaborationRunSummary } from "./collaboration-run-service.js";

export const MAX_ARTIFACT_CHUNK_BYTES = 64 * 1024;
export const MAX_HISTORY_PAGE_SIZE = 50;

type VerifiedArtifact = Awaited<ReturnType<CollaborationRunService["readArtifact"]>>;

/** Page only after the service has checked the complete artifact against its saved hash. */
export function artifactPage(artifact: VerifiedArtifact, offsetBytes = 0, maxBytes = MAX_ARTIFACT_CHUNK_BYTES) {
  const bytes = artifact.content_base64 === undefined
    ? Buffer.from(artifact.content ?? "", "utf8")
    : Buffer.from(artifact.content_base64, "base64");
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > bytes.length ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_CHUNK_BYTES ||
      bytes.length !== artifact.bytes) {
    throw new CoreError("CONTROLLED_PROPOSAL_VALIDATION_FAILED");
  }
  const chunk = bytes.subarray(offsetBytes, offsetBytes + maxBytes);
  const nextOffset = offsetBytes + chunk.length;
  return {
    run_id: artifact.run_id,
    path: artifact.path,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    offset_bytes: offsetBytes,
    chunk_bytes: chunk.length,
    next_offset_bytes: nextOffset < bytes.length ? nextOffset : null,
    eof: nextOffset === bytes.length,
    // A page can split a UTF-8 code point; base64 preserves those bytes for reassembly.
    ...(artifact.content !== undefined && isUtf8(chunk)
      ? { content: chunk.toString("utf8") }
      : { content_base64: chunk.toString("base64") })
  };
}

export function historyPage(runs: readonly CollaborationRunSummary[], offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > MAX_HISTORY_PAGE_SIZE) {
    throw new CoreError("CONTROLLED_PROPOSAL_VALIDATION_FAILED");
  }
  const page = runs.slice(offset, offset + limit).map((run) => ({
    ...run,
    objective: run.objective.length > 512 ? `${run.objective.slice(0, 512)} [truncated]` : run.objective
  }));
  return {
    runs: page,
    total: runs.length,
    offset,
    next_offset: offset + page.length < runs.length ? offset + page.length : null
  };
}
