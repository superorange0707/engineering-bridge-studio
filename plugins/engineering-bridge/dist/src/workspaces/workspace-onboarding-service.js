import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { lstat, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { CoreError, serializeError } from "../core/errors.js";
import { filesystemIdentity, inspectWorkspace, isHighConfidenceFilesystemMatch, isHighConfidenceRepositoryMatch, isMatchable, stableObjectIdentitiesMatch, isWithin } from "./repository-identity.js";
const MAX_SCAN_DIRECTORIES = 10_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const BROAD_HOME_CONTAINERS = new Set([
    "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"
].map((name) => join(homedir(), name)));
export class WorkspaceOnboardingService {
    registry;
    catalog;
    canonicalize;
    startProcess;
    inspect;
    scan;
    codexProjects;
    codexCandidateAllowWrite;
    readOnly;
    codexAutoOnboard;
    approvedRoots;
    constructor(registry, catalog, approvedRoots, canonicalize = realpath, startProcess = spawn, inspect = inspectWorkspace, scan = scanWorkspaceDirectories, _legacyBlockedRepositoryRemotes = [], codexProjects, excludedWorkspaceIds = [], codexCandidateAllowWrite = true, readOnly = false, codexAutoOnboard = true) {
        this.registry = registry;
        this.catalog = catalog;
        this.canonicalize = canonicalize;
        this.startProcess = startProcess;
        this.inspect = inspect;
        this.scan = scan;
        this.codexProjects = codexProjects;
        this.codexCandidateAllowWrite = codexCandidateAllowWrite;
        this.readOnly = readOnly;
        this.codexAutoOnboard = codexAutoOnboard;
        this.approvedRoots = approvedRoots.map((root) => typeof root === "string"
            ? { root, allowWrite: false }
            : root);
        this.excludedWorkspaceIds = new Set(excludedWorkspaceIds);
    }
    excludedWorkspaceIds;
    async attach(request) {
        this.assertCatalogMutationAllowed();
        let canonical;
        try {
            canonical = await this.canonicalize(request.project_path);
        }
        catch {
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        if (!isSafeNarrowAbsolute(canonical) || await isFilesystemRoot(canonical)) {
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        }
        if (!(await isDirectory(canonical)))
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        const inspected = asProjectInspection(await this.inspect(canonical));
        const existing = this.registry.findByRoot(inspected.root);
        if (existing !== undefined) {
            if (this.excludedWorkspaceIds.has(existing.id))
                throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
            const record = this.catalog.get(existing.id);
            if (record === undefined || !matchesExistingRegistrationIdentity(record, inspected)) {
                throw new CoreError("WORKSPACE_IDENTITY_MISMATCH");
            }
            if (record.workspaceType === "directory_workspace" && inspected.workspaceType === "git_workspace") {
                const alias = isAbsolute(request.project_path) && normalize(request.project_path) !== inspected.root
                    ? normalize(request.project_path)
                    : undefined;
                const upgraded = await this.catalog.rebind(record.id, inspected.root, identityInput(inspected, alias, record.allowWrite, record.source, request.codex_project_reference));
                this.registry.rebind(record.id, inspected.root);
                return attachResult(upgraded, false, false);
            }
            return attachResult(record, false, false);
        }
        const admitted = await this.canonicalizeWithinApprovedRoot(request.project_path);
        if (admitted.canonical !== canonical)
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        const { policy, alias } = admitted;
        const canonicalManagedRoot = await this.canonicalize(policy.root);
        if (!isWithin(canonicalManagedRoot, inspected.root) ||
            (inspected.git !== undefined && !isWithin(canonicalManagedRoot, inspected.git.gitTopLevel))) {
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        }
        const staleMatches = this.catalog.identityEntries().filter((record) => !pathExistsSyncSafe(record.root) && matchesIdentity(record, inspected));
        if (staleMatches.length > 1)
            throw new CoreError("WORKSPACE_IDENTITY_AMBIGUOUS");
        const input = identityInput(inspected, alias, policy.allowWrite, "managed", request.codex_project_reference);
        const stale = staleMatches[0];
        if (stale !== undefined) {
            const rebound = await this.catalog.rebind(stale.id, inspected.root, input);
            this.registry.rebind(stale.id, inspected.root);
            return attachResult(rebound, false, true);
        }
        const { id, created } = await this.catalog.registerOnce(inspected.root, input);
        const record = this.catalog.get(id);
        if (record === undefined)
            throw new CoreError("INTERNAL_ERROR");
        this.registry.registerManaged(id, inspected.root, record.allowWrite);
        return attachResult(record, created, false);
    }
    // Backward-compatible alias; approved managed roots no longer need a separate BIND decision.
    async bind(request) {
        const result = await this.attach(request);
        return {
            workspace_id: result.workspace_id,
            root: result.root,
            allow_write: result.allow_write,
            source: result.source
        };
    }
    async ensureAvailable(workspaceId) {
        const record = this.catalog.get(workspaceId);
        if (record === undefined)
            return this.registry.resolve(workspaceId);
        if (await pathExists(record.root)) {
            const inspected = asProjectInspection(await this.inspect(record.root));
            if (existingPathIdentityChanged(record, inspected)) {
                throw new CoreError("WORKSPACE_IDENTITY_MISMATCH");
            }
            if (!hasMatchableIdentity(record)) {
                if (this.readOnly)
                    throw new CoreError("WORKSPACE_IDENTITY_MISMATCH");
                await this.catalog.rebind(record.id, record.root, identityInput(inspected, undefined, record.allowWrite, record.source));
                return record.root;
            }
            if (record.workspaceType === "directory_workspace" && inspected.workspaceType === "git_workspace" &&
                isHighConfidenceFilesystemMatch(record.filesystem, inspected.filesystem)) {
                if (this.readOnly)
                    throw new CoreError("WORKSPACE_IDENTITY_MISMATCH");
                await this.catalog.rebind(record.id, record.root, identityInput(inspected, undefined, record.allowWrite, record.source));
                return record.root;
            }
            if (!matchesIdentity(record, inspected)) {
                throw new CoreError("WORKSPACE_IDENTITY_MISMATCH");
            }
            return record.root;
        }
        if (this.readOnly)
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        return (await this.reconcile(workspaceId)).root;
    }
    async reconcile(workspaceId) {
        this.assertCatalogMutationAllowed();
        const record = this.catalog.get(workspaceId);
        if (record === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        if (this.excludedWorkspaceIds.has(workspaceId))
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        if (await pathExists(record.root)) {
            await this.ensureAvailable(workspaceId);
            return record;
        }
        const referenceMatches = new Map();
        for (const reference of await this.readCodexProjects()) {
            await this.collectReconciliationCandidate(record, reference.path, referenceMatches, true);
        }
        if (referenceMatches.size > 1)
            throw new CoreError("WORKSPACE_IDENTITY_AMBIGUOUS");
        const referenced = [...referenceMatches.values()][0];
        if (referenced !== undefined) {
            const rebound = await this.catalog.rebind(workspaceId, referenced.root, identityInput(referenced, undefined, record.allowWrite, record.source));
            this.registry.rebind(workspaceId, referenced.root);
            return rebound;
        }
        const matches = new Map();
        for (const policy of this.approvedRoots) {
            const approvedRoot = await this.canonicalApprovedRoot(policy.root);
            for (const candidate of await this.scan(approvedRoot)) {
                await this.collectReconciliationCandidate(record, candidate, matches);
            }
        }
        const candidates = [...matches.values()];
        if (candidates.length === 0)
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        if (candidates.length > 1)
            throw new CoreError("WORKSPACE_IDENTITY_AMBIGUOUS");
        const inspected = candidates[0];
        const rebound = await this.catalog.rebind(workspaceId, inspected.root, identityInput(inspected, undefined, record.allowWrite, record.source));
        this.registry.rebind(workspaceId, inspected.root);
        return rebound;
    }
    async refresh(workspaceId) {
        this.assertCatalogMutationAllowed();
        const records = workspaceId === undefined
            ? this.catalog.identityEntries()
            : [this.catalog.get(workspaceId)].filter((record) => record !== undefined);
        if (workspaceId !== undefined && records.length === 0)
            throw new CoreError("UNKNOWN_WORKSPACE");
        const results = [];
        for (const record of records) {
            try {
                const root = await this.ensureAvailable(record.id);
                results.push({ workspace_id: record.id, status: root === record.root ? "current" : "rebound", root });
            }
            catch (error) {
                results.push({ workspace_id: record.id, status: "blocked", error: serializeError(error) });
            }
        }
        if (workspaceId === undefined)
            await this.refreshCodexProjectReferences(results);
        return results;
    }
    async create(request) {
        this.assertCatalogMutationAllowed();
        if (!isSingleSegment(request.name))
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        const { canonical: canonicalParent, policy } = await this.canonicalizeWithinApprovedRoot(request.parent);
        const target = join(canonicalParent, request.name);
        if (await pathExists(target))
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        try {
            await mkdir(target);
        }
        catch {
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        try {
            await this.git(target, ["init"]);
        }
        catch {
            await rmdir(target).catch(() => { });
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        const inspected = asProjectInspection(await this.inspect(target));
        const { id } = await this.catalog.registerOnce(target, identityInput(inspected, undefined, policy.allowWrite));
        const record = this.catalog.get(id);
        if (record === undefined)
            throw new CoreError("INTERNAL_ERROR");
        this.registry.registerManaged(id, target, record.allowWrite);
        return {
            workspace_id: id,
            root: target,
            allow_write: record.allowWrite,
            git: { initialized: true, head: "unborn" }
        };
    }
    async authorizeWrite(workspaceId) {
        this.assertCatalogMutationAllowed();
        const root = this.registry.resolve(workspaceId);
        if (this.registry.sourceOf(workspaceId) !== "managed") {
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        await this.catalog.authorize(root);
        this.registry.authorizeWrite(workspaceId);
        return { workspace_id: workspaceId, allow_write: true };
    }
    async diagnose(request) {
        if ((request.workspace_id === undefined) === (request.project_path === undefined)) {
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        const record = request.workspace_id === undefined ? undefined : this.catalog.get(request.workspace_id);
        if (request.workspace_id !== undefined && record === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        const sourcePath = request.project_path ?? record.root;
        let canonical;
        try {
            canonical = await this.canonicalize(sourcePath);
        }
        catch {
            return {
                ...(record === undefined ? {} : { workspace_id: record.id, workspace_type: record.workspaceType }),
                registration_type: record?.source ?? "unregistered",
                usable_by_workspace_id: false,
                managed_onboarding_applicable: false,
                matched_managed_root: false,
                boundary_status: "INELIGIBLE",
                boundary_reason: "MISSING_WORKSPACE",
                filesystem_identity_status: "UNKNOWN",
                repository_identity_status: "UNKNOWN",
                codex_project_reference: false,
                duplicate_workspace_ids: [],
                reconciliation_possible: false
            };
        }
        if (!isSafeNarrowAbsolute(canonical) || await isFilesystemRoot(canonical) || !(await isDirectory(canonical))) {
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        }
        const inspected = asProjectInspection(await this.inspect(canonical));
        const direct = this.registry.findByRoot(inspected.root);
        const matchingRecords = this.catalog.identityEntries().filter((candidate) => matchesIdentity(candidate, inspected));
        const selected = direct === undefined ? matchingRecords.length === 1 ? matchingRecords[0] : undefined
            : this.catalog.get(direct.id);
        const managedRootMatch = await this.matchesApprovedRoot(inspected);
        const codexReferences = await this.readCodexProjects();
        const codexReference = codexReferences.some(({ path }) => normalize(path) === normalize(sourcePath) ||
            normalize(path) === inspected.root);
        const codexOnboardingMatch = this.codexAutoOnboard && codexReference;
        const identityMatch = selected !== undefined && matchesIdentity(selected, inspected);
        const existingAuthoritative = direct !== undefined;
        return {
            ...(direct === undefined && selected === undefined ? {} : { workspace_id: direct?.id ?? selected.id }),
            canonical_path: inspected.root,
            workspace_type: inspected.workspaceType,
            registration_type: direct?.source ?? selected?.source ?? "unregistered",
            usable_by_workspace_id: existingAuthoritative && (selected === undefined || identityMatch),
            managed_onboarding_applicable: !existingAuthoritative && (managedRootMatch || codexOnboardingMatch),
            matched_managed_root: managedRootMatch,
            boundary_status: existingAuthoritative ? "EXISTING_AUTHORITATIVE"
                : managedRootMatch || codexOnboardingMatch ? "ELIGIBLE" : "INELIGIBLE",
            boundary_reason: existingAuthoritative ? "EXISTING_AUTHORITATIVE_WORKSPACE"
                : managedRootMatch ? "MANAGED_ROOT_MATCH"
                    : codexOnboardingMatch ? "CODEX_PROJECT_REFERENCE" : "NO_AUTHORIZED_ONBOARDING_BOUNDARY",
            filesystem_identity_status: selected === undefined ? "UNKNOWN"
                : isHighConfidenceFilesystemMatch(selected.filesystem, inspected.filesystem) ? "PASS" : "MISMATCH",
            repository_identity_status: selected === undefined ? "UNKNOWN"
                : selected.workspaceType !== "git_workspace" || inspected.workspaceType !== "git_workspace"
                    ? "NOT_APPLICABLE"
                    : isHighConfidenceRepositoryMatch(selected.repository, inspected.git.repository) ? "PASS" : "MISMATCH",
            codex_project_reference: codexReference,
            duplicate_workspace_ids: matchingRecords.map(({ id }) => id).filter((id) => id !== selected?.id).sort(),
            reconciliation_possible: direct === undefined && matchingRecords.length === 1 &&
                !pathExistsSyncSafe(matchingRecords[0].root)
        };
    }
    async canonicalizeWithinApprovedRoot(path) {
        let canonical;
        try {
            canonical = await this.canonicalize(path);
        }
        catch {
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
        let selected;
        for (const policy of this.approvedRoots) {
            let root;
            try {
                root = await this.canonicalApprovedRoot(policy.root);
            }
            catch {
                continue;
            }
            if (isWithin(root, canonical)) {
                if (selected === undefined || root.length > selected.root.length) {
                    selected = { policy, root };
                }
                else if (root === selected.root && policy.allowWrite !== selected.policy.allowWrite) {
                    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
                }
            }
        }
        if (selected !== undefined) {
            const normalizedAlias = isAbsolute(path) && normalize(path) !== canonical ? normalize(path) : undefined;
            return {
                canonical,
                policy: selected.policy,
                ...(normalizedAlias === undefined ? {} : { alias: normalizedAlias })
            };
        }
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    assertCatalogMutationAllowed() {
        if (this.readOnly)
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    async canonicalApprovedRoot(path) {
        const canonical = await this.canonicalize(path);
        if (!isSafeNarrowAbsolute(canonical) || await isFilesystemRoot(canonical)) {
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        }
        return canonical;
    }
    async matchesApprovedRoot(inspected) {
        for (const policy of this.approvedRoots) {
            try {
                const root = await this.canonicalApprovedRoot(policy.root);
                if (isWithin(root, inspected.root) &&
                    (inspected.git === undefined || isWithin(root, inspected.git.gitTopLevel)))
                    return true;
            }
            catch {
                // A broken configured root does not make an unrelated path eligible.
            }
        }
        return false;
    }
    async collectReconciliationCandidate(record, path, matches, allowCodexMetadataPathOutsideManagedRoots = false) {
        if (!isSafeNarrowAbsolute(path))
            return;
        let canonical;
        try {
            canonical = await this.canonicalize(path);
        }
        catch {
            return;
        }
        if (!isSafeNarrowAbsolute(canonical) || await isFilesystemRoot(canonical))
            return;
        let insideApprovedRoot = false;
        for (const policy of this.approvedRoots) {
            try {
                if (isWithin(await this.canonicalApprovedRoot(policy.root), canonical))
                    insideApprovedRoot = true;
            }
            catch {
                continue;
            }
        }
        if ((!insideApprovedRoot && !allowCodexMetadataPathOutsideManagedRoots) || !(await isDirectory(canonical)))
            return;
        try {
            const inspected = asProjectInspection(await this.inspect(canonical));
            if (matchesIdentity(record, inspected))
                matches.set(inspected.root, inspected);
        }
        catch {
            // A single unreadable or invalid candidate cannot weaken fail-closed matching.
        }
    }
    async refreshCodexProjectReferences(results) {
        const seen = new Set();
        for (const reference of await this.readCodexProjects()) {
            const path = normalize(reference.path);
            if (!isSafeNarrowAbsolute(path)) {
                results.push({ project_reference: reference.path, status: "unsafe_broad_path" });
                continue;
            }
            let canonical;
            try {
                canonical = await this.canonicalize(path);
            }
            catch {
                results.push({ project_reference: path, status: "missing_path" });
                continue;
            }
            if (!isSafeNarrowAbsolute(canonical) || await isFilesystemRoot(canonical)) {
                results.push({ project_reference: path, canonical_path: canonical, status: "unsafe_broad_path" });
                continue;
            }
            if (seen.has(canonical)) {
                results.push({ project_reference: path, canonical_path: canonical, status: "duplicate_alias" });
                continue;
            }
            seen.add(canonical);
            let inspected;
            try {
                inspected = asProjectInspection(await this.inspect(canonical));
            }
            catch {
                results.push({ project_reference: path, canonical_path: canonical, status: "invalid_directory" });
                continue;
            }
            const existing = this.registry.findByRoot(canonical);
            if (existing !== undefined) {
                if (this.excludedWorkspaceIds.has(existing.id)) {
                    results.push({ workspace_id: existing.id, project_reference: path,
                        canonical_path: canonical, status: "explicitly_user_excluded" });
                    continue;
                }
                try {
                    await this.ensureAvailable(existing.id);
                }
                catch (error) {
                    results.push({ workspace_id: existing.id, project_reference: path,
                        canonical_path: canonical, status: "blocked", error: serializeError(error) });
                    continue;
                }
                const record = this.catalog.get(existing.id);
                if (record !== undefined && !record.codexProjectReferences.includes(path)) {
                    await this.catalog.rebind(record.id, canonical, identityInput(inspected, path === canonical ? undefined : path, record.allowWrite, record.source, path));
                }
                results.push({ workspace_id: existing.id, project_reference: path,
                    canonical_path: canonical, status: "current" });
                continue;
            }
            const proposedId = proposedWorkspaceId(inspected.filesystem.fingerprint);
            try {
                const identityMatches = this.catalog.identityEntries().filter((record) => matchesIdentity(record, inspected));
                if (identityMatches.length > 1)
                    throw new CoreError("WORKSPACE_IDENTITY_AMBIGUOUS");
                const identityMatch = identityMatches[0];
                const workspaceId = identityMatch?.id ?? proposedId;
                if (this.excludedWorkspaceIds.has(workspaceId)) {
                    results.push({ workspace_id: workspaceId, project_reference: path,
                        canonical_path: canonical, status: "explicitly_user_excluded" });
                    continue;
                }
                if (identityMatch !== undefined) {
                    if (pathExistsSyncSafe(identityMatch.root))
                        throw new CoreError("WORKSPACE_IDENTITY_AMBIGUOUS");
                    const rebound = await this.catalog.rebind(identityMatch.id, inspected.root, identityInput(inspected, path === canonical ? undefined : path, identityMatch.allowWrite, identityMatch.source, path));
                    this.registry.rebind(identityMatch.id, inspected.root);
                    results.push({ ...attachResult(rebound, false, true), project_reference: path,
                        status: "auto_rebound_from_codex_metadata" });
                    continue;
                }
                if (!this.codexAutoOnboard) {
                    results.push({ project_reference: path, canonical_path: canonical,
                        status: "auto_onboarding_disabled" });
                    continue;
                }
                const { created } = await this.catalog.registerOnce(inspected.root, { ...identityInput(inspected, path === canonical ? undefined : path, this.codexCandidateAllowWrite, "managed", path), id: proposedId });
                const record = this.catalog.get(proposedId);
                if (record === undefined)
                    throw new CoreError("INTERNAL_ERROR");
                this.registry.registerManaged(record.id, record.root, record.allowWrite);
                results.push({ ...attachResult(record, created, false), project_reference: path, status: "auto_onboarded" });
            }
            catch (error) {
                results.push({ project_reference: path, canonical_path: canonical,
                    status: "blocked", error: serializeError(error) });
            }
        }
    }
    async readCodexProjects() {
        if (this.codexProjects === undefined)
            return [];
        try {
            return await this.codexProjects();
        }
        catch {
            return [];
        }
    }
    git(cwd, args) {
        return new Promise((resolveOutput, reject) => {
            let child;
            try {
                child = this.startProcess("git", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
            }
            catch {
                reject(new CoreError("WORKSPACE_PRECONDITION_FAILED"));
                return;
            }
            let stdout = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => { stdout += chunk; });
            child.stderr.resume();
            child.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
            child.on("close", (code) => code === 0
                ? resolveOutput(stdout)
                : reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
            child.stdin.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
            child.stdin.end();
        });
    }
}
function asProjectInspection(value) {
    if ("workspaceType" in value)
        return value;
    return {
        root: value.root,
        workspaceType: "git_workspace",
        filesystem: filesystemIdentity(value.repository.localMetadataId, value.repository.stableObjectIdentity),
        git: value
    };
}
function matchesIdentity(record, inspected) {
    if (record.filesystem.stableObjectIdentity !== undefined ||
        inspected.filesystem.stableObjectIdentity !== undefined) {
        return isHighConfidenceFilesystemMatch(record.filesystem, inspected.filesystem);
    }
    if (isHighConfidenceFilesystemMatch(record.filesystem, inspected.filesystem))
        return true;
    return record.workspaceType === "git_workspace" && inspected.workspaceType === "git_workspace" &&
        record.logicalRoot === inspected.git.logicalRoot &&
        isHighConfidenceRepositoryMatch(record.repository, inspected.git.repository);
}
function matchesExistingRegistrationIdentity(record, inspected) {
    if (existingPathIdentityChanged(record, inspected))
        return false;
    const filesystemMatch = isHighConfidenceFilesystemMatch(record.filesystem, inspected.filesystem);
    if (record.workspaceType === "directory_workspace") {
        return filesystemMatch &&
            (inspected.workspaceType === "directory_workspace" || inspected.workspaceType === "git_workspace");
    }
    return inspected.workspaceType === "git_workspace" &&
        (filesystemMatch || (record.filesystem.stableObjectIdentity === undefined &&
            record.filesystem.localMetadataId === undefined)) &&
        record.logicalRoot === inspected.git.logicalRoot &&
        isHighConfidenceRepositoryMatch(record.repository, inspected.git.repository);
}
function existingPathIdentityChanged(record, inspected) {
    if (localObjectIdentityChanged(record.filesystem, inspected.filesystem))
        return true;
    return record.workspaceType === "git_workspace" && inspected.workspaceType === "git_workspace" &&
        localObjectIdentityChanged(record.repository, inspected.git.repository);
}
function hasMatchableIdentity(record) {
    return record.filesystem.stableObjectIdentity !== undefined || record.filesystem.localMetadataId !== undefined ||
        (record.repository !== undefined && isMatchable(record.repository));
}
function identityInput(inspected, alias, allowWrite = false, source = "managed", codexProjectReference) {
    return {
        displayName: basename(inspected.root) || "workspace",
        aliases: alias === undefined ? [] : [alias],
        workspaceType: inspected.workspaceType,
        filesystem: inspected.filesystem,
        codexProjectReferences: codexProjectReference === undefined ? [] : [codexProjectReference],
        ...(inspected.git === undefined ? {} : {
            gitTopLevel: inspected.git.gitTopLevel,
            logicalRoot: inspected.git.logicalRoot,
            repository: inspected.git.repository
        }),
        allowWrite,
        source
    };
}
function attachResult(record, autoOnboarded, rebound) {
    return {
        workspace_id: record.id,
        root: record.root,
        allow_write: record.allowWrite,
        source: record.source,
        display_name: record.displayName,
        aliases: record.aliases,
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
        ...(record.workspaceType === "git_workspace" ? {
            git_identity: {
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
            }
        } : {}),
        auto_onboarded: autoOnboarded,
        rebound
    };
}
function localObjectIdentityChanged(recorded, current) {
    if (recorded.stableObjectIdentity !== undefined || current.stableObjectIdentity !== undefined) {
        return recorded.stableObjectIdentity === undefined || current.stableObjectIdentity === undefined ||
            !stableObjectIdentitiesMatch(recorded.stableObjectIdentity, current.stableObjectIdentity);
    }
    return recorded.localMetadataId !== undefined && current.localMetadataId !== undefined &&
        recorded.localMetadataId !== current.localMetadataId;
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
function isSingleSegment(name) {
    return name.length > 0 && !name.includes("/") && !name.includes("\\") &&
        name !== "." && name !== "..";
}
async function isDirectory(path) {
    try {
        return (await lstat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        return error.code !== "ENOENT";
    }
}
function pathExistsSyncSafe(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
}
async function scanWorkspaceDirectories(root) {
    const found = new Set();
    const queue = [root];
    let visited = 0;
    while (queue.length > 0) {
        const directory = queue.pop();
        if (++visited > MAX_SCAN_DIRECTORIES)
            throw new CoreError("WORKSPACE_SCAN_LIMIT_EXCEEDED");
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        found.add(await realpath(directory));
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name))
                continue;
            queue.push(join(directory, entry.name));
        }
    }
    return [...found].sort();
}
function isSafeNarrowAbsolute(path) {
    return isAbsolute(path) && normalize(path) === path && path !== "/" && path !== "/Users" &&
        path !== homedir() && !BROAD_HOME_CONTAINERS.has(path);
}
async function isFilesystemRoot(path) {
    const parent = dirname(path);
    if (parent === path)
        return true;
    try {
        const [currentMetadata, parentMetadata] = await Promise.all([lstat(path), lstat(parent)]);
        return currentMetadata.dev !== parentMetadata.dev;
    }
    catch {
        return true;
    }
}
function proposedWorkspaceId(fingerprint) {
    const value = createHash("sha256").update(`engineering-bridge-workspace:${fingerprint}`).digest();
    value[6] = (value[6] & 0x0f) | 0x40;
    value[8] = (value[8] & 0x3f) | 0x80;
    const hex = value.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
