import { constants, accessSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { CoreError, serializeError } from "../core/errors.js";
import { resolveCommand } from "./command-resolution.js";
const ENVIRONMENT_ALLOWLIST = [
    "PATH",
    "HOME",
    "DSH_HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    // Sanctioned DSH passthroughs only. DEEPSEEK_API_KEY feeds DSH's native
    // credential layer and DSH_TOOLS_MODE is a profile-composition input; both
    // are consumed by the DSH main process and scrubbed from its model-callable
    // subprocesses. Proxies (which may embed credentials and are visible to
    // model subprocesses) and any other secret-like variables stay out.
    "DEEPSEEK_API_KEY",
    "DSH_TOOLS_MODE"
];
const MAX_OUTPUT_BYTES = 1_048_576;
const TRUNCATION_MARKER = "[output truncated]";
// npm target of the official DSH package, derived from a dsh.cmd shim's
// location so a Windows npm install can be launched through Node directly
// (never through a shell carrying the user-controlled instruction).
const DSH_NODE_TARGET = ["@deepseek-ai", "dsh", "lib", "bin.js"];
function failure(code) {
    return { kind: "failed", error: serializeError(new CoreError(code)) };
}
// Strictly decodes a truncated stdout prefix. The truncation boundary may cut a
// multi-byte UTF-8 code point, so up to 3 incomplete trailing bytes are dropped
// to find the longest strictly valid prefix. Genuinely invalid UTF-8 before the
// boundary still fails every attempt and yields undefined.
function decodeTruncatedPrefix(chunks) {
    const bytes = Buffer.concat(chunks);
    for (let drop = 0; drop <= 3; drop += 1) {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - drop));
        }
        catch {
            // Try the next shorter prefix.
        }
    }
    return undefined;
}
function environment(host) {
    const result = {};
    for (const key of ENVIRONMENT_ALLOWLIST)
        if (host[key])
            result[key] = host[key];
    // Bridge owns the read-only boundary for its run_task calls. The host value
    // is never forwarded (the allowlist drops it) and this constant override pins
    // DSH's per-invocation sandbox policy (`sandboxPolicy.mode` reads
    // `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`) to read-only for
    // this child process only. Global DSH config and the headless profile are
    // untouched.
    result.DSH_PERMISSION_MODE = "read-only";
    return result;
}
function executableOnPath(host) {
    for (const entry of host.PATH?.split(delimiter) ?? []) {
        if (!isAbsolute(entry))
            continue;
        const candidate = join(entry, "dsh");
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            // Continue to the next fixed PATH entry.
        }
    }
    return undefined;
}
function installedRcLauncher(host) {
    const home = host.DSH_HOME
        ? resolve(host.DSH_HOME)
        : host.HOME
            ? join(resolve(host.HOME), ".dsh")
            : undefined;
    if (!home)
        return undefined;
    const launcher = join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    try {
        return statSync(launcher).isFile() ? launcher : undefined;
    }
    catch {
        return undefined;
    }
}
function invocation(host) {
    const args = ["--profile", "headless"];
    const executable = executableOnPath(host);
    if (executable)
        return { executable, args };
    const launcher = installedRcLauncher(host);
    return launcher
        ? { executable: process.execPath, args: [launcher, ...args] }
        : { executable: "dsh", args };
}
export class DshExecutor {
    workspaceRoot;
    startProcess;
    hostEnvironment;
    platform;
    active;
    constructor(workspaceRoot, startProcess = spawn, hostEnvironment = process.env, platform = process.platform) {
        this.workspaceRoot = workspaceRoot;
        this.startProcess = startProcess;
        this.hostEnvironment = hostEnvironment;
        this.platform = platform;
    }
    invocation() {
        if (this.platform === "win32") {
            // Windows: prefer a directly spawnable dsh.exe; otherwise derive the npm
            // dsh.cmd shim's real Node target and launch it through Node directly, so
            // the user-controlled instruction travels as a plain argv element and is
            // never parsed by a shell. A shim without a derivable target fails closed
            // through the existing launcher/fallback chain (never through ComSpec).
            const resolved = resolveCommand(this.hostEnvironment, "dsh", {
                nodeTarget: DSH_NODE_TARGET, platform: this.platform
            });
            if (resolved.kind === "direct")
                return { executable: resolved.executable, args: ["--profile", "headless"] };
            if (resolved.kind === "node-launcher")
                return { executable: process.execPath, args: [resolved.scriptPath, "--profile", "headless"] };
            const launcher = installedRcLauncher(this.hostEnvironment);
            return launcher
                ? { executable: process.execPath, args: [launcher, "--profile", "headless"] }
                : { executable: "dsh", args: ["--profile", "headless"] };
        }
        // Non-Windows: the original resolution chain is unchanged.
        return invocation(this.hostEnvironment);
    }
    async execute(request) {
        const command = this.invocation();
        let child;
        try {
            child = this.startProcess(command.executable, [...command.args, request.instruction], {
                cwd: this.workspaceRoot,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
                env: environment(this.hostEnvironment)
            });
        }
        catch {
            return failure("DSH_UNAVAILABLE");
        }
        return new Promise((resolveResult) => {
            const chunks = [];
            let bytes = 0;
            let truncated = false;
            let settled = false;
            const active = { child, interrupted: false };
            this.active = active;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                if (this.active === active)
                    this.active = undefined;
                resolveResult(result);
            };
            const stop = (result) => {
                if (!child.killed)
                    child.kill();
                finish(result);
            };
            child.on("error", () => stop(failure("DSH_UNAVAILABLE")));
            child.stdin.on("error", () => stop(failure("DSH_UNAVAILABLE")));
            child.stdout.on("error", () => stop(failure("DSH_PROTOCOL_ERROR")));
            child.stderr.on("error", () => stop(failure("DSH_EXECUTION_FAILED")));
            child.stderr.resume();
            child.stdout.on("data", (chunk) => {
                if (truncated)
                    return;
                const remaining = MAX_OUTPUT_BYTES - bytes;
                if (chunk.length > remaining) {
                    // Only the first MAX_OUTPUT_BYTES are retained. Keep draining stdout
                    // so DSH can run to completion and exit on its own; never kill it
                    // for producing too much output.
                    truncated = true;
                    if (remaining > 0)
                        chunks.push(chunk.subarray(0, remaining));
                    bytes = MAX_OUTPUT_BYTES;
                    return;
                }
                bytes += chunk.length;
                chunks.push(chunk);
            });
            child.on("close", (code) => {
                if (settled)
                    return;
                if (active.interrupted) {
                    // An interrupt was actually triggered with SIGTERM: report the cached
                    // partial stdout regardless of the exit code.
                    finish({ kind: "interrupted", output: new TextDecoder("utf-8").decode(Buffer.concat(chunks)) });
                    return;
                }
                if (code !== 0) {
                    finish(failure("DSH_EXECUTION_FAILED"));
                    return;
                }
                if (bytes === 0) {
                    // The headless runner exits 0 whenever the final turn/end completed,
                    // even when the agent produced no non-empty assistant text. An empty
                    // stdout with exit 0 is therefore a legitimate empty completion, not
                    // a protocol error. Nonzero exits still fail above.
                    finish({ kind: "completed", output: "" });
                    return;
                }
                if (truncated) {
                    const prefix = decodeTruncatedPrefix(chunks);
                    finish(prefix === undefined
                        ? failure("DSH_PROTOCOL_ERROR")
                        : { kind: "completed", output: `${prefix}\n${TRUNCATION_MARKER}` });
                    return;
                }
                try {
                    const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
                    finish(output.endsWith("\n")
                        ? { kind: "completed", output: output.slice(0, -1) }
                        : { kind: "completed", output });
                }
                catch {
                    finish(failure("DSH_PROTOCOL_ERROR"));
                }
            });
            child.stdin.end();
        });
    }
    async interrupt() {
        const active = this.active;
        if (active === undefined)
            throw new CoreError("INVALID_STATE_TRANSITION");
        if (active.interrupted)
            return;
        if (!active.child.kill("SIGTERM"))
            throw new CoreError("INVALID_STATE_TRANSITION");
        active.interrupted = true;
    }
}
