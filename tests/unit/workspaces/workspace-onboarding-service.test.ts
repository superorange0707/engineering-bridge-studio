import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import { isId, newId } from "../../../src/core/ids.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "../../../src/workspaces/workspace-onboarding-service.js";
import type { GitStarter } from "../../../src/workspaces/workspace-onboarding-service.js";
import {
  filesystemIdentity,
  inspectWorkspace,
  repositoryIdentity,
  stableObjectIdentity
} from "../../../src/workspaces/repository-identity.js";
import type { InspectedWorkspace } from "../../../src/workspaces/repository-identity.js";

interface GitInvocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
}

function fakeGitStarter(invocations: GitInvocation[], exitCode = 0): GitStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    invocations.push({ executable, args: [...args], options });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill() {
        this.killed = true;
        return true;
      }
    });
    queueMicrotask(() => {
      stdout.end();
      stderr.end();
      child.emit("close", exitCode, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

function expectCodeSync(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

function setup(): {
  approved: string;
  catalogPath: string;
  registry: RegisteredWorkspaceRegistry;
  catalog: ManagedWorkspaceCatalog;
  gitInvocations: GitInvocation[];
} {
  const approved = mkdtempSync(join(tmpdir(), "bridge-approved-"));
  const catalogPath = join(mkdtempSync(join(tmpdir(), "bridge-onboarding-")), "managed-workspaces.json");
  const registry = new RegisteredWorkspaceRegistry([]);
  const catalog = new ManagedWorkspaceCatalog(catalogPath);
  return { approved, catalogPath, registry, catalog, gitInvocations: [] };
}

function service(
  registry: RegisteredWorkspaceRegistry,
  catalog: ManagedWorkspaceCatalog,
  approvedRoots: readonly string[],
  gitInvocations: GitInvocation[],
  gitExitCode = 0,
  readOnly = false
): WorkspaceOnboardingService {
  return new WorkspaceOnboardingService(
    registry,
    catalog,
    approvedRoots,
    undefined,
    fakeGitStarter(gitInvocations, gitExitCode),
    async (path): Promise<InspectedWorkspace> => {
      const root = realpathSync(path);
      return {
        root,
        gitTopLevel: root,
        logicalRoot: ".",
        repository: repositoryIdentity("sha1", [], [root], createHash("sha256").update(root).digest("hex"))
      };
    },
    undefined,
    [],
    undefined,
    [],
    true,
    readOnly
  );
}

function catalogStateFilePath(catalog: ManagedWorkspaceCatalog): string {
  return (catalog as unknown as { stateFilePath: string }).stateFilePath;
}

test("bind registers an existing directory inside an approved root and persists it", async () => {
  const { approved, catalogPath, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "proj");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  const result = await onboarding.bind({ project_path: project });

  assert.equal(isId(result.workspace_id), true);
  assert.equal(result.root, realpathSync(project));
  assert.equal(result.allow_write, false);
  assert.equal(result.source, "managed");
  assert.equal(registry.resolve(result.workspace_id), realpathSync(project));
  assert.deepEqual(gitInvocations, []);

  // Cross-restart persistence: a fresh catalog + registry resolves the same id.
  const reloadedCatalog = new ManagedWorkspaceCatalog(catalogPath);
  await reloadedCatalog.load();
  assert.deepEqual(reloadedCatalog.entries(), [{ id: result.workspace_id, root: realpathSync(project), allowWrite: false }]);
  const reloadedRegistry = new RegisteredWorkspaceRegistry([]);
  for (const entry of reloadedCatalog.entries()) reloadedRegistry.registerManaged(entry.id, entry.root);
  assert.equal(reloadedRegistry.resolve(result.workspace_id), realpathSync(project));
});

test("read-only onboarding fails closed before missing-path reconciliation and writes nothing", async () => {
  const { approved, catalogPath, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "read-only-missing");
  mkdirSync(project);
  const created = await catalog.registerOnce(project);
  const before = readFileSync(catalogPath);
  rmSync(project, { recursive: true, force: true });

  const onboarding = service(registry, catalog, [approved], gitInvocations, 0, true);
  await expectCode(() => onboarding.ensureAvailable(created.id), "WORKSPACE_PRECONDITION_FAILED");
  assert.deepEqual(readFileSync(catalogPath), before);
  assert.deepEqual(gitInvocations, []);
});

test("read-only onboarding fails closed before rebinding a present workspace with no matchable identity", async () => {
  const { approved, catalogPath, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "read-only-no-identity");
  mkdirSync(project);
  const created = await catalog.registerOnce(project);
  const before = readFileSync(catalogPath);

  const onboarding = service(registry, catalog, [approved], gitInvocations, 0, true);
  await expectCode(() => onboarding.ensureAvailable(created.id), "WORKSPACE_IDENTITY_MISMATCH");
  assert.deepEqual(readFileSync(catalogPath), before);
  assert.equal(catalog.get(created.id)?.workspaceType, "directory_workspace");
  assert.deepEqual(gitInvocations, []);
});

test("read-only onboarding fails closed before a directory-to-Git identity upgrade", async () => {
  const { approved, catalogPath, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "read-only-directory-upgrade");
  mkdirSync(project);
  const filesystem = filesystemIdentity("a".repeat(64));
  const created = await catalog.registerOnce(project, {
    workspaceType: "directory_workspace",
    filesystem
  });
  const before = readFileSync(catalogPath);
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async (path) => {
      const root = realpathSync(path);
      return {
        root,
        workspaceType: "git_workspace",
        filesystem,
        git: {
          root,
          gitTopLevel: root,
          logicalRoot: ".",
          repository: repositoryIdentity("sha1", [], ["b".repeat(40)])
        }
      };
    },
    undefined,
    [],
    undefined,
    [],
    true,
    true
  );

  await expectCode(() => onboarding.ensureAvailable(created.id), "WORKSPACE_IDENTITY_MISMATCH");
  assert.deepEqual(readFileSync(catalogPath), before);
  const unchanged = catalog.get(created.id)!;
  assert.equal(unchanged.id, created.id);
  assert.equal(unchanged.workspaceType, "directory_workspace");
  assert.equal(unchanged.repository, undefined);
  assert.deepEqual(gitInvocations, []);
});

test("bind reuses an existing approved workspace with its real allow_write and source", async () => {
  const { approved, catalog, gitInvocations } = setup();
  const project = join(approved, "manual-proj");
  mkdirSync(project);
  const root = realpathSync(project);
  const id = newId();
  const repository = repositoryIdentity(
    "sha1", [], [root], createHash("sha256").update(root).digest("hex")
  );
  await catalog.registerOnce(root, {
    id,
    workspaceType: "git_workspace",
    filesystem: filesystemIdentity(repository.localMetadataId, repository.stableObjectIdentity),
    gitTopLevel: root,
    logicalRoot: ".",
    repository,
    allowWrite: true,
    source: "approved"
  });
  const manualRegistry = new RegisteredWorkspaceRegistry([
    { id, root, allow_write: true }
  ]);
  const onboarding = service(manualRegistry, catalog, [approved], gitInvocations);

  const result = await onboarding.bind({ project_path: project });

  assert.equal(result.workspace_id, id);
  assert.equal(result.root, root);
  assert.equal(result.allow_write, true);
  assert.equal(result.source, "approved");
});

test("bind verifies and reuses an authoritative outside-root workspace before managed-root admission", async () => {
  const { approved, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-registered-outside-"));
  const root = realpathSync(outside);
  const id = newId();
  const repository = repositoryIdentity("sha1", ["example.com/org/outside"], ["a".repeat(40)]);
  await catalog.registerOnce(root, {
    id,
    workspaceType: "git_workspace",
    filesystem: filesystemIdentity(repository.localMetadataId, repository.stableObjectIdentity),
    gitTopLevel: root,
    logicalRoot: ".",
    repository,
    allowWrite: true,
    source: "approved"
  });
  const registry = new RegisteredWorkspaceRegistry([{ id, root, allow_write: true }]);
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async () => ({
      root,
      workspaceType: "git_workspace",
      filesystem: filesystemIdentity(repository.localMetadataId, repository.stableObjectIdentity),
      git: { root, gitTopLevel: root, logicalRoot: ".", repository }
    })
  );

  const result = await onboarding.bind({ project_path: outside });

  assert.equal(result.workspace_id, id);
  assert.equal(result.root, root);
  assert.equal(result.source, "approved");
});

test("bind reuses an Etsy-style managed registry-only workspace outside managed roots", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-managed-outside-"));
  const root = realpathSync(outside);
  const id = newId();
  const filesystem = filesystemIdentity("1".repeat(64),
    stableObjectIdentity("700", "1700000000000000000", "16777243"));
  const repository = repositoryIdentity("sha1", [], ["b".repeat(40)], "2".repeat(64),
    stableObjectIdentity("701", "1700000000000000001", "16777243"));
  await catalog.registerOnce(root, {
    id,
    workspaceType: "git_workspace",
    filesystem,
    gitTopLevel: root,
    logicalRoot: ".",
    repository,
    allowWrite: true,
    source: "managed"
  });
  registry.registerManaged(id, root, true);
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async () => ({
      root,
      workspaceType: "git_workspace",
      filesystem,
      git: { root, gitTopLevel: root, logicalRoot: ".", repository }
    })
  );

  const result = await onboarding.bind({ project_path: outside });

  assert.equal(result.workspace_id, id);
  assert.equal(result.source, "managed");
  assert.equal(result.allow_write, true);
  assert.equal(catalog.identityEntries().length, 1);
});

test("existing-registration fast path fails closed on filesystem or Git identity replacement", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-identity-replaced-outside-"));
  const root = realpathSync(outside);
  const id = newId();
  const rootIdentity = stableObjectIdentity("800", "1700000000000000100", "16777243");
  const commonIdentity = stableObjectIdentity("801", "1700000000000000101", "16777243");
  const filesystem = filesystemIdentity("3".repeat(64), rootIdentity);
  const repository = repositoryIdentity("sha1", ["example.com/org/repo"], ["c".repeat(40)],
    "4".repeat(64), commonIdentity);
  await catalog.registerOnce(root, {
    id,
    workspaceType: "git_workspace",
    filesystem,
    gitTopLevel: root,
    logicalRoot: ".",
    repository,
    source: "managed"
  });
  registry.registerManaged(id, root);
  let currentFilesystem = filesystemIdentity("5".repeat(64),
    stableObjectIdentity("802", "1700000000000000102", "16777243"));
  let currentRepository = repository;
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async () => ({
      root,
      workspaceType: "git_workspace",
      filesystem: currentFilesystem,
      git: { root, gitTopLevel: root, logicalRoot: ".", repository: currentRepository }
    })
  );

  await expectCode(() => onboarding.bind({ project_path: outside }), "WORKSPACE_IDENTITY_MISMATCH");

  currentFilesystem = filesystem;
  currentRepository = repositoryIdentity("sha1", ["example.com/org/other"], ["d".repeat(40)],
    "6".repeat(64), stableObjectIdentity("803", "1700000000000000103", "16777243"));
  await expectCode(() => onboarding.bind({ project_path: outside }), "WORKSPACE_IDENTITY_MISMATCH");
});

test("symlink aliases cannot turn an unknown outside-root path into an existing registration", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-unknown-alias-outside-"));
  const alias = join(mkdtempSync(join(tmpdir(), "bridge-alias-parent-")), "alias");
  symlinkSync(outside, alias);
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  await expectCode(() => onboarding.bind({ project_path: alias }), "WORKSPACE_BOUNDARY_VIOLATION");
  assert.deepEqual(catalog.entries(), []);
});

test("repeated and concurrent binds of the same canonical root converge on one managed workspace", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "shared");
  mkdirSync(project);
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  const first = await onboarding.bind({ project_path: project });
  const second = await onboarding.bind({ project_path: project });
  assert.equal(first.workspace_id, second.workspace_id);
  assert.equal(second.source, "managed");
  assert.equal(second.allow_write, false);

  const [third, fourth] = await Promise.all([
    onboarding.bind({ project_path: project }),
    onboarding.bind({ project_path: project })
  ]);
  assert.equal(third.workspace_id, first.workspace_id);
  assert.equal(fourth.workspace_id, first.workspace_id);
  assert.equal(catalog.entries().length, 1);
});

test("bind rejects paths outside approved roots, prefix siblings, and symlink escapes", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-outside-"));
  mkdirSync(join(outside, "target"));
  const sibling = `${approved}-sibling`;
  mkdirSync(join(sibling, "inner"), { recursive: true });
  symlinkSync(join(outside, "target"), join(approved, "link"));
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  await expectCode(() => onboarding.bind({ project_path: join(outside, "target") }), "WORKSPACE_BOUNDARY_VIOLATION");
  await expectCode(() => onboarding.bind({ project_path: join(sibling, "inner") }), "WORKSPACE_BOUNDARY_VIOLATION");
  await expectCode(() => onboarding.bind({ project_path: join(approved, "link") }), "WORKSPACE_BOUNDARY_VIOLATION");
  assert.deepEqual(catalog.entries(), []);
});

test("a failing approved root does not disable healthy roots; all-failed or non-matching roots fail closed", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const otherApproved = mkdtempSync(join(tmpdir(), "bridge-other-approved-"));
  const project = join(approved, "proj");
  mkdirSync(project);
  const missingRoot = join(approved, "missing-root");

  // A bad root plus a healthy root that contains the candidate succeeds.
  const mixed = service(registry, catalog, [missingRoot, approved], gitInvocations);
  const result = await mixed.bind({ project_path: project });
  assert.equal(result.source, "managed");
  assert.equal(result.root, realpathSync(project));

  // A healthy root that does not contain the candidate still fails closed.
  await expectCode(() => mixed.bind({ project_path: otherApproved }), "WORKSPACE_BOUNDARY_VIOLATION");

  // All approved roots failing to canonicalize fail closed.
  const unknown = join(approved, "unknown");
  mkdirSync(unknown);
  const allBad = service(
    registry,
    catalog,
    [join(approved, "nope-1"), join(approved, "nope-2")],
    gitInvocations
  );
  await expectCode(() => allBad.bind({ project_path: unknown }), "WORKSPACE_BOUNDARY_VIOLATION");

  // Only the successful bind left a record behind.
  assert.deepEqual(catalog.entries(), [{ id: result.workspace_id, root: realpathSync(project), allowWrite: false }]);
});

test("bind rejects nonexistent paths, non-directories, and missing approved roots", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const file = join(approved, "file.txt");
  writeFileSync(file, "x");
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  await expectCode(() => onboarding.bind({ project_path: join(approved, "missing") }), "WORKSPACE_PRECONDITION_FAILED");
  await expectCode(() => onboarding.bind({ project_path: file }), "WORKSPACE_PRECONDITION_FAILED");

  const noRoots = service(registry, catalog, [], gitInvocations);
  await expectCode(() => noRoots.bind({ project_path: approved }), "WORKSPACE_BOUNDARY_VIOLATION");
  assert.deepEqual(catalog.entries(), []);
});

test("create makes the directory, runs git init only, registers, and reports unborn HEAD", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  const result = await onboarding.create({ parent: approved, name: "newproj" });

  assert.equal(isId(result.workspace_id), true);
  const expectedRoot = join(realpathSync(approved), "newproj");
  assert.equal(result.root, expectedRoot);
  assert.equal(result.allow_write, false);
  assert.deepEqual(result.git, { initialized: true, head: "unborn" });
  assert.equal(statSync(expectedRoot).isDirectory(), true);
  assert.equal(registry.resolve(result.workspace_id), expectedRoot);

  assert.equal(gitInvocations.length, 1);
  assert.equal(gitInvocations[0]?.executable, "git");
  assert.deepEqual(gitInvocations[0]?.args, ["init"]);
  assert.equal(gitInvocations[0]?.options.cwd, expectedRoot);

  assert.deepEqual(catalog.entries(), [{ id: result.workspace_id, root: expectedRoot, allowWrite: false }]);
});

test("create rejects invalid names, outside parents, missing parents, and existing targets", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-outside-create-"));
  mkdirSync(join(approved, "exists"));
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  for (const name of ["", "a/b", "a\\b", ".", ".."]) {
    await expectCode(() => onboarding.create({ parent: approved, name }), "WORKSPACE_PRECONDITION_FAILED");
  }
  await expectCode(() => onboarding.create({ parent: outside, name: "ok" }), "WORKSPACE_BOUNDARY_VIOLATION");
  await expectCode(
    () => onboarding.create({ parent: join(approved, "missing-parent"), name: "ok" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  await expectCode(() => onboarding.create({ parent: approved, name: "exists" }), "WORKSPACE_PRECONDITION_FAILED");

  assert.deepEqual(catalog.entries(), []);
  assert.deepEqual(gitInvocations, []);
});

test("create with a failing git init removes the new empty directory and registers nothing", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const onboarding = service(registry, catalog, [approved], gitInvocations, 1);

  await expectCode(() => onboarding.create({ parent: approved, name: "failproj" }), "WORKSPACE_PRECONDITION_FAILED");

  assert.equal(gitInvocations.length, 1);
  assert.throws(() => statSync(join(approved, "failproj")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(registry.findByRoot(join(realpathSync(approved), "failproj")), undefined);
  assert.deepEqual(catalog.entries(), []);
});

test("create with a catalog persist failure keeps the target, registers nothing, and bind can recover", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  await catalog.load();
  // Block the catalog path with a directory so the atomic rename fails.
  mkdirSync(catalogStateFilePath(catalog));
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  await expectCode(
    () => onboarding.create({ parent: approved, name: "kept-proj" }),
    "INTERNAL_ERROR"
  );

  const target = join(realpathSync(approved), "kept-proj");
  assert.equal(statSync(target).isDirectory(), true);
  assert.equal(registry.findByRoot(target), undefined);
  assert.deepEqual(catalog.entries(), []);

  // Recover: the retained directory can be bound after the catalog is usable again.
  rmSync(catalogStateFilePath(catalog), { recursive: true, force: true });
  const recovered = await onboarding.bind({ project_path: target });
  assert.equal(isId(recovered.workspace_id), true);
  assert.equal(recovered.source, "managed");
  assert.equal(recovered.allow_write, false);
  assert.equal(registry.resolve(recovered.workspace_id), target);
});

test("authorizeWrite persists controlled-write and enables resolveWritable after restart", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "auth-proj");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);
  const { workspace_id } = await onboarding.bind({ project_path: project });
  expectCodeSync(() => registry.resolveWritable(workspace_id), "WORKSPACE_PRECONDITION_FAILED");

  const authorized = await onboarding.authorizeWrite(workspace_id);
  assert.deepEqual(authorized, { workspace_id, allow_write: true });
  assert.equal(registry.resolveWritable(workspace_id), realpathSync(project));

  // Restart recovery: a fresh catalog + registry restores the authorization.
  const reloadedCatalog = new ManagedWorkspaceCatalog(catalogStateFilePath(catalog));
  await reloadedCatalog.load();
  assert.equal(reloadedCatalog.entries()[0]?.allowWrite, true);
  const reloadedRegistry = new RegisteredWorkspaceRegistry([]);
  for (const entry of reloadedCatalog.entries()) {
    reloadedRegistry.registerManaged(entry.id, entry.root, entry.allowWrite);
  }
  assert.equal(reloadedRegistry.resolveWritable(workspace_id), realpathSync(project));
});

test("authorizeWrite is idempotent and persists once", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "idem-proj");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);
  const { workspace_id } = await onboarding.bind({ project_path: project });

  await onboarding.authorizeWrite(workspace_id);
  await onboarding.authorizeWrite(workspace_id);
  assert.deepEqual(catalog.entries(), [{ id: workspace_id, root: realpathSync(project), allowWrite: true }]);
});

test("authorizeWrite rejects approved workspaces without touching the catalog", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "manual-auth");
  mkdirSync(project);
  const manualRegistry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: realpathSync(project), allow_write: true }
  ]);
  const onboarding = service(manualRegistry, catalog, [approved], gitInvocations);

  await expectCode(() => onboarding.authorizeWrite("manual"), "WORKSPACE_PRECONDITION_FAILED");
  await expectCode(() => onboarding.authorizeWrite("missing"), "UNKNOWN_WORKSPACE");
  assert.deepEqual(catalog.entries(), []);
});

test("authorizeWrite with a persist failure leaves runtime and catalog unauthorized", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "fail-auth");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);
  const { workspace_id } = await onboarding.bind({ project_path: project });

  // Block the catalog path so the authorize persist fails.
  rmSync(catalogStateFilePath(catalog));
  mkdirSync(catalogStateFilePath(catalog));
  await expectCode(() => onboarding.authorizeWrite(workspace_id), "INTERNAL_ERROR");

  // No half state: runtime is not authorized and the catalog record stays read-only.
  expectCodeSync(() => registry.resolveWritable(workspace_id), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(catalog.entries()[0]?.allowWrite, false);
});

test("a moved repository rebinds the stable id exactly once and records path history", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const oldPath = join(approved, "old-name");
  const newPath = join(approved, "new-name");
  mkdirSync(oldPath);
  const oldCanonical = realpathSync(oldPath);
  const repository = repositoryIdentity("sha1", ["example.com/org/repo"], ["a".repeat(40)]);
  const inspector = async (path: string): Promise<InspectedWorkspace> => {
    const root = realpathSync(path);
    return { root, gitTopLevel: root, logicalRoot: ".", repository };
  };
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    inspector,
    async () => [newPath]
  );
  const attached = await onboarding.attach({ project_path: oldPath });
  renameSync(oldPath, newPath);

  assert.equal(await onboarding.ensureAvailable(attached.workspace_id), realpathSync(newPath));
  const record = catalog.get(attached.workspace_id)!;
  assert.equal(record.root, realpathSync(newPath));
  assert.deepEqual(record.previousPaths, [oldCanonical]);
  assert.equal(registry.resolve(attached.workspace_id), realpathSync(newPath));
});

test("path reconciliation fails closed when repository identity has multiple matches", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const oldPath = join(approved, "old");
  const first = join(approved, "first");
  const second = join(approved, "second");
  mkdirSync(oldPath);
  mkdirSync(first);
  mkdirSync(second);
  const repository = repositoryIdentity("sha1", ["example.com/org/repo"], ["a".repeat(40)]);
  const inspector = async (path: string): Promise<InspectedWorkspace> => {
    const root = realpathSync(path);
    return { root, gitTopLevel: root, logicalRoot: ".", repository };
  };
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    inspector,
    async () => [first, second]
  );
  const attached = await onboarding.attach({ project_path: oldPath });
  rmSync(oldPath, { recursive: true });

  await expectCode(() => onboarding.ensureAvailable(attached.workspace_id), "WORKSPACE_IDENTITY_AMBIGUOUS");
  assert.equal(catalog.get(attached.workspace_id)?.root, attached.root);
});

test("updated Codex project metadata still reconciles an existing workspace when auto-onboarding is disabled", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const oldPath = join(approved, "metadata-old");
  const preferred = join(approved, "metadata-preferred");
  const duplicate = join(approved, "metadata-duplicate");
  mkdirSync(oldPath);
  mkdirSync(preferred);
  mkdirSync(duplicate);
  const repository = repositoryIdentity("sha1", ["example.com/org/repo"], ["a".repeat(40)]);
  const inspector = async (path: string): Promise<InspectedWorkspace> => {
    const root = realpathSync(path);
    return { root, gitTopLevel: root, logicalRoot: ".", repository };
  };
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    inspector,
    async () => [preferred, duplicate],
    undefined,
    async () => [{ path: preferred, trustLevel: "trusted" }],
    [],
    true,
    false,
    false
  );
  const attached = await onboarding.attach({ project_path: oldPath });
  rmSync(oldPath, { recursive: true });

  assert.equal(await onboarding.ensureAvailable(attached.workspace_id), realpathSync(preferred));
});

test("one physical Git repository can hold multiple stable logical workspaces", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const repo = join(approved, "mono");
  const app = join(repo, "packages", "app");
  const api = join(repo, "packages", "api");
  mkdirSync(app, { recursive: true });
  mkdirSync(api, { recursive: true });
  const repository = repositoryIdentity("sha1", ["example.com/org/mono"], ["b".repeat(40)]);
  const inspector = async (path: string): Promise<InspectedWorkspace> => {
    const root = realpathSync(path);
    return {
      root,
      gitTopLevel: realpathSync(repo),
      logicalRoot: root.endsWith("/app") ? "packages/app" : "packages/api",
      repository
    };
  };
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    inspector
  );

  const appWorkspace = await onboarding.attach({ project_path: app });
  const apiWorkspace = await onboarding.attach({ project_path: api });

  assert.notEqual(appWorkspace.workspace_id, apiWorkspace.workspace_id);
  assert.equal(appWorkspace.git_identity?.git_top_level, apiWorkspace.git_identity?.git_top_level);
  assert.equal(catalog.identityEntries().length, 2);
});

test("auto-onboarding inherits only the explicitly configured managed-root write policy", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "authorized-policy");
  mkdirSync(project);
  const repository = repositoryIdentity("sha1", [], ["c".repeat(40)]);
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [{ root: approved, allowWrite: true }],
    undefined,
    fakeGitStarter(gitInvocations),
    async (path) => {
      const root = realpathSync(path);
      return { root, gitTopLevel: root, logicalRoot: ".", repository };
    }
  );

  const attached = await onboarding.attach({ project_path: project });
  assert.equal(attached.allow_write, true);
  assert.equal(registry.resolveWritable(attached.workspace_id), realpathSync(project));
});

test("overlapping managed roots use the most specific policy independent of configuration order", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const nested = join(approved, "nested");
  const project = join(nested, "project");
  mkdirSync(project, { recursive: true });
  const repository = repositoryIdentity("sha1", [], [], "e".repeat(64));
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [
      { root: approved, allowWrite: true },
      { root: nested, allowWrite: false }
    ],
    undefined,
    fakeGitStarter(gitInvocations),
    async (path) => {
      const root = realpathSync(path);
      return { root, gitTopLevel: root, logicalRoot: ".", repository };
    }
  );

  const attached = await onboarding.attach({ project_path: project });
  assert.equal(attached.allow_write, false);
  expectCodeSync(() => registry.resolveWritable(attached.workspace_id), "WORKSPACE_PRECONDITION_FAILED");
});

test("an existing path replaced by another clone with the same remote fails closed", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "replaceable");
  mkdirSync(project);
  let localMetadataId = "1".repeat(64);
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async (path) => {
      const root = realpathSync(path);
      return {
        root,
        gitTopLevel: root,
        logicalRoot: ".",
        repository: repositoryIdentity(
          "sha1",
          ["example.com/org/repo"],
          ["f".repeat(40)],
          localMetadataId
        )
      };
    }
  );
  const attached = await onboarding.attach({ project_path: project });
  localMetadataId = "2".repeat(64);

  await expectCode(() => onboarding.ensureAvailable(attached.workspace_id), "WORKSPACE_IDENTITY_MISMATCH");
});

test("identity v2 accepts device-only renumber for directory and Git objects without a registry write", async () => {
  const { approved, catalogPath, registry, catalog, gitInvocations } = setup();
  const directory = join(approved, "device-renumber-directory");
  mkdirSync(directory);
  const canonicalDirectory = realpathSync(directory);
  const directoryStableBefore = stableObjectIdentity("80", "1700000000000000500", "16777243");
  const directoryStableAfter = stableObjectIdentity("80", "1700000000000000500", "16777299");
  const directoryRecord = await catalog.registerOnce(canonicalDirectory, {
    workspaceType: "directory_workspace",
    filesystem: filesystemIdentity("1".repeat(64), directoryStableBefore),
    source: "approved"
  });
  const directoryBefore = readFileSync(catalogPath);
  const directoryOnboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async () => ({
      root: canonicalDirectory,
      workspaceType: "directory_workspace",
      filesystem: filesystemIdentity("2".repeat(64), directoryStableAfter)
    }),
    undefined,
    [],
    undefined,
    [],
    true,
    true
  );
  assert.equal(await directoryOnboarding.ensureAvailable(directoryRecord.id), canonicalDirectory);
  assert.deepEqual(readFileSync(catalogPath), directoryBefore);

  const gitDirectory = join(approved, "device-renumber-git");
  mkdirSync(gitDirectory);
  const canonicalGit = realpathSync(gitDirectory);
  const rootBefore = stableObjectIdentity("81", "1700000000000000600", "16777243");
  const rootAfter = stableObjectIdentity("81", "1700000000000000600", "16777299");
  const commonBefore = stableObjectIdentity("82", "1700000000000000700", "16777243");
  const commonAfter = stableObjectIdentity("82", "1700000000000000700", "16777299");
  const gitRecord = await catalog.registerOnce(canonicalGit, {
    workspaceType: "git_workspace",
    filesystem: filesystemIdentity("3".repeat(64), rootBefore),
    gitTopLevel: canonicalGit,
    logicalRoot: ".",
    repository: repositoryIdentity(
      "sha1", ["example.com/org/repo"], ["a".repeat(40)], "4".repeat(64), commonBefore
    ),
    source: "approved"
  });
  const gitBefore = readFileSync(catalogPath);
  const gitOnboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async () => ({
      root: canonicalGit,
      workspaceType: "git_workspace",
      filesystem: filesystemIdentity("5".repeat(64), rootAfter),
      git: {
        root: canonicalGit,
        gitTopLevel: canonicalGit,
        logicalRoot: ".",
        repository: repositoryIdentity(
          "sha1", ["example.com/org/repo"], ["a".repeat(40)], "6".repeat(64), commonAfter
        )
      }
    }),
    undefined,
    [],
    undefined,
    [],
    true,
    true
  );
  assert.equal(await gitOnboarding.ensureAvailable(gitRecord.id), canonicalGit);
  assert.deepEqual(readFileSync(catalogPath), gitBefore);
});

test("identity v2 rejects same-path root replacement and Git common-directory replacement", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "identity-v2-replacement");
  mkdirSync(project);
  const root = realpathSync(project);
  const originalRoot = stableObjectIdentity("90", "1700000000000000800", "16777243");
  const replacementRoot = stableObjectIdentity("91", "1700000000000000900", "16777243");
  const originalCommon = stableObjectIdentity("92", "1700000000000001000", "16777243");
  const replacementCommon = stableObjectIdentity("93", "1700000000000001100", "16777243");
  const created = await catalog.registerOnce(root, {
    workspaceType: "git_workspace",
    filesystem: filesystemIdentity("1".repeat(64), originalRoot),
    gitTopLevel: root,
    logicalRoot: ".",
    repository: repositoryIdentity(
      "sha1", ["example.com/org/repo"], ["a".repeat(40)], "2".repeat(64), originalCommon
    ),
    source: "approved"
  });
  let currentRoot = replacementRoot;
  let currentCommon = originalCommon;
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async () => ({
      root,
      workspaceType: "git_workspace",
      filesystem: filesystemIdentity("3".repeat(64), currentRoot),
      git: {
        root,
        gitTopLevel: root,
        logicalRoot: ".",
        repository: repositoryIdentity(
          "sha1", ["example.com/org/repo"], ["a".repeat(40)], "4".repeat(64), currentCommon
        )
      }
    })
  );
  await expectCode(() => onboarding.ensureAvailable(created.id), "WORKSPACE_IDENTITY_MISMATCH");

  currentRoot = originalRoot;
  currentCommon = replacementCommon;
  await expectCode(() => onboarding.ensureAvailable(created.id), "WORKSPACE_IDENTITY_MISMATCH");
});

test("legacy identity remains fail closed when current inspection has identity-v2 evidence", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "legacy-needs-migration");
  mkdirSync(project);
  const root = realpathSync(project);
  const created = await catalog.registerOnce(root, {
    workspaceType: "directory_workspace",
    filesystem: filesystemIdentity("1".repeat(64)),
    source: "approved"
  });
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async () => ({
      root,
      workspaceType: "directory_workspace",
      filesystem: filesystemIdentity(
        "1".repeat(64),
        stableObjectIdentity("100", "1700000000000001200", "16777243")
      )
    })
  );
  await expectCode(() => onboarding.ensureAvailable(created.id), "WORKSPACE_IDENTITY_MISMATCH");
});

test("auto-onboarding treats Project Brain like any other valid project", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "excluded-project");
  mkdirSync(project);
  const projectBrainRemote = "github.com/superorange0707/project-brain";
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    async (path) => {
      const root = realpathSync(path);
      return {
        root,
        gitTopLevel: root,
        logicalRoot: ".",
        repository: repositoryIdentity("sha1", [projectBrainRemote], ["d".repeat(40)])
      };
    }
  );

  const attached = await onboarding.attach({ project_path: project });
  assert.equal(attached.git_identity?.repository_identity.normalized_remotes[0], projectBrainRemote);
  assert.equal(catalog.entries().length, 1);
});

test("a non-Git workspace upgrades in place after git init without losing id or write policy", async () => {
  const { approved, registry, catalog } = setup();
  const project = join(approved, "directory-first");
  mkdirSync(project);
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [{ root: approved, allowWrite: true }]
  );

  const attached = await onboarding.attach({ project_path: project });
  assert.equal(attached.workspace_type, "directory_workspace");
  execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });

  assert.equal(await onboarding.ensureAvailable(attached.workspace_id), realpathSync(project));
  const upgraded = catalog.get(attached.workspace_id)!;
  assert.equal(upgraded.workspaceType, "git_workspace");
  assert.equal(upgraded.allowWrite, true);
  assert.equal(upgraded.id, attached.workspace_id);
});

test("a moved non-Git directory rebinds by filesystem identity inside an approved root", async () => {
  const { approved, registry, catalog } = setup();
  const oldPath = join(approved, "plain-old");
  const newPath = join(approved, "plain-new");
  mkdirSync(oldPath);
  const onboarding = new WorkspaceOnboardingService(registry, catalog, [approved]);
  const attached = await onboarding.attach({ project_path: oldPath });
  renameSync(oldPath, newPath);

  assert.equal(await onboarding.ensureAvailable(attached.workspace_id), realpathSync(newPath));
  assert.deepEqual(catalog.get(attached.workspace_id)?.previousPaths, [attached.root]);
});

test("Codex project refresh auto-onboards safe outside-root metadata and blocks broad, missing, and excluded entries", async () => {
  const { registry, catalog } = setup();
  const project = mkdtempSync(join(tmpdir(), "bridge-codex-candidate-"));
  const missing = join(tmpdir(), "bridge-definitely-missing-project");
  const provider = async () => [
    { path: project, trustLevel: "trusted" },
    { path: homedir(), trustLevel: "trusted" },
    { path: missing, trustLevel: "trusted" }
  ];
  const firstService = new WorkspaceOnboardingService(
    registry, catalog, [], undefined, undefined, undefined, undefined, undefined, provider
  );
  const first = await firstService.refresh();
  const onboarded = first.find((item) => item.status === "auto_onboarded");
  assert.equal(onboarded?.root, realpathSync(project));
  assert.equal(onboarded?.allow_write, true);
  assert.equal(registry.resolveWritable(onboarded?.workspace_id as string), realpathSync(project));
  assert.equal(first.some((item) => item.status === "unsafe_broad_path"), true);
  assert.equal(first.some((item) => item.status === "missing_path"), true);
  const proposed = onboarded?.workspace_id;
  assert.equal(typeof proposed, "string");

  const secondService = new WorkspaceOnboardingService(
    registry, catalog, [], undefined, undefined, undefined, undefined, undefined, provider,
    [proposed as string]
  );
  const second = await secondService.refresh();
  assert.equal(second.some((item) => item.status === "explicitly_user_excluded"), true);
});

test("Codex refresh auto-onboards a new non-Git project inside an approved managed root", async () => {
  const { approved, registry, catalog } = setup();
  const project = join(approved, "new-codex-directory");
  mkdirSync(project);
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [{ root: approved, allowWrite: true }],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [{ path: project, trustLevel: "trusted" }]
  );

  const results = await onboarding.refresh();
  const result = results.find((item) => item.status === "auto_onboarded");
  assert.equal(result?.workspace_type, "directory_workspace");
  assert.equal(result?.allow_write, true);
  assert.equal(registry.resolveWritable(result?.workspace_id as string), realpathSync(project));
});

test("Codex refresh fails closed when a new reference ambiguously matches existing workspace identities", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const first = join(approved, "first-clone");
  const second = join(approved, "second-clone");
  const outside = mkdtempSync(join(tmpdir(), "bridge-codex-ambiguous-"));
  mkdirSync(first);
  mkdirSync(second);
  const repository = repositoryIdentity("sha1", ["example.com/org/shared"], ["a".repeat(40)]);
  const inspector = async (path: string): Promise<InspectedWorkspace> => {
    const root = realpathSync(path);
    return { root, gitTopLevel: root, logicalRoot: ".", repository };
  };
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    [approved],
    undefined,
    fakeGitStarter(gitInvocations),
    inspector,
    undefined,
    undefined,
    async () => [{ path: outside, trustLevel: "trusted" }]
  );
  await onboarding.attach({ project_path: first });
  await onboarding.attach({ project_path: second });

  const results = await onboarding.refresh();
  const blocked = results.find((item) => item.canonical_path === realpathSync(outside));
  assert.equal(blocked?.status, "blocked");
  assert.deepEqual(blocked?.error, {
    code: "WORKSPACE_IDENTITY_AMBIGUOUS",
    message: "More than one repository matches the registered workspace identity."
  });
  assert.equal(catalog.identityEntries().length, 2);
  assert.equal(registry.findByRoot(realpathSync(outside)), undefined);
});

test("diagnostics reports an approved workspace as healthy without requiring bind or managed-root membership", async () => {
  const project = mkdtempSync(join(tmpdir(), "bridge-approved-diagnostic-"));
  const inspected = await inspectWorkspace(project);
  const id = newId();
  const catalog = new ManagedWorkspaceCatalog();
  await catalog.registerOnce(inspected.root, {
    id,
    workspaceType: inspected.workspaceType,
    filesystem: inspected.filesystem,
    allowWrite: true,
    source: "approved"
  });
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerApproved(id, inspected.root, true);
  const onboarding = new WorkspaceOnboardingService(registry, catalog, []);

  const diagnostic = await onboarding.diagnose({ workspace_id: id });
  assert.equal(diagnostic.workspace_id, id);
  assert.equal(diagnostic.registration_type, "approved");
  assert.equal(diagnostic.usable_by_workspace_id, true);
  assert.equal(diagnostic.managed_onboarding_applicable, false);
  assert.equal(diagnostic.matched_managed_root, false);
  assert.equal(diagnostic.boundary_status, "EXISTING_AUTHORITATIVE");
  assert.equal(diagnostic.boundary_reason, "EXISTING_AUTHORITATIVE_WORKSPACE");
  const bound = await onboarding.bind({ project_path: project });
  assert.equal(bound.workspace_id, id);
});

test("diagnostics distinguishes Codex-reference onboarding from an ineligible outside-boundary path", async () => {
  const referenced = mkdtempSync(join(tmpdir(), "bridge-diagnostic-reference-"));
  const outside = mkdtempSync(join(tmpdir(), "bridge-diagnostic-outside-"));
  const onboarding = new WorkspaceOnboardingService(
    new RegisteredWorkspaceRegistry([]),
    new ManagedWorkspaceCatalog(),
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [{ path: referenced }]
  );

  const eligible = await onboarding.diagnose({ project_path: referenced });
  assert.equal(eligible.registration_type, "unregistered");
  assert.equal(eligible.managed_onboarding_applicable, true);
  assert.equal(eligible.boundary_reason, "CODEX_PROJECT_REFERENCE");
  const ineligible = await onboarding.diagnose({ project_path: outside });
  assert.equal(ineligible.managed_onboarding_applicable, false);
  assert.equal(ineligible.boundary_reason, "NO_AUTHORIZED_ONBOARDING_BOUNDARY");
});
