import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
const WINDOWS_PATH_DELIMITER = ";";
const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const REAL_EXECUTABLE_EXTS = new Set([".COM", ".EXE"]);
const SHIM_EXTS = new Set([".BAT", ".CMD"]);
export function resolveCommand(host, command, options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32")
        return { kind: "bare" };
    if (!/^[A-Za-z0-9._-]+$/u.test(command))
        return { kind: "bare" };
    // Real executables first, across the whole PATH.
    const direct = findInPath(host, command, (ext) => REAL_EXECUTABLE_EXTS.has(ext));
    if (direct !== undefined)
        return { kind: "direct", executable: direct };
    // Then .cmd/.bat shims, across the whole PATH. A shim is only usable when
    // its real Node target can be derived; without nodeTarget (or when the
    // target is missing) there is no shell-free way to launch it, so resolution
    // fails closed as bare.
    const shim = findInPath(host, command, (ext) => SHIM_EXTS.has(ext));
    if (shim === undefined || options.nodeTarget === undefined)
        return { kind: "bare" };
    const scriptPath = npmShimTarget(shim, options.nodeTarget);
    return scriptPath === undefined ? { kind: "bare" } : { kind: "node-launcher", scriptPath };
}
function findInPath(host, command, allowed) {
    const pathValue = envValue(host, "PATH");
    if (pathValue === undefined)
        return undefined;
    const extensions = pathExtensions(host);
    for (const entry of pathValue.split(WINDOWS_PATH_DELIMITER)) {
        if (!isAbsolute(entry))
            continue;
        for (const extension of extensions) {
            if (!allowed(extension))
                continue;
            // Windows filesystem lookup is case-insensitive; the directory scan
            // mirrors that and returns the on-disk casing.
            const candidate = findCaseInsensitive(entry, `${command}${extension}`);
            if (candidate !== undefined && isFile(candidate))
                return candidate;
        }
    }
    return undefined;
}
function findCaseInsensitive(directory, name) {
    let entries;
    try {
        entries = readdirSync(directory);
    }
    catch {
        return undefined;
    }
    const wanted = name.toLowerCase();
    const hit = entries.find((entry) => entry.toLowerCase() === wanted);
    return hit === undefined ? undefined : join(directory, hit);
}
function pathExtensions(host) {
    const raw = envValue(host, "PATHEXT");
    const entries = (raw ?? DEFAULT_WINDOWS_PATHEXT.join(WINDOWS_PATH_DELIMITER))
        .split(WINDOWS_PATH_DELIMITER)
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry) => entry !== "");
    if (entries.length === 0)
        return DEFAULT_WINDOWS_PATHEXT;
    return entries.map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
}
function npmShimTarget(shimPath, nodeTarget) {
    const shimDir = dirname(shimPath);
    for (const candidate of [
        join(shimDir, "node_modules", ...nodeTarget),
        join(shimDir, "..", ...nodeTarget)
    ]) {
        if (isFile(candidate))
            return candidate;
    }
    return undefined;
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function envValue(host, key) {
    const needle = key.toLowerCase();
    for (const name of Object.keys(host)) {
        if (name.toLowerCase() !== needle)
            continue;
        const value = host[name];
        return typeof value === "string" && value !== "" ? value : undefined;
    }
    return undefined;
}
