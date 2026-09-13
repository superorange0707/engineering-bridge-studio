#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(root, "var", "release"));
const temporary = await mkdtemp(join(tmpdir(), "bridge-release-"));
const name = `engineering-bridge-studio-${pkg.version}`;
const marketplace = join(temporary, name);
const plugin = join(marketplace, "plugins", "engineering-bridge");
const env = { ...process.env, npm_config_cache: join(root, "var", "npm-cache") };
try {
  execFileSync(process.execPath, [join(root, "bin", "release-check.mjs")], { cwd: root, stdio: "inherit", env });
  await mkdir(plugin, { recursive: true });
  const pack = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: root, encoding: "utf8", env }))[0];
  execFileSync("tar", ["-xzf", join(temporary, pack.filename), "--strip-components=1", "-C", plugin]);
  await cp(join(root, "package-lock.json"), join(plugin, "package-lock.json"));
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: plugin, stdio: "inherit", env });
  await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
  // Generated with the Plugin Creator scaffold. Keep catalog policy and source
  // paths in that validated template rather than synthesizing them per build.
  await cp(join(root, "config", "release-marketplace.json"), join(marketplace, ".agents", "plugins", "marketplace.json"));
  await cp(join(root, "docs", "installation.md"), join(marketplace, "INSTALL.md"));
  await mkdir(output, { recursive: true });
  const archive = `${name}.tar.gz`;
  execFileSync("tar", ["-czf", join(output, archive), "-C", temporary, name]);
  const digest = createHash("sha256").update(await readFile(join(output, archive))).digest("hex");
  await writeFile(join(output, "SHA256SUMS"), `${digest}  ${archive}\n`);
  process.stdout.write(`${JSON.stringify({ archive: join(output, archive), sha256: digest }, null, 2)}\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }
