import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { createStudioPlugin } = await import(pathToFileURL(join(process.cwd(), "bin/studio-mcp.mjs")).href);

test("a fresh plugin opens setup and discovers runtime tools after setup without restarting", async () => {
  let configured = false;
  let connections = 0;
  let closes = 0;
  const calls: unknown[] = [];
  const plugin = createStudioPlugin({
    resolveConfig: async () => "/test/bridge/config.json",
    readConfig: async () => {
      if (!configured) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { version: 3, workspaces: [] };
    },
    openStudio: async () => ({ url: "http://127.0.0.1:4000/#token=test", pid: 100 }),
    connect: async () => {
      connections++;
      return {
        client: {
          listTools: async () => ({ tools: [{ name: "collaboration_history", description: "History", inputSchema: { type: "object" } }] }),
          callTool: async (input: unknown) => {
            calls.push(input);
            return { content: [{ type: "text", text: '{"items":[]}' }] };
          }
        },
        close: async () => { closes++; }
      };
    }
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["bridge_studio", "bridge_setup_status"]);
    const opened = await client.callTool({ name: "bridge_studio", arguments: {} });
    assert.equal(opened.isError, undefined);
    assert.equal(connections, 0);
    assert.equal(calls.length, 0);
    configured = true;
    const status = await client.callTool({ name: "bridge_setup_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["bridge_studio", "bridge_setup_status", "collaboration_history"]);
    await client.callTool({ name: "collaboration_history", arguments: { workspace_id: "selected-project", limit: 1 } });
    assert.equal(connections, 1);
    assert.deepEqual(calls, [{ name: "collaboration_history", arguments: { workspace_id: "selected-project", limit: 1 } }]);
    assert.equal((await client.callTool({ name: "arbitrary_command", arguments: {} })).isError, true);
  } finally {
    await plugin.close();
    await client.close();
  }
  assert.equal(closes, 1);
});

test("runtime errors leave Studio available and are not reported as successful setup", async () => {
  const plugin = createStudioPlugin({
    resolveConfig: async () => "/test/config.json",
    readConfig: async () => ({ version: 3, workspaces: [] }),
    connect: async () => { throw new Error("runtime needs restart"); },
    openStudio: async () => ({ url: "http://127.0.0.1:4001/#token=test", pid: 101 })
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.equal((await client.listTools()).tools.length, 2);
    const result = await client.callTool({ name: "bridge_setup_status", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.deepEqual(JSON.parse(text).configured, false);
    assert.match(text, /runtime needs restart/);
    assert.equal((await client.callTool({ name: "bridge_studio", arguments: {} })).isError, undefined);
  } finally { await plugin.close(); await client.close(); }
});

test("a failed runtime call is not replayed and the next call reconnects", async () => {
  let connections = 0;
  let mutations = 0;
  let closes = 0;
  const plugin = createStudioPlugin({
    resolveConfig: async () => "/test/config.json",
    readConfig: async () => ({ version: 3, workspaces: [] }),
    connect: async () => {
      const connection = ++connections;
      return {
        client: {
          listTools: async () => ({ tools: [{ name: "collaboration_run", inputSchema: { type: "object" } }] }),
          callTool: async () => {
            mutations++;
            if (connection === 1) throw new Error("runtime disconnected after accepting the request");
            return { content: [{ type: "text", text: JSON.stringify({ state: "accepted", connection }) }] };
          }
        },
        close: async () => { closes++; }
      };
    }
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const first = await client.callTool({ name: "collaboration_run", arguments: { request_id: "first" } });
    assert.equal(first.isError, true);
    assert.equal(connections, 1);
    assert.equal(mutations, 1);
    const firstText = (first.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.match(firstText, /runtime disconnected/u);

    const second = await client.callTool({ name: "collaboration_run", arguments: { request_id: "second" } });
    assert.equal(second.isError, undefined);
    assert.equal(connections, 2);
    assert.equal(mutations, 2);
    const secondText = (second.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.deepEqual(JSON.parse(secondText), { state: "accepted", connection: 2 });
    assert.equal(closes, 1);
  } finally {
    await plugin.close();
    await client.close();
  }
});

test("a transport close drops the active runtime before the next request", async () => {
  let connections = 0;
  let notifyClose: (() => void) | undefined;
  const plugin = createStudioPlugin({
    resolveConfig: async () => "/test/config.json",
    readConfig: async () => ({ version: 3, workspaces: [] }),
    connect: async () => {
      const connection = ++connections;
      const client = {
        listTools: async () => ({ tools: [{ name: "bridge_capabilities", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ connection }) }] }),
        onclose: undefined as (() => void) | undefined
      };
      notifyClose = () => client.onclose?.();
      return { client, close: async () => {} };
    }
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const first = await client.callTool({ name: "bridge_capabilities", arguments: {} });
    assert.equal(first.isError, undefined);
    assert.equal(connections, 1);
    notifyClose?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await client.callTool({ name: "bridge_capabilities", arguments: {} });
    assert.equal(second.isError, undefined);
    assert.equal(connections, 2);
  } finally {
    await plugin.close();
    await client.close();
  }
});

test("a hung runtime handshake returns a bounded error", async () => {
  let connections = 0;
  const plugin = createStudioPlugin({
    resolveConfig: async () => "/test/config.json",
    readConfig: async () => ({ version: 3, workspaces: [] }),
    connectTimeoutMs: 25,
    connect: async () => {
      connections++;
      return await new Promise<never>(() => {});
    }
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const started = Date.now();
    const result = await client.callTool({ name: "bridge_capabilities", arguments: {} });
    const elapsed = Date.now() - started;
    assert.equal(result.isError, true);
    assert.equal(connections, 1);
    assert.ok(elapsed < 1_000, `handshake took ${elapsed}ms`);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.match(text, /connection timed out/u);
  } finally {
    await plugin.close();
    await client.close();
  }
});
