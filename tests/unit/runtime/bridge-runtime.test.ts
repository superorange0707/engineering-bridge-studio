import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Executor, ExecutorResult } from "../../../src/executors/executor.js";
import { inspectWorkspace } from "../../../src/workspaces/repository-identity.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { CollaborationRunService } from "../../../src/tasks/collaboration-run-service.js";
import type { CollaborationContract } from "../../../src/tasks/collaboration-contract.js";
import {
  inspectBridgeOwner,
  startBridgeOwner
} from "../../../src/runtime/bridge-runtime.js";
import type { Id } from "../../../src/core/ids.js";

interface TextResult {
  content?: Array<{ type?: string; text?: string }>;
}

function parseToolResult(value: unknown): Record<string, unknown> {
  const result = value as TextResult;
  const text = result.content?.find((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Expected a text MCP result.");
  return JSON.parse(text) as Record<string, unknown>;
}

async function waitFor<T>(read: () => Promise<T | undefined>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Bridge runtime state.");
}

async function waitForOwnerGone(configPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await inspectBridgeOwner(configPath) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Bridge runtime owner shutdown.");
}

async function fixture(prefix: string): Promise<{
  readonly root: string;
  readonly configPath: string;
  readonly stateRoot: string;
  readonly workspaceId: Id;
  readonly workspaceRoot: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const configDirectory = join(root, "config");
  const stateRoot = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  await Promise.all([mkdir(configDirectory, { mode: 0o700 }), mkdir(stateRoot, { mode: 0o700 }), mkdir(workspaceRoot, { mode: 0o700 })]);
  const configPath = join(configDirectory, "workspaces.json");
  const codexSource = join(root, "codex.toml");
  await writeFile(codexSource, "# fixture\n", { mode: 0o600 });
  const inspected = await inspectWorkspace(workspaceRoot);
  const workspaceId = randomUUID() as Id;
  await writeFile(configPath, `${JSON.stringify({
    version: 3,
    codex_projects: {
      source_file: codexSource,
      auto_onboard: false,
      permission_policy: { allow_write: false }
    },
    excluded_workspace_ids: [],
    managed_roots: [],
    workspaces: [],
    collaboration: { execution_workspace_ids: [workspaceId] }
  }, null, 2)}\n`, { mode: 0o600 });
  const catalog = new ManagedWorkspaceCatalog(join(stateRoot, "workspace-registry.json"), stateRoot);
  await catalog.registerOnce(workspaceRoot, {
    id: workspaceId,
    displayName: "runtime fixture",
    workspaceType: inspected.workspaceType,
    filesystem: inspected.filesystem,
    codexProjectReferences: [workspaceRoot],
    allowWrite: false,
    source: "approved"
  });
  return { root, configPath, stateRoot, workspaceId, workspaceRoot };
}

function contract(): CollaborationContract {
  return {
    domain: "engineering",
    objective: "Persist one deterministic runtime result",
    plan: ["Write the declared result"],
    acceptance_criteria: ["The result has the expected bytes"],
    expected_artifacts: ["result.json"]
  };
}

function fakeExecutor(workspaceRoot: string): Executor {
  const result: ExecutorResult = {
    kind: "completed",
    output: "deterministic fixture complete",
    threadId: "fixture-thread",
    metadata: {
      logicalRole: "implementer",
      model: "fixture-model",
      reasoningEffort: "max",
      codexVersion: "fixture-codex"
    },
    evidence: []
  };
  return {
    execute: async () => {
      await writeFile(join(workspaceRoot, "result.json"), "{\"ok\":true}\n", { mode: 0o600 });
      return result;
    }
  };
}

function clientFor(configPath: string): { client: Client; transport: StdioClientTransport } {
  const entry = process.env.ENGINEERING_BRIDGE_TEST_ENTRY ?? join(process.cwd(), "dist", "src", "mcp-stdio.js");
  const client = new Client({ name: `runtime-test-${randomUUID()}`, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  return { client, transport };
}

test("one owner serves two independent MCP clients and the same persisted run", { timeout: 30_000 }, async () => {
  const fixtureState = await fixture("engineering-bridge-shared-runtime-");
  const registry = new RegisteredWorkspaceRegistry([
    { id: fixtureState.workspaceId, root: fixtureState.workspaceRoot, allow_write: false }
  ]);
  const state = join(fixtureState.stateRoot, "collaboration");
  const service = new CollaborationRunService(state, registry, (workspaceRoot) => fakeExecutor(workspaceRoot));
  const runId = randomUUID() as Id;
  const started = await service.start({ request_id: runId, workspace_id: fixtureState.workspaceId, contract: contract() });
  assert.equal(started.state, "queued");
  await waitFor(async () => service.get(runId), (run) => run.state === "awaiting_review");

  const first = clientFor(fixtureState.configPath);
  const second = clientFor(fixtureState.configPath);
  try {
    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
    const [firstResult, secondResult] = await Promise.all([
      first.client.callTool({ name: "collaboration_result", arguments: { run_id: runId } }),
      second.client.callTool({ name: "collaboration_result", arguments: { run_id: runId } })
    ]);
    const firstView = parseToolResult(firstResult);
    const secondView = parseToolResult(secondResult);
    assert.deepEqual(secondView, firstView);
    assert.equal(firstView.state, "awaiting_review");
    const artifact = parseToolResult(await second.client.callTool({
      name: "collaboration_artifact",
      arguments: { run_id: runId, path: "result.json" }
    }));
    assert.equal(artifact.run_id, runId);
    assert.equal(artifact.path, "result.json");
    assert.equal(artifact.bytes, 12);
    assert.equal(artifact.sha256, "e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726");
    assert.equal(artifact.content, "{\"ok\":true}\n");
    const owner = await inspectBridgeOwner(fixtureState.configPath);
    assert.ok(owner?.alive);
    const ownerPid = owner.pid;
    await first.client.close();
    const stillShared = await inspectBridgeOwner(fixtureState.configPath);
    assert.equal(stillShared?.pid, ownerPid);
    await second.client.close();
    await waitForOwnerGone(fixtureState.configPath);

    const reconnect = clientFor(fixtureState.configPath);
    try {
      await reconnect.client.connect(reconnect.transport);
      const reconnected = await inspectBridgeOwner(fixtureState.configPath);
      assert.ok(reconnected?.alive);
      assert.notEqual(reconnected.pid, ownerPid);
      assert.equal(parseToolResult(await reconnect.client.callTool({
        name: "collaboration_result", arguments: { run_id: runId }
      })).state, "awaiting_review");
    } finally {
      await reconnect.client.close().catch(() => undefined);
    }
    await waitForOwnerGone(fixtureState.configPath);
  } finally {
    await first.client.close().catch(() => undefined);
    await second.client.close().catch(() => undefined);
  }
});

test("owner publishes the final identity after initialization creates the registry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "engineering-bridge-runtime-bootstrap-")));
  const configDirectory = join(root, "config");
  const stateRoot = join(root, "state");
  await Promise.all([mkdir(configDirectory, { mode: 0o700 }), mkdir(stateRoot, { mode: 0o700 })]);
  const configPath = join(configDirectory, "workspaces.json");
  await writeFile(configPath, `${JSON.stringify({
    version: 3,
    codex_projects: {
      source_file: join(root, "codex.toml"),
      auto_onboard: false,
      permission_policy: { allow_write: false }
    },
    excluded_workspace_ids: [], managed_roots: [], workspaces: []
  })}\n`, { mode: 0o600 });
  await writeFile(join(root, "codex.toml"), "# fixture\n", { mode: 0o600 });
  const owner = await startBridgeOwner(configPath, async () => {
    await writeFile(join(stateRoot, "workspace-registry.json"), "{\"version\":3,\"workspaces\":[]}\n", { mode: 0o600 });
    return {
      createServer: () => new McpServer({ name: "runtime-test", version: "1" }),
      close: async () => undefined
    };
  }, false);
  try {
    await owner.ready;
    const status = await inspectBridgeOwner(configPath);
    assert.equal(status?.state, "ready");
    assert.equal(status?.alive, true);
    assert.equal(lstatSync(join(stateRoot, "workspace-registry.json")).mode & 0o777, 0o600);
  } finally {
    await owner.close();
    await owner.closed;
  }
  assert.equal(await inspectBridgeOwner(configPath), undefined);
});

test("atomic owner publication leaves one live owner during concurrent startup", async () => {
  const fixtureState = await fixture("engineering-bridge-runtime-race-");
  const application = async () => ({
    createServer: () => new McpServer({ name: "runtime-race", version: "1" }),
    close: async () => undefined
  });
  const results = await Promise.allSettled([
    startBridgeOwner(fixtureState.configPath, application, false),
    startBridgeOwner(fixtureState.configPath, application, false)
  ]);
  const owners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startBridgeOwner>>> =>
    result.status === "fulfilled");
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(owners.length, 1);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]?.reason), /live Bridge runtime owner|still starting/u);
  try {
    await owners[0]!.value.ready;
  } finally {
    await owners[0]!.value.close();
    await owners[0]!.value.closed;
  }
  assert.equal(await inspectBridgeOwner(fixtureState.configPath), undefined);
});

test("executor child processes cannot re-enter the shared Bridge frontdoor", () => {
  const entry = process.env.ENGINEERING_BRIDGE_TEST_ENTRY ?? join(process.cwd(), "dist", "src", "mcp-stdio.js");
  const result = spawnSync(process.execPath, [entry], {
    env: { ...process.env, ENGINEERING_BRIDGE_EXECUTOR_CHILD: "1" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refuses recursive executor-child startup/u);
});

test("the plugin launcher also rejects executor-child recursion", { skip: process.platform !== "darwin" }, () => {
  const launcher = join(process.cwd(), "bin", "plugin-launcher.mjs");
  const result = spawnSync(process.execPath, [launcher], {
    env: { ...process.env, ENGINEERING_BRIDGE_EXECUTOR_CHILD: "1" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /recursive executor-child startup/u);
});
