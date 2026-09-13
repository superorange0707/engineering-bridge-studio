# Install Engineering Bridge Studio

Engineering Bridge Studio gives ChatGPT Web a local native Codex workspace for planning, writing, engineering work and research experiments.

[中文说明](../README.zh-CN.md) · [Research workflow](research-workflow.md) · [Upstream provenance](upstreams.md)

## Requirements

The unified beta currently supports macOS. Install Node.js 22+, Git and the Codex CLI, then sign in to Codex through its supported login flow. Web planning and the Web companion also require access to the ChatGPT account and workspace you intend to use.

## 1. Install and open Studio

Run the release installer:

```sh
curl -fsSL https://raw.githubusercontent.com/superorange0707/engineering-bridge-studio/main/install.mjs | node --input-type=module -
```

The installer downloads the release, verifies it, installs the plugin and opens Studio's setup screen. In Codex, ask **“Open Engineering Bridge Studio”**, or use the opening prompt on its plugin card, to show Studio in the current task's browser panel. Restart Codex once if the newly installed plugin is not visible.

You can also install directly through Codex's marketplace commands:

```sh
codex plugin marketplace add superorange0707/engineering-bridge-studio --ref marketplace
codex plugin add engineering-bridge@engineering-bridge-studio
```

This repository's `marketplace` branch contains the ready-to-run plugin, including its runtime dependencies. After installation, open the plugin and choose **Open Engineering Bridge Studio**. The public directory listing is a separate step.

## 2. Finish setup on screen

1. Choose **New setup**, enter your project directory, and enable **Run isolated experiments** if you want Codex to execute plans for this project. Choose **Connect existing** to reuse a Bridge configuration and its history.
2. Select the project in Studio. **Research** keeps its ChatGPT conversation link and prepares a project brief. **Experiments** shows plans, progress, results and reviews.
3. Open ChatGPT from the Research view and sign in. Use its project brief to begin the discussion. Configure a Bridge connector using the Web setup below when you want ChatGPT to call the project tools directly.

Project setup works before any Bridge tools are configured. After finishing, ask Codex to refresh Bridge setup; the plugin activates the project tools in that session. Only the selected project's experiment history is loaded.

## 3. Use the workspace

- **Research:** save the conversation URL, copy a brief, and open ChatGPT in a browser tab.
- **New experiment:** enter the objective, steps, expected files and acceptance criteria. Research experiments also include the hypothesis, baselines, data split, seeds, metrics and protocol.
- **Runs:** follow progress, inspect the recorded output, download verified artifacts, or stop an active run.
- **Review:** accept, request a revision or reject a completed run with feedback. Copy the result handoff back into the research conversation.

ChatGPT and Studio are separate browser tabs. Once connected through Bridge, ChatGPT can submit plans and read the same results directly. The copy actions provide a manual handoff as well. Studio does not present an installed companion or saved conversation URL as a verified Web connection.

<details>
<summary>Command-line project setup</summary>

The release installer keeps the plugin at:

```text
~/.local/share/engineering-bridge-studio/releases/engineering-bridge-studio-2.0.0-beta.2/plugins/engineering-bridge
```

Set the installed plugin path for the commands below:

```sh
export BRIDGE_PLUGIN="$HOME/.local/share/engineering-bridge-studio/releases/engineering-bridge-studio-2.0.0-beta.2/plugins/engineering-bridge"
```

For a new local Bridge stack, name the project explicitly. Add `--experiments` when this project should run isolated engineering or research collaboration runs:

```sh
node "$BRIDGE_PLUGIN/bin/bridge.mjs" init \
  --project /absolute/path/to/your-project \
  --experiments
```

For an existing Bridge stack, point the plugin at its existing configuration:

```sh
node "$BRIDGE_PLUGIN/bin/bridge.mjs" connect \
  --config /absolute/path/to/existing-stack/config/workspaces.json
```

`init` creates private state under `~/.local/share/engineering-bridge` and a connection pointer under `~/.config/engineering-bridge`. `connect` reuses the selected stack and its history. Both commands require an explicit project or configuration path; neither scans or configures projects automatically.

Start a new Codex task after connecting. Multiple Codex clients and the Web MCP connection share one local Bridge service for the same configuration, while each MCP connection keeps its own session.

To open Studio from the command line, run `node "$BRIDGE_PLUGIN/bin/bridge.mjs" open`. Add `--json` to obtain its URL without opening a browser.

</details>

## Web setup: use ChatGPT Web models inside Codex

In Studio, choose **Install Web companion**, then **Open Launcher**. You can also use these commands:

```sh
node "$BRIDGE_PLUGIN/bin/bridge.mjs" web install
node "$BRIDGE_PLUGIN/bin/bridge.mjs" web launch
```

The command installs the pinned `codex-chatgpt-web` v5.0.6 macOS Launcher and preserves its upstream notices. Complete the rest in the Launcher:

1. Sign in to ChatGPT, run the browser smoke test, choose **Install models**, then restart Codex and confirm a **ChatGPT Web** model appears.
2. On the Launcher's **MCP** page, create a separate Tunnel and runtime API key in your own OpenAI account. Enter them in the Launcher and select **Connect harness**.
3. In ChatGPT developer-mode app settings, create a Tunnel connector for that tunnel named **Codex Native2**. The pinned harness setup uses **Authentication: None** and **Allow all actions**; review the tools and your account or workspace policy before saving.
4. Run **Verify runtime** in the Launcher. Start a new Codex task with a Web model and the Engineering Bridge plugin enabled.

The [pinned full-harness guide](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/README.md#full-harness) and [walkthroughs](https://github.com/miuuyy/codex-chatgpt-web/blob/e85e3693fdb4e3e033348c08df0298c20fcdb612/TROUBLESHOOTING.md) cover the Launcher controls. For account requirements, see [OpenAI's developer-mode documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

## Optional: connect ordinary ChatGPT browser conversations directly

This route uses an OpenAI tunnel-client profile instead of the Launcher full harness. It needs access to [OpenAI Tunnels](https://platform.openai.com/settings/organization/tunnels) and a runtime key in your own account.

```sh
brew install openai/tools/tunnel-client
tunnel-client help quickstart
```

Create a profile with your own tunnel ID and absolute paths. Replace every placeholder; the MCP command must point to this release and the same `workspaces.json` used above:

```sh
tunnel-client init --sample sample_mcp_stdio_local \
  --profile engineering-bridge-studio \
  --tunnel-id YOUR_TUNNEL_ID \
  --health-listen-addr 127.0.0.1:8081 \
  --mcp-command '/absolute/path/to/node /absolute/path/to/plugins/engineering-bridge/dist/src/mcp-stdio.js /absolute/path/to/stack/config/workspaces.json'
tunnel-client doctor --profile engineering-bridge-studio --explain
tunnel-client run --profile engineering-bridge-studio
```

Provide `CONTROL_PLANE_API_KEY` through the private runtime environment. Keep the profile process running while ChatGPT discovers the connector, then select the same tunnel in [ChatGPT app settings](https://chatgpt.com/#settings/Connectors). Scan its tools, call `bridge_capabilities`, and run one small collaboration round. Use one tunnel-client instance per tunnel ID. See the [official tunnel-client setup](https://github.com/openai/tunnel-client#install-with-homebrew) for managed runtime operation.

## Verify both entrances

Local checks:

```sh
node "$BRIDGE_PLUGIN/bin/bridge.mjs" doctor --json
node "$BRIDGE_PLUGIN/bin/bridge.mjs" web status --json
```

Then verify the actual Web-to-Codex loop:

1. From the Codex plugin, call `bridge_capabilities` and resolve the selected project with `workspace_diagnostics`.
2. From ChatGPT Web or a Web-model Codex task, submit a small `collaboration_run` with a baseline, data split, seed, metric and declared output files.
3. Read the returned script, metrics and log through `collaboration_artifact`, following every page to EOF and checking the recorded hashes.
4. Read the same run from the other entrance and save an evidence-based `collaboration_review`.
5. After the run is terminal, restart the Bridge owner and verify the run, artifact hashes and review are still present.

`awaiting_review` means that execution returned and the evidence is ready for Web review. The review records the decision about the run; scientific conclusions follow from that evidence and review.

## Upgrade

Install a new release beside the current one and keep the previous release directory until the upgrade is accepted. Finish or interrupt active work, stop the old Bridge owner, restart the app and then start a client from the new release. A new client does not evict a live owner. Configuration or executable identity changes also require a clean service restart.

## Public Codex directory

Engineering Bridge Studio is distributed through this installer and GitHub Releases. It has not been submitted to the public Codex directory. Public listing uses [OpenAI's review process](https://developers.openai.com/plugins/deploy/submission); local MCP plugins also need a supported submission route.

<details>
<summary>Optional manual archive installation</summary>

Download the release archive and `SHA256SUMS` from [GitHub Releases](https://github.com/superorange0707/engineering-bridge-studio/releases), verify the archive, and extract it into the stable release directory:

```sh
shasum -a 256 -c SHA256SUMS
mkdir -p "$HOME/.local/share/engineering-bridge-studio/releases"
tar -xzf engineering-bridge-studio-2.0.0-beta.2.tar.gz \
  -C "$HOME/.local/share/engineering-bridge-studio/releases"
cd "$HOME/.local/share/engineering-bridge-studio/releases/engineering-bridge-studio-2.0.0-beta.2"
codex plugin marketplace add "$PWD"
codex plugin add engineering-bridge@engineering-bridge-studio
```

Restart Codex, then continue with [Choose a project](#2-choose-a-project).

</details>
