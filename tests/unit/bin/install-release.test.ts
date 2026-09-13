import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type ProcessRunner = (command: string, args: string[], options: Record<string, unknown>) => unknown;
type InstallOptions = {
  homeDir: string;
  download: (url: string, destination: string) => Promise<void>;
  runProcess: ProcessRunner;
  expectedSha256?: string;
  platform: string;
  nodeVersion: string;
};
type InstallResult = {
  release_root: string;
  marketplace_deeplink: string;
  reused_existing: boolean;
};

const installer = await import(pathToFileURL(join(process.cwd(), "install.mjs")).href) as unknown as {
  RELEASE: { directory: string; archiveName: string; archiveUrl: string; version: string };
  installRelease(options: InstallOptions): Promise<InstallResult>;
};

async function fixtureArchive(parent: string): Promise<string> {
  const releaseRoot = join(parent, installer.RELEASE.directory);
  const pluginRoot = join(releaseRoot, "plugins", "engineering-bridge");
  await mkdir(join(releaseRoot, ".agents", "plugins"), { recursive: true });
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "bin"), { recursive: true });
  await mkdir(join(pluginRoot, "assets", "studio"), { recursive: true });
  await mkdir(join(pluginRoot, "dist", "src"), { recursive: true });
  await mkdir(join(pluginRoot, "node_modules", "zod"), { recursive: true });
  await mkdir(join(pluginRoot, "node_modules", "@modelcontextprotocol", "sdk"), { recursive: true });
  await writeFile(join(releaseRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "engineering-bridge-studio",
    plugins: [{
      name: "engineering-bridge",
      source: { source: "local", path: "./plugins/engineering-bridge" },
    }],
  }));
  await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "engineering-bridge",
    version: installer.RELEASE.version,
  }));
  await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  await writeFile(join(pluginRoot, "bin", "plugin-launcher.mjs"), "#!/usr/bin/env node\n");
  for (const name of ["studio-mcp.mjs", "studio-process.mjs", "studio-server.mjs"]) {
    await writeFile(join(pluginRoot, "bin", name), "export {};\n");
  }
  for (const name of ["index.html", "app.js", "style.css"]) {
    await writeFile(join(pluginRoot, "assets", "studio", name), "fixture\n");
  }
  await writeFile(join(pluginRoot, "dist", "src", "mcp-stdio.js"), "export {};\n");
  await writeFile(join(pluginRoot, "node_modules", "zod", "package.json"), "{}\n");
  await writeFile(join(pluginRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "{}\n");
  const archive = join(parent, installer.RELEASE.archiveName);
  execFileSync("tar", ["-czf", archive, "-C", parent, installer.RELEASE.directory], { stdio: "ignore" });
  return archive;
}

function processRunner(calls: Array<{ command: string; args: string[] }>): ProcessRunner {
  return (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "tar") return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (command === "codex" && args[0] === "--version") return "codex test\n";
    if (command === "codex" && args[0] === "plugin") return "{}\n";
    throw new Error(`unexpected process ${command}`);
  };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function optionsFor(homeDir: string, archive: string, runProcess: ProcessRunner, expectedSha256?: string): Promise<InstallOptions> {
  return {
    homeDir,
    download: async (_url, destination) => { await cp(archive, destination); },
    runProcess,
    ...(expectedSha256 ? { expectedSha256 } : {}),
    platform: "darwin",
    nodeVersion: "22.0.0",
  };
}

test("checksum failure stops before extraction or Codex registration", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "engineering-bridge-install-test-"));
  const root = await realpath(temporary);
  try {
    const archive = await fixtureArchive(root);
    const home = join(root, "home");
    await mkdir(home);
    const calls: Array<{ command: string; args: string[] }> = [];
    const runProcess = processRunner(calls);
    await assert.rejects(
      installer.installRelease(await optionsFor(home, archive, runProcess)),
      /release archive checksum mismatch/,
    );
    assert.deepEqual(calls, [{ command: "codex", args: ["--version"] }]);
    await assert.rejects(lstat(join(home, ".local", "share", "engineering-bridge-studio", "releases", installer.RELEASE.directory)), { code: "ENOENT" });
    const staging = join(home, ".local", "share", "engineering-bridge-studio", ".staging");
    assert.deepEqual(await readdir(staging), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("fresh install registers the stable marketplace and rerun preserves it", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "engineering-bridge-install-test-"));
  const root = await realpath(temporary);
  try {
    const archive = await fixtureArchive(root);
    const archiveBytes = await readFile(archive);
    const archiveSha256 = digest(archiveBytes);
    const home = join(root, "home");
    await mkdir(home);
    const calls: Array<{ command: string; args: string[] }> = [];
    const runProcess = processRunner(calls);
    const first = await installer.installRelease(await optionsFor(home, archive, runProcess, archiveSha256));
    const marker = join(first.release_root, "user-added-file.txt");
    await writeFile(marker, "keep me\n");
    const before = await lstat(first.release_root);

    const second = await installer.installRelease(await optionsFor(home, archive, runProcess, archiveSha256));
    const after = await lstat(second.release_root);
    assert.equal(second.reused_existing, true);
    assert.equal(await readFile(marker, "utf8"), "keep me\n");
    assert.equal(before.dev, after.dev);
    assert.equal(before.ino, after.ino);
    assert.equal(second.marketplace_deeplink, `codex://plugins/engineering-bridge?marketplacePath=${encodeURIComponent(join(second.release_root, ".agents/plugins/marketplace.json"))}`);
    assert.deepEqual(calls.map(({ command, args }) => [command, ...args.slice(0, 3)]), [
      ["codex", "--version"],
      ["tar", "-xzf", calls[1]?.args[1], "-C"],
      ["codex", "plugin", "marketplace", "add"],
      ["codex", "plugin", "add", "engineering-bridge@engineering-bridge-studio"],
      ["codex", "--version"],
      ["codex", "plugin", "marketplace", "add"],
      ["codex", "plugin", "add", "engineering-bridge@engineering-bridge-studio"],
    ]);
    assert.equal(calls.filter(({ command, args }) => command === "tar" && args[0] === "-xzf").length, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
