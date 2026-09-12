# Install Engineering Bridge Studio

The unified beta supports macOS and Node.js 22+. Install Git and the Codex CLI, then sign in to Codex using its own supported login flow. You also need a ChatGPT account with the Web capabilities you intend to use.

## 1. Get the release

Download the release archive and its `SHA256SUMS` from this repository's Releases page. Verify the archive before extracting it:

```sh
shasum -a 256 -c SHA256SUMS
tar -xzf engineering-bridge-studio-2.0.0-beta.1.tar.gz
cd engineering-bridge-studio-2.0.0-beta.1
```

The extracted directory is a Codex marketplace containing `plugins/engineering-bridge`. It includes built Bridge code and production dependencies. Keep that directory in a stable location.

## 2. Connect your projects

For a new Bridge installation:

```sh
node plugins/engineering-bridge/bin/bridge.mjs init \
  --project /absolute/path/to/your-project --experiments
```

You can repeat `--project`. `--experiments` enables isolated code execution only for those projects. Omit it for a read-only starting point. The command creates private state under `~/.local/share/engineering-bridge` and a connection pointer under `~/.config/engineering-bridge`. It never replaces an existing configuration and does not enable source writes or scan all your projects.

For an existing Bridge installation:

```sh
node plugins/engineering-bridge/bin/bridge.mjs connect \
  --config /absolute/path/to/existing-stack/config/workspaces.json
```

The pointer refers to the same configuration and state. It does not copy your registry or experiment history. An explicit `ENGINEERING_BRIDGE_CONFIG` environment variable takes precedence over the pointer. The configuration file must be a private regular file owned by your user.

## 3. Install the plugin

From the extracted marketplace root:

```sh
codex plugin marketplace add "$PWD"
codex plugin add engineering-bridge@engineering-bridge-studio
```

Start a new Codex task to load the plugin's skills and tools. A running task does not automatically receive a refreshed tool inventory. The plugin launches a client of the shared local service. It can share the same configuration with the Web MCP tunnel.

When upgrading from the earlier single-owner STDIO implementation, finish or interrupt active work, stop the old Bridge owner, then start the new client once. New clients refuse to evict an older live owner. Keep the previous release directory available for rollback. Configuration or executable identity changes require a clean service restart; do not make a second configuration to bypass the owner check.

## 4. Add ChatGPT Web models

```sh
node plugins/engineering-bridge/bin/bridge.mjs web install
node plugins/engineering-bridge/bin/bridge.mjs web launch
```

The installer downloads the official codex-chatgpt-web v5.0.6 Launcher for your Mac architecture and checks its fixed SHA-256. It preserves upstream attribution and the app bundle. It does not change the Codex provider or import credentials as an installation side effect. If it replaces an existing verified installation, it retains that directory as a backup and reports its path; user-added files are not deleted with the old installation.

In the Launcher, sign in to ChatGPT and follow its setup interface. Full local-tool use needs the upstream full-mode remote connector setup; browser-only mode cannot execute your local tools. Complete its notice and route connection controls deliberately. A Web model selection should appear in a new Codex task after setup; existing tasks retain their original protocol/model context.

ChatGPT browser conversations can also call Bridge through a separately authenticated Web MCP tunnel pointed at this release's `dist/src/mcp-stdio.js` and the same configuration path. The Launcher-owned connector and a Bridge Web connector have different roles. Do not repoint an existing authenticated tunnel at a different protocol or copy its runtime key into a release package.

## 5. Verify the actual collaboration

```sh
node plugins/engineering-bridge/bin/bridge.mjs doctor --json
node plugins/engineering-bridge/bin/bridge.mjs web status --json
```

These checks report configuration and installation facts. They do not certify login, Web routing, full-mode tool access or scientific correctness.

Use this acceptance sequence in your own account:

1. From the Codex plugin, call `bridge_capabilities` and resolve the selected project through `workspace_diagnostics`.
2. From ChatGPT Web or a Web-model Codex task, submit a tiny research contract using `collaboration_run`. Include baseline, data split, seed, metric and declared output files.
3. Wait for `collaboration_result`. Verify the recorded executor is the configured native Codex role, and read the real script, metrics and log through `collaboration_artifact`, following every page until EOF.
4. Read that same run ID from the other entrance. Record an evidence-based `collaboration_review` and verify both entrances see it.
5. Restart the Bridge service after work is terminal and verify the same run, artifact hashes and review remain.
6. Disconnect the Web route using the Launcher and verify ordinary native Codex still works.

Do not describe a browser-only installation or simulated developer harness as passing this acceptance.

## Upgrade and removal

For an upgrade, unpack and verify the new release in a new directory, reuse the connection pointer and reinstall the plugin from its marketplace. Do not delete the old release while an owner process is running from it.

Remove the Codex plugin through the Codex plugin UI or its supported CLI. Disconnect the Web provider route through the Launcher before removing that companion. Keep Bridge state if you want to preserve experiments and reviews. Deleting state is separate from uninstalling the plugin; this distribution does not automatically delete projects, research artifacts, user credentials or browser profiles.
