# Contributing

Engineering Bridge Studio combines Web planning with supervised local engineering and research execution. Keep changes focused on a real user workflow, with explicit execution boundaries and evidence that another person can inspect.

The shared runtime owns one configuration and registry. Each client has an independent MCP session. Preserve per-client read-only policy, reject recursive delegation from native executor children, and never evict a live owner to force an upgrade. Research execution is an explicit per-workspace opt-in with isolated writes, declared inputs/outputs, no network and a deadline. Source changes use the separate reviewed controlled-patch flow.

Contracts, execution results, artifacts and reviews persist. Do not confuse this history with older transient task supervision or a copied ChatGPT transcript. Scientific claims require independent evidence review. Do not invent successful experiments, citations or benchmark improvements.

The pinned Web companion keeps upstream browser authentication and provider route ownership. Changes to that integration require a fixed release digest, retained notices, installation tests and an actual account round trip. Fixture tests or browser-only mode do not establish full-mode tool execution.

Keep changes focused and include tests when behavior changes. Do not add machine-specific paths, credentials, secrets, or private integration details to source, fixtures, examples, documentation, commits, or issue reports.

Run the standard checks before submitting a change:

```sh
npm ci
npm run typecheck
npm test
npm run release:check
```

Describe what changed, why it is within the existing boundary, and which checks you ran. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
