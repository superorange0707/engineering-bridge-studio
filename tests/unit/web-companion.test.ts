import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = join(process.cwd(), "bin", "web-companion.mjs");

type Companion = {
  LOCK: {
    release_tag: string;
    source_commit: string;
    assets: Record<string, { name: string; size: number; sha256: string; url: string }>;
    notices: Array<{ name: string; size: number; sha256: string; url: string }>;
  };
  assetForPlatform(platform?: string, arch?: string): { key: string; name: string; size: number; sha256: string; url: string };
  assertInstallTarget(path: string): string;
  captureInstallTarget(path: string): Record<string, unknown>;
  revalidateInstallTarget(path: string, expected: Record<string, unknown>): Record<string, unknown>;
  commitInstallation(staged: string, target: string, expected: Record<string, unknown>, backupPath?: string): { target: string; backup_path?: string };
  defaultInstallDir(): string;
  inspectArchive(path: string): Array<{ mode: string; name: string; symlinkTarget?: string }>;
  downloadFixedFile(
    entry: { name: string; size: number; sha256: string; url: string },
    destination: string,
    fetchImpl: typeof fetch,
  ): Promise<string>;
  parseArgs(args: string[]): { command: string; installDir?: string; archive?: string; json: boolean };
  readInstallationStatus(path: string): Record<string, unknown>;
  validateArchiveEntries(entries: unknown[]): string[];
};

async function companion(): Promise<Companion> {
  return await import(pathToFileURL(script).href) as unknown as Companion;
}

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function productManifest(module: Companion, target: string, asset = module.assetForPlatform("darwin", "arm64"), backupPath?: string): Record<string, unknown> {
  return {
    schema_version: 1,
    product: "engineering-bridge-web-companion",
    repository: "miuuyy/codex-chatgpt-web",
    release_tag: module.LOCK.release_tag,
    source_commit: module.LOCK.source_commit,
    platform: asset.key,
    asset: { name: asset.name, size: asset.size, sha256: asset.sha256 },
    app_path: "Codex Web GPT.app",
    notice_files: module.LOCK.notices.map((notice) => ({ name: notice.name, size: notice.size, sha256: notice.sha256 })),
    install_dir: target,
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
  };
}

function createProduct(module: Companion, target: string, marker: string, backupPath?: string, manifestTarget = target): void {
  mkdirSync(join(target, "Codex Web GPT.app", "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "Codex Web GPT.app", "Contents", "MacOS", "Codex Web GPT"), marker, { mode: 0o700 });
  writeFileSync(join(target, "companion-manifest.json"), `${JSON.stringify(productManifest(module, manifestTarget, undefined, backupPath), null, 2)}\n`, { mode: 0o600 });
}

test("the lock pins the upstream release and both macOS assets", async () => {
  const module = await companion();
  assert.equal(module.LOCK.release_tag, "v5.0.6");
  assert.equal(module.LOCK.source_commit, "e85e3693fdb4e3e033348c08df0298c20fcdb612");
  assert.match(module.assetForPlatform("darwin", "arm64").sha256, /^[a-f0-9]{64}$/);
  assert.match(module.assetForPlatform("darwin", "x64").sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => module.assetForPlatform("linux", "x64"), /macOS only/);
});

test("fixed download uses the expected bytes and rejects a bad digest", async () => {
  const module = await companion();
  const root = temp("engineering-bridge-web-companion-download-");
  try {
    const bytes = Buffer.from("fixture archive bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const entry = {
      name: "fixture.zip",
      size: bytes.length,
      sha256: digest,
      url: "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.6/fixture.zip",
    };
    const destination = join(root, "staging", "fixture.zip");
    const fetchImpl: typeof fetch = async (url) => {
      const requestUrl = typeof url === "string" || url instanceof URL ? url : url.url;
      assert.equal(new URL(requestUrl).hostname, "github.com");
      return new Response(bytes, { status: 200 });
    };
    assert.equal(await module.downloadFixedFile(entry, destination, fetchImpl), destination);

    const badDestination = join(root, "staging", "bad.zip");
    await assert.rejects(
      module.downloadFixedFile({ ...entry, sha256: "0".repeat(64) }, badDestination, fetchImpl),
      /SHA-256 mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive entry validation rejects traversal and symlink escapes while allowing in-bundle links", async () => {
  const module = await companion();
  assert.deepEqual(module.validateArchiveEntries([
    { name: "Codex Web GPT.app/", uncompressedSize: 0 },
    { name: "Codex Web GPT.app/Contents/MacOS/Codex Web GPT", uncompressedSize: 5 },
    { name: "Codex Web GPT.app/Contents/Frameworks/Electron Framework.framework/Electron Framework", mode: "lrwxr-xr-x", symlinkTarget: "Versions/Current/Electron Framework", uncompressedSize: 22 },
  ]), [
    "Codex Web GPT.app",
    "Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
    "Codex Web GPT.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
  ]);
  for (const entry of [
    { name: "../outside" },
    { name: "/absolute" },
    { name: "Codex Web GPT.app/file" },
    { name: "Codex Web GPT.app/file" },
  ]) {
    assert.throws(() => module.validateArchiveEntries([entry, ...(entry.name.endsWith("file") ? [entry] : [])]), /archive/);
  }
  assert.throws(() => module.validateArchiveEntries([{
    name: "Codex Web GPT.app/link",
    mode: "lrwxr-xr-x",
    symlinkTarget: "../../outside",
  }]), /symlink escapes/);
  assert.throws(() => module.validateArchiveEntries([{
    name: "Codex Web GPT.app/link",
    mode: "lrwxr-xr-x",
  }]), /symlink/);
});

const downloadedOfficialArchive = join(process.cwd(), "var", "companion-download", "codex-web-gpt-5.0.6-mac-arm64.zip");
if (existsSync(downloadedOfficialArchive)) {
  test("the downloaded official arm64 archive fits the bounded listing path", async () => {
    const module = await companion();
    const entries = module.inspectArchive(downloadedOfficialArchive);
    assert.equal(entries.length, 7_294);
    assert.equal(entries.filter((entry) => entry.mode.startsWith("l")).length, 16);
  });
}

test("status reads only a product manifest and refuses a foreign install directory", async () => {
  const module = await companion();
  const root = temp("engineering-bridge-web-companion-status-");
  try {
    const app = join(root, "Codex Web GPT.app", "Contents", "MacOS");
    mkdirSync(app, { recursive: true, mode: 0o700 });
    const executable = join(app, "Codex Web GPT");
    writeFileSync(executable, "fixture", { mode: 0o700 });
    const asset = module.assetForPlatform("darwin", process.arch);
    writeFileSync(join(root, "companion-manifest.json"), `${JSON.stringify({
      schema_version: 1,
      product: "engineering-bridge-web-companion",
      repository: "miuuyy/codex-chatgpt-web",
      release_tag: module.LOCK.release_tag,
      source_commit: module.LOCK.source_commit,
      platform: asset.key,
      asset: { name: asset.name, size: asset.size, sha256: asset.sha256 },
    app_path: "Codex Web GPT.app",
      notice_files: module.LOCK.notices.map((notice) => ({
        name: notice.name,
        size: notice.size,
        sha256: notice.sha256,
      })),
    })}\n`, { mode: 0o600 });

    const status = module.readInstallationStatus(root);
    assert.equal(status.installed, true);
    assert.equal(status.app_present, true);
    const cliStatus = JSON.parse(execFileSync(process.execPath, [script, "status", "--install-dir", root, "--json"], { encoding: "utf8" })) as Record<string, unknown>;
    assert.equal(cliStatus.installed, true);

    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "unrelated.txt"), "keep");
    assert.throws(() => module.assertInstallTarget(foreign), /non-product/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI keeps archive installs explicit and never activates a provider", async () => {
  const module = await companion();
  assert.deepEqual(module.parseArgs(["install", "--archive", "/tmp/companion.zip", "--notices-dir", "/tmp/notices", "--install-dir", "/tmp/bridge-companion", "--json"]), {
    command: "install",
    archive: "/tmp/companion.zip",
    noticesDir: "/tmp/notices",
    installDir: "/tmp/bridge-companion",
    json: true,
  });
  assert.throws(() => module.parseArgs(["status", "--archive", "/tmp/companion.zip"]), /only for install/);
  assert.throws(() => module.parseArgs(["status", "--notices-dir", "/tmp/notices"]), /only for install/);
  assert.match(execFileSync(process.execPath, [script, "--version"], { encoding: "utf8" }), /^5\.0\.6\n$/);
});

test("publication revalidates the exact target directory and manifest before moving it", async () => {
  const module = await companion();
  const root = temp("engineering-bridge-web-companion-revalidate-");
  try {
    const target = join(root, "companion");
    createProduct(module, target, "old");
    const expected = module.captureInstallTarget(target);
    const manifestPath = join(target, "companion-manifest.json");
    writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}\n`, { mode: 0o600 });
    assert.throws(() => module.revalidateInstallTarget(target, expected), /changed before commit/);
    assert.equal(readFileSync(join(target, "Codex Web GPT.app", "Contents", "MacOS", "Codex Web GPT"), "utf8"), "old");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication retains the previous product, including user files, and reports its backup", async () => {
  const module = await companion();
  const root = temp("engineering-bridge-web-companion-backup-");
  try {
    const target = join(root, "companion");
    createProduct(module, target, "old");
    writeFileSync(join(target, "user-added.txt"), "keep this file\n", { mode: 0o600 });
    const expected = module.captureInstallTarget(target);
    const backupPath = `${target}.previous-test`;
    const stage = join(root, "staged");
    createProduct(module, stage, "new", backupPath, target);

    const committed = module.commitInstallation(stage, target, expected, backupPath);
    assert.equal(committed.backup_path, backupPath);
    assert.equal(readFileSync(join(backupPath, "user-added.txt"), "utf8"), "keep this file\n");
    assert.equal(readFileSync(join(target, "Codex Web GPT.app", "Contents", "MacOS", "Codex Web GPT"), "utf8"), "new");

    const status = module.readInstallationStatus(target);
    assert.equal(status.backup_path, backupPath);
    assert.equal(status.backup_present, true);
    rmSync(backupPath, { recursive: true, force: true });
    const afterRemoval = module.readInstallationStatus(target);
    assert.equal(afterRemoval.backup_path, backupPath);
    assert.equal(afterRemoval.backup_present, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
