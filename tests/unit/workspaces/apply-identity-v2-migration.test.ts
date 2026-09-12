import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROPOSAL_ID = "workspace-identity-v2-migration-24-6ccd39b537567a21";
const CONFIG_PRE_SHA256 = "7ffae04e3a1a49745e27c2d7b3b4f16df9624c3632de7dd9c4d62d81da302b67";
const CONFIG_RESULT_SHA256 = "80173e1c1c17c45fac1681422384444c645e3c411c93020de4db429054cf3366";
const REGISTRY_PRE_SHA256 = "9a00e71777e799326e668cf70dfafccdca995a21dc19fc8100a77923723e4376";
const REGISTRY_RESULT_SHA256 = "ef609b5b6b3a421f09940462bd3b637c8c48baf12774e43a91033061f848f1f2";
const AUTHORITATIVE_STACK = resolve(homedir(), "Developer", "ai-engineering-stack");
const ARTIFACT_DIRECTORY = process.env.IDENTITY_V2_MIGRATION_ARTIFACT_DIR;
const CONFIG_PREIMAGE = process.env.IDENTITY_V2_MIGRATION_CONFIG_PREIMAGE;
const REGISTRY_PREIMAGE = process.env.IDENTITY_V2_MIGRATION_REGISTRY_PREIMAGE;
const SOURCE_DIST = fileURLToPath(new URL("../../../", import.meta.url));

interface Fixture {
  readonly root: string;
  readonly configPath: string;
  readonly registryPath: string;
  readonly entrypoint: string;
  readonly worker: string;
  readonly artifactDirectory: string;
  readonly configPreimage: Buffer;
  readonly registryPreimage: Buffer;
}

const enabled = ARTIFACT_DIRECTORY !== undefined && CONFIG_PREIMAGE !== undefined &&
  REGISTRY_PREIMAGE !== undefined;
const hash = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function requireIsolated(root: string): void {
  const temporary = realpathSync(tmpdir());
  if (!isWithin(temporary, root) || isWithin(AUTHORITATIVE_STACK, root)) {
    throw new Error("mutation-capable test rejected a non-isolated target");
  }
}

function fixture(): Fixture {
  if (!enabled) throw new Error("exact frozen migration test evidence is not configured");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "identity-v2-entrypoint-")));
  requireIsolated(root);
  const configDirectory = join(root, "config");
  const stateDirectory = join(root, "state");
  const bridgeDirectory = join(root, "engineering-bridge-router");
  mkdirSync(configDirectory, { mode: 0o700 });
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(bridgeDirectory, { mode: 0o700 });
  cpSync(SOURCE_DIST, join(bridgeDirectory, "dist"), { recursive: true });
  const configPath = join(configDirectory, "workspaces.json");
  const registryPath = join(stateDirectory, "workspace-registry.json");
  copyFileSync(CONFIG_PREIMAGE!, configPath);
  copyFileSync(REGISTRY_PREIMAGE!, registryPath);
  const configPreimage = readFileSync(configPath);
  const registryPreimage = readFileSync(registryPath);
  assert.equal(hash(configPreimage), CONFIG_PRE_SHA256);
  assert.equal(hash(registryPreimage), REGISTRY_PRE_SHA256);
  const artifactDirectory = realpathSync(ARTIFACT_DIRECTORY!);
  assert.equal(artifactDirectory, ARTIFACT_DIRECTORY);
  return {
    root,
    configPath,
    registryPath,
    entrypoint: join(bridgeDirectory, "dist", "src", "workspaces", "apply-identity-v2-migration.js"),
    worker: join(bridgeDirectory, "dist", "tests", "fixtures", "identity-v2-migration-entrypoint-worker.js"),
    artifactDirectory,
    configPreimage,
    registryPreimage
  };
}

async function run(
  command: string,
  args: readonly string[]
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, [command, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

function requirePreimages(value: Fixture): void {
  assert.deepEqual(readFileSync(value.configPath), value.configPreimage);
  assert.deepEqual(readFileSync(value.registryPath), value.registryPreimage);
}

function requireResults(value: Fixture): void {
  assert.equal(hash(readFileSync(value.configPath)), CONFIG_RESULT_SHA256);
  assert.equal(hash(readFileSync(value.registryPath)), REGISTRY_RESULT_SHA256);
}

function copiedArtifactDirectory(value: Fixture): string {
  const target = join(value.root, `artifacts-${randomUUID()}`);
  mkdirSync(target, { mode: 0o700 });
  for (const name of [
    "WORKSPACES_CONFIG.identity-v2.proposed.json",
    "WORKSPACE_REGISTRY.identity-v2.proposed.json",
    "IDENTITY_V2_CONTROL_PLANE_MIGRATION.patch"
  ]) copyFileSync(join(value.artifactDirectory, name), join(target, name));
  return target;
}

async function waitForFile(path: string, child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before checkpoint: ${child.exitCode ?? child.signalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker checkpoint timed out");
}

async function stoppedWorker(
  value: Fixture,
  action: "apply" | "recover" | "lease",
  checkpoint: string
): Promise<ReturnType<typeof spawn>> {
  const marker = join(value.root, `${action}-${checkpoint}-${randomUUID()}.marker`);
  const child = spawn(process.execPath, [
    value.worker,
    action,
    value.configPath,
    value.artifactDirectory,
    checkpoint,
    marker
  ], { stdio: "ignore" });
  await waitForFile(marker, child);
  return child;
}

async function kill(child: ReturnType<typeof spawn>): Promise<void> {
  assert.equal(child.kill("SIGKILL"), true);
  const [, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  assert.equal(signal, "SIGKILL");
}

test("frozen production entrypoint enforces exact Owner gate, payload, target, and quiescence", {
  skip: !enabled
}, async () => {
  const wrongConfirmation = fixture();
  assert.notEqual((await run(wrongConfirmation.entrypoint, [
    PROPOSAL_ID, "REVIEW", wrongConfirmation.artifactDirectory
  ])).code, 0);
  requirePreimages(wrongConfirmation);

  const missingConfirmation = fixture();
  assert.notEqual((await run(missingConfirmation.entrypoint, [PROPOSAL_ID])).code, 0);
  requirePreimages(missingConfirmation);

  const wrongProposal = fixture();
  assert.notEqual((await run(wrongProposal.entrypoint, [
    "wrong-proposal", "APPLY", wrongProposal.artifactDirectory
  ])).code, 0);
  requirePreimages(wrongProposal);

  for (const name of [
    "WORKSPACES_CONFIG.identity-v2.proposed.json",
    "WORKSPACE_REGISTRY.identity-v2.proposed.json",
    "IDENTITY_V2_CONTROL_PLANE_MIGRATION.patch"
  ]) {
    const badPayload = fixture();
    const copiedArtifacts = copiedArtifactDirectory(badPayload);
    writeFileSync(join(copiedArtifacts, name), "wrong\n", { mode: 0o600 });
    assert.notEqual((await run(badPayload.entrypoint, [
      PROPOSAL_ID, "APPLY", copiedArtifacts
    ])).code, 0);
    requirePreimages(badPayload);
  }

  const stale = fixture();
  writeFileSync(stale.configPath, "stale\n", { mode: 0o600 });
  assert.notEqual((await run(stale.entrypoint, [PROPOSAL_ID, "APPLY", stale.artifactDirectory])).code, 0);
  assert.equal(readFileSync(stale.configPath, "utf8"), "stale\n");
  assert.deepEqual(readFileSync(stale.registryPath), stale.registryPreimage);

  const staleRegistry = fixture();
  writeFileSync(staleRegistry.registryPath, "stale\n", { mode: 0o600 });
  assert.notEqual((await run(staleRegistry.entrypoint, [
    PROPOSAL_ID, "APPLY", staleRegistry.artifactDirectory
  ])).code, 0);
  assert.deepEqual(readFileSync(staleRegistry.configPath), staleRegistry.configPreimage);
  assert.equal(readFileSync(staleRegistry.registryPath, "utf8"), "stale\n");

  const substituted = fixture();
  const outside = join(substituted.root, "outside-config");
  copyFileSync(substituted.configPath, outside);
  unlinkSync(substituted.configPath);
  symlinkSync(outside, substituted.configPath);
  assert.notEqual((await run(substituted.entrypoint, [
    PROPOSAL_ID, "APPLY", substituted.artifactDirectory
  ])).code, 0);
  assert.deepEqual(readFileSync(outside), substituted.configPreimage);

  const blocked = fixture();
  const runtime = await stoppedWorker(blocked, "lease", "lease");
  assert.notEqual((await run(blocked.entrypoint, [PROPOSAL_ID, "APPLY", blocked.artifactDirectory])).code, 0);
  requirePreimages(blocked);
  await kill(runtime);

  const canary = join(blocked.root, "must-not-change");
  writeFileSync(canary, "canary\n", { mode: 0o600 });
  const applied = await run(blocked.entrypoint, [PROPOSAL_ID, "APPLY", blocked.artifactDirectory]);
  assert.equal(applied.code, 0);
  assert.equal(applied.stdout, "IDENTITY_V2_MIGRATION_APPLY=PASS\n");
  assert.equal(applied.stderr, "");
  requireResults(blocked);
  assert.equal(readFileSync(canary, "utf8"), "canary\n");
});

test("frozen production entrypoint survives SIGKILL and restart recovery at commit boundaries", {
  skip: !enabled
}, async () => {
  const beforeReplace = fixture();
  await kill(await stoppedWorker(beforeReplace, "apply", "after_prepared"));
  const beforeReplaceRecovery = await run(beforeReplace.worker, [
    "recover", beforeReplace.configPath, beforeReplace.artifactDirectory, "never", join(beforeReplace.root, "unused")
  ]);
  assert.equal(beforeReplaceRecovery.code, 0, beforeReplaceRecovery.stderr);
  requirePreimages(beforeReplace);

  for (const checkpoint of [
    "after_commit_intent",
    "after_config_replace",
    "after_registry_replace",
    "before_committed",
    "after_committed"
  ] as const) {
    const value = fixture();
    await kill(await stoppedWorker(value, "apply", checkpoint));
    const recovery = await run(value.worker, [
      "recover", value.configPath, value.artifactDirectory, "never", join(value.root, "unused")
    ]);
    assert.equal(recovery.code, 0, recovery.stderr);
    requireResults(value);
  }

  for (const recoveryCheckpoint of ["after_recovery_config", "after_recovery_registry"] as const) {
    const value = fixture();
    await kill(await stoppedWorker(value, "apply", "after_commit_intent"));
    await kill(await stoppedWorker(value, "recover", recoveryCheckpoint));
    const recovery = await run(value.worker, [
      "recover", value.configPath, value.artifactDirectory, "never", join(value.root, "unused")
    ]);
    assert.equal(recovery.code, 0, recovery.stderr);
    requireResults(value);
  }
});
