#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  lstat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  connectConfig as defaultConnectConfig,
  connectionFile as defaultConnectionFile,
  defaultStack,
  readPrivateJson,
  resolveConfigPath as defaultResolveConfigPath
} from "./connection.mjs";
import { initialize as defaultInitialize } from "./bridge.mjs";
import { installCompanion, launchCompanion, readInstallationStatus } from "./web-companion.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const STUDIO_VERSION = typeof PACKAGE.version === "string" ? PACKAGE.version : "2.0.0-beta.1";
export const STUDIO_HOST = "127.0.0.1";
export const STUDIO_MAX_BODY_BYTES = 1 * 1024 * 1024;
export const STUDIO_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const STUDIO_REQUEST_TIMEOUT_MS = 180_000;
export const STUDIO_LIFETIME_MS = 30 * 60 * 1000;

export const STUDIO_TOOLS = Object.freeze([
  "bridge_capabilities",
  "workspace_diagnostics",
  "collaboration_run",
  "collaboration_result",
  "collaboration_history",
  "collaboration_artifact",
  "collaboration_review",
  "collaboration_interrupt"
]);

const STATIC_ASSETS = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/assets/studio/index.html": ["index.html", "text/html; charset=utf-8"],
  "/assets/studio/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/assets/studio/style.css": ["style.css", "text/css; charset=utf-8"],
  "/studio/index.html": ["index.html", "text/html; charset=utf-8"],
  "/studio/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/studio/style.css": ["style.css", "text/css; charset=utf-8"]
});
const ALLOWED_ENVIRONMENT = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"];
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const PID_PATTERN = /^[1-9][0-9]*$/u;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METADATA_PRODUCT = "engineering-bridge-studio-studio";
const READ_ONLY_TOOLS = new Set([
  "bridge_capabilities",
  "workspace_diagnostics",
  "collaboration_result",
  "collaboration_history",
  "collaboration_artifact"
]);

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

function fail(message) {
  throw new Error(message);
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) {
    fail(`${label} must be an absolute, normalized path`);
  }
  return value;
}

function pathInside(root, candidate) {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function safeVersion(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000\r\n]/u.test(value)) {
    fail("Studio version is invalid");
  }
  return value;
}

function safeToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) fail("Studio token is invalid");
  return value;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function ensurePrivateDirectory(pathValue) {
  absolutePath(pathValue, "private directory");
  await mkdir(pathValue, { recursive: true, mode: 0o700 });
  const info = await lstat(pathValue);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (currentUid() !== undefined && info.uid !== currentUid()) || (info.mode & 0o077) !== 0) {
    fail(`Studio requires a private directory: ${pathValue}`);
  }
}

async function checkPrivateDirectory(pathValue) {
  const info = await lstat(pathValue);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (currentUid() !== undefined && info.uid !== currentUid()) || (info.mode & 0o077) !== 0) {
    fail(`Studio requires a private directory: ${pathValue}`);
  }
}

async function writePrivateMetadata(pathValue, metadata) {
  absolutePath(pathValue, "Studio metadata path");
  await ensurePrivateDirectory(dirname(pathValue));
  const temporary = `${pathValue}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, pathValue);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function removeOwnedMetadata(pathValue, identity) {
  if (pathValue === undefined) return;
  let metadata;
  let file;
  try {
    file = await lstat(pathValue);
    metadata = JSON.parse(await readFile(pathValue, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    return;
  }
  if (!object(metadata) || metadata.pid !== identity.pid || metadata.token !== identity.token ||
      metadata.plugin_root !== identity.plugin_root || metadata.version !== identity.version ||
      metadata.read_only !== identity.read_only) return;
  const current = await lstat(pathValue).catch(() => undefined);
  if (current?.dev === file.dev && current.ino === file.ino) await unlink(pathValue).catch(() => undefined);
}

function readConfigPath(options) {
  if (options.configPath !== undefined) return absolutePath(options.configPath, "config path");
  const pointer = options.connectionFile === undefined
    ? defaultConnectionFile()
    : absolutePath(options.connectionFile, "connection file");
  return Promise.resolve((options.resolveConfig ?? defaultResolveConfigPath)(options.env ?? process.env, pointer));
}

function configProjects(config) {
  if (!object(config) || config.version !== 3 || !Array.isArray(config.workspaces)) return undefined;
  const enabled = new Set(Array.isArray(config.collaboration?.execution_workspace_ids)
    ? config.collaboration.execution_workspace_ids.filter((value) => typeof value === "string")
    : []);
  const projects = [];
  for (const workspace of config.workspaces) {
    if (!object(workspace) || typeof workspace.workspace_id !== "string" ||
        typeof workspace.display_name !== "string" || typeof workspace.current_path !== "string") return undefined;
    projects.push({
      workspace_id: workspace.workspace_id,
      display_name: workspace.display_name,
      current_path: workspace.current_path,
      execution_enabled: enabled.has(workspace.workspace_id)
    });
  }
  return projects;
}

function stackDirectoryForConfig(configPath) {
  return dirname(dirname(configPath));
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[0-9a-f]{64}/giu, "Bearer [redacted]").slice(0, 2_000);
}

function jsonBytes(value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > STUDIO_MAX_RESPONSE_BYTES) throw new HttpError(500, "Studio response exceeded its size limit");
  return bytes;
}

function sendJson(response, status, value, headers = {}) {
  let bytes;
  try {
    bytes = jsonBytes(value);
  } catch (error) {
    status = error instanceof HttpError ? error.status : 500;
    bytes = Buffer.from(JSON.stringify({ error: errorMessage(error) }), "utf8");
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(bytes);
}

function sendError(response, error) {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message }, error.headers);
    return;
  }
  sendJson(response, 400, { error: errorMessage(error) });
}

function parseUrl(request, origin) {
  try {
    return new URL(request.url ?? "/", origin);
  } catch {
    throw new HttpError(400, "Invalid request URL");
  }
}

function requireObject(value, label) {
  if (!object(value)) throw new HttpError(400, `${label} must be a JSON object`);
  return value;
}

async function readBody(request) {
  const lengthHeader = request.headers["content-length"];
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, "Invalid content length");
    if (length > STUDIO_MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      request.resume();
      rejectBody(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > STUDIO_MAX_BODY_BYTES) {
        rejectOnce(new HttpError(413, "Request body is too large"));
        return;
      }
      chunks.push(value);
    });
    request.once("error", rejectOnce);
    request.once("aborted", () => rejectOnce(new HttpError(400, "Request body was interrupted")));
    request.once("end", () => {
      if (settled) return;
      settled = true;
      const bytesValue = Buffer.concat(chunks);
      if (bytesValue.byteLength === 0) {
        rejectBody(new HttpError(400, "Request body is required"));
        return;
      }
      try {
        resolveBody(requireObject(JSON.parse(bytesValue.toString("utf8")), "Request body"));
      } catch (error) {
        rejectBody(error instanceof HttpError ? error : new HttpError(400, "Request body is not valid JSON"));
      }
    });
  });
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new HttpError(400, `${label} contains an unsupported field`);
}

function assertAbsoluteRequestPath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) {
    throw new HttpError(400, `${label} must be an absolute, normalized path`);
  }
  return value;
}

function workspaceId(value) {
  if (typeof value !== "string" || !WORKSPACE_ID_PATTERN.test(value)) {
    throw new HttpError(400, "workspace_id must be a UUID v4");
  }
  return value;
}

function conversationUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new HttpError(400, "conversation_url must be a ChatGPT URL");
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new HttpError(400, "conversation_url must be a ChatGPT URL"); }
  if (parsed.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(parsed.hostname) ||
      parsed.username !== "" || parsed.password !== "" || parsed.port !== "" ||
      parsed.search !== "" || parsed.hash !== "" ||
      (parsed.pathname !== "/" && !(parsed.pathname.startsWith("/c/") && parsed.pathname.length > 3))) {
    throw new HttpError(400, "conversation_url must be https://chatgpt.com/ or a /c/ conversation URL without query or fragment");
  }
  return value;
}

function buildEnvironment() {
  const environment = {};
  for (const name of ALLOWED_ENVIRONMENT) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  // The MCP child is a Bridge front door, not a Codex executor. Do not pass
  // the executor-child marker, which would make the selected Bridge refuse its
  // own connection. Preserve the explicit routed read-only marker when set.
  if (process.env.CODEX_ROUTED_TASK_READ_ONLY !== undefined) {
    environment.CODEX_ROUTED_TASK_READ_ONLY = process.env.CODEX_ROUTED_TASK_READ_ONLY;
  }
  return environment;
}

function firstJsonText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const firstText = content.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
  if (firstText === undefined) throw new Error("Bridge tool returned no JSON text result");
  try {
    return JSON.parse(firstText);
  } catch {
    throw new Error("Bridge tool returned invalid JSON text");
  }
}

export async function relayBridgeTool({
  configPath,
  name,
  arguments: args,
  pluginRoot = PLUGIN_ROOT,
  mcpEntryPath = join(pluginRoot, "dist", "src", "mcp-stdio.js"),
  clientFactory = (version) => new Client({ name: "engineering-bridge-studio", version }),
  transportFactory = (options) => new StdioClientTransport(options),
  readOnly = false
}) {
  assertAbsoluteRequestPath(configPath, "config path");
  if (!STUDIO_TOOLS.includes(name)) throw new HttpError(400, "Unknown Studio tool");
  requireObject(args, "Tool arguments");
  const client = clientFactory(STUDIO_VERSION);
  const transport = transportFactory({
    command: process.execPath,
    args: [mcpEntryPath, configPath],
    cwd: pluginRoot,
    env: (() => {
      const environment = buildEnvironment();
      if (readOnly) environment.CODEX_ROUTED_TASK_READ_ONLY = "1";
      return environment;
    })(),
    stderr: "pipe"
  });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const value = firstJsonText(result);
    if (result?.isError === true) {
      const message = object(value) && object(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : "Bridge tool failed";
      throw new HttpError(400, message);
    }
    return value;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function normalizeCompanion(value) {
  return {
    installed: value?.installed === true,
    release_tag: typeof value?.release_tag === "string" ? value.release_tag : null
  };
}

export async function createStudioServer(options = {}) {
  const pluginRoot = absolutePath(options.pluginRoot ?? PLUGIN_ROOT, "plugin root");
  const version = safeVersion(options.version ?? STUDIO_VERSION);
  const assetRoot = absolutePath(options.assetRoot ?? join(pluginRoot, "assets", "studio"), "Studio asset root");
  const connectionPath = options.connectionFile === undefined
    ? defaultConnectionFile()
    : absolutePath(options.connectionFile, "connection file");
  let activeConfigPath = await readConfigPath(options);
  if (activeConfigPath !== undefined) activeConfigPath = absolutePath(activeConfigPath, "config path");
  let activeStackDir = options.stackDir === undefined
    ? (activeConfigPath === undefined ? undefined : stackDirectoryForConfig(activeConfigPath))
    : absolutePath(options.stackDir, "stack directory");
  const host = options.host ?? STUDIO_HOST;
  if (host !== STUDIO_HOST) fail("Studio must bind to 127.0.0.1");
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) fail("Studio port is invalid");
  const token = safeToken(options.token ?? randomBytes(32).toString("hex"));
  const pid = Number.isSafeInteger(options.pid) ? options.pid : process.pid;
  const configReader = options.readConfig ?? readPrivateJson;
  const initialize = options.initialize ?? defaultInitialize;
  const connectConfig = options.connectConfig ?? defaultConnectConfig;
  const resolveConfig = options.resolveConfig ?? defaultResolveConfigPath;
  const companionStatus = options.companionStatus ?? (() => readInstallationStatus());
  const companionInstall = options.companionInstall ?? (() => installCompanion());
  const companionLaunch = options.companionLaunch ?? (() => launchCompanion());
  const relay = options.relayTool ?? relayBridgeTool;
  const readOnly = options.readOnly === true || (options.env ?? process.env).CODEX_ROUTED_TASK_READ_ONLY === "1";
  const metadataPath = options.metadataPath === undefined
    ? undefined
    : absolutePath(options.metadataPath, "Studio metadata path");
  const metadataIdentity = {
    pid,
    token,
    plugin_root: pluginRoot,
    version,
    read_only: readOnly
  };
  let server;
  let port;
  let closed = false;
  let setupInFlight;
  let closePromise;
  let lifetimeTimer;
  const lifetimeMs = options.lifetimeMs ?? STUDIO_LIFETIME_MS;

  function touchLifetime() {
    if (closed) return;
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    lifetimeTimer = setTimeout(() => { void close(); }, lifetimeMs);
    lifetimeTimer.unref?.();
  }

  const status = async () => {
    let config;
    if (activeConfigPath !== undefined) {
      try { config = await configReader(activeConfigPath); } catch { config = undefined; }
    }
    const projects = configProjects(config);
    let companion;
    try { companion = normalizeCompanion(await companionStatus()); } catch { companion = { installed: false, release_tag: null }; }
    return {
      version,
      setup_required: projects === undefined,
      config_path: activeConfigPath ?? null,
      projects: projects ?? [],
      companion,
      web_connection: "not_verified",
      read_only: readOnly
    };
  };

  async function currentProjects() {
    if (activeConfigPath === undefined) return undefined;
    let config;
    try { config = await configReader(activeConfigPath); } catch { return undefined; }
    return configProjects(config);
  }

  function researchLinkPath(workspace) {
    if (activeStackDir === undefined) throw new HttpError(400, "Choose a configured Bridge project first");
    return join(activeStackDir, "state", "studio-links", `${workspace.workspace_id}.json`);
  }

  async function ensureResearchLinkDirectory(pathValue) {
    const linkDir = dirname(pathValue);
    const directories = [dirname(dirname(linkDir)), dirname(linkDir), linkDir];
    for (const directory of directories) await ensurePrivateDirectory(directory);
  }

  async function checkResearchLinkDirectory(pathValue) {
    const linkDir = dirname(pathValue);
    const directories = [dirname(dirname(linkDir)), dirname(linkDir), linkDir];
    for (const directory of directories) {
      try { await checkPrivateDirectory(directory); }
      catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }

  async function readResearchLink(pathValue, workspaceIdValue) {
    let value;
    try {
      value = await readPrivateJson(pathValue);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new HttpError(500, "Saved research link is unavailable");
    }
    if (!object(value) || value.version !== 1 || value.workspace_id !== workspaceIdValue ||
        typeof value.conversation_url !== "string") {
      throw new HttpError(500, "Saved research link is invalid");
    }
    return conversationUrl(value.conversation_url);
  }

  async function saveResearchLink(pathValue, workspaceIdValue, value) {
    await ensureResearchLinkDirectory(pathValue);
    if (value === "") {
      let file;
      try { file = await lstat(pathValue); } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw new HttpError(500, "Saved research link is unavailable");
      }
      if (file.isSymbolicLink() || !file.isFile() ||
          (currentUid() !== undefined && file.uid !== currentUid()) || (file.mode & 0o077) !== 0) {
        throw new HttpError(500, "Saved research link is not a private regular file");
      }
      const current = await lstat(pathValue).catch(() => undefined);
      if (current?.dev !== file.dev || current?.ino !== file.ino) return null;
      await unlink(pathValue).catch((error) => {
        if (error?.code !== "ENOENT") throw new HttpError(500, "Saved research link could not be cleared");
      });
      return null;
    }
    await writePrivateMetadata(pathValue, {
      version: 1,
      workspace_id: workspaceIdValue,
      conversation_url: value
    });
    return value;
  }

  async function research(body) {
    if (body.action !== "get" && body.action !== "save") {
      throw new HttpError(400, "Research action must be get or save");
    }
    assertExactKeys(body, body.action === "get"
      ? ["action", "workspace_id"]
      : ["action", "workspace_id", "conversation_url"], "Research request");
    const id = workspaceId(body.workspace_id);
    const projects = await currentProjects();
    const workspace = projects?.find((project) => project.workspace_id === id);
    if (workspace === undefined) throw new HttpError(400, "workspace_id is not in the active Bridge configuration");
    const pathValue = researchLinkPath(workspace);
    if (body.action === "get") {
      const present = await checkResearchLinkDirectory(pathValue);
      return { conversation_url: present ? await readResearchLink(pathValue, id) : null };
    }
    if (readOnly) throw new HttpError(403, "Studio is read-only");
    if (typeof body.conversation_url !== "string") throw new HttpError(400, "conversation_url must be a ChatGPT URL");
    const value = body.conversation_url === "" ? "" : conversationUrl(body.conversation_url);
    await ensureResearchLinkDirectory(pathValue);
    return { conversation_url: await saveResearchLink(pathValue, id, value) };
  }

  const writeMetadata = async () => {
    if (metadataPath === undefined) return;
    await (options.writeMetadata ?? writePrivateMetadata)(metadataPath, {
      schema_version: 1,
      product: METADATA_PRODUCT,
      ...metadataIdentity,
      config_path: activeConfigPath ?? null,
      host: STUDIO_HOST,
      port,
      started_at: options.startedAt ?? new Date().toISOString()
    });
  };

  async function setup(body) {
    if (setupInFlight !== undefined) return setupInFlight;
    setupInFlight = (async () => {
      const mode = body.mode;
      if (mode === "create") {
        assertExactKeys(body, ["mode", "project_path", "experiments"], "Setup request");
        const projectPath = assertAbsoluteRequestPath(body.project_path, "project_path");
        if (typeof body.experiments !== "boolean") throw new HttpError(400, "experiments must be a boolean");
        const stack = options.stackDir === undefined ? defaultStack() : absolutePath(options.stackDir, "stack directory");
        const initialized = await initialize({ home: stack, project: [projectPath], experiments: body.experiments });
        if (!object(initialized) || typeof initialized.config_path !== "string") throw new Error("Bridge setup did not return a configuration path");
        const connected = await connectConfig(absolutePath(initialized.config_path, "created config path"), connectionPath);
        activeConfigPath = absolutePath(connected?.config_path ?? initialized.config_path, "created config path");
        activeStackDir = stack;
      } else if (mode === "connect") {
        assertExactKeys(body, ["mode", "config_path"], "Setup request");
        const configPath = assertAbsoluteRequestPath(body.config_path, "config_path");
        const connected = await connectConfig(configPath, connectionPath);
        activeConfigPath = absolutePath(connected?.config_path ?? configPath, "config path");
        activeStackDir = stackDirectoryForConfig(activeConfigPath);
      } else {
        throw new HttpError(400, "Setup mode must be create or connect");
      }
      await writeMetadata();
      return { ok: true, ...(await status()) };
    })();
    try { return await setupInFlight; } finally { setupInFlight = undefined; }
  }

  async function handleApi(request, response, url) {
    const expectedOrigin = `http://${STUDIO_HOST}:${port}`;
    const requestOrigin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    const missingOriginAllowed = request.method === "GET" && requestOrigin === undefined &&
      (fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none");
    if (requestOrigin !== expectedOrigin && !missingOriginAllowed) {
      throw new HttpError(403, "Origin is not allowed");
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      throw new HttpError(401, "Studio authentication failed", { "WWW-Authenticate": "Bearer" });
    }
    touchLifetime();
    if (url.search !== "") throw new HttpError(400, "Query parameters are not accepted");
    if (url.pathname === "/api/status") {
      if (request.method !== "GET") throw new HttpError(405, "Method is not allowed", { Allow: "GET" });
      return sendJson(response, 200, await status());
    }
    if (!["/api/setup", "/api/tools", "/api/companion", "/api/research"].includes(url.pathname)) {
      throw new HttpError(404, "Studio route not found");
    }
    if (request.method !== "POST") throw new HttpError(405, "Method is not allowed", { Allow: "POST" });
    if (readOnly && url.pathname !== "/api/tools" && url.pathname !== "/api/research") {
      throw new HttpError(403, "Studio is read-only");
    }
    const body = await readBody(request);
    if (url.pathname === "/api/setup") return sendJson(response, 200, await setup(body));
    if (url.pathname === "/api/research") return sendJson(response, 200, await research(body));
    if (url.pathname === "/api/tools") {
      assertExactKeys(body, ["name", "arguments"], "Tool request");
      if (typeof body.name !== "string" || !STUDIO_TOOLS.includes(body.name)) throw new HttpError(400, "Unknown Studio tool");
      requireObject(body.arguments, "Tool arguments");
      if (readOnly && !READ_ONLY_TOOLS.has(body.name)) throw new HttpError(403, "Studio is read-only");
      if (activeConfigPath === undefined) throw new HttpError(400, "Choose a project in Studio first");
      const value = await relay({ configPath: activeConfigPath, name: body.name, arguments: body.arguments, pluginRoot, readOnly });
      return sendJson(response, 200, value);
    }
    if (readOnly) throw new HttpError(403, "Studio is read-only");
    assertExactKeys(body, ["action"], "Companion request");
    if (body.action !== "install" && body.action !== "launch") throw new HttpError(400, "Companion action must be install or launch");
    const result = body.action === "install" ? await companionInstall() : await companionLaunch();
    return sendJson(response, 200, { action: body.action, result, companion: normalizeCompanion(await companionStatus()) });
  }

  async function handleRequest(request, response) {
    const origin = `http://${STUDIO_HOST}:${port ?? requestedPort}`;
    const url = parseUrl(request, origin);
    if (request.headers.host !== `${STUDIO_HOST}:${port}`) throw new HttpError(403, "Host is not allowed");
    if (url.pathname.startsWith("/api/")) return handleApi(request, response, url);
    const staticAsset = STATIC_ASSETS[url.pathname];
    if (staticAsset !== undefined) {
      if (request.method !== "GET") throw new HttpError(405, "Method is not allowed", { Allow: "GET" });
      if (request.headers.origin !== undefined && request.headers.origin !== `http://${STUDIO_HOST}:${port}`) {
        throw new HttpError(403, "Origin is not allowed");
      }
      if (url.search !== "") throw new HttpError(400, "Query parameters are not accepted");
      const [fileName, contentType] = staticAsset;
      const filePath = join(assetRoot, fileName);
      if (!pathInside(assetRoot, filePath)) throw new HttpError(404, "Studio asset not found");
      let bytes;
      try { bytes = await readFile(filePath); } catch { throw new HttpError(404, "Studio asset not found"); }
      if (bytes.byteLength > STUDIO_MAX_RESPONSE_BYTES) throw new HttpError(500, "Studio asset exceeded its size limit");
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": bytes.byteLength,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(bytes);
      return;
    }
    throw new HttpError(404, "Studio route not found");
  }

  server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    });
  });
  server.requestTimeout = options.requestTimeoutMs ?? STUDIO_REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(server.requestTimeout, 30_000);
  server.keepAliveTimeout = 5_000;
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen({ host: STUDIO_HOST, port: requestedPort }, () => {
      server.off("error", rejectServer);
      resolveServer();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    fail("Studio did not obtain a TCP port");
  }
  port = address.port;
  await writeMetadata();
  const url = `http://${STUDIO_HOST}:${port}/#token=${encodeURIComponent(token)}`;

  const close = async () => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      if (closed) return;
      closed = true;
      if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
      await new Promise((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
      await (options.removeMetadata ?? removeOwnedMetadata)(metadataPath, metadataIdentity);
    })();
    return closePromise;
  };
  touchLifetime();
  return { server, url, pid, port, token, close };
}

function parseServeArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--serve") { values.serve = true; continue; }
    if (flag === "--read-only") { values.read_only = true; continue; }
    if (!["--metadata", "--plugin-root", "--version", "--config-path", "--connection-file", "--state-dir"].includes(flag)) {
      throw new Error(`Unknown Studio server option: ${flag}`);
    }
    const value = args[++index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.serve || typeof values.metadata !== "string" || typeof values.plugin_root !== "string" ||
      typeof values.version !== "string" || typeof values.config_path !== "string" ||
      typeof values.connection_file !== "string" || typeof values.state_dir !== "string") {
    throw new Error("Studio server requires --serve, --metadata, --plugin-root, --version, --config-path, --connection-file and --state-dir");
  }
  return values;
}

async function runStandalone() {
  const values = parseServeArgs(process.argv.slice(2));
  const studio = await createStudioServer({
    metadataPath: absolutePath(values.metadata, "Studio metadata path"),
    pluginRoot: absolutePath(values.plugin_root, "plugin root"),
    version: values.version,
    configPath: absolutePath(values.config_path, "config path"),
    connectionFile: absolutePath(values.connection_file, "connection file"),
    stateDir: absolutePath(values.state_dir, "state directory"),
    readOnly: values.read_only === true
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void studio.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise(() => undefined);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--serve")) {
  runStandalone().catch(() => { process.exitCode = 1; });
}
