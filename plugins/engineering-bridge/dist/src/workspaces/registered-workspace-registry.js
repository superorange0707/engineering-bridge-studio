import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { CoreError } from "../core/errors.js";
export class RegisteredWorkspaceRegistry {
    registrations = new Map();
    canonicalRoots = new Map();
    canonicalize;
    constructor(entries, canonicalize = bestEffortCanonicalRoot) {
        this.canonicalize = canonicalize;
        for (const entry of entries) {
            if (typeof entry.id !== "string" || entry.id.length === 0 ||
                typeof entry.root !== "string" || entry.root.length === 0 ||
                (entry.allow_write !== undefined && typeof entry.allow_write !== "boolean") ||
                !isAbsolute(entry.root) || normalize(entry.root) !== entry.root ||
                this.registrations.has(entry.id)) {
                throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
            }
            const canonicalRoot = canonicalize(entry.root);
            this.registrations.set(entry.id, {
                root: entry.root,
                canonicalRoot,
                allowWrite: entry.allow_write ?? false,
                source: "approved"
            });
            // Duplicate canonical roots among approved entries do not fail startup;
            // the first entry wins for canonical lookup.
            if (!this.canonicalRoots.has(canonicalRoot))
                this.canonicalRoots.set(canonicalRoot, entry.id);
        }
    }
    resolve(workspaceId) {
        const registration = this.registrations.get(workspaceId);
        if (registration === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        return registration.root;
    }
    resolveExecution(workspaceId) {
        const registration = this.registrations.get(workspaceId);
        if (registration === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        return { root: registration.root, allowWrite: registration.allowWrite };
    }
    resolveWritable(workspaceId) {
        const registration = this.registrations.get(workspaceId);
        if (registration === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        if (!registration.allowWrite)
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        return registration.root;
    }
    findByRoot(canonicalRoot) {
        const id = this.canonicalRoots.get(canonicalRoot);
        if (id === undefined)
            return undefined;
        const registration = this.registrations.get(id);
        if (registration === undefined)
            return undefined;
        return {
            id,
            root: registration.root,
            allowWrite: registration.allowWrite,
            source: registration.source
        };
    }
    registerManaged(id, root, allowWrite = false) {
        this.register(id, root, allowWrite, "managed");
    }
    registerApproved(id, root, allowWrite = false) {
        this.register(id, root, allowWrite, "approved");
    }
    rebind(workspaceId, root) {
        const existing = this.registrations.get(workspaceId);
        if (existing === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        const canonicalRoot = this.canonicalize(root);
        const occupied = this.canonicalRoots.get(canonicalRoot);
        if (occupied !== undefined && occupied !== workspaceId) {
            throw new CoreError("WORKSPACE_IDENTITY_AMBIGUOUS");
        }
        this.canonicalRoots.delete(existing.canonicalRoot);
        existing.root = root;
        existing.canonicalRoot = canonicalRoot;
        this.canonicalRoots.set(canonicalRoot, workspaceId);
    }
    register(id, root, allowWrite, source) {
        const existing = this.registrations.get(id);
        if (existing !== undefined) {
            if (existing.root === root && existing.source === source && existing.allowWrite === allowWrite)
                return;
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        }
        const canonicalRoot = this.canonicalize(root);
        if (this.canonicalRoots.has(canonicalRoot))
            throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
        this.registrations.set(id, { root, canonicalRoot, allowWrite, source });
        this.canonicalRoots.set(canonicalRoot, id);
    }
    sourceOf(workspaceId) {
        const registration = this.registrations.get(workspaceId);
        if (registration === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        return registration.source;
    }
    // Grants controlled-write authorization for one managed workspace. Approved
    // seed policies stay authoritative through workspaces.json. Idempotent.
    authorizeWrite(workspaceId) {
        const registration = this.registrations.get(workspaceId);
        if (registration === undefined)
            throw new CoreError("UNKNOWN_WORKSPACE");
        if (registration.source !== "managed")
            throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        registration.allowWrite = true;
    }
}
function bestEffortCanonicalRoot(root) {
    try {
        return realpathSync(root);
    }
    catch {
        return root;
    }
}
