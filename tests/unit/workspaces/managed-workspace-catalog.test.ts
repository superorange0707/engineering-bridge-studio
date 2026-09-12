import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { isId, newId } from "../../../src/core/ids.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import {
  filesystemIdentity,
  repositoryIdentity,
  stableObjectIdentity
} from "../../../src/workspaces/repository-identity.js";

function catalogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bridge-catalog-")), "managed-workspaces.json");
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

test("loads an absent catalog as empty and round-trips registrations through the file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-"));
  const path = join(directory, "managed-workspaces.json");
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  assert.deepEqual(catalog.entries(), []);

  const first = await catalog.registerOnce("/canonical/a");
  assert.equal(first.created, true);
  const second = await catalog.registerOnce("/canonical/b");

  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [
    { id: first.id, root: "/canonical/a", allowWrite: false },
    { id: second.id, root: "/canonical/b", allowWrite: false }
  ]);
  // Atomic writes leave no temporary files behind.
  assert.deepEqual(readdirSync(directory), ["managed-workspaces.json"]);
});

test("registerOnce returns the existing id for the same root without duplicating", async () => {
  const catalog = new ManagedWorkspaceCatalog(undefined);
  const first = await catalog.registerOnce("/canonical/a");
  const second = await catalog.registerOnce("/canonical/a");

  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  assert.deepEqual(catalog.entries(), [{ id: first.id, root: "/canonical/a", allowWrite: false }]);
});

test("concurrent registerOnce calls for the same root converge on one id and one record", async () => {
  const path = catalogPath();
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();

  const [first, second] = await Promise.all([
    catalog.registerOnce("/canonical/same"),
    catalog.registerOnce("/canonical/same")
  ]);

  assert.equal(first.id, second.id);
  assert.notEqual(first.created, second.created);

  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [{ id: first.id, root: "/canonical/same", allowWrite: false }]);
});

test("a persist failure rolls back the in-memory record and allows a later retry", async () => {
  const path = catalogPath();
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();

  // Block the state file path with a directory so the atomic rename fails.
  mkdirSync(path);
  await expectCode(() => catalog.registerOnce("/canonical/x"), "INTERNAL_ERROR");
  assert.deepEqual(catalog.entries(), []);

  rmSync(path, { recursive: true, force: true });
  const retried = await catalog.registerOnce("/canonical/x");
  assert.equal(retried.created, true);
  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [{ id: retried.id, root: "/canonical/x", allowWrite: false }]);
});

test("skips individually invalid records and rejects a corrupt whole file", async () => {
  const path = catalogPath();
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    workspaces: [
      { id: "not-a-uuid", root: "/canonical/bad-id" },
      { id: "00000000-0000-4000-8000-000000000001", root: "relative/root" },
      { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/ok" },
      { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/dup-id" },
      { id: "00000000-0000-4000-8000-000000000003", root: "/canonical/ok" }
    ]
  }, null, 2)}\n`);

  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  assert.deepEqual(catalog.entries(), [
    { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/ok", allowWrite: false }
  ]);

  writeFileSync(path, "not json at all");
  await expectCode(() => new ManagedWorkspaceCatalog(path).load(), "INTERNAL_ERROR");

  writeFileSync(path, `${JSON.stringify({ version: 4, workspaces: [] })}\n`);
  await expectCode(() => new ManagedWorkspaceCatalog(path).load(), "INTERNAL_ERROR");
});

test("persists stable identity evidence and rebinds without changing workspace id or permission", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bridge-catalog-identity-")));
  const stateRoot = join(directory, "state");
  const path = join(stateRoot, "workspace-registry.json");
  const catalog = new ManagedWorkspaceCatalog(path, stateRoot);
  await catalog.load();
  const repository = repositoryIdentity("sha1", ["example.com/org/repo"], ["a".repeat(40)]);
  const created = await catalog.registerOnce("/old/repo", {
    displayName: "repo",
    aliases: ["/alias/repo"],
    gitTopLevel: "/old/repo",
    logicalRoot: ".",
    repository,
    source: "managed"
  });
  assert.equal(isId(created.id), true);

  await catalog.rebind(created.id, "/new/repo", {
    gitTopLevel: "/new/repo",
    logicalRoot: ".",
    repository,
    source: "managed"
  });
  const record = catalog.get(created.id)!;
  assert.equal(record.id, created.id);
  assert.equal(record.root, "/new/repo");
  assert.deepEqual(record.previousPaths, ["/old/repo"]);
  assert.deepEqual(record.aliases, ["/alias/repo"]);
  assert.equal(record.allowWrite, false);
  assert.equal(statIsDirectory(join(stateRoot, created.id)), true);

  const reloaded = new ManagedWorkspaceCatalog(path, stateRoot);
  await reloaded.load();
  assert.deepEqual(reloaded.get(created.id), record);
});

test("round-trips explicit identity-v2 object evidence and rejects malformed retained evidence", async () => {
  const path = catalogPath();
  const catalog = new ManagedWorkspaceCatalog(path);
  const filesystem = filesystemIdentity(
    "1".repeat(64),
    stableObjectIdentity("70", "1700000000000000300", "16777243")
  );
  const repository = repositoryIdentity(
    "sha1",
    ["example.com/org/repo"],
    ["a".repeat(40)],
    "2".repeat(64),
    stableObjectIdentity("71", "1700000000000000400", "16777243")
  );
  const { id } = await catalog.registerOnce("/identity-v2/repo", {
    workspaceType: "git_workspace",
    filesystem,
    gitTopLevel: "/identity-v2/repo",
    logicalRoot: ".",
    repository,
    source: "approved"
  });
  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.get(id)?.filesystem.stableObjectIdentity, filesystem.stableObjectIdentity);
  assert.deepEqual(reloaded.get(id)?.repository?.stableObjectIdentity, repository.stableObjectIdentity);

  const retained = JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    workspaces: Array<{ filesystem_identity: { stable_object_identity: { id: string } } }>;
  };
  retained.workspaces[0]!.filesystem_identity.stable_object_identity.id = "f".repeat(64);
  writeFileSync(path, `${JSON.stringify(retained, null, 2)}\n`);
  const quarantined = new ManagedWorkspaceCatalog(path);
  await quarantined.load();
  assert.deepEqual(quarantined.entries(), []);
});

test("identity v2 refuses cross-volume root substitution even when Git evidence is otherwise identical", async () => {
  const catalog = new ManagedWorkspaceCatalog();
  const id = newId();
  const repository = repositoryIdentity(
    "sha1",
    ["example.com/org/repo"],
    ["a".repeat(40)],
    "1".repeat(64),
    stableObjectIdentity("110", "1700000000000001300", "16777243")
  );
  await catalog.registerOnce("/old/repo", {
    id,
    workspaceType: "git_workspace",
    filesystem: filesystemIdentity(
      "2".repeat(64),
      stableObjectIdentity("111", "1700000000000001400", "16777243")
    ),
    gitTopLevel: "/old/repo",
    logicalRoot: ".",
    repository,
    allowWrite: true,
    source: "approved"
  });
  await expectCode(() => catalog.registerOnce("/copied/repo", {
    id,
    workspaceType: "git_workspace",
    filesystem: filesystemIdentity(
      "3".repeat(64),
      stableObjectIdentity("112", "1700000000000001500", "16777299")
    ),
    gitTopLevel: "/copied/repo",
    logicalRoot: ".",
    repository,
    allowWrite: true,
    source: "approved"
  }), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("upgrades a directory workspace to Git without changing id, permission, or state directory", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bridge-catalog-upgrade-")));
  const stateRoot = join(directory, "state");
  const path = join(stateRoot, "workspace-registry.json");
  const catalog = new ManagedWorkspaceCatalog(path, stateRoot);
  const filesystem = filesystemIdentity("a".repeat(64));
  const created = await catalog.registerOnce("/project", {
    workspaceType: "directory_workspace",
    filesystem,
    codexProjectReferences: ["/project"],
    allowWrite: true,
    source: "approved"
  });

  const upgraded = await catalog.rebind(created.id, "/project", {
    workspaceType: "git_workspace",
    filesystem,
    codexProjectReferences: ["/alias/project"],
    gitTopLevel: "/project",
    logicalRoot: ".",
    repository: repositoryIdentity("sha1", ["example.com/org/project"], ["b".repeat(40)]),
    allowWrite: false,
    source: "managed"
  });

  assert.equal(upgraded.id, created.id);
  assert.equal(upgraded.workspaceType, "git_workspace");
  assert.equal(upgraded.allowWrite, true);
  assert.equal(upgraded.source, "approved");
  assert.deepEqual(upgraded.codexProjectReferences, ["/alias/project", "/project"]);
  assert.equal(statIsDirectory(join(stateRoot, created.id)), true);
});

test("an approved seed remains compatible with a rebound path when high-confidence Git identity matches", async () => {
  const catalog = new ManagedWorkspaceCatalog(undefined);
  const id = newId();
  const oldIdentity = repositoryIdentity(
    "sha1",
    ["example.com/org/repo"],
    ["a".repeat(40)],
    "1".repeat(64)
  );
  await catalog.registerOnce("/old/repo", {
    id,
    gitTopLevel: "/old/repo",
    logicalRoot: ".",
    repository: oldIdentity,
    source: "approved"
  });
  const movedIdentity = repositoryIdentity(
    "sha1",
    ["example.com/org/repo"],
    ["a".repeat(40)],
    "2".repeat(64)
  );
  await catalog.rebind(id, "/new/repo", {
    gitTopLevel: "/new/repo",
    logicalRoot: ".",
    repository: movedIdentity,
    source: "approved"
  });

  const startupSeed = await catalog.registerOnce("/old/repo", {
    id,
    gitTopLevel: "/old/repo",
    logicalRoot: ".",
    repository: oldIdentity,
    source: "approved"
  });
  assert.deepEqual(startupSeed, { id, created: false });
  assert.equal(catalog.get(id)?.root, "/new/repo");
});

function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

test("a catalog without a state file path stays process-local", async () => {
  const catalog = new ManagedWorkspaceCatalog(undefined);
  await catalog.load();
  const { id } = await catalog.registerOnce("/canonical/local");
  assert.deepEqual(catalog.entries(), [{ id, root: "/canonical/local", allowWrite: false }]);
});

test("loads pre-authorization v1 records as read-only and round-trips authorized records", async () => {
  const path = catalogPath();
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    workspaces: [
      { id: "00000000-0000-4000-8000-000000000001", root: "/canonical/old" },
      { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/authorized", allow_write: true }
    ]
  }, null, 2)}\n`);

  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  assert.deepEqual(catalog.entries(), [
    { id: "00000000-0000-4000-8000-000000000001", root: "/canonical/old", allowWrite: false },
    { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/authorized", allowWrite: true }
  ]);

  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), catalog.entries());
});

test("registerOnce records stay read-only until authorize flips the record persistently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-auth-"));
  const path = join(directory, "managed-workspaces.json");
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  const { id } = await catalog.registerOnce("/canonical/auth");
  assert.equal(catalog.entries()[0]?.allowWrite, false);

  await catalog.authorize("/canonical/auth");
  assert.equal(catalog.entries()[0]?.allowWrite, true);

  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [{ id, root: "/canonical/auth", allowWrite: true }]);
});

test("authorize is idempotent and unknown roots fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-idem-"));
  const path = join(directory, "managed-workspaces.json");
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  await catalog.registerOnce("/canonical/idem");

  await catalog.authorize("/canonical/idem");
  await catalog.authorize("/canonical/idem");
  assert.equal(catalog.entries()[0]?.allowWrite, true);
  await expectCode(() => catalog.authorize("/canonical/unknown"), "INTERNAL_ERROR");
  assert.equal(readdirSync(directory).length, 1); // no extra temporary files
});

test("concurrent authorize calls converge and a persist failure rolls back the in-memory record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-conc-"));
  const path = join(directory, "managed-workspaces.json");
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  await catalog.registerOnce("/canonical/concurrent");

  await Promise.all([
    catalog.authorize("/canonical/concurrent"),
    catalog.authorize("/canonical/concurrent")
  ]);
  assert.equal(catalog.entries()[0]?.allowWrite, true);

  // Replace the state file with a directory so the atomic rename fails.
  const blockedPath = join(directory, "blocked.json");
  const blocked = new ManagedWorkspaceCatalog(blockedPath);
  await blocked.load();
  await blocked.registerOnce("/canonical/blocked");
  rmSync(blockedPath);
  mkdirSync(blockedPath);
  await expectCode(() => blocked.authorize("/canonical/blocked"), "INTERNAL_ERROR");
  assert.equal(blocked.entries()[0]?.allowWrite, false);

  // The same catalog can authorize once the blocker is gone.
  rmSync(blockedPath, { recursive: true, force: true });
  await blocked.authorize("/canonical/blocked");
  assert.equal(blocked.entries()[0]?.allowWrite, true);
});
