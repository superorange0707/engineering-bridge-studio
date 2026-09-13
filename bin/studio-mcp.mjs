import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readPrivateJson, resolveConfigPath } from "./connection.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const STUDIO_CONNECT_TIMEOUT_MS = 15_000;
const studioTools = [
  {
    name: "bridge_studio",
    description: "Open Engineering Bridge Studio: the visual project setup, ChatGPT research handoff, Codex experiments and results workspace. Works immediately after plugin installation, even before a project is configured. Open the returned URL in this task's right-hand browser panel with open_in_codex when available; otherwise show the URL to the user. Do not discard its fragment. This opens a workspace, not an experiment.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "bridge_setup_status",
    description: "Refresh the plugin after completing Studio setup. Reports whether a project is configured and activates its Bridge tools in this session. Does not start an experiment or inspect project history.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }
];

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export async function connectRuntime(configPath, { timeoutMs = STUDIO_CONNECT_TIMEOUT_MS } = {}) {
  const client = new Client({ name: "engineering-bridge-studio-plugin", version: pkg.version });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/src/mcp-stdio.js", import.meta.url)), configPath],
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    stderr: "pipe"
  });
  // The MCP channel contains protocol messages only. Runtime failures are
  // returned by requests; never mix child diagnostic output with the protocol.
  transport.stderr?.resume();
  try {
    await client.connect(transport, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    return { client, close: () => client.close() };
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
}

export function createStudioPlugin({
  resolveConfig = resolveConfigPath,
  readConfig = readPrivateJson,
  connect = connectRuntime,
  openStudio = async (options) => (await import("./studio-process.mjs")).ensureStudio(options),
  connectTimeoutMs = STUDIO_CONNECT_TIMEOUT_MS
} = {}) {
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) throw new Error("Studio connection timeout is invalid");
  const server = new Server({ name: "engineering-bridge", version: pkg.version }, {
    capabilities: { tools: { listChanged: true } },
    instructions: "For first use or a request to open the plugin, call bridge_studio and open its URL in the current Codex task's browser panel. Studio guides project setup and shows real experiments and results. After setup, call bridge_setup_status to refresh the available tools. ChatGPT Web supplies research and plans; native Codex executes the selected project. Do not claim that opening a web page automatically shares its conversation."
  });
  let active;
  let activePath;
  let connecting;
  let runtimeTools = [];
  let lastError;
  let closed = false;

  async function discardActive(connection) {
    if (active !== connection) return;
    active = undefined;
    activePath = undefined;
    runtimeTools = [];
    void server.sendToolListChanged().catch(() => {});
    await connection.close().catch(() => {});
  }

  async function connectBounded(path) {
    const connectionPromise = Promise.resolve().then(() => connect(path));
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("Bridge runtime connection timed out"));
      }, connectTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([connectionPromise, timeout]);
    } catch (error) {
      if (timedOut) {
        void connectionPromise.then(connection => connection?.close?.()).catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const path = await resolveConfig();
        const config = await readConfig(path);
        if (config.version !== 3 || !Array.isArray(config.workspaces)) throw new Error("Choose a project in Studio to finish setup.");
        if (active && path === activePath) return true;
        const next = await connectBounded(path);
        let nextClosed = false;
        const previousOnClose = next.client.onclose;
        next.client.onclose = () => {
          nextClosed = true;
          previousOnClose?.();
          void discardActive(next);
        };
        let tools;
        try { tools = (await next.client.listTools()).tools; }
        catch (error) { await next.close(); throw error; }
        if (closed || nextClosed) { await next.close(); return false; }
        await active?.close().catch(() => {});
        active = next;
        activePath = path;
        runtimeTools = tools.filter(tool => !studioTools.some(item => item.name === tool.name));
        lastError = undefined;
        void server.sendToolListChanged().catch(() => {});
        return true;
      } catch (error) {
        lastError = error.code === "ENOENT" ? undefined : error.message;
        return false;
      }
    })();
    try { return await connecting; } finally { connecting = undefined; }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const ready = await refresh();
    return { tools: [...studioTools, ...(ready ? runtimeTools : [])] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === "bridge_studio") {
        if (Object.keys(args).length) throw new Error("bridge_studio takes no arguments.");
        const configPath = await resolveConfig().catch(() => undefined);
        return json({ ...await openStudio({ ...(configPath ? { configPath } : {}) }),
          open_in: "current_task_browser_panel", title: "Engineering Bridge Studio" });
      }
      if (name === "bridge_setup_status") {
        if (Object.keys(args).length) throw new Error("bridge_setup_status takes no arguments.");
        const ready = await refresh();
        return json({ configured: ready, setup_required: !ready, tools_available: ready ? runtimeTools.length : 0,
          ...(ready ? { config_path: activePath } : {}), ...(lastError ? { error: lastError } : {}),
          next: ready ? "Choose the project in Studio, then start a plan or experiment." : "Open bridge_studio to finish setup." });
      }
      if (!await refresh() || !active) throw new Error(lastError ?? "Open bridge_studio and choose a project first.");
      if (!runtimeTools.some(tool => tool.name === name)) throw new Error("Unknown Bridge tool.");
      const connection = active;
      try {
        return await connection.client.callTool({ name, arguments: args }, undefined,
          { signal: extra.signal, timeout: 120_000 });
      } catch (error) {
        // A failed call may have been delivered before the transport died. Do
        // not replay it: clear the dead session and let the next request
        // establish a new one.
        await discardActive(connection);
        throw error;
      }
    } catch (error) {
      return { isError: true, ...json({ error: { message: error.message } }) };
    }
  });
  return {
    server,
    async close() { closed = true; await connecting?.catch(() => {}); await active?.close(); await server.close(); }
  };
}

export async function runStudioPlugin() {
  const plugin = createStudioPlugin();
  await plugin.server.connect(new StdioServerTransport());
  let stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    await plugin.close().catch(() => {});
  };
  process.stdin.once("end", close);
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
}
