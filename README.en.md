# Engineering Bridge Studio

**Bring an idea. Plan and write with ChatGPT Web. Execute with native Codex. Review the evidence through Bridge.**

[中文](README.md) · [Installation](docs/installation.md) · [Research workflow](docs/chatgpt-codex-workflow.md) · [Upstream provenance](docs/upstreams.md)

This open-source distribution combines Engineering Bridge with a pinned codex-chatgpt-web companion. The first unified release is **2.0.0-beta.1 for macOS**. A shared local Bridge service owns workspace and experiment state; each Codex or authenticated Web MCP connection has its own session.

The user supplies ideas and makes final decisions. ChatGPT Web develops research questions, hypotheses, experiments, outlines and prose. Native Codex writes and runs code in an isolated run directory. Bridge preserves contracts, execution results, declared artifacts and evidence-based reviews across restarts. New experiments can link to earlier runs.

## Get started

Install Node.js 22+, Git and an authenticated Codex CLI. Download and verify the release archive, then follow [the installation guide](docs/installation.md). The archive includes the Bridge plugin, runtime and production dependencies. Its unified CLI installs a fixed, SHA-256-verified Web Launcher release.

For source development:

```sh
git clone https://github.com/superorange0707/engineering-bridge-studio.git
cd engineering-bridge-studio
npm ci
npm test
node bin/bridge.mjs --help
```

Use `connect` to reuse an existing Bridge configuration and its history. Use `init --project /absolute/project --experiments` to explicitly opt a new project into isolated execution. Source writes remain disabled unless separately authorized.

## Product boundaries

Research contracts require a hypothesis, baselines, data splits, seeds, metrics and protocol. Execution is local, deadline-bound and network-disabled. Read actual artifacts and record a review before using their results in writing. Successful execution and hashes are not scientific validation.

The Web companion owns ChatGPT login, its browser profile, provider routing and remote tool connection. This does not embed the entire ChatGPT product or guarantee access to Projects, Canvas or Deep Research. A `doctor` result is not a live Web acceptance test; complete the round trip described in the installation guide.

The distribution is based on Engineering Bridge v1.2.1 and codex-chatgpt-web v5.0.6. It has an independent release line and does not claim all upstream v1.4.4 controlled-commit or Windows features. Both upstream MIT licenses and additional notices are retained. See [provenance](docs/upstreams.md), [contribution guidance](CONTRIBUTING.md) and [security](SECURITY.md).
