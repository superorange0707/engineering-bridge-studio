import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// These are the exact JavaScript entry points distributed with the plugin.
// @ts-expect-error JavaScript CLI has no declaration file.
const { initialize } = await import("../../../bin/bridge.mjs");
// @ts-expect-error JavaScript CLI has no declaration file.
const { connectConfig, resolveConfigPath } = await import("../../../bin/connection.mjs");

test("fresh project initialization creates private state and explicit isolated execution only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-onboarding-"));
  try {
    const project = join(directory, "project");
    await mkdir(project);
    const result = await initialize({ home: join(directory, "stack"), project: [project], experiments: true });
    const config = JSON.parse(await readFile(result.config_path, "utf8"));
    assert.equal(config.version, 3);
    assert.equal(config.workspaces.length, 1);
    assert.equal(config.workspaces[0].permission_policy.allow_write, false);
    assert.deepEqual(config.collaboration.execution_workspace_ids, [config.workspaces[0].workspace_id]);
    assert.ok(config.workspaces[0].filesystem_identity.stable_object_identity.id);
    assert.equal((await stat(result.config_path)).mode & 0o777, 0o600);
    assert.equal(config.codex_projects.auto_onboard, false);
    const registryPath = join(directory, "stack", "state", "workspace-registry.json");
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { version: 3, workspaces: [] });
    assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
    const before = await readFile(result.config_path, "utf8");
    await assert.rejects(initialize({ home: join(directory, "stack"), project: [project] }), /already exists/);
    assert.equal(await readFile(result.config_path, "utf8"), before);
    const pointer = join(directory, "connection", "connection.json");
    await connectConfig(result.config_path, pointer);
    assert.equal(await resolveConfigPath({}, pointer), result.config_path);
    assert.equal(await readFile(result.config_path, "utf8"), before);
    assert.equal(await resolveConfigPath({ ENGINEERING_BRIDGE_CONFIG: "/explicit/config.json" }, pointer), "/explicit/config.json");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("initialization preserves retained state and removes its incomplete configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-onboarding-retained-"));
  try {
    const project = join(directory, "project");
    const stack = join(directory, "stack");
    await mkdir(project);
    await mkdir(join(stack, "state"), { recursive: true, mode: 0o700 });
    const registry = join(stack, "state", "workspace-registry.json");
    const retained = '{"version":3,"workspaces":[],"fixture":"must remain"}\n';
    await writeFile(registry, retained, { mode: 0o600 });
    await assert.rejects(initialize({ home: stack, project: [project] }), /state already exists/);
    assert.equal(await readFile(registry, "utf8"), retained);
    await assert.rejects(stat(join(stack, "config", "workspaces.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("connection refuses symlinks and initialization refuses duplicate physical projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-onboarding-symlink-"));
  try {
    const project = join(directory, "project");
    const alias = join(directory, "alias");
    await mkdir(project);
    await symlink(project, alias);
    await assert.rejects(initialize({ home: join(directory, "stack"), project: [project, alias] }), /distinct/);
    const target = join(directory, "target.json");
    await writeFile(target, JSON.stringify({ version: 1, config_path: "/secret" }), { mode: 0o600 });
    const pointer = join(directory, "pointer.json");
    await symlink(target, pointer);
    await assert.rejects(resolveConfigPath({}, pointer));
    assert.equal(JSON.parse(await readFile(target, "utf8")).config_path, "/secret");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
