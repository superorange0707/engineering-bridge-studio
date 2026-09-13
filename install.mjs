#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";

export const RELEASE = Object.freeze({
  version: "2.0.0-beta.2",
  directory: "engineering-bridge-studio-2.0.0-beta.2",
  archiveName: "engineering-bridge-studio-2.0.0-beta.2.tar.gz",
  archiveUrl: "https://github.com/superorange0707/engineering-bridge-studio/releases/download/v2.0.0-beta.2/engineering-bridge-studio-2.0.0-beta.2.tar.gz",
  sha256: "7f1fa43eca95a98a62f1060274d31bcbf5a5d7e3496e64e5c17ab2717b66b524",
});

const MARKETPLACE_NAME = "engineering-bridge-studio";
const PLUGIN_SELECTOR = "engineering-bridge@engineering-bridge-studio";
const DATA_DIRECTORY = ".local/share/engineering-bridge-studio";
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const RELEASE_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const REQUIRED_RELEASE_FILES = [
  ".agents/plugins/marketplace.json",
  "plugins/engineering-bridge/.codex-plugin/plugin.json",
  "plugins/engineering-bridge/.mcp.json",
  "plugins/engineering-bridge/bin/plugin-launcher.mjs",
  "plugins/engineering-bridge/bin/studio-mcp.mjs",
  "plugins/engineering-bridge/bin/studio-process.mjs",
  "plugins/engineering-bridge/bin/studio-server.mjs",
  "plugins/engineering-bridge/assets/studio/index.html",
  "plugins/engineering-bridge/assets/studio/app.js",
  "plugins/engineering-bridge/assets/studio/style.css",
  "plugins/engineering-bridge/dist/src/mcp-stdio.js",
  "plugins/engineering-bridge/node_modules/zod/package.json",
  "plugins/engineering-bridge/node_modules/@modelcontextprotocol/sdk/package.json",
];

function fail(message) {
  throw new Error(message);
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(`${label} must be an absolute path`);
  return resolve(value);
}

function pathInside(root, candidate) {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function assertNoSymlinkAncestors(value) {
  let cursor = resolve(value);
  while (true) {
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) fail(`refusing a symlink in installer path: ${cursor}`);
      if (cursor !== resolve(value) && !entry.isDirectory()) fail(`installer path ancestor is not a directory: ${cursor}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function ensurePrivateDirectory(value) {
  const directory = absolutePath(value, "installer directory");
  await assertNoSymlinkAncestors(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`installer directory is not a private directory: ${directory}`);
  await chmod(directory, 0o700);
  return directory;
}

async function existingPath(value) {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(value, label) {
  let bytes;
  try {
    bytes = await readFile(value);
  } catch {
    fail(`${label} is missing or unreadable`);
  }
  if (bytes.byteLength > 256 * 1024) fail(`${label} is unexpectedly large`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function requireRegularFile(root, relativePath) {
  const candidate = resolve(root, relativePath);
  if (!pathInside(root, candidate)) fail(`release contains an unsafe path: ${relativePath}`);
  let entry;
  try {
    entry = await lstat(candidate);
  } catch {
    fail(`release is incomplete; missing ${relativePath}`);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`release contains a non-regular file: ${relativePath}`);
}

export async function verifyReleaseRoot(root) {
  const releaseRoot = absolutePath(root, "release root");
  const rootEntry = await lstat(releaseRoot).catch(() => undefined);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) fail(`release root is not a regular directory: ${releaseRoot}`);
  for (const file of REQUIRED_RELEASE_FILES) await requireRegularFile(releaseRoot, file);

  const marketplace = await readJson(join(releaseRoot, ".agents/plugins/marketplace.json"), "marketplace manifest");
  if (marketplace?.name !== MARKETPLACE_NAME || !Array.isArray(marketplace?.plugins)) {
    fail("release marketplace manifest is not the Engineering Bridge marketplace");
  }
  const plugin = marketplace.plugins.find((entry) => entry?.name === "engineering-bridge");
  if (plugin?.source?.source !== "local" || plugin.source.path !== "./plugins/engineering-bridge") {
    fail("release marketplace manifest points to an unexpected plugin path");
  }

  const pluginManifest = await readJson(join(releaseRoot, "plugins/engineering-bridge/.codex-plugin/plugin.json"), "plugin manifest");
  if (typeof pluginManifest?.version !== "string" || pluginManifest.version.split("+")[0] !== RELEASE.version) {
    fail("release plugin manifest has an unexpected version");
  }
  const mcpManifest = await readJson(join(releaseRoot, "plugins/engineering-bridge/.mcp.json"), "MCP manifest");
  if (!mcpManifest?.mcpServers || typeof mcpManifest.mcpServers !== "object") fail("release MCP manifest is invalid");
  return releaseRoot;
}

function allowedDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    fail("release download must use HTTPS without credentials");
  }
  if (!RELEASE_HOSTS.has(url.hostname.toLowerCase())) fail("release download redirect left the GitHub release hosts");
  return url;
}

export async function downloadArchive(urlValue, destination) {
  let current = allowedDownloadUrl(urlValue).toString();
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let created = false;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail("release download exceeded its deadline");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      timer.unref?.();
      try {
        let response;
        try {
          response = await fetch(current, { redirect: "manual", signal: controller.signal });
        } catch {
          fail("release download failed or exceeded its deadline");
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location || redirect === MAX_REDIRECTS) fail("release download used an invalid redirect chain");
          current = allowedDownloadUrl(new URL(location, current).toString()).toString();
          continue;
        }
        if (!response.ok) fail(`release download returned HTTP ${response.status}`);
        if (!response.body) fail("release download returned no body");
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) fail("release archive is larger than the installer limit");
        const handle = await open(destination, "wx", 0o600);
        created = true;
        try {
          let total = 0;
          for await (const chunk of Readable.fromWeb(response.body)) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > MAX_ARCHIVE_BYTES) fail("release archive is larger than the installer limit");
            await handle.write(bytes);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(destination, 0o600);
        return destination;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    if (created) await rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  fail("release download did not complete");
}

async function sha256File(value) {
  const entry = await lstat(value);
  if (!entry.isFile() || entry.isSymbolicLink()) fail("downloaded release is not a regular file");
  if (entry.size > MAX_ARCHIVE_BYTES) fail("downloaded release is larger than the installer limit");
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of createReadStream(value)) {
    total += chunk.byteLength;
    if (total > MAX_ARCHIVE_BYTES) fail("downloaded release is larger than the installer limit");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function defaultProcessRunner(command, args, options) {
  return execFileSync(command, args, options);
}

function invoke(processRunner, command, args, label, timeout = PROCESS_TIMEOUT_MS) {
  try {
    const result = processRunner(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    });
    if (typeof result === "string") return result;
    if (result?.stdout !== undefined) return Buffer.from(result.stdout).toString("utf8");
    return "";
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} is unavailable; install it and retry`);
    fail(`${label} failed; inspect the Codex installation state before retrying`);
  }
}

function installerPaths(home) {
  const homeRoot = absolutePath(home, "home directory");
  const dataRoot = join(homeRoot, DATA_DIRECTORY);
  return {
    dataRoot,
    releasesRoot: join(dataRoot, "releases"),
    stagingRoot: join(dataRoot, ".staging"),
    releaseRoot: join(dataRoot, "releases", RELEASE.directory),
  };
}

async function publishWithoutOverwrite(stagedRoot, releaseRoot) {
  try {
    // Both paths are on the installation volume. Publish the complete directory
    // at once so an interrupted copy cannot leave a half-installed release.
    await rename(stagedRoot, releaseRoot);
    return false;
  } catch (error) {
    // A concurrent installer may have published the same non-empty release.
    if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
    await verifyReleaseRoot(releaseRoot);
    return true;
  }
}

export async function installRelease(options = {}) {
  assertPrerequisites(options.platform ?? process.platform, options.nodeVersion ?? process.versions.node);
  const paths = installerPaths(options.homeDir ?? homedir());
  const processRunner = options.runProcess ?? defaultProcessRunner;
  const downloader = options.download ?? downloadArchive;
  const expectedSha256 = String(options.expectedSha256 ?? RELEASE.sha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) fail("installer release checksum is invalid");

  invoke(processRunner, "codex", ["--version"], "Codex CLI preflight", 30_000);
  await ensurePrivateDirectory(paths.dataRoot);
  await ensurePrivateDirectory(paths.releasesRoot);
  await ensurePrivateDirectory(paths.stagingRoot);

  let reusedExisting = false;
  if (await existingPath(paths.releaseRoot)) {
    await verifyReleaseRoot(paths.releaseRoot);
    reusedExisting = true;
  } else {
    const stage = await mkdtemp(join(paths.stagingRoot, "release-"));
    await chmod(stage, 0o700);
    try {
      const archive = join(stage, RELEASE.archiveName);
      await downloader(RELEASE.archiveUrl, archive);
      const digest = await sha256File(archive);
      if (digest !== expectedSha256) fail("release archive checksum mismatch; nothing was extracted or installed");
      invoke(processRunner, "tar", ["-xzf", archive, "-C", stage], "tar archive extraction");
      const stagedRoot = join(stage, RELEASE.directory);
      await verifyReleaseRoot(stagedRoot);
      reusedExisting = await publishWithoutOverwrite(stagedRoot, paths.releaseRoot);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  invoke(processRunner, "codex", ["plugin", "marketplace", "add", paths.releaseRoot], "Codex marketplace registration");
  invoke(processRunner, "codex", ["plugin", "add", PLUGIN_SELECTOR, "--json"], "Codex plugin installation");

  const marketplaceDeepLink = `codex://plugins/engineering-bridge?marketplacePath=${encodeURIComponent(join(paths.releaseRoot, ".agents/plugins/marketplace.json"))}`;
  return {
    status: "installed",
    version: RELEASE.version,
    release_root: paths.releaseRoot,
    marketplace: MARKETPLACE_NAME,
    marketplace_deeplink: marketplaceDeepLink,
    reused_existing: reusedExisting,
    next: "Open Engineering Bridge Studio in Codex to choose a project and finish setup.",
  };
}

export function parseInstallerArgs(args) {
  const parsed = parseArgs({
    args,
    options: { help: { type: "boolean" }, json: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  if (parsed.positionals.length > 0) fail("installer takes no positional arguments; use --help");
  return { help: parsed.values.help === true, json: parsed.values.json === true };
}

function helpText() {
  return `Engineering Bridge Studio verified release installer\n\nUsage:\n  curl -fsSL https://raw.githubusercontent.com/superorange0707/engineering-bridge-studio/main/install.mjs | node --input-type=module -\n  node install.mjs [--json]\n\nDownloads the pinned ${RELEASE.version} release, verifies SHA-256 before extraction,\npreserves an existing matching installation, and registers the local Codex marketplace.\nOpens Studio for project setup and the ChatGPT Web connection steps.\n`;
}

function assertPrerequisites(platform, nodeVersion) {
  if (platform !== "darwin") fail("this verified beta installer currently supports macOS only");
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 22) fail("this installer requires Node.js 22 or newer");
}

async function main() {
  const parsed = parseInstallerArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(helpText());
    return;
  }
  const result = await installRelease();
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Installed Engineering Bridge Studio ${result.version}${result.reused_existing ? " (existing installation preserved)" : ""}.\n`);
  try {
    const studio = JSON.parse(invoke(defaultProcessRunner, process.execPath,
      [join(result.release_root, "plugins", "engineering-bridge", "bin", "bridge.mjs"), "open", "--json"], "Studio startup"));
    invoke(defaultProcessRunner, "open", [studio.url], "Opening Studio");
    process.stdout.write("Studio is open. Choose a project and follow the setup steps.\n");
  } catch {
    process.stdout.write("Open Codex → Plugins → Engineering Bridge Studio → Open Studio to finish setup.\n");
  }
  process.stdout.write("In Codex, ask: Open Engineering Bridge Studio.\n");
  process.stdout.write(`Open plugin: ${result.marketplace_deeplink}\n`);
}

const invokedPath = process.argv[1];
const runningAsScript = invokedPath === "-" || (invokedPath && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url)));
if (runningAsScript) {
  main().catch((error) => {
    process.stderr.write(`Install failed: ${error instanceof Error ? error.message : "unknown installer error"}\n`);
    process.exitCode = 1;
  });
}
