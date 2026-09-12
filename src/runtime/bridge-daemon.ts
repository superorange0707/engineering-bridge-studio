#!/usr/bin/env node

import { createBridgeRuntime, createBridgeServer } from "../mcp-stdio.js";
import { startBridgeOwner } from "./bridge-runtime.js";

async function main(): Promise<void> {
  if (process.argv.length < 3 || process.argv.length > 4) {
    throw new Error("Usage: node dist/src/runtime/bridge-daemon.js /absolute/path/to/workspaces.json [--read-only]");
  }
  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("Workspace configuration path is required.");
  const ownerReadOnly = process.argv[3] === "--read-only";
  if (process.argv[3] !== undefined && !ownerReadOnly) throw new Error("Invalid Bridge runtime owner mode.");
  const owner = await startBridgeOwner(configPath, async (readOnly) => {
    const runtime = await createBridgeRuntime(configPath, readOnly);
    return {
      createServer: async (sessionReadOnly: boolean) => {
        if (!sessionReadOnly) await runtime.ensureWritable();
        return createBridgeServer(runtime, sessionReadOnly);
      },
      close: runtime.close,
      isBusy: () => runtime.service.hasActiveWork() || runtime.controlledPatches.hasActiveWork() ||
        [...runtime.executionWorkspaceIds].some((workspaceId) => {
          try {
            return runtime.collaboration.list(workspaceId).some(({ state }) =>
              state === "queued" || state === "running" || state === "interrupting");
          } catch {
            return false;
          }
        })
    };
  }, ownerReadOnly);
  const shutdown = () => { void owner.close().finally(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await owner.ready;
  await owner.closed;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Failed to start the Bridge runtime owner.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
