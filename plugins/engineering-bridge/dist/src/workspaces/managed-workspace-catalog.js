import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { CoreError } from "../core/errors.js";
import { isId, newId } from "../core/ids.js";
import { applyControlPlaneRegistryWrite } from "./control-plane-transaction.js";
import { filesystemIdentity, isHighConfidenceFilesystemMatch, isHighConfidenceRepositoryMatch, repositoryIdentity, stableObjectIdentity } from "./repository-identity.js";
const MANAGED_WORKSPACES_VERSION = 3;
export class ManagedWorkspaceCatalog {
    stateFilePath;
    projectStateRoot;
    records = new Map();
    roots = new Map();
    mutationQueue = Promise.resolve();
    writeSequence = 0;
    constructor(stateFilePath, projectStateRoot) {
        this.stateFilePath = stateFilePath;
        this.projectStateRoot = projectStateRoot;
    }
    async load() {
        if (this.stateFilePath === undefined)
            return;
        if (this.records.size !== 0)
            throw new CoreError("INTERNAL_ERROR");
        let source;
        try {
            source = await readFile(this.stateFilePath, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw new CoreError("INTERNAL_ERROR");
        }
        let value;
        try {
            value = JSON.parse(source);
        }
        catch {
            throw new CoreError("INTERNAL_ERROR");
        }
        if (!isObject(value) || !Array.isArray(value.workspaces) ||
            (value.version !== 1 && value.version !== 2 && value.version !== MANAGED_WORKSPACES_VERSION)) {
            throw new CoreError("INTERNAL_ERROR");
        }
        for (const item of value.workspaces) {
            const record = value.version === 1
                ? parseLegacyRecord(item)
                : value.version === 2 ? parseV2IdentityRecord(item) : parseIdentityRecord(item);
            if (record === undefined || this.records.has(record.id) || this.roots.has(record.root))
                continue;
            this.records.set(record.id, record);
            this.roots.set(record.root, record.id);
        }
    }
    entries() {
        return [...this.records.values()].map(({ id, root, allowWrite }) => ({ id, root, allowWrite }));
    }
    identityEntries() {
        return [...this.records.values()];
    }
    get(workspaceId) {
        return this.records.get(workspaceId);
    }
    registerOnce(root, identity) {
        return this.mutate(async () => {
            const existingId = this.roots.get(root);
            if (existingId !== undefined) {
                const existing = this.records.get(existingId);
                if (identity?.id !== undefined && identity.id !== existingId) {
                    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
                }
                if (identity?.source === "approved" && !sameApprovedIdentity(existing, buildRecord(root, identity))) {
                    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
                }
                return { id: existingId, created: false };
            }
            const record = buildRecord(root, identity);
            const existing = this.records.get(record.id);
            if (existing !== undefined) {
                if (sameApprovedIdentity(existing, record))
                    return { id: record.id, created: false };
                throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
            }
            const snapshot = this.snapshot();
            this.records.set(record.id, record);
            this.roots.set(record.root, record.id);
            try {
                await this.persist();
            }
            catch {
                this.restore(snapshot);
                throw new CoreError("INTERNAL_ERROR");
            }
            return { id: record.id, created: true };
        });
    }
    rebind(workspaceId, root, identity) {
        return this.mutate(async () => {
            const existing = this.records.get(workspaceId);
            if (existing === undefined)
                throw new CoreError("UNKNOWN_WORKSPACE");
            const occupied = this.roots.get(root);
            if (occupied !== undefined && occupied !== workspaceId) {
                throw new CoreError("WORKSPACE_IDENTITY_AMBIGUOUS");
            }
            const candidate = buildRecord(root, { ...identity, id: existing.id });
            const replacement = {
                ...candidate,
                displayName: existing.displayName,
                aliases: sortedUnique([...existing.aliases, ...candidate.aliases]),
                codexProjectReferences: sortedUnique([
                    ...existing.codexProjectReferences,
                    ...candidate.codexProjectReferences
                ]),
                previousPaths: root === existing.root
                    ? existing.previousPaths
                    : sortedUnique([...existing.previousPaths, existing.root]),
                allowWrite: existing.allowWrite,
                source: existing.source
            };
            validateRecord(replacement);
            const snapshot = this.snapshot();
            this.roots.delete(existing.root);
            this.roots.set(root, workspaceId);
            this.records.set(workspaceId, replacement);
            try {
                await this.persist();
            }
            catch {
                this.restore(snapshot);
                throw new CoreError("INTERNAL_ERROR");
            }
            return replacement;
        });
    }
    // Grants persistent controlled-patch APPLY eligibility to one managed workspace.
    authorize(root) {
        return this.mutate(async () => {
            const id = this.roots.get(root);
            const record = id === undefined ? undefined : this.records.get(id);
            if (record === undefined || record.source !== "managed")
                throw new CoreError("INTERNAL_ERROR");
            if (record.allowWrite)
                return;
            const snapshot = this.snapshot();
            this.records.set(record.id, { ...record, allowWrite: true });
            try {
                await this.persist();
            }
            catch {
                this.restore(snapshot);
                throw new CoreError("INTERNAL_ERROR");
            }
        });
    }
    mutate(operation) {
        const mutation = this.mutationQueue.then(operation);
        this.mutationQueue = mutation.then(() => undefined, () => undefined);
        return mutation;
    }
    snapshot() {
        return { records: new Map(this.records), roots: new Map(this.roots) };
    }
    restore(snapshot) {
        this.records = snapshot.records;
        this.roots = snapshot.roots;
    }
    async persist() {
        if (this.stateFilePath === undefined)
            return;
        await mkdir(dirname(this.stateFilePath), { recursive: true, mode: 0o700 });
        if (this.projectStateRoot !== undefined) {
            await Promise.all([...this.records.keys()].map((id) => mkdir(join(this.projectStateRoot, id), { recursive: true, mode: 0o700 })));
        }
        const contents = `${JSON.stringify({
            version: MANAGED_WORKSPACES_VERSION,
            workspaces: [...this.records.values()].map(serializeRecord)
        }, null, 2)}\n`;
        if (this.projectStateRoot === undefined) {
            await this.writeStateFile(contents);
        }
        else {
            if (this.stateFilePath !== join(this.projectStateRoot, "workspace-registry.json")) {
                throw new CoreError("INTERNAL_ERROR");
            }
            await applyControlPlaneRegistryWrite(this.projectStateRoot, Buffer.from(contents), () => this.writeStateFile(contents));
        }
    }
    async writeStateFile(contents) {
        const stateFilePath = this.stateFilePath;
        const temporaryPath = `${stateFilePath}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
        try {
            await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
            await rename(temporaryPath, stateFilePath);
        }
        catch {
            await unlink(temporaryPath).catch(() => { });
            throw new CoreError("INTERNAL_ERROR");
        }
    }
}
function buildRecord(root, input = {}) {
    const workspaceType = input.workspaceType ??
        (input.gitTopLevel === undefined ? "directory_workspace" : "git_workspace");
    const record = {
        id: input.id ?? newId(),
        root,
        displayName: input.displayName ?? (basename(root) || "workspace"),
        aliases: sortedUnique(input.aliases ?? []),
        previousPaths: [],
        workspaceType,
        filesystem: input.filesystem ?? filesystemIdentity(),
        codexProjectReferences: sortedUnique(input.codexProjectReferences ?? []),
        ...(workspaceType === "git_workspace"
            ? {
                gitTopLevel: input.gitTopLevel ?? root,
                logicalRoot: input.logicalRoot ?? ".",
                repository: input.repository ?? repositoryIdentity("unknown", [], [])
            }
            : {}),
        allowWrite: input.allowWrite ?? false,
        source: input.source ?? "managed"
    };
    validateRecord(record);
    return record;
}
function parseLegacyRecord(value) {
    if (!isObject(value))
        return undefined;
    const { id, root, allow_write } = value;
    if (typeof id !== "string" || !isId(id) || typeof root !== "string" ||
        (allow_write !== undefined && typeof allow_write !== "boolean"))
        return undefined;
    try {
        return buildRecord(root, {
            id,
            allowWrite: allow_write ?? false,
            source: "managed"
        });
    }
    catch {
        return undefined;
    }
}
function parseV2IdentityRecord(value) {
    if (!isObject(value) || !isObject(value.repository_identity) || !isObject(value.permission_policy)) {
        return undefined;
    }
    const record = {
        id: value.workspace_id,
        root: value.current_path,
        displayName: value.display_name,
        aliases: value.aliases,
        previousPaths: value.previous_paths,
        workspaceType: "git_workspace",
        filesystem: filesystemIdentity(),
        codexProjectReferences: [],
        gitTopLevel: value.git_top_level,
        logicalRoot: value.logical_root,
        repository: {
            fingerprint: value.repository_identity.fingerprint,
            ...(typeof value.repository_identity.local_metadata_id === "string"
                ? { localMetadataId: value.repository_identity.local_metadata_id }
                : {}),
            objectFormat: value.repository_identity.object_format,
            normalizedRemotes: value.repository_identity.normalized_remotes,
            rootCommits: value.repository_identity.root_commits
        },
        allowWrite: value.permission_policy.allow_write,
        source: value.source
    };
    try {
        validateRecord(record);
        return record;
    }
    catch {
        return undefined;
    }
}
function parseIdentityRecord(value) {
    if (!isObject(value) || !isObject(value.filesystem_identity) || !isObject(value.permission_policy)) {
        return undefined;
    }
    const gitIdentity = isObject(value.git_identity) ? value.git_identity : undefined;
    const repositoryIdentityValue = gitIdentity !== undefined && isObject(gitIdentity.repository_identity)
        ? gitIdentity.repository_identity
        : undefined;
    const filesystemStableObjectIdentity = parseStableObjectIdentity(value.filesystem_identity.stable_object_identity);
    const repositoryStableObjectIdentity = parseStableObjectIdentity(repositoryIdentityValue?.stable_object_identity);
    if ((value.filesystem_identity.stable_object_identity !== undefined &&
        filesystemStableObjectIdentity === undefined) ||
        (repositoryIdentityValue?.stable_object_identity !== undefined &&
            repositoryStableObjectIdentity === undefined))
        return undefined;
    const workspaceType = value.workspace_type;
    const record = {
        id: value.workspace_id,
        root: value.current_path,
        displayName: value.display_name,
        aliases: value.aliases,
        previousPaths: value.previous_paths,
        workspaceType,
        filesystem: {
            fingerprint: value.filesystem_identity.fingerprint,
            ...(typeof value.filesystem_identity.local_metadata_id === "string"
                ? { localMetadataId: value.filesystem_identity.local_metadata_id }
                : {}),
            ...(filesystemStableObjectIdentity === undefined
                ? {}
                : { stableObjectIdentity: filesystemStableObjectIdentity })
        },
        codexProjectReferences: value.codex_project_references,
        ...(workspaceType === "git_workspace" && gitIdentity !== undefined &&
            repositoryIdentityValue !== undefined
            ? {
                gitTopLevel: gitIdentity.git_top_level,
                logicalRoot: gitIdentity.logical_root,
                repository: {
                    fingerprint: repositoryIdentityValue.fingerprint,
                    ...(typeof repositoryIdentityValue.local_metadata_id === "string"
                        ? { localMetadataId: repositoryIdentityValue.local_metadata_id }
                        : {}),
                    ...(repositoryStableObjectIdentity === undefined
                        ? {}
                        : { stableObjectIdentity: repositoryStableObjectIdentity }),
                    objectFormat: repositoryIdentityValue.object_format,
                    normalizedRemotes: repositoryIdentityValue.normalized_remotes,
                    rootCommits: repositoryIdentityValue.root_commits
                }
            }
            : {}),
        allowWrite: value.permission_policy.allow_write,
        source: value.source
    };
    try {
        validateRecord(record);
        return record;
    }
    catch {
        return undefined;
    }
}
function validateRecord(record) {
    const gitFieldCount = [record.gitTopLevel, record.logicalRoot, record.repository]
        .filter((value) => value !== undefined).length;
    const gitComplete = record.gitTopLevel !== undefined && record.logicalRoot !== undefined &&
        record.repository !== undefined;
    if (!isId(record.id) || !isNormalizedAbsolute(record.root) ||
        typeof record.displayName !== "string" || record.displayName.length === 0 ||
        !isPathList(record.aliases) || !isPathList(record.previousPaths) ||
        !isPathList(record.codexProjectReferences) ||
        (record.source !== "approved" && record.source !== "managed") ||
        typeof record.allowWrite !== "boolean" ||
        !/^[0-9a-f]{64}$/.test(record.filesystem.fingerprint) ||
        (record.filesystem.localMetadataId !== undefined &&
            !/^[0-9a-f]{64}$/.test(record.filesystem.localMetadataId)) ||
        !isStableObjectIdentity(record.filesystem.stableObjectIdentity) ||
        (gitFieldCount !== 0 && gitFieldCount !== 3) ||
        (record.workspaceType === "directory_workspace" && gitComplete) ||
        (record.workspaceType === "git_workspace" && !gitComplete) ||
        (gitComplete && (!isNormalizedAbsolute(record.gitTopLevel) ||
            !isLogicalRoot(record.logicalRoot) ||
            normalize(join(record.gitTopLevel, record.logicalRoot)) !== record.root ||
            !/^[0-9a-f]{64}$/.test(record.repository.fingerprint) ||
            (record.repository.localMetadataId !== undefined &&
                !/^[0-9a-f]{64}$/.test(record.repository.localMetadataId)) ||
            !isStableObjectIdentity(record.repository.stableObjectIdentity) ||
            typeof record.repository.objectFormat !== "string" ||
            record.repository.objectFormat.length === 0 ||
            !isStringList(record.repository.normalizedRemotes) ||
            !isStringList(record.repository.rootCommits)))) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
}
function serializeRecord(record) {
    return {
        workspace_id: record.id,
        display_name: record.displayName,
        aliases: record.aliases,
        current_path: record.root,
        previous_paths: record.previousPaths,
        workspace_type: record.workspaceType,
        filesystem_identity: {
            fingerprint: record.filesystem.fingerprint,
            ...(record.filesystem.localMetadataId === undefined
                ? {}
                : { local_metadata_id: record.filesystem.localMetadataId }),
            ...(record.filesystem.stableObjectIdentity === undefined
                ? {}
                : { stable_object_identity: serializeStableObjectIdentity(record.filesystem.stableObjectIdentity) })
        },
        codex_project_references: record.codexProjectReferences,
        ...(record.workspaceType === "git_workspace"
            ? { git_identity: {
                    git_top_level: record.gitTopLevel,
                    logical_root: record.logicalRoot,
                    repository_identity: {
                        fingerprint: record.repository.fingerprint,
                        ...(record.repository.localMetadataId === undefined
                            ? {}
                            : { local_metadata_id: record.repository.localMetadataId }),
                        ...(record.repository.stableObjectIdentity === undefined
                            ? {}
                            : {
                                stable_object_identity: serializeStableObjectIdentity(record.repository.stableObjectIdentity)
                            }),
                        object_format: record.repository.objectFormat,
                        normalized_remotes: record.repository.normalizedRemotes,
                        root_commits: record.repository.rootCommits
                    }
                } }
            : {}),
        permission_policy: { allow_write: record.allowWrite },
        source: record.source
    };
}
function sameApprovedIdentity(left, right) {
    if (left.source !== "approved" || right.source !== "approved" || left.allowWrite !== right.allowWrite) {
        return false;
    }
    if (left.filesystem.stableObjectIdentity !== undefined || right.filesystem.stableObjectIdentity !== undefined) {
        return isHighConfidenceFilesystemMatch(left.filesystem, right.filesystem);
    }
    if (isHighConfidenceFilesystemMatch(left.filesystem, right.filesystem))
        return true;
    return left.workspaceType === "git_workspace" && right.workspaceType === "git_workspace" &&
        left.logicalRoot === right.logicalRoot &&
        isHighConfidenceRepositoryMatch(left.repository, right.repository);
}
function isNormalizedAbsolute(path) {
    return typeof path === "string" && path.length > 0 && isAbsolute(path) && normalize(path) === path;
}
function isLogicalRoot(path) {
    return typeof path === "string" && path.length > 0 && !isAbsolute(path) &&
        normalize(path) === path && path !== ".." && !path.startsWith(`..${sep}`);
}
function isPathList(value) {
    return Array.isArray(value) && value.every(isNormalizedAbsolute) && new Set(value).size === value.length;
}
function isStringList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) &&
        new Set(value).size === value.length;
}
function parseStableObjectIdentity(value) {
    if (!isObject(value) || value.version !== 2 || typeof value.id !== "string" ||
        typeof value.inode !== "string" || typeof value.birthtime_ns !== "string" ||
        typeof value.device_observation !== "string")
        return undefined;
    return {
        version: 2,
        id: value.id,
        inode: value.inode,
        birthtimeNs: value.birthtime_ns,
        deviceObservation: value.device_observation
    };
}
function serializeStableObjectIdentity(identity) {
    return {
        version: identity.version,
        id: identity.id,
        inode: identity.inode,
        birthtime_ns: identity.birthtimeNs,
        device_observation: identity.deviceObservation
    };
}
function isStableObjectIdentity(identity) {
    if (identity === undefined)
        return true;
    try {
        return identity.version === 2 && identity.id === stableObjectIdentity(identity.inode, identity.birthtimeNs, identity.deviceObservation).id;
    }
    catch {
        return false;
    }
}
function sortedUnique(values) {
    return [...new Set(values)].sort();
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
