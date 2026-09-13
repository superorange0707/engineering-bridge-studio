import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inspectBridgeOwner } from "../../src/runtime/bridge-runtime.js";
import { applyControlPlaneTransaction } from "../../src/workspaces/control-plane-transaction.js";
import { inspectWorkspace } from "../../src/workspaces/repository-identity.js";
import type { StableObjectIdentityEvidence } from "../../src/workspaces/repository-identity.js";

const VERSION_MODULE = new URL("../../src/version.js", import.meta.url);

interface ToolResult {
  content: Array<{ type?: string; text?: string } | undefined>;
}

const BOOTSTRAP_TOOL_NAMES = ["bridge_studio", "bridge_setup_status"] as const;
const EXISTING_TOOL_NAMES = [
  "collaboration_run",
  "collaboration_result",
  "collaboration_history",
  "collaboration_artifact",
  "collaboration_review",
  "collaboration_interrupt",
  "run_task",
  "task_result",
  "control_task",
  "bind_project",
  "workspace_diagnostics",
  "refresh_workspace_registry",
  "create_project",
  "authorize_workspace_write",
  "generate_controlled_patch",
  "prepare_project_instructions",
  "refine_controlled_patch",
  "apply_controlled_patch",
  "bridge_capabilities"
] as const;

function assertStudioToolSurface(tools: Array<{ name: string }>): void {
  const expected = [...BOOTSTRAP_TOOL_NAMES, ...EXISTING_TOOL_NAMES];
  assert.equal(tools.length, BOOTSTRAP_TOOL_NAMES.length + EXISTING_TOOL_NAMES.length);
  assert.deepEqual(new Set(tools.map(({ name }) => name)), new Set(expected));
}

function newConfigPath(prefix: string): string {
  const stack = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const config = join(stack, "config");
  mkdirSync(config);
  const state = join(stack, "state");
  mkdirSync(state);
  const configPath = join(config, "workspaces.json");
  writeFileSync(configPath, "", { mode: 0o600 });
  writeFileSync(join(state, "workspace-registry.json"), `${JSON.stringify({
    version: 3,
    workspaces: []
  }, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

function configJson(
  managedRoots: Array<{ root: string; allowWrite?: boolean }> = [],
  workspaces: unknown[] = [],
  codexProjects: { sourceFile?: string; autoOnboard?: boolean; allowWrite?: boolean } = {}
): string {
  return `${JSON.stringify({
    version: 3,
    codex_projects: {
      source_file: codexProjects.sourceFile ?? join(tmpdir(), "engineering-bridge-absent-codex", "config.toml"),
      auto_onboard: codexProjects.autoOnboard ?? true,
      permission_policy: { allow_write: codexProjects.allowWrite ?? true }
    },
    excluded_workspace_ids: [],
    managed_roots: managedRoots.map(({ root, allowWrite = false }) => ({
      root,
      auto_onboard: true,
      permission_policy: { allow_write: allowWrite }
    })),
    workspaces
  }, null, 2)}\n`;
}

test("disabled Codex metadata onboarding stays off and reports the configured capabilities", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-codex-disabled-project-")));
  const codexConfigDirectory = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-codex-disabled-config-")));
  const codexConfigPath = join(codexConfigDirectory, "config.toml");
  writeFileSync(codexConfigPath, `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  const configPath = newConfigPath("engineering-bridge-codex-disabled-");
  writeFileSync(configPath, configJson([], [], {
    sourceFile: codexConfigPath,
    autoOnboard: false,
    allowWrite: false
  }));

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const capabilitiesResult = await client.callTool({ name: "bridge_capabilities", arguments: {} });
    const capabilitiesContent = capabilitiesResult.content as ToolResult["content"];
    const capabilities = JSON.parse(capabilitiesContent[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(capabilities.codex_project_metadata_auto_onboarding, false);
    assert.equal(capabilities.managed_root_auto_onboarding, false);

    const diagnosticsResult = await client.callTool({
      name: "workspace_diagnostics",
      arguments: { project_path: project }
    });
    const diagnosticsContent = diagnosticsResult.content as ToolResult["content"];
    const diagnostics = JSON.parse(diagnosticsContent[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(diagnostics.codex_project_reference, true);
    assert.equal(diagnostics.managed_onboarding_applicable, false);
    assert.equal(diagnostics.boundary_status, "INELIGIBLE");
    assert.equal(diagnostics.boundary_reason, "NO_AUTHORIZED_ONBOARDING_BOUNDARY");

    const refreshResult = await client.callTool({ name: "refresh_workspace_registry", arguments: {} });
    const refreshContent = refreshResult.content as ToolResult["content"];
    const refresh = JSON.parse(refreshContent[0]?.text ?? "{}") as { results?: unknown[] };
    assert.deepEqual(refresh.results, [{
      project_reference: project,
      canonical_path: project,
      status: "auto_onboarding_disabled"
    }]);
    const registry = JSON.parse(readFileSync(join(
      dirname(dirname(configPath)), "state", "workspace-registry.json"
    ), "utf8")) as { workspaces?: unknown[] };
    assert.deepEqual(registry.workspaces, []);
  } finally {
    await client.close();
  }
});

test("the macOS private-plugin launcher exposes the Bridge MCP tools", {
  skip: process.platform !== "darwin"
}, async () => {
  const configPath = newConfigPath("engineering-bridge-plugin-launcher-");
  writeFileSync(configPath, configJson([], [], { autoOnboard: false, allowWrite: false }));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.ENGINEERING_BRIDGE_CONFIG = configPath;
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "bin", "plugin-launcher.mjs")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    assertStudioToolSurface((await client.listTools()).tools);
  } finally {
    await client.close();
  }
});

function initRepository(path: string): void {
  execFileSync("git", ["init", "-q"], { cwd: path, stdio: "ignore" });
}

function serializedStableObjectIdentity(identity: StableObjectIdentityEvidence | undefined) {
  return identity === undefined ? {} : {
    stable_object_identity: {
      version: identity.version,
      id: identity.id,
      inode: identity.inode,
      birthtime_ns: identity.birthtimeNs,
      device_observation: identity.deviceObservation
    }
  };
}

async function approvedSeed(path: string, allowWrite: boolean): Promise<Record<string, unknown>> {
  const inspected = await inspectWorkspace(path);
  assert.equal(inspected.workspaceType, "git_workspace");
  assert.ok(inspected.git !== undefined);
  return {
    workspace_id: randomUUID(),
    display_name: path.split("/").at(-1) ?? "workspace",
    aliases: [],
    current_path: inspected.root,
    previous_paths: [],
    workspace_type: inspected.workspaceType,
    filesystem_identity: {
      fingerprint: inspected.filesystem.fingerprint,
      ...(inspected.filesystem.localMetadataId === undefined
        ? {}
        : { local_metadata_id: inspected.filesystem.localMetadataId }),
      ...serializedStableObjectIdentity(inspected.filesystem.stableObjectIdentity)
    },
    codex_project_references: [inspected.root],
    git_identity: {
      git_top_level: inspected.git!.gitTopLevel,
      logical_root: inspected.git!.logicalRoot,
      repository_identity: {
        fingerprint: inspected.git!.repository.fingerprint,
        ...(inspected.git!.repository.localMetadataId === undefined
          ? {}
          : { local_metadata_id: inspected.git!.repository.localMetadataId }),
        ...serializedStableObjectIdentity(inspected.git!.repository.stableObjectIdentity),
        object_format: inspected.git!.repository.objectFormat,
        normalized_remotes: inspected.git!.repository.normalizedRemotes,
        root_commits: inspected.git!.repository.rootCommits
      }
    },
    permission_policy: { allow_write: allowWrite }
  };
}

async function approvedDirectorySeed(path: string, allowWrite: boolean): Promise<Record<string, unknown>> {
  const inspected = await inspectWorkspace(path);
  assert.equal(inspected.workspaceType, "directory_workspace");
  return {
    workspace_id: randomUUID(),
    display_name: path.split("/").at(-1) ?? "workspace",
    aliases: [],
    current_path: inspected.root,
    previous_paths: [],
    workspace_type: inspected.workspaceType,
    filesystem_identity: {
      fingerprint: inspected.filesystem.fingerprint,
      ...(inspected.filesystem.localMetadataId === undefined
        ? {}
        : { local_metadata_id: inspected.filesystem.localMetadataId }),
      ...serializedStableObjectIdentity(inspected.filesystem.stableObjectIdentity)
    },
    codex_project_references: [inspected.root],
    permission_policy: { allow_write: allowWrite }
  };
}

test("MCP and Codex client metadata use the shared package VERSION, and stdio returns structured tool errors", async () => {
  const { VERSION } = await import(VERSION_MODULE.href) as { VERSION: unknown };
  const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: unknown }).version;

  assert.equal(VERSION, packageVersion);
  for (const path of ["src/mcp-stdio.ts", "src/executors/codex-executor.ts"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /import\s+\{\s*VERSION\s*\}\s+from\s+["'][^"']*version\.js["'];/u);
    assert.match(source, /version:\s*VERSION\b/u);
  }

  const configPath = newConfigPath("engineering-bridge-mcp-");
  writeFileSync(configPath, configJson());
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, VERSION);

    const listed = await client.listTools();
    assert.match(client.getInstructions() ?? "", /ChatGPT Web owns research/);
    assert.match(client.getInstructions() ?? "", /collaboration_history/);
    assert.deepEqual(listed.tools.map(({ name }) => name).sort(), [
      "apply_controlled_patch",
      "authorize_workspace_write",
      "bind_project",
      "bridge_capabilities",
      "collaboration_artifact",
      "collaboration_history",
      "collaboration_interrupt",
      "collaboration_result",
      "collaboration_review",
      "collaboration_run",
      "control_task",
      "create_project",
      "generate_controlled_patch",
      "prepare_project_instructions",
      "refine_controlled_patch",
      "refresh_workspace_registry",
      "run_task",
      "task_result",
      "workspace_diagnostics"
    ]);

    for (const name of ["collaboration_result", "collaboration_history", "collaboration_artifact"]) {
      assert.equal(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
    }
    assert.equal(listed.tools.find((tool) => tool.name === "collaboration_run")?.annotations?.readOnlyHint, false);
    const experiment = {
      request_id: randomUUID(),
      workspace_id: randomUUID(),
      contract: {
        domain: "engineering", objective: "Check an isolated artifact",
        plan: ["Create one deterministic result file"], acceptance_criteria: ["Result exists"],
        expected_artifacts: ["result.json"]
      }
    };
    const disabledExecution = await client.callTool({ name: "collaboration_run", arguments: experiment });
    assert.equal(disabledExecution.isError, true);
    assert.match(JSON.stringify(disabledExecution.content), /WORKSPACE_PRECONDITION_FAILED/);
    const invalidResearch = await client.callTool({ name: "collaboration_run", arguments: {
      ...experiment, contract: { ...experiment.contract, domain: "research" }
    } });
    assert.equal(invalidResearch.isError, true);

    const diagnosticsSchema = listed.tools.find(({ name }) => name === "workspace_diagnostics")?.inputSchema;
    assert.deepEqual(Object.keys(diagnosticsSchema?.properties ?? {}).sort(), ["project_path", "workspace_id"]);
    assert.equal(listed.tools.find(({ name }) => name === "prepare_project_instructions")?.inputSchema
      .properties?.workspace_id !== undefined, true);

    const runTaskInputSchema = listed.tools.find(({ name }) => name === "run_task")?.inputSchema;
    assert.ok(runTaskInputSchema !== undefined);
    assert.ok(Array.isArray(runTaskInputSchema.required));
    assert.ok(runTaskInputSchema.properties !== undefined);
    assert.deepEqual([...runTaskInputSchema.required].sort(), ["instruction", "workspace_id"]);
    assert.deepEqual(Object.keys(runTaskInputSchema.properties).sort(), [
      "executor",
      "handoff_snapshot",
      "instruction",
      "parent_task_id",
      "routing",
      "workspace_id"
    ]);

    const generatePatchInputSchema = listed.tools.find(
      ({ name }) => name === "generate_controlled_patch"
    )?.inputSchema;
    assert.ok(generatePatchInputSchema !== undefined);
    assert.ok(Array.isArray(generatePatchInputSchema.required));
    assert.ok(generatePatchInputSchema.properties !== undefined);
    assert.deepEqual([...generatePatchInputSchema.required].sort(), ["change_request", "workspace_id"]);
    assert.deepEqual(Object.keys(generatePatchInputSchema.properties).sort(), [
      "change_request",
      "handoff_snapshot",
      "parent_task_id",
      "routing",
      "workspace_id"
    ]);

    const assertInputValidationError = async (
      request: { name: string; arguments: Record<string, unknown> },
      expected: RegExp
    ): Promise<void> => {
      const rejected = await client.callTool(request);
      const serialized = JSON.stringify(rejected);
      assert.equal(rejected.isError, true);
      assert.match(serialized, expected);
      assert.doesNotMatch(serialized, /UNKNOWN_WORKSPACE/u);
      assert.equal(serialized.includes("task_id"), false);
    };

    await assertInputValidationError({
      name: "run_task",
      arguments: {
        workspace_id: "missing",
        instruction: "inspect",
        executor: "codex",
        parent_task_id: "parent-without-snapshot"
      }
    }, /handoff_snapshot/u);
    for (const dshOnlyField of [
      { routing: "local_lead" },
      { parent_task_id: "parent" },
      { handoff_snapshot: { objective: "inspect", current_state: "ready" } }
    ]) {
      await assertInputValidationError({
        name: "run_task",
        arguments: { workspace_id: "missing", instruction: "inspect", executor: "dsh", ...dshOnlyField }
      }, /not accepted for DSH/u);
    }
    await assertInputValidationError({
      name: "generate_controlled_patch",
      arguments: {
        workspace_id: "missing",
        change_request: "change",
        parent_task_id: "parent-without-snapshot"
      }
    }, /handoff_snapshot/u);

    const result = await client.callTool({
      name: "generate_controlled_patch",
      arguments: { workspace_id: "missing", change_request: "change nothing", routing: "local_lead" }
    });
    assert.equal(result.isError, true);
    const resultContent = result.content;
    assert.ok(Array.isArray(resultContent));
    const content = resultContent[0] as { type?: string; text?: string } | undefined;
    assert.equal(content?.type, "text");
    if (content?.type !== "text" || typeof content.text !== "string") return;
    assert.deepEqual(JSON.parse(content.text), {
      error: {
        code: "UNKNOWN_WORKSPACE",
        message: "The requested workspace is not registered."
      }
    });

    const refinementResult = await client.callTool({
      name: "refine_controlled_patch",
      arguments: { patch_task_id: "missing", change_request: "refine nothing", routing: "repo_principal" }
    });
    assert.equal(refinementResult.isError, true);
    const refinementResultContent = refinementResult.content;
    assert.ok(Array.isArray(refinementResultContent));
    const refinementContent = refinementResultContent[0] as { type?: string; text?: string } | undefined;
    assert.equal(refinementContent?.type, "text");
    if (refinementContent?.type !== "text" || typeof refinementContent.text !== "string") return;
    assert.deepEqual(JSON.parse(refinementContent.text), {
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: "The requested state transition is not allowed."
      }
    });

    for (const request of [
      { name: "generate_controlled_patch", arguments: { workspace_id: "missing", change_request: "change" } },
      { name: "refine_controlled_patch", arguments: { patch_task_id: "missing", change_request: "change" } },
      { name: "generate_controlled_patch", arguments: {
        workspace_id: "missing", change_request: "change", routing: "generic"
      } },
      { name: "run_task", arguments: {
        workspace_id: "missing", instruction: "inspect", model: "gpt-5.6-sol"
      } },
      { name: "run_task", arguments: {
        workspace_id: "missing", instruction: "inspect", reasoning_effort: "xhigh"
      } }
    ]) {
      const rejected = await client.callTool(request);
      assert.equal(rejected.isError, true);
      assert.equal(JSON.stringify(rejected).includes("task_id"), false);
    }

    for (const argumentsValue of [
      { workspace_id: "missing", instruction: "inspect" },
      { workspace_id: "missing", instruction: "inspect", executor: "codex" },
      { workspace_id: "missing", instruction: "inspect", routing: "implementer" },
      { workspace_id: "missing", instruction: "inspect", executor: "codex", routing: "repo_principal" },
      { workspace_id: "missing", instruction: "inspect", executor: "dsh" }
    ]) {
      const runResult = await client.callTool({
        name: "run_task",
        arguments: argumentsValue
      });
      assert.notEqual(runResult.isError, true);
      const runContent = runResult.content;
      assert.ok(Array.isArray(runContent));
      const first = runContent[0] as { type?: string; text?: string } | undefined;
      assert.equal(first?.type, "text");
      assert.equal(typeof first?.text, "string");
      if (typeof first?.text === "string") {
        const body = JSON.parse(first.text) as { task_id?: unknown };
        assert.equal(typeof body.task_id, "string");
      }
    }

    const unknownExecutor = await client.callTool({
      name: "run_task",
      arguments: {
        workspace_id: "missing",
        instruction: "inspect",
        executor: "unknown"
      }
    });
    assert.equal(unknownExecutor.isError, true);
    assert.equal(JSON.stringify(unknownExecutor).includes("task_id"), false);
  } finally {
    await client.close();
  }
});

test("Routed Codex read-only mode loads the central catalog without mutating or reconciling it", async () => {
  const project = mkdtempSync(join(tmpdir(), "engineering-bridge-routed-read-only-project-"));
  initRepository(project);
  const seed = await approvedSeed(project, true);
  const configPath = newConfigPath("engineering-bridge-routed-read-only-config-");
  writeFileSync(configPath, configJson([], [seed]));
  const catalogFile = join(dirname(dirname(configPath)), "state", "workspace-registry.json");
  mkdirSync(dirname(catalogFile), { recursive: true });
  writeFileSync(catalogFile, `${JSON.stringify({
    version: 3,
    workspaces: [{
      workspace_id: seed.workspace_id,
      display_name: seed.display_name,
      aliases: seed.aliases,
      current_path: seed.current_path,
      previous_paths: seed.previous_paths,
      workspace_type: seed.workspace_type,
      filesystem_identity: seed.filesystem_identity,
      codex_project_references: seed.codex_project_references,
      ...(seed.git_identity === undefined ? {} : { git_identity: seed.git_identity }),
      permission_policy: seed.permission_policy,
      source: "approved"
    }]
  }, null, 2)}\n`, { mode: 0o600 });
  const before = readFileSync(catalogFile);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    env: { ...environment, CODEX_ROUTED_TASK_READ_ONLY: "1" },
    stderr: "pipe"
  });
  try {
    await client.connect(transport);
    for (const name of [
      "bind_project", "refresh_workspace_registry", "create_project", "authorize_workspace_write",
      "prepare_project_instructions"
    ]) {
      const result = await client.callTool({ name, arguments: name === "bind_project"
        ? { project_path: project }
        : name === "refresh_workspace_registry" ? {} : name === "create_project"
          ? { parent: project, name: "new-project", confirmation: "CREATE" }
          : name === "authorize_workspace_write"
            ? { workspace_id: seed.workspace_id, confirmation: "AUTHORIZE" }
            : { workspace_id: seed.workspace_id } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /WORKSPACE_PRECONDITION_FAILED/u);
    }
  } finally {
    await client.close();
  }
  assert.deepEqual(readFileSync(catalogFile), before);

  const ownerExitDeadline = Date.now() + 5_000;
  while (Date.now() < ownerExitDeadline) {
    const owner = await inspectBridgeOwner(configPath).catch(() => undefined);
    if (owner === undefined || !owner.alive) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  const ownerAfterClose = await inspectBridgeOwner(configPath).catch(() => undefined);
  assert.ok(ownerAfterClose === undefined || !ownerAfterClose.alive, "the shared owner must exit before rereading the catalog");

  const managedCatalog = JSON.parse(before.toString("utf8")) as {
    workspaces: Array<Record<string, unknown>>;
  };
  managedCatalog.workspaces[0]!.source = "managed";
  writeFileSync(catalogFile, `${JSON.stringify(managedCatalog, null, 2)}\n`, { mode: 0o600 });
  const managedBefore = readFileSync(catalogFile);
  const managedClient = new Client({ name: "test-client-managed", version: "1.0.0" });
  const managedTransport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    env: { ...environment, CODEX_ROUTED_TASK_READ_ONLY: "1" },
    stderr: "pipe"
  });
  try {
    await assert.rejects(managedClient.connect(managedTransport));
  } finally {
    await managedClient.close().catch(() => undefined);
  }
  assert.deepEqual(readFileSync(catalogFile), managedBefore);
});

test("workspace diagnostics keeps healthy Git identity separate from dirty proposal readiness", async () => {
  const project = mkdtempSync(join(tmpdir(), "engineering-bridge-dirty-diagnostic-"));
  initRepository(project);
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: project });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  writeFileSync(join(project, "note.txt"), "committed\n");
  execFileSync("git", ["add", "note.txt"], { cwd: project });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
  const seed = await approvedSeed(project, true);
  writeFileSync(join(project, "note.txt"), "legitimate unstaged work\n");
  const configPath = newConfigPath("engineering-bridge-dirty-diagnostic-config-");
  writeFileSync(configPath, configJson([], [seed]));
  const client = new Client({ name: "diagnostic-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const diagnose = async (): Promise<Record<string, unknown>> => {
    const result = await client.callTool({
      name: "workspace_diagnostics",
      arguments: { workspace_id: seed.workspace_id }
    });
    assert.notEqual(result.isError, true);
    const content = result.content as ToolResult["content"];
    return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
  };
  try {
    await client.connect(transport);
    const dirty = await diagnose();
    assert.equal(dirty.usable_by_workspace_id, true);
    assert.equal(dirty.boundary_status, "EXISTING_AUTHORITATIVE");
    assert.equal(dirty.filesystem_identity_status, "PASS");
    assert.equal(dirty.repository_identity_status, "PASS");
    assert.equal(dirty.controlled_proposal_status, "READY");
    assert.equal(dirty.controlled_proposal_reason, "UNSTAGED_DIRTY_WORKTREE_SUPPORTED");

    execFileSync("git", ["add", "note.txt"], { cwd: project });
    const staged = await diagnose();
    assert.equal(staged.usable_by_workspace_id, true);
    assert.equal(staged.boundary_status, "EXISTING_AUTHORITATIVE");
    assert.equal(staged.controlled_proposal_status, "BLOCKED");
    assert.equal(staged.controlled_proposal_reason, "INDEX_DIRTY");
  } finally {
    await client.close();
  }
});

test("task_result honestly reports the fixed executor and never fabricates a thread id", async () => {
  const configPath = newConfigPath("engineering-bridge-executor-view-");
  writeFileSync(configPath, configJson());

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body: body as Record<string, unknown> };
  };

  const waitForTerminal = async (taskId: string): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const poll = await call("task_result", { task_id: taskId });
      if (poll.body.state !== "queued" && poll.body.state !== "running") return poll.body;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("task did not reach a terminal state");
  };

  try {
    await client.connect(transport);

    // Codex auto routing reports its selected logical role and exact mapping; no thread_id exists yet.
    const codexRun = await call("run_task", {
      workspace_id: "missing",
      instruction: "inspect"
    });
    const codexTaskId = codexRun.body.task_id;
    assert.equal(typeof codexTaskId, "string");
    if (typeof codexTaskId !== "string") return;
    const codexView = await waitForTerminal(codexTaskId);
    assert.equal(codexView.executor, "codex");
    assert.equal(codexView.routing, "auto");
    assert.equal(codexView.logical_role, "local_lead");
    assert.equal(codexView.routing_reason, "default_quality_route");
    assert.equal(codexView.matched_rule, "quality_fallback");
    assert.deepEqual(codexView.matched_factors, []);
    assert.deepEqual(codexView.ignored_guard_factors, []);
    assert.equal(codexView.model, "gpt-5.6-terra");
    assert.equal(codexView.reasoning_effort, "max");
    assert.equal("thread_id" in codexView, false);
    assert.deepEqual(codexView.error, {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered."
    });

    // Explicit dsh selection is reported as dsh, still without any thread_id.
    const dshRun = await call("run_task", {
      workspace_id: "missing",
      instruction: "inspect",
      executor: "dsh"
    });
    const dshTaskId = dshRun.body.task_id;
    assert.equal(typeof dshTaskId, "string");
    if (typeof dshTaskId !== "string") return;
    const dshView = await waitForTerminal(dshTaskId);
    assert.equal(dshView.executor, "dsh");
    assert.equal("thread_id" in dshView, false);
    assert.deepEqual(dshView.error, {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered."
    });
  } finally {
    await client.close();
  }
});

test("task_result serializes retained routing audit, native evidence, and directory proposal_review", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-mcp-directory-review-")));
  writeFileSync(join(root, "README.md"), "before\n");
  const seed = await approvedDirectorySeed(root, true);
  const workspaceId = seed.workspace_id as string;
  const taskId = randomUUID();
  const configPath = newConfigPath("engineering-bridge-mcp-review-config-");
  const beforeSha = createHash("sha256").update("before\n").digest("hex");
  const output = `${JSON.stringify({
    version: 1,
    operations: [{
      operation: "modify",
      path: "README.md",
      before_sha256: beforeSha,
      content: "after\n"
    }]
  })}\n`;
  const evidence = [{
    id: "command-1",
    type: "commandExecution",
    status: "completed",
    command: "inspect README.md and package.json",
    result: { state: "complete", exit_code: 0, output: "README.md\nscripts.test=node --test\n" }
  }];
  const proposalReview = {
    status: "PASS",
    human_approvable: true,
    workspace_id: workspaceId,
    workspace_type: "directory_workspace",
    proposal_schema_status: "PASS",
    canonical_root_status: "PASS",
    workspace_type_status: "PASS",
    operation_limits_status: "PASS",
    operations: [{
      operation: "modify",
      path: "README.md",
      normalized_path_status: "PASS",
      target_within_root: "PASS",
      parent_path_symlink_status: "PASS",
      target_symlink_status: "PASS",
      target_exists: true,
      target_kind: "file",
      proposal_preimage_sha256: beforeSha,
      current_target_sha256: beforeSha,
      preimage_match: true,
      precondition_status: "PASS"
    }],
    apply_revalidation_required: true
  };
  const { VERSION } = await import(VERSION_MODULE.href) as { VERSION: string };
  writeFileSync(configPath, configJson([], [seed]));
  writeFileSync(`${configPath}.controlled-patches.json`, `${JSON.stringify({
    version: 3,
    applied_task_ids: [],
    proposals: [{
      task_id: taskId,
      workspace_id: workspaceId,
      workspace_root: root,
      base_head: null,
      filesystem: true,
      state: "proposed",
      routing: "auto",
      logical_role: "implementer",
      routing_reason: "bounded_implementation",
      routing_matched_rule: "bounded_implementation",
      routing_matched_factors: ["action:add", "scope:one", "scope:file"],
      routing_ignored_guard_factors: ["signal:migrations"],
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      bridge_version: VERSION,
      codex_version: "0.148.0",
      thread_id: "thread-review",
      evidence,
      proposal_review: proposalReview,
      executor: "codex",
      output
    }]
  }, null, 2)}\n`);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "task_result", arguments: { task_id: taskId } });
    const content = result.content as ToolResult["content"];
    const body = JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(body.matched_rule, "bounded_implementation");
    assert.deepEqual(body.matched_factors, ["action:add", "scope:one", "scope:file"]);
    assert.deepEqual(body.ignored_guard_factors, ["signal:migrations"]);
    assert.deepEqual(body.evidence, evidence);
    assert.deepEqual(body.proposal_review, proposalReview);
    assert.deepEqual(body.proposal_lifecycle, {
      stage: "READY",
      started_at: "1970-01-01T00:00:00.000Z",
      deadline_at: "1970-01-01T00:00:00.000Z",
      model_turn_started: true,
      model_turn_completed: true,
      proposal_bytes_received: Buffer.byteLength(output, "utf8"),
      parse_status: "PASS",
      validation_stage: "COMPLETE",
      terminal_transition: "READY"
    });
  } finally {
    await client.close();
  }
});

test("bind_project and create_project register workspaces inside approved project roots", async () => {
  const approved = mkdtempSync(join(tmpdir(), "engineering-bridge-approved-"));
  const configPath = newConfigPath("engineering-bridge-onboard-");
  const approvedProject = join(approved, "approved-project");
  mkdirSync(approvedProject);
  initRepository(approvedProject);
  const otherProject = join(approved, "other-project");
  mkdirSync(otherProject);
  initRepository(otherProject);
  const seed = await approvedSeed(approvedProject, true);
  writeFileSync(configPath, configJson([{ root: approved }], [seed]));

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body };
  };

  try {
    await client.connect(transport);

    // Attaching an existing approved workspace returns its stable id and policy.
    const approvedBind = await call("bind_project", { project_path: approvedProject });
    assert.equal(approvedBind.isError, false);
    const approvedBody = approvedBind.body as Record<string, unknown>;
    assert.equal(approvedBody.workspace_id, seed.workspace_id);
    assert.equal(approvedBody.root, realpathSync(approvedProject));
    assert.equal(approvedBody.allow_write, true);
    assert.equal(approvedBody.source, "approved");
    assert.equal(approvedBody.auto_onboarded, false);

    // Binding a new project creates a managed workspace and reuses its id.
    const firstBind = await call("bind_project", { project_path: otherProject });
    assert.equal(firstBind.isError, false);
    const firstBody = firstBind.body as { workspace_id?: unknown; root?: unknown; allow_write?: unknown; source?: unknown };
    assert.equal(typeof firstBody.workspace_id, "string");
    assert.equal(firstBody.root, realpathSync(otherProject));
    assert.equal(firstBody.allow_write, false);
    assert.equal(firstBody.source, "managed");
    assert.equal((firstBind.body as { auto_onboarded?: unknown }).auto_onboarded, true);

    const secondBind = await call("bind_project", { project_path: otherProject });
    assert.equal((secondBind.body as { workspace_id?: unknown }).workspace_id, firstBody.workspace_id);
    assert.equal((secondBind.body as { auto_onboarded?: unknown }).auto_onboarded, false);

    // The managed workspace is immediately usable for task routing.
    const run = await call("run_task", {
      workspace_id: firstBody.workspace_id,
      instruction: "inspect",
      executor: "dsh"
    });
    assert.equal(run.isError, false);
    assert.equal(typeof (run.body as { task_id?: unknown }).task_id, "string");

    // create_project performs mkdir + git init and reports an unborn HEAD.
    const created = await call("create_project", {
      parent: approved,
      name: "created-project",
      confirmation: "CREATE"
    });
    assert.equal(created.isError, false);
    const createdBody = created.body as { workspace_id?: unknown; root?: unknown; allow_write?: unknown; git?: unknown };
    assert.equal(typeof createdBody.workspace_id, "string");
    assert.equal(createdBody.root, realpathSync(join(approved, "created-project")));
    assert.equal(createdBody.allow_write, false);
    assert.deepEqual(createdBody.git, { initialized: true, head: "unborn" });
    assert.equal(readFileSync(join(approved, "created-project", ".git", "HEAD"), "utf8").includes("ref:"), true);

    // Wrong or missing confirmation is rejected by the schema without side effects.
    const wrongConfirmation = await call("create_project", {
      parent: approved,
      name: "rejected-project",
      confirmation: "NO"
    });
    assert.equal(wrongConfirmation.isError, true);
    assert.equal(JSON.stringify(wrongConfirmation.body).includes("workspace_id"), false);

    // Paths outside every approved root are rejected with a structured error.
    const outside = mkdtempSync(join(tmpdir(), "engineering-bridge-outside-"));
    const outsideBind = await call("bind_project", { project_path: outside });
    assert.equal(outsideBind.isError, true);
    assert.deepEqual(outsideBind.body, {
      error: {
        code: "WORKSPACE_BOUNDARY_VIOLATION",
        message: "The workspace boundary could not be verified."
      }
    });
  } finally {
    await client.close();
  }
});

test("startup rejects relative, non-normalized, or broad managed roots and accepts a valid one", async () => {
  for (const root of ["relative/root", "/registered/../root", "/", "/Users", homedir()]) {
    const configPath = newConfigPath("engineering-bridge-badroot-");
    writeFileSync(configPath, configJson([{ root }]));

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    // The server exits during startup, so connecting must fail.
    await assert.rejects(client.connect(transport));
    await client.close();
  }

  // A valid absolute, normalized project_root still boots.
  const configPath = newConfigPath("engineering-bridge-goodroot-");
  const approvedRoot = dirname(dirname(configPath));
  writeFileSync(configPath, configJson([{ root: approvedRoot }]));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some(({ name }) => name === "bind_project"), true);
  } finally {
    await client.close();
  }
});

test("startup treats Project Brain as a normal approved workspace candidate", async () => {
  const project = mkdtempSync(join(tmpdir(), "engineering-bridge-project-brain-seed-"));
  initRepository(project);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/superorange0707/project-brain.git"], {
    cwd: project,
    stdio: "ignore"
  });
  const seed = await approvedSeed(project, false);
  const configPath = newConfigPath("engineering-bridge-project-brain-seed-config-");
  writeFileSync(configPath, configJson([], [seed]));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 19);
  } finally {
    await client.close();
  }
});

test("startup recovers a durable commit intent before parsing workspaces.json", async () => {
  const configPath = newConfigPath("engineering-bridge-startup-recovery-");
  const registryPath = join(dirname(dirname(configPath)), "state", "workspace-registry.json");
  const configPreimage = Buffer.from("not valid json\n");
  const registryPreimage = Buffer.from(`${JSON.stringify({ version: 2, workspaces: [] }, null, 2)}\n`);
  const configResult = Buffer.from(configJson());
  const registryResult = Buffer.from(`${JSON.stringify({ version: 3, workspaces: [] }, null, 2)}\n`);
  writeFileSync(configPath, configPreimage);
  writeFileSync(registryPath, registryPreimage);
  const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
  const proposalId = "startup-recovery-before-config-parse";
  await assert.rejects(applyControlPlaneTransaction({
    configPath,
    proposalId,
    configPreimageSha256: digest(configPreimage),
    configResultSha256: digest(configResult),
    configResult,
    registryPreimageSha256: digest(registryPreimage),
    registryResultSha256: digest(registryResult),
    registryResult
  }, {
    checkpoint: (checkpoint) => {
      if (checkpoint === "after_commit_intent") throw new Error("simulated stop");
    }
  }));
  assert.deepEqual(readFileSync(configPath), configPreimage);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  try {
    await client.connect(transport);
    assert.deepEqual(readFileSync(configPath), configResult);
    assert.deepEqual(readFileSync(registryPath), registryResult);
    const retained = JSON.parse(readFileSync(join(
      dirname(registryPath), "control-plane-transactions", proposalId, "journal.json"
    ), "utf8")) as { phase: string };
    assert.equal(retained.phase, "COMMITTED");
  } finally {
    await client.close();
  }
});

test("startup never exposes MCP tools for a mixed config and registry generation", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-startup-mixed-project-")));
  const seed = await approvedDirectorySeed(project, true);
  const configPath = newConfigPath("engineering-bridge-startup-mixed-");
  writeFileSync(configPath, configJson([], [seed]));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.CODEX_ROUTED_TASK_READ_ONLY = "1";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe"
  });
  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("bind_project fails closed when no project_root is configured", async () => {
  const configPath = newConfigPath("engineering-bridge-noroots-");
  const project = join(dirname(configPath), "project");
  mkdirSync(project);
  initRepository(project);
  writeFileSync(configPath, configJson());

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "bind_project",
      arguments: { project_path: project }
    });
    assert.equal(result.isError, true);
    const content = result.content as ToolResult["content"];
    const body = JSON.parse(content[0]?.text ?? "") as { error?: unknown };
    assert.deepEqual(body.error, {
      code: "WORKSPACE_BOUNDARY_VIOLATION",
      message: "The workspace boundary could not be verified."
    });
  } finally {
    await client.close();
  }
});

test("authorize_workspace_write persists for managed workspaces and rejects approved seeds", async () => {
  const approved = mkdtempSync(join(tmpdir(), "engineering-bridge-authorize-"));
  const configPath = newConfigPath("engineering-bridge-authorize-config-");
  const managedProject = join(approved, "managed-project");
  const approvedProject = join(approved, "approved-project");
  mkdirSync(managedProject);
  initRepository(managedProject);
  mkdirSync(approvedProject);
  initRepository(approvedProject);
  const seed = await approvedSeed(approvedProject, true);
  writeFileSync(configPath, configJson([{ root: approved }], [seed]));

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body };
  };

  try {
    await client.connect(transport);

    const bound = await call("bind_project", { project_path: managedProject });
    const workspaceId = (bound.body as { workspace_id?: string }).workspace_id;
    assert.equal(typeof workspaceId, "string");

    // AUTHORIZE a managed workspace: persisted in the stable identity state.
    const authorized = await call("authorize_workspace_write", {
      workspace_id: workspaceId,
      confirmation: "AUTHORIZE"
    });
    assert.equal(authorized.isError, false);
    assert.deepEqual(authorized.body, { workspace_id: workspaceId, allow_write: true });
    const catalogFile = join(dirname(dirname(configPath)), "state", "workspace-registry.json");
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8")) as {
      workspaces: Array<{ workspace_id: string; permission_policy: { allow_write: boolean } }>;
    };
    assert.equal(catalog.workspaces.find(({ workspace_id }) => workspace_id === workspaceId)
      ?.permission_policy.allow_write, true);

    // Idempotent on repeat.
    const again = await call("authorize_workspace_write", {
      workspace_id: workspaceId,
      confirmation: "AUTHORIZE"
    });
    assert.deepEqual(again.body, authorized.body);

    // Approved seed policies stay authoritative through workspaces.json.
    const approvedResult = await call("authorize_workspace_write", {
      workspace_id: seed.workspace_id,
      confirmation: "AUTHORIZE"
    });
    assert.equal(approvedResult.isError, true);
    assert.deepEqual(approvedResult.body, {
      error: {
        code: "WORKSPACE_PRECONDITION_FAILED",
        message: "The workspace preconditions were not met."
      }
    });

    // Unknown workspaces are unchanged.
    const missing = await call("authorize_workspace_write", {
      workspace_id: "missing",
      confirmation: "AUTHORIZE"
    });
    assert.equal(missing.isError, true);
    assert.deepEqual(missing.body, {
      error: {
        code: "UNKNOWN_WORKSPACE",
        message: "The requested workspace is not registered."
      }
    });

    // Wrong confirmation is rejected by the schema.
    const wrong = await call("authorize_workspace_write", {
      workspace_id: workspaceId,
      confirmation: "NO"
    });
    assert.equal(wrong.isError, true);
    assert.equal(JSON.stringify(wrong.body).includes("allow_write"), false);
  } finally {
    await client.close();
  }
});
