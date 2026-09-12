import assert from "node:assert/strict";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

test("returns the fixed root for a registered id", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);

  assert.equal(registry.resolve("known"), ROOT);
});

test("write access defaults to denied and must be explicitly enabled", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "default", root: ROOT },
    { id: "enabled", root: "/write/root", allow_write: true }
  ]);

  expectCode(() => registry.resolveWritable("default"), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(registry.resolveWritable("enabled"), "/write/root");
  assert.equal(registry.resolve("default"), ROOT);
});

test("rejects an unknown id", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);

  expectCode(() => registry.resolve("unknown"), "UNKNOWN_WORKSPACE");
});

test("rejects duplicate ids", () => {
  expectCode(() => new RegisteredWorkspaceRegistry([
    { id: "known", root: ROOT },
    { id: "known", root: "/other/root" }
  ]), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("rejects relative, non-normalized, or empty configuration fields", () => {
  const invalidEntries = [
    [{ id: "known", root: "relative/root" }],
    [{ id: "known", root: "/registered/../root" }],
    [{ id: "", root: ROOT }],
    [{ id: "known", root: "" }]
  ];

  for (const entries of invalidEntries) {
    expectCode(() => new RegisteredWorkspaceRegistry(entries), "WORKSPACE_BOUNDARY_VIOLATION");
  }
  expectCode(
    () => new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT, allow_write: "yes" }] as never),
    "WORKSPACE_BOUNDARY_VIOLATION"
  );
});

test("registers managed workspaces read-only and resolves them", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-1", ROOT);

  assert.equal(registry.resolve("managed-1"), ROOT);
  assert.deepEqual(registry.resolveExecution("managed-1"), { root: ROOT, allowWrite: false });
  expectCode(() => registry.resolveWritable("managed-1"), "WORKSPACE_PRECONDITION_FAILED");
  expectCode(() => registry.resolve("unknown-managed"), "UNKNOWN_WORKSPACE");
});

test("registerManaged is idempotent for the same id and root", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-1", ROOT);
  registry.registerManaged("managed-1", ROOT);
  assert.equal(registry.resolve("managed-1"), ROOT);
});

test("registerManaged rejects conflicting ids and occupied canonical roots", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "manual", root: ROOT }]);
  expectCode(() => registry.registerManaged("managed-1", ROOT), "WORKSPACE_BOUNDARY_VIOLATION");

  registry.registerManaged("managed-1", "/managed/root");
  expectCode(() => registry.registerManaged("managed-1", "/other/root"), "WORKSPACE_BOUNDARY_VIOLATION");
  expectCode(() => registry.registerManaged("managed-2", "/managed/root"), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("findByRoot returns the approved registration with its real write access", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: ROOT, allow_write: true }
  ]);

  assert.deepEqual(registry.findByRoot(ROOT), {
    id: "manual",
    root: ROOT,
    allowWrite: true,
    source: "approved"
  });
  assert.equal(registry.findByRoot("/unknown/root"), undefined);
});

test("findByRoot resolves managed registrations and approved canonical duplicates first-win", () => {
  const canonicalize = (root: string): string => root === "/manual/root" ? "/canonical/root" : root;
  const registry = new RegisteredWorkspaceRegistry([
    { id: "first", root: "/manual/root" },
    { id: "second", root: "/two/root" }
  ], canonicalize);

  assert.deepEqual(registry.findByRoot("/canonical/root"), {
    id: "first",
    root: "/manual/root",
    allowWrite: false,
    source: "approved"
  });

  registry.registerManaged("managed-1", "/managed/root");
  assert.deepEqual(registry.findByRoot("/managed/root"), {
    id: "managed-1",
    root: "/managed/root",
    allowWrite: false,
    source: "managed"
  });
});

test("a managed registration cannot occupy an approved canonical root", () => {
  const canonicalize = (): string => "/canonical/root";
  const registry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: "/manual/root", allow_write: true }
  ], canonicalize);

  expectCode(() => registry.registerManaged("managed-1", "/managed/root"), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("manual roots that cannot be canonicalized fall back to the literal root without failing startup", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "known", root: "/definitely/missing/path" }
  ]);

  assert.deepEqual(registry.findByRoot("/definitely/missing/path"), {
    id: "known",
    root: "/definitely/missing/path",
    allowWrite: false,
    source: "approved"
  });
  assert.equal(registry.resolve("known"), "/definitely/missing/path");
});

test("registerManaged restores a persisted allow_write flag", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-readonly", ROOT);
  registry.registerManaged("managed-authorized", "/write/managed", true);

  expectCode(() => registry.resolveWritable("managed-readonly"), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(registry.resolveWritable("managed-authorized"), "/write/managed");
});

test("authorizeWrite grants controlled-write to managed workspaces idempotently", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-1", ROOT);
  expectCode(() => registry.resolveWritable("managed-1"), "WORKSPACE_PRECONDITION_FAILED");

  registry.authorizeWrite("managed-1");
  assert.equal(registry.resolveWritable("managed-1"), ROOT);
  registry.authorizeWrite("managed-1");
  assert.equal(registry.resolveWritable("managed-1"), ROOT);
});

test("authorizeWrite rejects approved workspaces and unknown ids", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: ROOT, allow_write: true }
  ]);

  expectCode(() => registry.authorizeWrite("manual"), "WORKSPACE_PRECONDITION_FAILED");
  expectCode(() => registry.authorizeWrite("missing"), "UNKNOWN_WORKSPACE");
  assert.equal(registry.resolveWritable("manual"), ROOT);
});

test("sourceOf distinguishes approved and managed registrations", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "manual", root: ROOT }]);
  registry.registerManaged("managed-1", "/managed/root");

  assert.equal(registry.sourceOf("manual"), "approved");
  assert.equal(registry.sourceOf("managed-1"), "managed");
  expectCode(() => registry.sourceOf("missing"), "UNKNOWN_WORKSPACE");
});

test("rebind preserves stable id and permission while replacing the canonical path", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-1", "/old/root", true);

  registry.rebind("managed-1", "/new/root");

  assert.equal(registry.resolve("managed-1"), "/new/root");
  assert.equal(registry.resolveWritable("managed-1"), "/new/root");
  assert.equal(registry.findByRoot("/old/root"), undefined);
  assert.equal(registry.findByRoot("/new/root")?.id, "managed-1");
});
