import { createHash } from "node:crypto";
import { constants, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CoreError } from "../core/errors.js";
import {
  acquireControlPlaneRuntimeLease,
  applyControlPlaneTransaction
} from "./control-plane-transaction.js";
import type { ControlPlaneTransactionTestHooks } from "./control-plane-transaction.js";

const PROPOSAL_ID = "workspace-identity-v2-migration-24-6ccd39b537567a21";
const PATCH_SHA256 = "a1510cd9103e5ed8f2b50d364330a948150a804050fd9ad1e16fc22fbae870cc";
const CONFIG_PRE_SHA256 = "7ffae04e3a1a49745e27c2d7b3b4f16df9624c3632de7dd9c4d62d81da302b67";
const CONFIG_RESULT_SHA256 = "80173e1c1c17c45fac1681422384444c645e3c411c93020de4db429054cf3366";
const REGISTRY_PRE_SHA256 = "9a00e71777e799326e668cf70dfafccdca995a21dc19fc8100a77923723e4376";
const REGISTRY_RESULT_SHA256 = "ef609b5b6b3a421f09940462bd3b637c8c48baf12774e43a91033061f848f1f2";
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface FrozenIdentityV2MigrationRequest {
  readonly proposalId: string;
  readonly confirmation: string;
  readonly artifactDirectory: string;
}

function fail(): never {
  throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function readArtifact(directory: string, name: string, expectedSha256: string): Promise<Buffer> {
  const path = join(directory, name);
  if (await realpath(path).catch(() => fail()) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail());
  try {
    const metadata = await handle.stat().catch(() => fail());
    const uid = process.getuid?.();
    if (uid === undefined || !metadata.isFile() || metadata.uid !== uid || metadata.nlink !== 1 ||
        (metadata.mode & 0o022) !== 0 || metadata.size > MAX_ARTIFACT_BYTES) fail();
    const contents = await handle.readFile().catch(() => fail());
    if (contents.length !== metadata.size || sha256(contents) !== expectedSha256) fail();
    return contents;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function trustedConfigPath(): Promise<string> {
  const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() => fail());
  const stackRoot = resolve(dirname(modulePath), "../../../..");
  if (modulePath !== join(
    stackRoot,
    "engineering-bridge-router",
    "dist",
    "src",
    "workspaces",
    "apply-identity-v2-migration.js"
  )) fail();
  return join(stackRoot, "config", "workspaces.json");
}

export async function applyFrozenIdentityV2Migration(
  request: FrozenIdentityV2MigrationRequest,
  hooks?: ControlPlaneTransactionTestHooks
): Promise<void> {
  if (request.proposalId !== PROPOSAL_ID || request.confirmation !== "APPLY" ||
      !isAbsolute(request.artifactDirectory) || normalize(request.artifactDirectory) !== request.artifactDirectory) fail();
  const artifactDirectory = await realpath(request.artifactDirectory).catch(() => fail());
  if (artifactDirectory !== request.artifactDirectory) fail();
  const metadata = await lstat(artifactDirectory).catch(() => fail());
  const uid = process.getuid?.();
  if (uid === undefined || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid ||
      (metadata.mode & 0o022) !== 0) fail();

  const [configResult, registryResult] = await Promise.all([
    readArtifact(artifactDirectory, "WORKSPACES_CONFIG.identity-v2.proposed.json", CONFIG_RESULT_SHA256),
    readArtifact(artifactDirectory, "WORKSPACE_REGISTRY.identity-v2.proposed.json", REGISTRY_RESULT_SHA256),
    readArtifact(artifactDirectory, "IDENTITY_V2_CONTROL_PLANE_MIGRATION.patch", PATCH_SHA256)
  ]);
  const configPath = await trustedConfigPath();
  const release = await acquireControlPlaneRuntimeLease(configPath, "migration");
  try {
    await applyControlPlaneTransaction({
      configPath,
      proposalId: PROPOSAL_ID,
      configPreimageSha256: CONFIG_PRE_SHA256,
      configResultSha256: CONFIG_RESULT_SHA256,
      configResult,
      registryPreimageSha256: REGISTRY_PRE_SHA256,
      registryResultSha256: REGISTRY_RESULT_SHA256,
      registryResult
    }, hooks);
  } finally {
    await release();
  }
}

async function main(): Promise<void> {
  const [proposalId, confirmation, artifactDirectory, extra] = process.argv.slice(2);
  if (proposalId === undefined || confirmation === undefined || artifactDirectory === undefined || extra !== undefined) fail();
  await applyFrozenIdentityV2Migration({ proposalId, confirmation, artifactDirectory });
  process.stdout.write("IDENTITY_V2_MIGRATION_APPLY=PASS\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("Identity-v2 migration failed closed.\n");
    process.exitCode = 1;
  });
}
