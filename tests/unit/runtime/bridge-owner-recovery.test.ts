import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const runtimeModule = await import(
  process.execArgv.includes("--experimental-strip-types")
    ? "../../../src/runtime/bridge-runtime.ts"
    : "../../../src/runtime/bridge-runtime.js"
);
const {
  inspectBridgeBuildIdentity,
  inspectBridgeOwner,
  runBridgeStdioFrontdoor,
  startBridgeOwner
} = runtimeModule;

async function fixture(prefix: string): Promise<{ readonly root: string; readonly configPath: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const configDirectory = join(root, "config");
  await Promise.all([mkdir(configDirectory, { mode: 0o700 }), mkdir(join(root, "state"), { mode: 0o700 })]);
  const configPath = join(configDirectory, "workspaces.json");
  await writeFile(configPath, "{\"version\":3,\"workspaces\":[]}\n", { mode: 0o600 });
  return { root, configPath };
}

function socketPathFor(configPath: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The owner recovery test requires a local user identity.");
  const directory = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  return join(directory, `engineering-bridge-${uid}`, `.mcp.sock-${createHash("sha256").update(configPath).digest("hex").slice(0, 24)}`);
}

async function ensureSocketDirectory(configPath: string): Promise<string> {
  const socketPath = socketPathFor(configPath);
  await mkdir(dirname(socketPath), { mode: 0o700, recursive: true });
  return socketPath;
}

function application(): () => Promise<{
  readonly createServer: () => McpServer;
  readonly close: () => Promise<void>;
}> {
  return async () => ({
    createServer: () => new McpServer({ name: "owner-recovery-test", version: "1" }),
    close: async () => undefined
  });
}

async function listen(socketPath: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolvePromise());
  });
  return server;
}

async function closeAndRemoveSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  await unlink(socketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function createKilledOrphan(socketPath: string): Promise<void> {
  const script = [
    "const net = require('node:net');",
    "const server = net.createServer();",
    "server.once('error', (error) => { console.error(error); process.exit(2); });",
    `server.listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready\\n'));`
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolvePromise, reject) => {
    child.stdout.once("data", () => resolvePromise());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`orphan socket helper exited with ${code}`));
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise, reject) => {
    child.once("exit", () => resolvePromise());
    child.once("error", reject);
  });
}

test("runtime build identity covers copied code independent of installation path", { timeout: 30_000 }, async () => {
  const sourceMode = process.execArgv.includes("--experimental-strip-types");
  const extension = sourceMode ? ".ts" : ".js";
  const sourceRoot = join(process.cwd(), sourceMode ? "src" : "dist/src");
  if (!existsSync(sourceRoot)) return;
  const root = await mkdtemp(join(process.cwd(), ".bridge-build-identity-"));
  try {
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await Promise.all([
      cp(sourceRoot, join(firstRoot, "src"), { recursive: true }),
      cp(sourceRoot, join(secondRoot, "src"), { recursive: true }),
      copyFile(join(process.cwd(), "package.json"), join(root, "package.json"))
    ]);
    const firstModule = await import(`${pathToFileURL(join(firstRoot, `src/runtime/bridge-runtime${extension}`)).href}?copy=${randomUUID()}`);
    const secondModule = await import(`${pathToFileURL(join(secondRoot, `src/runtime/bridge-runtime${extension}`)).href}?copy=${randomUUID()}`);
    const firstIdentity = await firstModule.inspectBridgeBuildIdentity();
    const secondIdentity = await secondModule.inspectBridgeBuildIdentity();
    assert.equal(secondIdentity, firstIdentity);
    await writeFile(
      join(secondRoot, `src/tasks/collaboration-run-service${extension}`),
      `${await readFile(join(secondRoot, `src/tasks/collaboration-run-service${extension}`), "utf8")}\n// fingerprint test\n`
    );
    const changedIdentity = await secondModule.inspectBridgeBuildIdentity();
    assert.notEqual(changedIdentity, firstIdentity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner metadata binds cleanup to the socket dev and inode", { timeout: 30_000 }, async () => {
  const fixtureState = await fixture("engineering-bridge-owner-inode-");
  const owner = await startBridgeOwner(fixtureState.configPath, application(), false);
  try {
    await owner.ready;
    const metadata = JSON.parse(await readFile(owner.paths.ownerPath, "utf8")) as Record<string, unknown>;
    const socket = await lstat(owner.paths.socketPath);
    assert.equal(metadata.socket_dev, socket.dev);
    assert.equal(metadata.socket_ino, socket.ino);

    await unlink(owner.paths.socketPath);
    const replacement = await listen(owner.paths.socketPath);
    try {
      const replacementSocket = await lstat(owner.paths.socketPath);
      await owner.close();
      await owner.closed;
      const afterClose = await lstat(owner.paths.socketPath);
      assert.equal(afterClose.dev, replacementSocket.dev);
      assert.equal(afterClose.ino, replacementSocket.ino);
    } finally {
      await closeAndRemoveSocket(replacement, owner.paths.socketPath);
    }
    assert.equal(await inspectBridgeOwner(fixtureState.configPath), undefined);
  } finally {
    await owner.close().catch(() => undefined);
    await owner.closed.catch(() => undefined);
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("owner removes a dead orphan socket only after refusal and preserves an active listener", { timeout: 30_000 }, async () => {
  const fixtureState = await fixture("engineering-bridge-owner-orphan-");
  const socketPath = await ensureSocketDirectory(fixtureState.configPath);
  await createKilledOrphan(socketPath);
  assert.equal((await lstat(socketPath)).isSocket(), true);

  const owner = await startBridgeOwner(fixtureState.configPath, application(), false);
  try {
    await owner.ready;
    assert.equal((await lstat(owner.paths.socketPath)).isSocket(), true);
    await owner.close();
    await owner.closed;
  } finally {
    await owner.close().catch(() => undefined);
    await owner.closed.catch(() => undefined);
    await unlink(socketPath).catch(() => undefined);
    await rm(fixtureState.root, { recursive: true, force: true });
  }

  const activeFixture = await fixture("engineering-bridge-owner-active-socket-");
  const activeSocketPath = await ensureSocketDirectory(activeFixture.configPath);
  const listener = await listen(activeSocketPath);
  let factoryCalled = false;
  try {
    const failedOwner = await startBridgeOwner(activeFixture.configPath, async () => {
      factoryCalled = true;
      return await application()();
    }, false);
    await assert.rejects(failedOwner.ready, /socket listener is already active/u);
    await failedOwner.closed;
    assert.equal(factoryCalled, false);
    assert.equal((await lstat(activeSocketPath)).isSocket(), true);
  } finally {
    await closeAndRemoveSocket(listener, activeSocketPath);
    await rm(activeFixture.root, { recursive: true, force: true });
  }
});

test("frontdoor stops retrying after a spawned owner exits unsuccessfully", { timeout: 15_000 }, async () => {
  const fixtureState = await fixture("engineering-bridge-owner-invalid-start-");
  try {
    await writeFile(fixtureState.configPath, "not-json\n", { mode: 0o600 });
    const startedAt = Date.now();
    await assert.rejects(
      runBridgeStdioFrontdoor(fixtureState.configPath, { readOnly: false }),
      /Bridge runtime owner failed to start/u
    );
    assert.ok(Date.now() - startedAt < 5_000);
    assert.equal(await inspectBridgeOwner(fixtureState.configPath), undefined);
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});
