# Upstream provenance

Engineering Bridge Studio is an independent distribution maintained under the `superorange0707/engineering-bridge-studio` repository. Its version is independent of either upstream.

| Component | Pinned source | Integration |
| --- | --- | --- |
| Bridge core baseline | `wudy29/engineering-bridge`, v1.2.1, `30e6b74b895d383ebf006e184a4b470c89020cf0` | MIT-derived source with workspace identity, native model routing, research contracts, artifact review, shared runtime and onboarding changes |
| Web model companion | `miuuyy/codex-chatgpt-web`, v5.0.6, `e85e3693fdb4e3e033348c08df0298c20fcdb612` | Official macOS Launcher archive, installed by a fixed SHA-256 lock; its browser, provider and authentication lifecycle remain upstream-owned. This is not a claim of Apple notarization or Developer ID signing. |

The Web assets and their digests live in `config/web-companion.lock.json`. Updates require changing that lock, checking the upstream release and licenses, running the installer tests, and repeating the real account acceptance. The installer does not follow `latest` or execute downloaded installer scripts.

The Bridge upstream had reached v1.4.4 (`636d3f135335a8a31835c1ae48acabd5cda66340`) when this integration was prepared. That line includes significant controlled-commit, validation and Windows changes which are not all part of this macOS distribution. It is kept as a separate upstream, with no forced update or publication to its repository. Protocol protections added here include bounded capability probing and JSONL frames, turn/thread completion checks, unsupported reverse-RPC rejection and child delegation prevention. These do not imply that every later upstream fix has been merged.

The original Bridge copyright remains in `LICENSE`. Web companion attribution and third-party notices are described in `THIRD_PARTY_NOTICES.md` and retained alongside the installed companion. No OpenAI, ChatGPT or upstream project endorsement is implied.
