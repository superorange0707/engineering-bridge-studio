import { realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { applyFrozenIdentityV2Migration } from "../../src/workspaces/apply-identity-v2-migration.js";
import {
  acquireControlPlaneRuntimeLease,
  recoverControlPlaneTransactions
} from "../../src/workspaces/control-plane-transaction.js";
import type { ControlPlaneTransactionCheckpoint } from "../../src/workspaces/control-plane-transaction.js";

const AUTHORITATIVE_STACK = resolve(homedir(), "Developer", "ai-engineering-stack");

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function requireIsolated(configPath: string): Promise<void> {
  const root = resolve(dirname(configPath), "..");
  const temporary = await realpath(tmpdir());
  if (!isWithin(temporary, root)) throw new Error("isolated target is outside the temporary root");
  if (isWithin(AUTHORITATIVE_STACK, root)) throw new Error("isolated target overlaps the authoritative stack");
  if (configPath !== resolve(root, "config", "workspaces.json")) throw new Error("isolated config target is invalid");
}

const [action, configPath, artifactDirectory, stopAt, markerPath] = process.argv.slice(2);
if ((action !== "apply" && action !== "recover" && action !== "lease") || configPath === undefined ||
    artifactDirectory === undefined || stopAt === undefined || markerPath === undefined) {
  throw new Error("invalid worker arguments");
}
await requireIsolated(configPath);

const checkpoint = async (value: ControlPlaneTransactionCheckpoint) => {
  if (value !== stopAt) return;
  await writeFile(markerPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  process.kill(process.pid, "SIGSTOP");
};

if (action === "apply") {
  await applyFrozenIdentityV2Migration({
    proposalId: "workspace-identity-v2-migration-24-6ccd39b537567a21",
    confirmation: "APPLY",
    artifactDirectory
  }, { checkpoint });
} else if (action === "recover") {
  const release = await acquireControlPlaneRuntimeLease(configPath, "runtime");
  try {
    await recoverControlPlaneTransactions(configPath, { checkpoint });
  } finally {
    await release();
  }
} else {
  await acquireControlPlaneRuntimeLease(configPath, "runtime");
  await writeFile(markerPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  process.kill(process.pid, "SIGSTOP");
}
