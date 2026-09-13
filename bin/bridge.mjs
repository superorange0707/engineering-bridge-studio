#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { absolutePath, connectConfig, defaultStack, privateDirectory, readPrivateJson, resolveConfigPath } from "./connection.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const help = `Engineering Bridge Studio — one planning and execution workspace

  open [--config /absolute/config] [--json]
      Open the Studio workspace and first-use setup. No project configuration is needed.
  init --project /absolute/project [--project /another] [--experiments] [--home /new/stack]
      Create a private configuration for the named projects. Source writes stay disabled.
      --experiments enables isolated execution only for the explicitly named projects.
  connect --config /existing/stack/config/workspaces.json
      Point this plugin at an existing Bridge stack without copying its state.
  doctor [--config /absolute/config] [--json]
      Check local prerequisites and configuration; does not certify a Web round trip.
  web install|status|launch [options]
      Install or open the pinned ChatGPT Web companion; authentication stays in its UI.
  serve [--config /absolute/config]
      Start a STDIO client of the shared Bridge service.

Requires macOS and Node.js 22+. See docs/installation.md for plugin installation.
`;

function parse(args) {
  const values = { project: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--json", "--experiments"].includes(flag)) { values[flag.slice(2)] = true; continue; }
    if (!["--project", "--home", "--config", "--connection-file"].includes(flag) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Unknown option or missing value: ${flag}`);
    }
    const value = args[++i];
    if (flag === "--project") values.project.push(absolutePath(value));
    else values[flag.slice(2)] = absolutePath(value);
  }
  return values;
}

function serializedIdentity(value) {
  const stable = value.stableObjectIdentity;
  return {
    fingerprint: value.fingerprint,
    ...(value.localMetadataId ? { local_metadata_id: value.localMetadataId } : {}),
    ...(stable ? { stable_object_identity: {
      version: 2, id: stable.id, inode: stable.inode, birthtime_ns: stable.birthtimeNs,
      device_observation: stable.deviceObservation
    } } : {})
  };
}

export async function initialize(options) {
  if (!options.project?.length) throw new Error("init requires at least one explicit --project path.");
  const { inspectWorkspace } = await import("../dist/src/workspaces/repository-identity.js");
  const requestedStack = absolutePath(options.home ?? defaultStack());
  const projects = await Promise.all(options.project.map(async path => {
    absolutePath(path);
    const canonical = await realpath(path);
    if (["/", "/Users", homedir()].includes(canonical)) throw new Error("Choose a specific project directory.");
    return inspectWorkspace(canonical);
  }));
  if (new Set(projects.map(p => p.root)).size !== projects.length) throw new Error("Project paths must be distinct.");
  const workspaces = projects.map(project => ({
    workspace_id: randomUUID(), display_name: basename(project.root), aliases: [],
    current_path: project.root, previous_paths: [], workspace_type: project.workspaceType,
    filesystem_identity: serializedIdentity(project.filesystem), codex_project_references: [],
    ...(project.git ? { git_identity: {
      git_top_level: project.git.gitTopLevel, logical_root: project.git.logicalRoot,
      repository_identity: { ...serializedIdentity(project.git.repository),
        object_format: project.git.repository.objectFormat,
        normalized_remotes: project.git.repository.normalizedRemotes,
        root_commits: project.git.repository.rootCommits }
    } } : {}),
    permission_policy: { allow_write: false }
  }));
  await privateDirectory(requestedStack);
  const stack = await realpath(requestedStack);
  await privateDirectory(join(stack, "config"));
  await privateDirectory(join(stack, "state"));
  const configPath = join(stack, "config", "workspaces.json");
  const config = {
    version: 3,
    collaboration: { execution_workspace_ids: options.experiments ? workspaces.map(w => w.workspace_id) : [] },
    codex_projects: {
      source_file: join(homedir(), ".codex", "config.toml"), auto_onboard: false,
      permission_policy: { allow_write: false }
    },
    excluded_workspace_ids: [], managed_roots: [], workspaces
  };
  const handle = await open(configPath, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new Error("Configuration already exists. Use connect to reuse it; init never replaces it.");
    throw error;
  });
  const registryPath = join(stack, "state", "workspace-registry.json");
  let registryHandle;
  try {
    registryHandle = await open(registryPath, "wx", 0o600).catch(error => {
      if (error.code === "EEXIST") throw new Error("Workspace state already exists. Use connect with its existing configuration.");
      throw error;
    });
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await registryHandle.writeFile('{"version":3,"workspaces":[]}\n');
    await Promise.all([handle.sync(), registryHandle.sync()]);
  } catch (error) {
    // Remove only files this initialization created; never replace retained state.
    for (const [path, owned] of [[configPath, handle], [registryPath, registryHandle]]) {
      if (!owned) continue;
      const original = await owned.stat();
      const current = await lstat(path).catch(() => undefined);
      if (current?.dev === original.dev && current.ino === original.ino) await unlink(path);
    }
    throw error;
  } finally {
    await handle.close();
    await registryHandle?.close();
  }
  return { config_path: configPath, workspace_ids: workspaces.map(w => w.workspace_id),
    isolated_execution: Boolean(options.experiments), source_writes: false };
}

function run(command, args, { capture = false, env = process.env } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let text = "";
    let timer;
    if (capture) {
      child.stdout.on("data", data => { text = (text + data).slice(0, 8192); });
      timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }
    child.once("error", () => { clearTimeout(timer); resolveResult({ code: 1, available: false }); });
    child.once("close", code => { clearTimeout(timer); resolveResult({ code: code ?? 1, available: code === 0, output: text.trim() }); });
  });
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || ["--help", "help", "-h"].includes(command)) { process.stdout.write(help); return; }
  if (command === "--version") { process.stdout.write(`${JSON.parse(await readFile(join(root, "package.json"), "utf8")).version}\n`); return; }
  if (command === "web") {
    process.exitCode = (await run(process.execPath, [join(root, "bin", "web-companion.mjs"), ...rest])).code;
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("This unified distribution currently supports macOS. Other platforms are not certified.");
  }
  const options = parse(rest);
  let result;
  if (command === "open") {
    const { ensureStudio } = await import("./studio-process.mjs");
    result = await ensureStudio({ ...(options.config ? { configPath: options.config } : {}) });
    if (!options.json) await run("open", [result.url]);
  } else if (command === "init") {
    result = await initialize(options);
    result = { ...result, ...await connectConfig(result.config_path, options["connection-file"]) };
  } else if (command === "connect") {
    if (!options.config) throw new Error("connect requires --config /absolute/path.");
    result = await connectConfig(options.config, options["connection-file"]);
  } else if (command === "serve") {
    const path = options.config ?? await resolveConfigPath();
    process.exitCode = (await run(process.execPath, [join(root, "dist", "src", "mcp-stdio.js"), path])).code;
    return;
  } else if (command === "doctor") {
    const path = options.config ?? await resolveConfigPath();
    let config;
    let configError;
    try {
      config = await readPrivateJson(path);
      const { WorkspaceConfigSchema } = await import("../dist/src/mcp-stdio.js");
      if (!WorkspaceConfigSchema.safeParse(config).success) throw new Error("Workspace configuration does not match the Bridge schema.");
    } catch (error) { configError = error.message; }
    const [codex, git] = await Promise.all([run("codex", ["--version"], { capture: true }), run("git", ["--version"], { capture: true })]);
    result = {
      node: process.version, platform: process.platform,
      codex: { available: codex.available, version: codex.output },
      git: { available: git.available, version: git.output },
      config: { path, present: Boolean(config), version: config?.version,
        project_count: config?.workspaces?.length, isolated_execution_count: config?.collaboration?.execution_workspace_ids?.length ?? 0,
        ...(configError ? { error: configError } : {}) },
      local_ready: !configError && config?.version === 3 && codex.available && git.available,
      web_round_trip: "not_verified",
      next: "Use web status for the pinned companion, then complete the two-entrance acceptance in docs/installation.md."
    };
    if (!result.local_ready) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}\n${help}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Engineering Bridge: ${error.message}\n`); process.exitCode = 1; });
}
