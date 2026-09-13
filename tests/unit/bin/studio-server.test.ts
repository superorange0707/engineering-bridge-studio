import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { VERSION } from "../../../src/version.js";

const studioModule = await import(pathToFileURL(join(process.cwd(), "bin/studio-server.mjs")).href) as unknown as {
  createStudioServer(options: Record<string, unknown>): Promise<Studio>;
};

type Studio = {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
};

type HttpResult = { status: number; body: unknown; text: string };

const workspaceId = "8f2d3c4b-7a1e-4d6f-9b2c-1234567890ab";

async function fixture(options: { configured?: boolean; readOnly?: boolean; lifetimeMs?: number } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "engineering-bridge-studio-test-"));
  const stack = join(temporary, "stack");
  const configDir = join(stack, "config");
  const assetRoot = join(temporary, "assets", "studio");
  const configPath = join(configDir, "workspaces.json");
  const connectionFile = join(temporary, "connection.json");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(assetRoot, { recursive: true, mode: 0o700 });
  await chmod(stack, 0o700);
  await writeFile(join(assetRoot, "index.html"), "<!doctype html><title>Studio</title>\n");
  await writeFile(join(assetRoot, "app.js"), "console.log('studio');\n");
  await writeFile(join(assetRoot, "style.css"), "body{}\n");
  const config = {
    version: 3,
    collaboration: { execution_workspace_ids: [workspaceId] },
    workspaces: [{
      workspace_id: workspaceId,
      display_name: "Example project",
      current_path: "/tmp/example-project"
    }]
  };
  let configured = options.configured ?? true;
  const calls: Array<{ name: string; arguments: Record<string, unknown>; readOnly: boolean }> = [];
  const studio = await studioModule.createStudioServer({
    pluginRoot: temporary,
    assetRoot,
    stackDir: stack,
    configPath,
    connectionFile,
    readOnly: options.readOnly === true,
    lifetimeMs: options.lifetimeMs ?? 60_000,
    readConfig: async () => {
      if (!configured) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return config;
    },
    initialize: async () => {
      configured = true;
      return { config_path: configPath };
    },
    connectConfig: async () => ({ config_path: configPath }),
    companionStatus: async () => ({ installed: false, release_tag: null }),
    companionInstall: async () => ({ installed: true }),
    companionLaunch: async () => ({ launched: true }),
    relayTool: async (input: { name: string; arguments: Record<string, unknown>; readOnly: boolean }) => {
      calls.push(input);
      return { ok: true, name: input.name, arguments: input.arguments };
    }
  });
  return { temporary, stack, configPath, connectionFile, config, calls, studio, setConfigured: (value: boolean) => { configured = value; } };
}

function request(studio: Studio, path: string, options: {
  method?: string;
  origin?: string;
  token?: string | null;
  body?: unknown;
} = {}): Promise<HttpResult> {
  return new Promise((resolveResult, rejectResult) => {
    const method = options.method ?? "GET";
    const bytes = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
    const headers: Record<string, string | number> = {
      Host: `127.0.0.1:${studio.port}`
    };
    if (options.origin !== undefined) headers.Origin = options.origin;
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    else if (options.token !== null) headers.Authorization = `Bearer ${studio.token}`;
    if (bytes !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = bytes.byteLength;
    }
    const requestValue = httpRequest({
      hostname: "127.0.0.1",
      port: studio.port,
      path,
      method,
      headers,
      agent: false
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        resolveResult({ status: response.statusCode ?? 0, body, text });
      });
      response.once("error", rejectResult);
    });
    requestValue.once("error", rejectResult);
    if (bytes !== undefined) requestValue.write(bytes);
    requestValue.end();
  });
}

function expectedOrigin(studio: Studio): string {
  return `http://127.0.0.1:${studio.port}`;
}

async function closeFixture(value: { temporary: string; studio: Studio }) {
  await value.studio.close();
  await rm(value.temporary, { recursive: true, force: true });
}

test("fresh Studio serves authenticated status, allows setup, and serves fixed assets", async () => {
  const value = await fixture({ configured: false });
  try {
    const anonymous = await request(value.studio, "/api/status", { token: null });
    assert.equal(anonymous.status, 401);
    const status = await request(value.studio, "/api/status");
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, {
      version: VERSION,
      setup_required: true,
      config_path: value.configPath,
      projects: [],
      companion: { installed: false, release_tag: null },
      web_connection: "not_verified",
      read_only: false
    });
    const asset = await request(value.studio, "/assets/studio/index.html", { token: null });
    assert.equal(asset.status, 200);
    assert.match(asset.text, /Studio/u);

    const setup = await request(value.studio, "/api/setup", {
      method: "POST",
      origin: expectedOrigin(value.studio),
      body: { mode: "create", project_path: "/tmp/example-project", experiments: true }
    });
    assert.equal(setup.status, 200);
    assert.equal((setup.body as { ok: boolean }).ok, true);
    assert.equal((setup.body as { setup_required: boolean }).setup_required, false);
  } finally {
    await closeFixture(value);
  }
});

test("Studio applies exact origin and method policy while relaying only allowlisted tools", async () => {
  const value = await fixture();
  try {
    const foreign = await request(value.studio, "/api/status", { origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    const wrongToken = await request(value.studio, "/api/status", { token: "0".repeat(64) });
    assert.equal(wrongToken.status, 401);
    const wrongMethod = await request(value.studio, "/api/tools", {
      origin: expectedOrigin(value.studio),
      body: { name: "bridge_capabilities", arguments: {} }
    });
    assert.equal(wrongMethod.status, 405);
    const unknown = await request(value.studio, "/api/tools", {
      method: "POST",
      origin: expectedOrigin(value.studio),
      body: { name: "arbitrary_command", arguments: {} }
    });
    assert.equal(unknown.status, 400);
    const relayed = await request(value.studio, "/api/tools", {
      method: "POST",
      origin: expectedOrigin(value.studio),
      body: { name: "workspace_diagnostics", arguments: { workspace_id: workspaceId } }
    });
    assert.equal(relayed.status, 200);
    assert.deepEqual(relayed.body, {
      ok: true,
      name: "workspace_diagnostics",
      arguments: { workspace_id: workspaceId }
    });
    assert.deepEqual(value.calls, [{
      configPath: value.configPath,
      pluginRoot: value.temporary,
      name: "workspace_diagnostics",
      arguments: { workspace_id: workspaceId },
      readOnly: false
    }]);
  } finally {
    await closeFixture(value);
  }
});

test("research links are private, workspace-scoped, URL-validated, and clearable", async () => {
  const value = await fixture();
  try {
    const origin = expectedOrigin(value.studio);
    const initial = await request(value.studio, "/api/research", {
      method: "POST", origin,
      body: { action: "get", workspace_id: workspaceId }
    });
    assert.deepEqual(initial.body, { conversation_url: null });
    const saved = await request(value.studio, "/api/research", {
      method: "POST", origin,
      body: { action: "save", workspace_id: workspaceId, conversation_url: "https://chatgpt.com/c/example" }
    });
    assert.deepEqual(saved.body, { conversation_url: "https://chatgpt.com/c/example" });
    const linkPath = join(value.stack, "state", "studio-links", `${workspaceId}.json`);
    const linkInfo = await lstat(linkPath);
    assert.equal(linkInfo.isFile(), true);
    assert.equal(linkInfo.mode & 0o077, 0);
    assert.deepEqual(JSON.parse(await readFile(linkPath, "utf8")), {
      version: 1, workspace_id: workspaceId, conversation_url: "https://chatgpt.com/c/example"
    });
    const loaded = await request(value.studio, "/api/research", {
      method: "POST", origin,
      body: { action: "get", workspace_id: workspaceId }
    });
    assert.deepEqual(loaded.body, { conversation_url: "https://chatgpt.com/c/example" });
    const invalid = await request(value.studio, "/api/research", {
      method: "POST", origin,
      body: { action: "save", workspace_id: workspaceId, conversation_url: "https://evil.example/c/secret" }
    });
    assert.equal(invalid.status, 400);
    const cleared = await request(value.studio, "/api/research", {
      method: "POST", origin,
      body: { action: "save", workspace_id: workspaceId, conversation_url: "" }
    });
    assert.deepEqual(cleared.body, { conversation_url: null });
    await assert.rejects(lstat(linkPath), { code: "ENOENT" });
    const traversal = await request(value.studio, "/api/research", {
      method: "POST", origin,
      body: { action: "get", workspace_id: "../../etc/passwd" }
    });
    assert.equal(traversal.status, 400);
  } finally {
    await closeFixture(value);
  }
});

test("read-only Studio allows research reads and read-only tools only", async () => {
  const value = await fixture({ readOnly: true });
  try {
    const origin = expectedOrigin(value.studio);
    const save = await request(value.studio, "/api/research", {
      method: "POST", origin,
      body: { action: "save", workspace_id: workspaceId, conversation_url: "https://chatgpt.com/" }
    });
    assert.equal(save.status, 403);
    const setup = await request(value.studio, "/api/setup", {
      method: "POST", origin,
      body: { mode: "connect", config_path: value.configPath }
    });
    assert.equal(setup.status, 403);
    const writeTool = await request(value.studio, "/api/tools", {
      method: "POST", origin,
      body: { name: "collaboration_run", arguments: {} }
    });
    assert.equal(writeTool.status, 403);
    const readTool = await request(value.studio, "/api/tools", {
      method: "POST", origin,
      body: { name: "collaboration_history", arguments: { workspace_id: workspaceId } }
    });
    assert.equal(readTool.status, 200);
    assert.equal(value.calls.at(-1)?.readOnly, true);
  } finally {
    await closeFixture(value);
  }
});

test("authenticated API activity renews Studio's idle lifetime", async () => {
  const value = await fixture({ lifetimeMs: 300 });
  try {
    const origin = expectedOrigin(value.studio);
    // The first status arrives before the original 300 ms deadline. A fixed
    // wall-clock timer would close the server before the second status; an
    // idle timer renewed by the first request keeps it available.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await request(value.studio, "/api/status", { origin })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal((await request(value.studio, "/api/status", { origin })).status, 200);
  } finally {
    await closeFixture(value);
  }
});
