import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectWorkspace,
  inspectGitWorkspace,
  isHighConfidenceFilesystemMatch,
  isHighConfidenceRepositoryMatch,
  isMatchable,
  normalizeGitRemote,
  repositoryIdentity,
  stableObjectIdentity
} from "../../../src/workspaces/repository-identity.js";

test("normalizes network remotes without credentials or transport differences", () => {
  assert.equal(normalizeGitRemote("https://example-user@example.com/Org/repo.git"), "example.com/Org/repo");
  assert.equal(normalizeGitRemote("git@example.com:Org/repo.git"), "example.com/Org/repo");
  assert.match(normalizeGitRemote("/local/repo.git"), /^local-sha256:[0-9a-f]{64}$/);
  assert.notEqual(normalizeGitRemote("../repo.git", "/one/worktree"),
    normalizeGitRemote("../repo.git", "/two/worktree"));
});

test("repository identity matches by deterministic Git evidence, never folder name", () => {
  const first = repositoryIdentity("sha1", ["example.com/org/repo"], ["a".repeat(40)]);
  const moved = repositoryIdentity("sha1", ["example.com/org/repo"], ["a".repeat(40)]);
  const sameNameDifferentRepo = repositoryIdentity("sha1", ["example.com/other/repo"], ["b".repeat(40)]);

  assert.equal(isHighConfidenceRepositoryMatch(first, moved), true);
  assert.equal(isHighConfidenceRepositoryMatch(first, sameNameDifferentRepo), false);
  assert.equal(isMatchable(repositoryIdentity("sha1", [], [])), false);
  const unborn = repositoryIdentity("sha1", [], [], "c".repeat(64));
  assert.equal(isMatchable(unborn), true);
  assert.equal(isHighConfidenceRepositoryMatch(unborn, repositoryIdentity("sha1", [], [], "c".repeat(64))), true);
  assert.equal(isHighConfidenceRepositoryMatch(
    repositoryIdentity("sha1", [], ["d".repeat(40)]),
    repositoryIdentity("sha1", [], ["d".repeat(40)])
  ), false, "a shared root commit alone can also describe forks and is not high confidence");
  assert.equal(isHighConfidenceRepositoryMatch(
    repositoryIdentity("sha1", ["example.com/org/repo", "example.com/upstream/repo"], ["d".repeat(40)]),
    repositoryIdentity("sha1", ["example.com/other-fork/repo", "example.com/upstream/repo"], ["d".repeat(40)])
  ), false, "a shared upstream remote alone is not high confidence");
});

test("inspects a logical subproject separately from its physical Git top-level", async () => {
  const calls: string[][] = [];
  const inspected = await inspectGitWorkspace("/repo/packages/app", async (_cwd, args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
    if (args[0] === "rev-parse") return "sha1\n";
    if (args[0] === "rev-list") return `${"a".repeat(40)}\n`;
    if (args[0] === "remote") return args.length === 1 ? "origin\n" : "git@example.com:org/repo.git\n";
    return "";
  }, async (path) => path);

  assert.equal(inspected.root, "/repo/packages/app");
  assert.equal(inspected.gitTopLevel, "/repo");
  assert.equal(inspected.logicalRoot, "packages/app");
  assert.deepEqual(inspected.repository.normalizedRemotes, ["example.com/org/repo"]);
  assert.equal(calls.some((args) => args.join(" ") === "remote get-url --all origin"), true);
});

test("inspects non-Git directories as first-class workspaces with filesystem evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-directory-identity-"));
  const inspected = await inspectWorkspace(directory);

  assert.equal(inspected.root, realpathSync(directory));
  assert.equal(inspected.workspaceType, "directory_workspace");
  assert.match(inspected.filesystem.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(inspected.filesystem.localMetadataId ?? "", /^[0-9a-f]{64}$/);
  assert.equal(inspected.filesystem.stableObjectIdentity?.version, 2);
  assert.match(inspected.filesystem.stableObjectIdentity?.id ?? "", /^[0-9a-f]{64}$/);
  assert.match(inspected.filesystem.stableObjectIdentity?.inode ?? "", /^[1-9][0-9]*$/);
  assert.match(inspected.filesystem.stableObjectIdentity?.birthtimeNs ?? "", /^[1-9][0-9]*$/);
  assert.equal(inspected.git, undefined);
});

test("identity v2 ignores device observations but rejects replacement evidence and legacy mixing", () => {
  const before = stableObjectIdentity("42", "1700000000000000000", "16777243");
  const renumbered = stableObjectIdentity("42", "1700000000000000000", "16777299");
  const replacement = stableObjectIdentity("43", "1700000000000000001", "16777299");
  const beforeFilesystem = {
    fingerprint: "1".repeat(64), localMetadataId: "2".repeat(64), stableObjectIdentity: before
  };
  const renumberedFilesystem = {
    fingerprint: "3".repeat(64), localMetadataId: "4".repeat(64), stableObjectIdentity: renumbered
  };
  const replacementFilesystem = {
    fingerprint: "5".repeat(64), localMetadataId: "6".repeat(64), stableObjectIdentity: replacement
  };

  assert.equal(isHighConfidenceFilesystemMatch(beforeFilesystem, renumberedFilesystem), true);
  assert.equal(isHighConfidenceFilesystemMatch(beforeFilesystem, replacementFilesystem), false);
  assert.equal(isHighConfidenceFilesystemMatch(
    beforeFilesystem,
    { fingerprint: "7".repeat(64), localMetadataId: beforeFilesystem.localMetadataId }
  ), false, "legacy and identity-v2 evidence must not be silently reinterpreted");
});

test("Git identity v2 rejects a different common directory even when remotes match", () => {
  const remote = ["example.com/org/repo"];
  const roots = ["a".repeat(40)];
  const original = repositoryIdentity(
    "sha1", remote, roots, "1".repeat(64),
    stableObjectIdentity("50", "1700000000000000100", "16777243")
  );
  const renumbered = repositoryIdentity(
    "sha1", remote, roots, "2".repeat(64),
    stableObjectIdentity("50", "1700000000000000100", "16777299")
  );
  const copiedClone = repositoryIdentity(
    "sha1", remote, roots, "3".repeat(64),
    stableObjectIdentity("51", "1700000000000000200", "16777299")
  );

  assert.equal(isHighConfidenceRepositoryMatch(original, renumbered), true);
  assert.equal(isHighConfidenceRepositoryMatch(original, copiedClone), false);
});
