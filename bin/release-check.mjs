#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
if (plugin.version.split("+")[0] !== pkg.version || lock.version !== pkg.version) throw new Error("Release versions disagree.");
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: join(root, "var", "npm-cache") }
}))[0];
const forbidden = /(^|\/)(?:var|tests|\.git|\.codex|\.env(?:\..*)?|auth\.json|connection\.json|workspace-registry\.json|node_modules)(\/|$)/u;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{30,}\b/u;
const errors = [];
for (const file of packed.files) {
  if (forbidden.test(file.path)) errors.push(`Unexpected private/development path: ${file.path}`);
  const value = readFileSync(join(root, file.path), "utf8");
  if (value.includes(`${homedir()}/`) || secret.test(value)) errors.push(`Potential private material: ${file.path}`);
}
for (const required of [".codex-plugin/plugin.json", ".mcp.json", "bin/bridge.mjs", "bin/plugin-launcher.mjs", "bin/connection.mjs", "bin/web-companion.mjs", "config/web-companion.lock.json", "dist/src/mcp-stdio.js", "LICENSE", "THIRD_PARTY_NOTICES.md", "docs/installation.md"]) {
  if (!packed.files.some(file => file.path === required)) errors.push(`Missing release file: ${required}`);
}
if (errors.length) throw new Error(errors.join("\n"));
process.stdout.write(`${JSON.stringify({ version: pkg.version, files: packed.files.length, package_bytes: packed.size, privacy_check: "passed", versions: "consistent" }, null, 2)}\n`);
