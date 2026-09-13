#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

export const LOCK = JSON.parse(readFileSync(new URL("../config/web-companion.lock.json", import.meta.url), "utf8"));
const PRODUCT = "engineering-bridge-web-companion";
const MANIFEST_NAME = "companion-manifest.json";
const APP_NAME = "Codex Web GPT.app";
const MAX_REDIRECTS = 3;
const RELEASE_HOST = "github.com";
const ARCHIVE_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;
const ARCHIVE_LIST_TIMEOUT_MS = 30_000;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 120_000;

function lockValue(name) {
  const value = LOCK[name];
  if (value === undefined) throw new Error(`web companion lock is missing ${name}`);
  return value;
}

export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") throw new Error("the Web companion currently supports macOS only");
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-x64";
  throw new Error(`unsupported macOS architecture: ${arch}`);
}

export function assetForPlatform(platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch);
  const asset = LOCK.assets?.[key];
  if (!asset) throw new Error(`web companion lock has no asset for ${key}`);
  return { key, ...asset };
}

export function defaultInstallDir() {
  return join(homedir(), ".engineering-bridge", "web-companion", LOCK.release_tag);
}

function archiveLimits() {
  return LOCK.archive_limits ?? {};
}

function normalizeSha(value) {
  return typeof value === "string" ? value.replace(/^sha256:/, "").toLowerCase() : "";
}

function assertSha(value, label) {
  if (!/^[a-f0-9]{64}$/.test(normalizeSha(value))) throw new Error(`${label} has an invalid SHA-256`);
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

function assertNoSymlinkAncestors(pathValue) {
  let cursor = resolve(pathValue);
  while (true) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`refusing a symlink in install path: ${cursor}`);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function pathInside(root, candidate) {
  const rootAbsolute = resolve(root);
  const candidateAbsolute = resolve(candidate);
  const suffix = relative(rootAbsolute, candidateAbsolute);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function installTarget(value) {
  const target = value === undefined ? defaultInstallDir() : assertAbsolutePath(value, "--install-dir");
  assertNoSymlinkAncestors(target);
  return target;
}

function readJsonFile(pathValue, label) {
  try {
    const bytes = readFileSync(pathValue);
    if (bytes.byteLength > 128 * 1024) throw new Error(`${label} is too large`);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function expectedAssetForManifest(manifest) {
  const assets = Object.values(LOCK.assets ?? {});
  return assets.find((asset) => asset.name === manifest.asset?.name && normalizeSha(asset.sha256) === normalizeSha(manifest.asset?.sha256));
}

function expectedNotice(name) {
  return (LOCK.notices ?? []).find((notice) => notice.name === name);
}

function assertBackupPath(backupPath, installDir) {
  if (typeof backupPath !== "string" || !isAbsolute(backupPath)) {
    throw new Error("installation manifest has an invalid backup path");
  }
  const target = resolve(installDir);
  const backup = resolve(backupPath);
  const expectedPrefix = `${target}.previous-`;
  if (dirname(backup) !== dirname(target) || !backup.startsWith(expectedPrefix)) {
    throw new Error("installation manifest has an unsafe backup path");
  }
  return backup;
}

function assertProductManifest(manifest, installDir) {
  if (!manifest || typeof manifest !== "object") throw new Error("installation manifest is not an object");
  if (manifest.schema_version !== 1 || manifest.product !== PRODUCT) {
    throw new Error("installation directory is not owned by Engineering Bridge Web Companion");
  }
  if (manifest.repository !== LOCK.repository || manifest.release_tag !== LOCK.release_tag
    || manifest.source_commit !== LOCK.source_commit) {
    throw new Error("installation manifest is for an unsupported Web companion release");
  }
  if (manifest.install_dir !== undefined
    && (typeof manifest.install_dir !== "string" || resolve(manifest.install_dir) !== resolve(installDir))) {
    throw new Error("installation manifest belongs to a different install directory");
  }
  if (manifest.backup_path !== undefined) assertBackupPath(manifest.backup_path, installDir);
  const expectedAsset = expectedAssetForManifest(manifest);
  if (manifest.app_path !== APP_NAME || !expectedAsset
    || manifest.asset?.size !== expectedAsset.size) {
    throw new Error("installation manifest has an unexpected companion path or asset");
  }
  if (!Array.isArray(manifest.notice_files)) throw new Error("installation manifest has no notice file list");
  const noticeNames = new Set();
  for (const notice of manifest.notice_files) {
    if (!notice || typeof notice.name !== "string" || notice.name.includes("/") || notice.name.includes("\\")) {
      throw new Error("installation manifest has an unsafe notice path");
    }
    if (noticeNames.has(notice.name)) throw new Error(`installation manifest repeats a notice file: ${notice.name}`);
    noticeNames.add(notice.name);
    assertSha(notice.sha256, `notice ${notice.name}`);
    const expected = expectedNotice(notice.name);
    if (!expected || notice.size !== expected.size || normalizeSha(notice.sha256) !== normalizeSha(expected.sha256)) {
      throw new Error(`installation manifest has an unexpected notice file: ${notice.name}`);
    }
  }
  const expectedNotices = LOCK.notices ?? [];
  if (manifest.notice_files.length !== expectedNotices.length
    || expectedNotices.some((notice) => !noticeNames.has(notice.name))) {
    throw new Error("installation manifest has an incomplete notice file list");
  }
  return manifest;
}

function readInstallTargetSnapshot(target, logicalTarget = target) {
  const absolute = installTarget(target);
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: absolute, exists: false };
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`refusing to overwrite a non-product install target: ${absolute}`);
  }
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`refusing to overwrite an install target owned by another user: ${absolute}`);
  }
  const manifestPath = join(absolute, MANIFEST_NAME);
  let manifestMetadata;
  try {
    manifestMetadata = lstatSync(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`refusing to overwrite a non-product install target: ${absolute}`);
    }
    throw error;
  }
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
    throw new Error(`refusing to overwrite a non-product install target: ${absolute}`);
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = readJsonFile(manifestPath, "installation manifest");
  assertProductManifest(manifest, logicalTarget);
  return {
    path: resolve(logicalTarget),
    exists: true,
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    nlink: metadata.nlink,
    manifest_dev: manifestMetadata.dev,
    manifest_ino: manifestMetadata.ino,
    manifest_size: manifestBytes.byteLength,
    manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

export function captureInstallTarget(target) {
  return readInstallTargetSnapshot(target);
}

function sameTargetSnapshot(actual, expected) {
  if (!actual || !expected || actual.path !== expected.path || actual.exists !== expected.exists) return false;
  if (!actual.exists) return true;
  return actual.dev === expected.dev && actual.ino === expected.ino
    && actual.uid === expected.uid && actual.nlink === expected.nlink
    && actual.manifest_dev === expected.manifest_dev && actual.manifest_ino === expected.manifest_ino
    && actual.manifest_size === expected.manifest_size && actual.manifest_sha256 === expected.manifest_sha256;
}

export function revalidateInstallTarget(target, expected) {
  let actual;
  try {
    actual = readInstallTargetSnapshot(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`install target changed before commit: ${message}`);
  }
  if (!sameTargetSnapshot(actual, expected)) {
    throw new Error("install target changed before commit; refusing to replace it");
  }
  return actual;
}

export function assertInstallTarget(target) {
  return captureInstallTarget(target).path;
}

function releasePath(name) {
  return `/miuuyy/codex-chatgpt-web/releases/download/${LOCK.release_tag}/${name}`;
}

function assertDownloadUrl(value, expectedName, initial = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error("download URL is invalid"); }
  const hosts = new Set(lockValue("download_hosts"));
  if (url.protocol !== "https:" || !hosts.has(url.hostname)) {
    throw new Error("downloads must use HTTPS and the pinned GitHub release CDN");
  }
  if (initial && (url.hostname !== RELEASE_HOST || url.pathname !== releasePath(expectedName))) {
    throw new Error(`download URL is not the pinned release asset: ${expectedName}`);
  }
  return url;
}

async function fetchRelease(url, expectedName, fetchImpl, redirects = 0, initial = true) {
  const checked = assertDownloadUrl(url, expectedName, initial);
  if (typeof fetchImpl !== "function") throw new Error("Node fetch is unavailable");
  const response = await fetchImpl(checked, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    if (redirects >= MAX_REDIRECTS) throw new Error("release download redirected too many times");
    const location = response.headers.get("location");
    if (!location) throw new Error("release download returned a redirect without a location");
    return fetchRelease(new URL(location, checked).toString(), expectedName, fetchImpl, redirects + 1, false);
  }
  if (response.status !== 200) throw new Error(`release download failed with HTTP ${response.status}`);
  return response;
}

async function sha256File(pathValue) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pathValue)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyFixedFile(pathValue, entry, label = "archive") {
  const absolute = assertAbsolutePath(pathValue, "archive");
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (metadata.size !== entry.size) throw new Error(`${label} size mismatch for ${entry.name}`);
  const digest = await sha256File(absolute);
  if (digest !== normalizeSha(entry.sha256)) throw new Error(`${label} SHA-256 mismatch for ${entry.name}`);
  return absolute;
}

export async function downloadFixedFile(entry, destination, fetchImpl = globalThis.fetch) {
  assertSha(entry.sha256, entry.name);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`invalid fixed size for ${entry.name}`);
  const destinationPath = assertAbsolutePath(destination, "download destination");
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const response = await fetchRelease(entry.url, entry.name, fetchImpl);
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(contentLength) && contentLength > entry.size) {
    throw new Error(`download exceeds the pinned size for ${entry.name}`);
  }
  const maxBytes = entry.name.endsWith(".zip") ? archiveLimits().max_bytes : entry.size;
  if (!Number.isSafeInteger(maxBytes) || entry.size > maxBytes) throw new Error(`download limit is invalid for ${entry.name}`);
  const hash = createHash("sha256");
  let bytes = 0;
  if (!response.body) throw new Error(`release download returned no body for ${entry.name}`);
  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      const data = Buffer.from(chunk);
      bytes += data.byteLength;
      if (bytes > maxBytes) {
        callback(new Error(`download exceeds the size limit for ${entry.name}`));
        return;
      }
      hash.update(data);
      callback(null, data);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      tracker,
      createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw error;
  }
  if (bytes !== entry.size) {
    rmSync(destinationPath, { force: true });
    throw new Error(`download size mismatch for ${entry.name}`);
  }
  if (hash.digest("hex") !== normalizeSha(entry.sha256)) {
    rmSync(destinationPath, { force: true });
    throw new Error(`download SHA-256 mismatch for ${entry.name}`);
  }
  return destinationPath;
}

function commandOutput(command, args, { maxBuffer = ARCHIVE_COMMAND_MAX_BUFFER, timeout = ARCHIVE_LIST_TIMEOUT_MS } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} could not inspect the archive: ${message}`);
  }
}

function archiveEntryName(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("archive contains an invalid entry name");
  }
  if (Buffer.byteLength(value, "utf8") > archiveLimits().max_path_bytes) {
    throw new Error("archive entry path exceeds the size limit");
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)
    || /[*?\[\]]/.test(value)) {
    throw new Error(`archive contains an unsafe path: ${value}`);
  }
  const parts = value.split("/");
  const meaningful = value.endsWith("/") ? parts.slice(0, -1) : parts;
  if (meaningful.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`archive contains an unsafe path: ${value}`);
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function assertSafeArchiveSymlink(name, target) {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    throw new Error(`archive has an invalid symlink target: ${name}`);
  }
  if (Buffer.byteLength(target, "utf8") > archiveLimits().max_path_bytes
    || target.includes("\\") || target.startsWith("/") || /^[A-Za-z]:/.test(target)) {
    throw new Error(`archive symlink escapes its staging directory: ${name}`);
  }
  const archiveRoot = "/__engineering_bridge_web_companion_archive__";
  const resolved = resolve(archiveRoot, dirname(name), target);
  if (!pathInside(archiveRoot, resolved)) {
    throw new Error(`archive symlink escapes its staging directory: ${name}`);
  }
}

export function validateArchiveEntries(entries) {
  const limits = archiveLimits();
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("archive contains no entries");
  if (entries.length > limits.max_entries) throw new Error("archive contains too many entries");
  const names = new Set();
  let uncompressedBytes = 0;
  for (const item of entries) {
    const entry = typeof item === "string" ? { name: item } : item;
    const name = archiveEntryName(entry?.name);
    if (names.has(name)) throw new Error(`archive contains a duplicate path: ${name}`);
    names.add(name);
    if (entry?.symlink === true || (typeof entry?.mode === "string" && entry.mode.startsWith("l"))) {
      assertSafeArchiveSymlink(name, entry?.symlinkTarget);
    }
    if (entry?.uncompressedSize !== undefined) {
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw new Error(`archive has an invalid size: ${name}`);
      }
      uncompressedBytes += entry.uncompressedSize;
      if (uncompressedBytes > limits.max_uncompressed_bytes) {
        throw new Error("archive expands beyond the size limit");
      }
    }
  }
  return [...names];
}

function readArchiveSymlinkTarget(archivePath, name) {
  try {
    const bytes = execFileSync("unzip", ["-p", archivePath, name], {
      encoding: "buffer",
      timeout: ARCHIVE_LIST_TIMEOUT_MS,
      maxBuffer: archiveLimits().max_path_bytes + 1,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (bytes.byteLength > archiveLimits().max_path_bytes) {
      throw new Error("symlink target exceeds the path limit");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`archive symlink target could not be read for ${name}: ${message}`);
  }
}

function listArchiveEntries(archivePath) {
  const names = commandOutput("unzip", ["-Z1", archivePath], { timeout: ARCHIVE_LIST_TIMEOUT_MS })
    .split(/\r?\n/)
    .map((name) => name.trimEnd())
    .filter(Boolean);
  validateArchiveEntries(names);
  const detailLines = commandOutput("zipinfo", ["-l", archivePath], { timeout: ARCHIVE_LIST_TIMEOUT_MS }).split(/\r?\n/);
  const details = [];
  for (const line of detailLines) {
    const trimmed = line.trim();
    if (!trimmed || !/^[dlcbps-]/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 10 || !/^\d+$/.test(parts[3])) continue;
    details.push({ mode: parts[0], uncompressedSize: Number(parts[3]), name: parts.slice(9).join(" ") });
  }
  if (details.length !== names.length) throw new Error("archive listing could not be parsed completely");
  const withTargets = details.map((detail) => detail.mode.startsWith("l")
    ? { ...detail, symlinkTarget: readArchiveSymlinkTarget(archivePath, detail.name) }
    : detail);
  validateArchiveEntries(withTargets);
  return withTargets;
}

export function inspectArchive(archivePath) {
  return listArchiveEntries(assertAbsolutePath(archivePath, "archive"));
}

function locateApp(root) {
  const rootReal = realpathSync(root);
  const appPaths = [];
  const findApps = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const pathValue = join(directory, name);
      const metadata = lstatSync(pathValue);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        if (name === APP_NAME) appPaths.push(pathValue);
        findApps(pathValue);
      }
    }
  };
  findApps(root);
  if (appPaths.length !== 1 || basename(appPaths[0]) !== APP_NAME) {
    throw new Error("archive must contain exactly one Codex Web GPT.app bundle");
  }
  const appRoot = appPaths[0];
  const appRootReal = realpathSync(appRoot);
  let totalBytes = 0;
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const pathValue = join(directory, name);
      const metadata = lstatSync(pathValue);
      if (metadata.isSymbolicLink()) {
        let real;
        try { real = realpathSync(pathValue); } catch (error) {
          throw new Error(`archive extraction contains a broken symlink: ${name}: ${error.message}`);
        }
        if (!pathInside(rootReal, real) || !pathInside(appRootReal, real)) {
          throw new Error(`archive extraction symlink escapes the app bundle: ${name}`);
        }
        continue;
      }
      const real = realpathSync(pathValue);
      if (!pathInside(rootReal, real)) throw new Error(`archive extraction escaped its staging directory: ${name}`);
      if (metadata.isDirectory()) {
        visit(pathValue);
      } else if (metadata.isFile()) {
        totalBytes += metadata.size;
        if (totalBytes > archiveLimits().max_uncompressed_bytes) throw new Error("archive extraction exceeds the size limit");
      } else {
        throw new Error(`archive extraction contains an unsupported file: ${name}`);
      }
    }
  };
  visit(root);
  const executable = join(appPaths[0], "Contents", "MacOS", "Codex Web GPT");
  const executableMetadata = lstatSync(executable);
  if (!executableMetadata.isFile() || (executableMetadata.mode & 0o111) === 0) {
    throw new Error("Codex Web GPT.app has no executable launcher");
  }
  return appPaths[0];
}

function extractArchive(archivePath, destination) {
  listArchiveEntries(archivePath);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  commandOutput("ditto", ["-x", "-k", archivePath, destination], { timeout: ARCHIVE_EXTRACT_TIMEOUT_MS });
  return locateApp(destination);
}

function productManifest(target, asset, notices, backupPath) {
  return {
    schema_version: 1,
    product: PRODUCT,
    repository: LOCK.repository,
    release_tag: LOCK.release_tag,
    source_commit: LOCK.source_commit,
    platform: asset.key,
    asset: { name: asset.name, size: asset.size, sha256: normalizeSha(asset.sha256) },
    app_path: APP_NAME,
    notice_source: notices.source,
    notice_files: notices.files.map((notice) => ({ name: notice.name, size: notice.size, sha256: normalizeSha(notice.sha256) })),
    install_dir: target,
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
  };
}

async function copyVerifiedNotices(sourceDir, destination) {
  const source = assertAbsolutePath(sourceDir, "--notices-dir");
  assertNoSymlinkAncestors(source);
  const sourceMetadata = lstatSync(source);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
    throw new Error("--notices-dir must be a regular directory");
  }
  const files = [];
  for (const notice of LOCK.notices ?? []) {
    const sourcePath = join(source, notice.name);
    await verifyFixedFile(sourcePath, notice, "notice");
    const destinationPath = join(destination, notice.name);
    copyFileSync(sourcePath, destinationPath);
    files.push(notice);
  }
  return { source: "pinned-local", files };
}

function pathExists(pathValue) {
  try {
    lstatSync(pathValue);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function newBackupPath(target) {
  const backup = `${target}.previous-${process.pid}-${randomUUID()}`;
  if (pathExists(backup)) throw new Error(`backup path already exists: ${backup}`);
  return backup;
}

function restoreBackup(backup, target) {
  if (!pathExists(backup)) return false;
  if (pathExists(target)) return false;
  renameSync(backup, target);
  return true;
}

function assertMovedTargetMatches(backup, target, expected) {
  const moved = readInstallTargetSnapshot(backup, target);
  const logical = { ...moved, path: target };
  if (!sameTargetSnapshot(logical, expected)) {
    throw new Error("install target changed while it was being moved; refusing to replace it");
  }
}

export function commitInstallation(staged, target, expectedSnapshot = captureInstallTarget(target), backupPath) {
  const absolute = installTarget(target);
  const current = revalidateInstallTarget(absolute, expectedSnapshot);
  const hadExisting = current.exists;
  const backup = hadExisting ? (backupPath ?? newBackupPath(absolute)) : undefined;
  if (backup !== undefined) {
    assertBackupPath(backup, absolute);
    if (pathExists(backup)) throw new Error(`backup path already exists: ${backup}`);
  }

  if (hadExisting) {
    renameSync(absolute, backup);
    try {
      // A concurrent replacement can race the pre-rename validation. Verify the
      // object that was actually moved before publishing the new product.
      assertMovedTargetMatches(backup, absolute, expectedSnapshot);
    } catch (error) {
      let restored = false;
      try { restored = restoreBackup(backup, absolute); } catch (restoreError) {
        throw new Error(`install target changed while it was being moved; retained backup at ${backup}: ${restoreError.message}`);
      }
      if (!restored) throw new Error(`install target changed while it was being moved; retained backup at ${backup}`);
      throw error;
    }
  }

  try {
    if (pathExists(absolute)) {
      if (backup !== undefined) restoreBackup(backup, absolute);
      throw new Error("install target appeared before publication; refusing to overwrite it");
    }
    renameSync(staged, absolute);
  } catch (error) {
    if (backup !== undefined && pathExists(backup)) {
      try {
        if (!pathExists(absolute)) restoreBackup(backup, absolute);
      } catch (restoreError) {
        throw new Error(`installation publication failed; retained previous installation at ${backup}: ${restoreError.message}`);
      }
    }
    throw error;
  }
  return { target: absolute, ...(backup === undefined ? {} : { backup_path: backup }) };
}

export async function installCompanion({ installDir, archive, noticesDir, fetchImpl = globalThis.fetch } = {}) {
  if (process.platform !== "darwin") throw new Error("the Web companion installer currently supports macOS only");
  const targetSnapshot = captureInstallTarget(installDir);
  const target = targetSnapshot.path;
  const asset = assetForPlatform();
  if (existsSync(target)) {
    const existing = readInstallationStatus(target);
    if (existing.installed && existing.platform === asset.key) return existing;
  }
  const stageParent = dirname(target);
  mkdirSync(stageParent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(stageParent, ".web-companion-stage-"));
  try {
    const archivePath = join(staging, asset.name);
    if (archive === undefined) await downloadFixedFile(asset, archivePath, fetchImpl);
    else await verifyFixedFile(assertAbsolutePath(archive, "--archive"), asset);
    let notices;
    const noticeDir = join(staging, "notices");
    mkdirSync(noticeDir, { recursive: true, mode: 0o700 });
    if (noticesDir !== undefined) {
      notices = await copyVerifiedNotices(noticesDir, noticeDir);
    } else if (archive !== undefined) {
      throw new Error("--archive requires --notices-dir with the pinned upstream notice files");
    } else {
      const files = [];
      for (const notice of LOCK.notices ?? []) {
        const noticePath = join(noticeDir, notice.name);
        await downloadFixedFile(notice, noticePath, fetchImpl);
        files.push(notice);
      }
      notices = { source: "upstream-release", files };
    }
    const extracted = join(staging, "extracted");
    const appPath = extractArchive(archive ?? archivePath, extracted);
    const product = join(staging, "product");
    mkdirSync(product, { mode: 0o700 });
    commandOutput("ditto", [appPath, join(product, APP_NAME)]);
    const noticeDestination = join(product, "third-party");
    mkdirSync(noticeDestination, { mode: 0o700 });
    for (const notice of notices.files) copyFileSync(join(noticeDir, notice.name), join(noticeDestination, notice.name));
    const backupPath = targetSnapshot.exists ? newBackupPath(target) : undefined;
    writeFileSync(join(product, MANIFEST_NAME), `${JSON.stringify(productManifest(target, asset, notices, backupPath), null, 2)}\n`, { mode: 0o600 });
    commitInstallation(product, target, targetSnapshot, backupPath);
    return readInstallationStatus(target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function readInstallationStatus(installDir) {
  const target = installTarget(installDir);
  if (!existsSync(target)) return { installed: false, product: PRODUCT, install_dir: target };
  if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) {
    throw new Error(`install target is not a directory: ${target}`);
  }
  const manifestPath = join(target, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { installed: false, product: PRODUCT, install_dir: target, reason: "manifest_missing" };
  const manifest = assertProductManifest(readJsonFile(manifestPath, "installation manifest"), target);
  const appPath = resolve(target, manifest.app_path);
  if (!pathInside(target, appPath)) throw new Error("installation manifest points outside its install directory");
  const appPresent = existsSync(appPath) && lstatSync(appPath).isDirectory() && !lstatSync(appPath).isSymbolicLink();
  const backupPath = manifest.backup_path === undefined ? undefined : assertBackupPath(manifest.backup_path, target);
  let backupPresent = false;
  if (backupPath !== undefined) {
    try {
      assertNoSymlinkAncestors(backupPath);
      const backupMetadata = lstatSync(backupPath);
      if (backupMetadata.isDirectory() && !backupMetadata.isSymbolicLink()) {
        const backupManifestPath = join(backupPath, MANIFEST_NAME);
        const backupManifestMetadata = lstatSync(backupManifestPath);
        if (backupManifestMetadata.isFile() && !backupManifestMetadata.isSymbolicLink()) {
          assertProductManifest(readJsonFile(backupManifestPath, "previous installation manifest"), target);
          backupPresent = true;
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") backupPresent = false;
    }
  }
  return {
    installed: appPresent,
    product: PRODUCT,
    install_dir: target,
    release_tag: manifest.release_tag,
    source_commit: manifest.source_commit,
    platform: manifest.platform,
    app_path: appPath,
    app_present: appPresent,
    notices: manifest.notice_files.map((notice) => notice.name),
    ...(backupPath === undefined ? {} : { backup_path: backupPath, backup_present: backupPresent }),
  };
}

export function launchCompanion(installDir, open = (pathValue) => execFileSync("open", [pathValue], { stdio: "ignore" })) {
  if (process.platform !== "darwin") throw new Error("the Web companion launcher currently supports macOS only");
  const status = readInstallationStatus(installDir);
  if (!status.installed) throw new Error("Web companion is not installed; run install first");
  open(status.app_path);
  return { launched: true, app_path: status.app_path };
}

function help() {
  return [
    "Engineering Bridge Web companion",
    "Usage: node bin/web-companion.mjs <install|status|launch> [options]",
    "  install [--install-dir ABSOLUTE] [--archive ABSOLUTE_ZIP] [--notices-dir ABSOLUTE] [--json]",
    "  status [--install-dir ABSOLUTE] [--json]",
    "  launch [--install-dir ABSOLUTE] [--json]",
    "  --version",
  ].join("\n") + "\n";
}

export function parseArgs(argv) {
  let command;
  let installDir;
  let archive;
  let noticesDir;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--install-dir" || arg === "--archive" || arg === "--notices-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires an absolute path`);
      if (arg === "--install-dir") installDir = value;
      else if (arg === "--archive") archive = value;
      else noticesDir = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") { command = "help"; continue; }
    if (arg === "--version" || arg === "-v") { command = "version"; continue; }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    if (command !== undefined) throw new Error(`unexpected argument: ${arg}`);
    command = arg;
  }
  command ??= "status";
  if (!["help", "version", "install", "status", "launch"].includes(command)) throw new Error(`unknown command: ${command}`);
  if (archive !== undefined && command !== "install") throw new Error("--archive is valid only for install");
  if (noticesDir !== undefined && command !== "install") throw new Error("--notices-dir is valid only for install");
  if (installDir !== undefined) assertAbsolutePath(installDir, "--install-dir");
  if (archive !== undefined) assertAbsolutePath(archive, "--archive");
  if (noticesDir !== undefined) assertAbsolutePath(noticesDir, "--notices-dir");
  return { command, installDir, archive, noticesDir, json };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "help") { process.stdout.write(help()); return; }
  if (options.command === "version") { process.stdout.write(`${LOCK.release_tag.slice(1)}\n`); return; }
  if (options.command === "status") {
    const result = readInstallationStatus(options.installDir);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(result.installed ? `installed ${result.release_tag} at ${result.app_path}\n` : `not installed at ${result.install_dir}\n`);
      if (result.backup_path) process.stdout.write(`previous installation retained at ${result.backup_path}\n`);
    }
    if (!result.installed) process.exitCode = 1;
    return;
  }
  const result = options.command === "install"
    ? await installCompanion({ installDir: options.installDir, archive: options.archive, noticesDir: options.noticesDir })
    : launchCompanion(options.installDir);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(options.command === "install" ? `installed ${result.release_tag} at ${result.app_path}\n` : `launched ${result.app_path}\n`);
    if (options.command === "install" && result.backup_path) {
      process.stdout.write(`previous installation retained at ${result.backup_path}\n`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`web-companion: ${message}\n`);
    process.exitCode = 1;
  });
}
