import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexProjectReferences } from
  "../../../src/workspaces/codex-project-references.js";
import { readCodexProjectReferences } from
  "../../../src/workspaces/codex-project-references.js";

test("parses only Codex projects sections without reading auth or unrelated configuration", () => {
  const source = `
model = "not-a-project"
[projects."/Users/example/Project A"]
trust_level = "trusted"

[projects.'/Users/example/Project B']
trust_level = 'untrusted'

[mcp_servers.bridge]
command = "node"
`;

  assert.deepEqual(parseCodexProjectReferences(source), [
    { path: "/Users/example/Project A", trustLevel: "trusted" },
    { path: "/Users/example/Project B", trustLevel: "untrusted" }
  ]);
});

test("dedicated parser ignores malformed project headers and preserves missing trust as evidence", () => {
  assert.deepEqual(parseCodexProjectReferences(`
[projects.bad]
trust_level = "trusted"
[projects."/valid/path"]
other = true
`), [{ path: "/valid/path" }]);
});

test("reader refuses auth.json and any non-config.toml source before reading it", async () => {
  await assert.rejects(readCodexProjectReferences("/private/tmp/auth.json"));
  await assert.rejects(readCodexProjectReferences("/private/tmp/projects.toml"));
});
