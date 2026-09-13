#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { open, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connectionFile as defaultConnectionFile, resolveConfigPath as defaultResolveConfigPath } from "./connection.mjs";
import { STUDIO_HOST, STUDIO_VERSION } from "./studio-server.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 75;
const LOCK_STALE_MS = 30_000;
const MAX_METADATA_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const PID_PATTERN = /^[1-9][0-9]*$/u;

export function defaultStudioStateDir() {
  return join(homedir(), ".local", "share", "engineering-bridge-studio", "studio");
}

function fail(message) {
  throw new Error(message);
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) {
    fail(`${label} must be an absolute, normalized path`);
  }
  return value;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function ensurePrivateDirectory(pathValue) {
  absolutePath(pathValue, "Studio state directory");
  await mkdir(pathValue, { recursive: true, mode: 0o700 });
  const info = await lstat(pathValue);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (currentUid() !== undefined && info.uid !== currentUid()) || (info.mode & 0o077) !== 0) {
    fail(`Studio requires a private state directory: ${pathValue}`);
  }
}

function scopeId({ pluginRoot, version, configPath, readOnly }) {
  return createHash("sha256")
    .update(`${pluginRoot}\0${version}\0${configPath}\0${readOnly ? "read-only" : "writable"}`, "utf8")
    .digest("hex");
}

function metadataExpected({ pluginRoot, version, configPath, readOnly }) {
  return {
    product: "engineering-bridge-studio-studio",
    plugin_root: pluginRoot,
    version,
    config_path: configPath,
    read_only: readOnly,
    host: STUDIO_HOST
  };
}

function validMetadata(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1 ||
      value.product !== expected.product || value.plugin_root !== expected.plugin_root ||
      value.version !== expected.version || value.config_path !== expected.config_path ||
      value.read_only !== expected.read_only || value.host !== expected.host ||
      !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535 ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || !TOKEN_PATTERN.test(value.token)) return false;
  return true;
}

async function readMetadata(pathValue, expected) {
  let file;
  try {
    file = await lstat(pathValue);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (file.isSymbolicLink() || !file.isFile() ||
      (currentUid() !== undefined && file.uid !== currentUid()) || (file.mode & 0o077) !== 0 || file.size > MAX_METADATA_BYTES) {
    fail("Studio owner metadata is not a private regular file");
  }
  let value;
  try { value = JSON.parse(await readFile(pathValue, "utf8")); }
  catch { fail("Studio owner metadata is invalid"); }
  if (!validMetadata(value, expected)) fail("Studio owner metadata does not match this plugin, version, configuration or access mode");
  return { value, file };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function removeMetadataIfUnchanged(pathValue, file) {
  const current = await lstat(pathValue).catch(() => undefined);
  if (current?.dev === file.dev && current.ino === file.ino) await unlink(pathValue).catch(() => undefined);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function probeOwner(owner) {
  const host = `${STUDIO_HOST}:${owner.port}`;
  return new Promise((resolveProbe) => {
    const request = httpRequest({
      hostname: STUDIO_HOST,
      port: owner.port,
      method: "GET",
      path: "/api/status",
      headers: {
        Host: host,
        Origin: `http://${host}`,
        Authorization: `Bearer ${owner.token}`
      },
      timeout: 2_000,
      agent: false
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes <= MAX_METADATA_BYTES) chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200 || bytes > MAX_METADATA_BYTES) { resolveProbe(false); return; }
        try { JSON.parse(Buffer.concat(chunks).toString("utf8")); resolveProbe(true); }
        catch { resolveProbe(false); }
      });
      response.once("error", () => resolveProbe(false));
    });
    request.once("error", () => resolveProbe(false));
    request.once("timeout", () => { request.destroy(); resolveProbe(false); });
    request.end();
  });
}

async function acquireLock(pathValue, expected, deadline) {
  while (Date.now() < deadline) {
    try {
      const handle = await open(pathValue, "wx", 0o600);
      const file = await handle.stat();
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, scope: expected.scope, nonce: randomUUID() })}\n`);
      await handle.sync();
      return { handle, file };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try { existing = await lstat(pathValue); } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (existing.isSymbolicLink() || !existing.isFile() ||
          (currentUid() !== undefined && existing.uid !== currentUid()) || (existing.mode & 0o077) !== 0) {
        fail("Studio startup lock is not private");
      }
      if (Date.now() - existing.mtimeMs > LOCK_STALE_MS) {
        let lockOwner;
        try { lockOwner = JSON.parse(await readFile(pathValue, "utf8")); } catch { lockOwner = undefined; }
        if (!lockOwner || !processIsAlive(lockOwner.pid)) {
          await removeMetadataIfUnchanged(pathValue, existing);
          continue;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
  fail("Studio owner startup is already in progress");
}

async function releaseLock(pathValue, lock) {
  await lock.handle.close().catch(() => undefined);
  await removeMetadataIfUnchanged(pathValue, lock.file);
}

function ownerUrl(owner) {
  return `http://${STUDIO_HOST}:${owner.port}/#token=${encodeURIComponent(owner.token)}`;
}

async function waitForOwner(metadataPath, expected, child, deadline) {
  let childExited = false;
  let childError;
  child?.once("exit", (code) => { childExited = true; if (code !== 0) childError = new Error("Studio owner failed to start"); });
  child?.once("error", () => { childExited = true; childError = new Error("Studio owner failed to start"); });
  while (Date.now() < deadline) {
    const current = await readMetadata(metadataPath, expected);
    if (current !== undefined) {
      if (processIsAlive(current.value.pid) && await probeOwner(current.value)) {
        return { url: ownerUrl(current.value), pid: current.value.pid };
      }
      if (!processIsAlive(current.value.pid)) await removeMetadataIfUnchanged(metadataPath, current.file);
    }
    if (childExited && current === undefined) throw childError ?? new Error("Studio owner failed to start");
    await sleep(POLL_INTERVAL_MS);
  }
  throw childError ?? new Error("Studio owner did not become ready before the startup deadline");
}

export async function ensureStudio(options = {}) {
  const environment = options.env ?? process.env;
  const pluginRoot = absolutePath(options.pluginRoot ?? PLUGIN_ROOT, "plugin root");
  const version = typeof options.version === "string" ? options.version : STUDIO_VERSION;
  const readOnly = options.readOnly === true || environment.CODEX_ROUTED_TASK_READ_ONLY === "1";
  const connectionPath = options.connectionFile === undefined
    ? defaultConnectionFile()
    : absolutePath(options.connectionFile, "connection file");
  const configPath = absolutePath(options.configPath ?? await (options.resolveConfig ?? defaultResolveConfigPath)(environment, connectionPath), "config path");
  const stateDir = absolutePath(options.stateDir ?? defaultStudioStateDir(), "Studio state directory");
  await ensurePrivateDirectory(stateDir);
  const metadataDir = join(stateDir, "instances");
  await ensurePrivateDirectory(metadataDir);
  const expected = { ...metadataExpected({ pluginRoot, version, configPath, readOnly }), scope: scopeId({ pluginRoot, version, configPath, readOnly }) };
  const metadataPath = join(metadataDir, `${expected.scope}.json`);
  const lockPath = `${metadataPath}.lock`;
  const deadline = Date.now() + (options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
  const first = await readMetadata(metadataPath, expected);
  if (first !== undefined) {
    if (processIsAlive(first.value.pid) && await probeOwner(first.value)) {
      return { url: ownerUrl(first.value), pid: first.value.pid };
    }
    if (!processIsAlive(first.value.pid)) await removeMetadataIfUnchanged(metadataPath, first.file);
    else fail("Studio owner metadata names a live but unresponsive process; refusing to stop it");
  }

  const lock = await acquireLock(lockPath, expected, deadline);
  try {
    const current = await readMetadata(metadataPath, expected);
    if (current !== undefined) {
      if (processIsAlive(current.value.pid) && await probeOwner(current.value)) return { url: ownerUrl(current.value), pid: current.value.pid };
      if (!processIsAlive(current.value.pid)) await removeMetadataIfUnchanged(metadataPath, current.file);
      else fail("Studio owner metadata names a live but unresponsive process; refusing to stop it");
    }
    const serverScript = absolutePath(options.serverScript ?? fileURLToPath(new URL("./studio-server.mjs", import.meta.url)), "Studio server script");
    const args = [serverScript, "--serve", "--metadata", metadataPath, "--plugin-root", pluginRoot,
      "--version", version, "--config-path", configPath, "--connection-file", connectionPath, "--state-dir", stateDir];
    if (readOnly) args.push("--read-only");
    const child = (options.spawnProcess ?? spawn)(process.execPath, args, {
      cwd: pluginRoot,
      detached: true,
      stdio: "ignore",
      env: { ...environment }
    });
    child.unref?.();
    return await waitForOwner(metadataPath, expected, child, deadline);
  } finally {
    await releaseLock(lockPath, lock);
  }
}
