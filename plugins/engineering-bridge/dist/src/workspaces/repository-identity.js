import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CoreError } from "../core/errors.js";
const execFileAsync = promisify(execFile);
export async function inspectWorkspace(path, readGit = runGit, canonicalize = realpath) {
    let root;
    try {
        root = await canonicalize(path);
    }
    catch {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    let localMetadataId;
    let stableObjectIdentity;
    try {
        const metadata = await stat(root, { bigint: true });
        if (!metadata.isDirectory())
            throw new Error("not a directory");
        localMetadataId = createHash("sha256").update(`${metadata.dev}:${metadata.ino}`).digest("hex");
        stableObjectIdentity = stableObjectIdentityFromStat(metadata);
    }
    catch {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const filesystem = filesystemIdentity(localMetadataId, stableObjectIdentity);
    try {
        const git = await inspectGitWorkspace(root, readGit, canonicalize);
        return { root, workspaceType: "git_workspace", filesystem, git };
    }
    catch {
        return { root, workspaceType: "directory_workspace", filesystem };
    }
}
export function filesystemIdentity(localMetadataId, stableObjectIdentity) {
    return {
        fingerprint: createHash("sha256").update(JSON.stringify({ localMetadataId })).digest("hex"),
        ...(localMetadataId === undefined ? {} : { localMetadataId }),
        ...(stableObjectIdentity === undefined ? {} : { stableObjectIdentity })
    };
}
export function isHighConfidenceFilesystemMatch(left, right) {
    if (left.stableObjectIdentity !== undefined || right.stableObjectIdentity !== undefined) {
        return left.stableObjectIdentity !== undefined && right.stableObjectIdentity !== undefined &&
            stableObjectIdentitiesMatch(left.stableObjectIdentity, right.stableObjectIdentity);
    }
    return left.localMetadataId !== undefined && left.localMetadataId === right.localMetadataId;
}
export async function inspectGitWorkspace(path, readGit = runGit, canonicalize = realpath) {
    let root;
    try {
        root = await canonicalize(path);
    }
    catch {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const topLevelOutput = await readGit(root, ["rev-parse", "--show-toplevel"])
        .catch(() => { throw new CoreError("WORKSPACE_PRECONDITION_FAILED"); });
    let gitTopLevel;
    try {
        gitTopLevel = await canonicalize(topLevelOutput.trim());
    }
    catch {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    if (!isWithin(gitTopLevel, root))
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const objectFormat = (await readGit(gitTopLevel, ["rev-parse", "--show-object-format"])
        .catch(() => "unknown")).trim() || "unknown";
    const rootCommits = sortedUnique(lines(await readGit(gitTopLevel, ["rev-list", "--max-parents=0", "HEAD"])
        .catch(() => "")));
    const remoteNames = sortedUnique(lines(await readGit(gitTopLevel, ["remote"]).catch(() => "")));
    const normalizedRemotes = [];
    for (const name of remoteNames) {
        const urls = lines(await readGit(gitTopLevel, ["remote", "get-url", "--all", name]).catch(() => ""));
        for (const url of urls)
            normalizedRemotes.push(normalizeGitRemote(url, gitTopLevel));
    }
    const commonDirOutput = (await readGit(gitTopLevel, ["rev-parse", "--git-common-dir"]).catch(() => "")).trim();
    let localMetadataId;
    let stableObjectIdentity;
    if (commonDirOutput !== "") {
        try {
            const commonDir = await canonicalize(isAbsolute(commonDirOutput)
                ? commonDirOutput
                : resolve(gitTopLevel, commonDirOutput));
            const metadata = await stat(commonDir, { bigint: true });
            localMetadataId = createHash("sha256").update(`${metadata.dev}:${metadata.ino}`).digest("hex");
            stableObjectIdentity = stableObjectIdentityFromStat(metadata);
        }
        catch {
            // Remote/root evidence can still identify committed repositories. An
            // unborn repository without any evidence remains deliberately unmatchable.
        }
    }
    const repository = repositoryIdentity(objectFormat, normalizedRemotes, rootCommits, localMetadataId, stableObjectIdentity);
    return {
        root,
        gitTopLevel,
        logicalRoot: relative(gitTopLevel, root) || ".",
        repository
    };
}
export function repositoryIdentity(objectFormat, normalizedRemotes, rootCommits, localMetadataId, stableObjectIdentity) {
    const remotes = sortedUnique(normalizedRemotes.filter(Boolean));
    const roots = sortedUnique(rootCommits.filter(Boolean));
    const payload = JSON.stringify({ objectFormat, normalizedRemotes: remotes, rootCommits: roots, localMetadataId });
    return {
        fingerprint: createHash("sha256").update(payload).digest("hex"),
        ...(localMetadataId === undefined ? {} : { localMetadataId }),
        ...(stableObjectIdentity === undefined ? {} : { stableObjectIdentity }),
        objectFormat,
        normalizedRemotes: remotes,
        rootCommits: roots
    };
}
export function isHighConfidenceRepositoryMatch(left, right) {
    if (left.objectFormat !== right.objectFormat)
        return false;
    if (left.stableObjectIdentity !== undefined || right.stableObjectIdentity !== undefined) {
        return left.stableObjectIdentity !== undefined && right.stableObjectIdentity !== undefined &&
            stableObjectIdentitiesMatch(left.stableObjectIdentity, right.stableObjectIdentity);
    }
    if (left.fingerprint === right.fingerprint && isMatchable(left))
        return true;
    return (left.localMetadataId !== undefined && left.localMetadataId === right.localMetadataId) ||
        (left.normalizedRemotes.length > 0 && arraysEqual(left.normalizedRemotes, right.normalizedRemotes));
}
export function isMatchable(identity) {
    return identity.stableObjectIdentity !== undefined || identity.localMetadataId !== undefined ||
        identity.normalizedRemotes.length > 0;
}
export function stableObjectIdentity(inode, birthtimeNs, deviceObservation) {
    const normalizedInode = String(inode);
    const normalizedBirthtimeNs = String(birthtimeNs);
    const normalizedDevice = String(deviceObservation);
    if (!/^[1-9][0-9]*$/.test(normalizedInode) || !/^[1-9][0-9]*$/.test(normalizedBirthtimeNs) ||
        !/^[0-9]+$/.test(normalizedDevice)) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const payload = JSON.stringify({ version: 2, inode: normalizedInode, birthtimeNs: normalizedBirthtimeNs });
    return {
        version: 2,
        id: createHash("sha256").update(payload).digest("hex"),
        inode: normalizedInode,
        birthtimeNs: normalizedBirthtimeNs,
        deviceObservation: normalizedDevice
    };
}
export function stableObjectIdentitiesMatch(left, right) {
    return left.version === 2 && right.version === 2 && left.id === right.id &&
        left.inode === right.inode && left.birthtimeNs === right.birthtimeNs;
}
function stableObjectIdentityFromStat(metadata) {
    return stableObjectIdentity(metadata.ino, metadata.birthtimeNs, metadata.dev);
}
export function normalizeGitRemote(value, relativeTo = process.cwd()) {
    const remote = value.trim();
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote);
    if (scp !== null && !remote.includes("://")) {
        return networkRemote(scp[1], scp[2]);
    }
    try {
        const url = new URL(remote);
        if (url.protocol === "file:")
            return localRemote(url.pathname, relativeTo);
        return networkRemote(`${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`, url.pathname);
    }
    catch {
        return localRemote(remote, relativeTo);
    }
}
export function isWithin(parent, child) {
    return child === parent || child.startsWith(`${parent}${sep}`);
}
function networkRemote(host, path) {
    const normalizedPath = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `${host.toLowerCase()}/${normalizedPath}`;
}
function localRemote(path, relativeTo) {
    const normalizedPath = isAbsolute(path) ? normalize(path) : resolve(relativeTo, path);
    return `local-sha256:${createHash("sha256").update(normalizedPath).digest("hex")}`;
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function lines(value) {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function sortedUnique(values) {
    return [...new Set(values)].sort();
}
async function runGit(cwd, args) {
    try {
        const result = await execFileAsync("git", args, {
            cwd,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" },
            maxBuffer: 1024 * 1024
        });
        return result.stdout;
    }
    catch {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
}
