# Maintainer validation for 2.0.0-beta.1

The checks below were performed on macOS on 12 September 2026. They distinguish local execution evidence from account-dependent Web setup.

## Real native execution and recovery

`node bin/collaboration-smoke.mjs --live` passed with Node.js 26.3.0 and Codex CLI 0.148.0. The recorded native executor was `gpt-5.6-luna` at `max` effort.

The experiment generated synthetic `y = 2x + 1 + noise`, fitted an intercept and slope using 64 training observations, and evaluated on 32 separate test observations per seed. The returned script was inspected: model fitting and the constant baseline use training data only.

| Seed | OLS test MSE | Training-mean test MSE |
| --- | ---: | ---: |
| 17 | 0.0044486167088177014 | 1.4601788554822916 |
| 29 | 0.0026819996662393827 | 1.2562479340330266 |
| 43 | 0.003707344781818408 | 1.4141660519340435 |

Both independent MCP sessions saw the same declared metrics and accepted review. The returned script was replayed independently through the Codex command sandbox; its metrics were byte-identical. The old shared owner exited, a different owner PID started, and the accepted run and artifact hash survived. The original `idea.md` input remained unchanged.

Metrics SHA-256: `733293f8557f7b101bb76a032fee0f936f494e6ae0f2b8abcc0ba8cc45c81c1f`.

This is an infrastructure check, not evidence of scientific novelty or a publishable research result. Exact floating-point output and the environment field can change with the Node environment; independent replay compares bytes within the same environment.

## Distribution checks

The plugin manifest and skill pass their validators. Release packaging checks required production files, version consistency and private material exclusions. A fresh private project can initialize and expose all nineteen tools. Companion installation checks the fixed upstream archive and license digests; installation status does not establish browser authentication or tool access.

The CI and release workflows run the complete automated suite with Node.js 22. CI covers macOS and Linux; the unified Launcher distribution is currently certified only for macOS. Tests for a historical, frozen production migration remain intentionally skipped without their original reviewed fixture.

## Account-dependent acceptance

The native execution test above uses two local MCP sessions. It does not certify ChatGPT Web model routing, a full-mode remote connector, or access to every ChatGPT product feature from Codex. Follow the two-entrance acceptance in [the installation guide](installation.md) after signing in through the Launcher. Browser-only login, a healthy port or a successful local test must not be reported as that full Web round trip.
