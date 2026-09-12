import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfigPath } from "./connection.mjs";

function fail(message) {
  process.stderr.write(`Engineering Bridge plugin: ${message}\n`);
  process.exit(1);
}

if (process.env.ENGINEERING_BRIDGE_EXECUTOR_CHILD === "1") {
  fail("refusing recursive executor-child startup");
}

if (process.platform !== "darwin") {
  fail("this unified beta currently supports macOS only");
}

const configPath = await resolveConfigPath().catch(error => fail(error.message));
await access(configPath).catch(() => fail("configure a project with engineering-bridge-studio init, or connect an existing stack first"));

const entryPath = fileURLToPath(new URL("../dist/src/mcp-stdio.js", import.meta.url));
await access(entryPath).catch(() => fail("the Bridge build is missing; use a release package or run npm ci and npm run build"));

process.argv = [process.execPath, entryPath, configPath];
await import(pathToFileURL(entryPath).href);
