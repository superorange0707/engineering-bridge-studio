#!/usr/bin/env node
// Explicit live check: this invokes the installed, authenticated Codex CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inspectWorkspace } from "../dist/src/workspaces/repository-identity.js";
import { inspectBridgeOwner } from "../dist/src/runtime/bridge-runtime.js";

if (!process.argv.includes("--live")) {
  process.stderr.write("Usage: node bin/collaboration-smoke.mjs --live (runs a real Codex experiment)\n");
  process.exit(2);
}

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await realpath(await mkdtemp(join(tmpdir(), "bridge-collaboration-smoke-")));
const project = join(root, "source-project");
const state = join(root, "state");
const config = join(root, "config", "workspaces.json");
await mkdir(project, { mode: 0o700 });
await mkdir(state, { mode: 0o700 });
await mkdir(dirname(config), { mode: 0o700 });
const idea = "Synthetic reproducibility smoke test. This file must remain unchanged.\n";
await writeFile(join(project, "idea.md"), idea);
const inspected = await inspectWorkspace(project);
const identity = inspected.filesystem;
const workspaceId = randomUUID();
await writeFile(join(state, "workspace-registry.json"), JSON.stringify({ version: 3, workspaces: [] }), { mode: 0o600 });
await writeFile(config, JSON.stringify({
  version: 3,
  collaboration: { execution_workspace_ids: [workspaceId] },
  codex_projects: { source_file: join(root, ".codex", "config.toml"), auto_onboard: false, permission_policy: { allow_write: false } },
  excluded_workspace_ids: [],
  managed_roots: [],
  workspaces: [{
    workspace_id: workspaceId, display_name: "Collaboration smoke", aliases: [],
    current_path: project, previous_paths: [], workspace_type: "directory_workspace",
    filesystem_identity: {
      fingerprint: identity.fingerprint,
      ...(identity.localMetadataId === undefined ? {} : { local_metadata_id: identity.localMetadataId }),
      ...(identity.stableObjectIdentity === undefined ? {} : { stable_object_identity: {
        version: 2, id: identity.stableObjectIdentity.id, inode: identity.stableObjectIdentity.inode,
        birthtime_ns: identity.stableObjectIdentity.birthtimeNs,
        device_observation: identity.stableObjectIdentity.deviceObservation
      } })
    }, codex_project_references: [], permission_policy: { allow_write: false }
  }]
}, null, 2), { mode: 0o600 });

async function connect() {
  const client = new Client({ name: "collaboration-live-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(repo, "dist/src/mcp-stdio.js"), config],
    cwd: repo, stderr: "pipe"
  });
  await client.connect(transport);
  return client;
}
async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content.find((item) => item.type === "text");
  const value = JSON.parse(content?.text ?? "null");
  assert.ok(!response.isError, `${name}: ${JSON.stringify(value)}`);
  return value;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function readArtifact(client, runId, path) {
  const parts = [];
  let offset = 0;
  let first;
  while (true) {
    const page = await call(client, "collaboration_artifact", { run_id: runId, path, offset_bytes: offset });
    first ??= page;
    assert.equal(page.sha256, first.sha256);
    assert.equal(page.bytes, first.bytes);
    assert.equal(page.offset_bytes, offset);
    assert.ok(page.bytes <= 16 * 1024 * 1024);
    const chunk = page.content_base64 === undefined
      ? Buffer.from(page.content, "utf8") : Buffer.from(page.content_base64, "base64");
    assert.equal(chunk.length, page.chunk_bytes);
    parts.push(chunk);
    offset += chunk.length;
    if (page.eof) { assert.equal(page.next_offset_bytes, null); break; }
    assert.ok(chunk.length > 0);
    assert.equal(page.next_offset_bytes, offset);
    assert.ok(offset < first.bytes);
  }
  const bytes = Buffer.concat(parts);
  assert.equal(bytes.length, first.bytes);
  assert.equal(hash(bytes), first.sha256);
  return { run_id: runId, path, bytes: bytes.length, sha256: first.sha256, content_base64: bytes.toString("base64") };
}
// Replay uses the official app-server command sandbox, never host execution of generated code.
async function replayScript(cwd) {
  const child = spawn("codex", ["app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "ignore"],
    env: Object.fromEntries(["PATH", "HOME", "CODEX_HOME", "USER", "LOGNAME", "LANG", "TMPDIR"]
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])) });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sandbox replay timed out")), 45_000);
      let buffer = "";
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.on("error", finish);
      child.on("close", () => finish(new Error("Sandbox replay closed before completion")));
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 1024 * 1024) return finish(new Error("Sandbox replay output too large"));
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { return finish(new Error("Invalid sandbox protocol")); }
          if (message.error) return finish(new Error("Sandbox replay request failed"));
          if (message.id === 1) {
            child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
            child.stdin.write(JSON.stringify({ id: 2, method: "command/exec", params: {
              command: [process.execPath, "experiment.mjs"], cwd, timeoutMs: 30_000,
              sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false,
                excludeSlashTmp: true, excludeTmpdirEnvVar: true }
            } }) + "\n");
          } else if (message.id === 2) {
            finish(message.result?.exitCode === 0 ? undefined : new Error("Independent script replay failed"));
          }
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
        clientInfo: { name: "bridge-sandbox-replay", version: "1.0.0" }
      } }) + "\n");
    });
  } finally { child.kill(); }
}
let client = await connect();
let peer;
try {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 19);
  const capabilities = await call(client, "bridge_capabilities", {});
  assert.equal(capabilities.max_ready, true);
  const initialOwner = await inspectBridgeOwner(config);
  assert.ok(initialOwner?.alive, "shared owner must be alive");
  peer = await connect();
  assert.equal((await inspectBridgeOwner(config)).pid, initialOwner.pid);
  const contract = JSON.parse(await readFile(join(repo, "examples/research-smoke-contract.json"), "utf8"));
  const started = await call(client, "collaboration_run", {
    request_id: randomUUID(), workspace_id: workspaceId, contract, input_files: ["idea.md"]
  });
  process.stdout.write(`Started real Codex run ${started.run_id}\n`);
  let result;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    result = await call(client, "collaboration_result", { run_id: started.run_id });
    if (!["queued", "running", "interrupting"].includes(result.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(result.state, "awaiting_review", JSON.stringify(result));
  const artifacts = {};
  for (const path of ["experiment.mjs", "metrics.json", "run.log"]) {
    artifacts[path] = await readArtifact(client, started.run_id, path);
  }
  // Re-execute the returned script independently, not the model's claim of a rerun.
  const verification = join(root, "independent-verification");
  await mkdir(verification, { mode: 0o700 });
  const bytes = (artifact) => artifact.content_base64 === undefined
    ? Buffer.from(artifact.content, "utf8") : Buffer.from(artifact.content_base64, "base64");
  const metrics = JSON.parse(bytes(artifacts["metrics.json"]).toString("utf8"));
  assert.deepEqual(metrics.results.map((row) => row.seed), [17, 29, 43]);
  assert.equal(metrics.node_version, process.version);
  for (const row of metrics.results) {
    assert.equal(row.train_size, 64); assert.equal(row.test_size, 32);
    assert.equal(Object.keys(row.test_mse).length, 2);
    assert.ok(Object.values(row.test_mse).every((value) => Number.isFinite(value) && value >= 0));
  }
  await writeFile(join(verification, "experiment.mjs"), bytes(artifacts["experiment.mjs"]));
  await replayScript(verification);
  const replay = await readFile(join(verification, "metrics.json"));
  assert.equal(hash(replay), hash(bytes(artifacts["metrics.json"])), "independent replay metrics mismatch");
  assert.equal(await readFile(join(project, "idea.md"), "utf8"), idea, "source input modified");
  await call(client, "collaboration_review", {
    run_id: started.run_id, decision: "accept",
    feedback: "Infrastructure smoke accepted: declared artifacts read back and independent replay produced byte-identical metrics; source idea.md unchanged. This is not a scientific novelty or publication claim."
  });
  const peerResult = await call(peer, "collaboration_result", { run_id: started.run_id });
  assert.equal(peerResult.state, "accepted", "second MCP session must see the review");
  assert.equal((await readArtifact(peer, started.run_id, "metrics.json")).sha256, hash(replay));
  await client.close();
  await peer.close();
  peer = undefined;
  const idleDeadline = Date.now() + 15_000;
  while ((await inspectBridgeOwner(config))?.alive && Date.now() < idleDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(!(await inspectBridgeOwner(config))?.alive, "old owner must exit before restart verification");
  client = await connect();
  const restartedOwner = await inspectBridgeOwner(config);
  assert.ok(restartedOwner?.alive);
  assert.notEqual(restartedOwner.pid, initialOwner.pid, "reconnect alone is not a service restart");
  const recovered = await call(client, "collaboration_result", { run_id: started.run_id });
  const history = await call(client, "collaboration_history", { workspace_id: workspaceId });
  assert.ok(history.runs.some((run) => run.run_id === started.run_id));
  const recoveredMetrics = await readArtifact(client, started.run_id, "metrics.json");
  assert.equal(hash(bytes(recoveredMetrics)), hash(replay));
  assert.equal(recovered.state, "accepted");
  const report = { checked_at: new Date().toISOString(), scope: "two local MCP sessions and real Codex; browser round trip not verified", run_id: started.run_id, source_workspace: project, state_root: state, recovered_state: recovered.state, metrics_sha256: hash(replay), independent_replay: "passed", source_input_unchanged: true, shared_sessions: "passed", restart_recovery: "passed", owner_pids: [initialOwner.pid, restartedOwner.pid], artifacts };
  await writeFile(join(root, "verification.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(`PASS: real execution, artifact read-back, independent replay and restart recovery.\nReport: ${join(root, "verification.json")}\n`);
} finally {
  await client.close();
  await peer?.close();
}
