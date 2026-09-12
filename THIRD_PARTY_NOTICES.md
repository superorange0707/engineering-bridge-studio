# Web companion notices

Engineering Bridge can install the upstream `codex-chatgpt-web` v5.0.6 macOS
launcher as a separate companion. The companion is not rebuilt, re-signed, or
merged into the Bridge MCP process. The installer keeps the upstream release
files in the installed version directory under `third-party/`.

Upstream source and release:

- Repository: <https://github.com/miuuyy/codex-chatgpt-web>
- Release: `v5.0.6`
- Pinned source commit: `e85e3693fdb4e3e033348c08df0298c20fcdb612`
- License: MIT, copyright `2026 codex-chatgpt-web contributors`
- Release checksums: <https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.6/checksums.txt>

The fixed companion lock records the SHA-256 values for both macOS launcher
archives and for the upstream notices. The installer verifies those bytes
before extraction and copies these files into the product directory:

- `LICENSE`
- `THIRD_PARTY_NOTICES.txt`
- `Bun-1.4.0.md`
- `libnotify-0.8.7-LGPL-2.1.md`

The upstream MIT license text is reproduced below to preserve the attribution
when this notice is distributed with Engineering Bridge:

```text
MIT License

Copyright (c) 2026 codex-chatgpt-web contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`THIRD_PARTY_NOTICES.txt` and the Bun/libnotify license documents remain the
authoritative complete notices for the published companion runtime.

For an offline install from a previously downloaded launcher archive, pass
`--notices-dir` containing those four exact release files. The installer
verifies each file against the pinned size and SHA-256 before copying it into
the installed companion. The launcher archive does not contain the generated
release notice bundle, so the short reference document in this repository is
not used as a substitute for those files.
