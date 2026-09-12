# Engineering Bridge Studio

**Plan with ChatGPT Web. Build and experiment with Codex. Keep the work connected.**

[中文说明](README.zh-CN.md) · [Installation guide](docs/installation.md) · [Research workflow](docs/research-workflow.md) · [Upstream provenance](docs/upstreams.md)

## Install

Available for macOS. Install Node.js 22+, Git and the Codex CLI, then sign in to Codex.

```sh
curl -fsSL https://raw.githubusercontent.com/superorange0707/engineering-bridge-studio/main/install.mjs | node --input-type=module -
```

The installer downloads the release, checks its SHA-256 and installs the plugin in Codex. Restart the app, open **Plugins → Installed**, and look for **Engineering Bridge Studio**. The [installation guide](docs/installation.md) covers choosing a project and connecting ChatGPT Web.

The plugin is available through this installer and [GitHub Releases](https://github.com/superorange0707/engineering-bridge-studio/releases). Public Codex directory review is a separate publishing step.

## How it works

Engineering Bridge Studio connects ChatGPT Web planning with local native Codex execution around one project.

- **You** set the idea, product goal, research question and final decisions.
- **ChatGPT Web** researches the field, shapes hypotheses and experiments, builds outlines, writes papers and reviews results.
- **Native Codex** writes code, runs experiments and produces files, metrics and logs.
- **Bridge** keeps the project, experiment plan, results and reviews together across conversations.

A paper can follow the same loop as a product: define a question, run a small verifiable round, inspect what actually happened, then decide what to build or write next.

## The loop

1. Start with an idea and a concrete question.
2. ChatGPT Web turns it into a plan, including the baseline, data, metrics and experiment steps.
3. Codex runs the work locally and returns the script, results and logs.
4. ChatGPT Web reviews the results and develops the next experiment or paper section.
5. Pick up the same project in another conversation and continue from its last review.

Open the same project from ChatGPT Web or Codex. Both entrances connect to the same Bridge service and see the same experiments, files and reviews.

## Development

```bash
git clone https://github.com/superorange0707/engineering-bridge-studio.git
cd engineering-bridge-studio
npm ci
npm test
node bin/bridge.mjs --help
```

## Credits

This distribution builds on [Engineering Bridge](https://github.com/wudy29/engineering-bridge) and the [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) companion. The pinned revisions and license notices are listed in [docs/upstreams.md](docs/upstreams.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

For development and security reporting, see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
