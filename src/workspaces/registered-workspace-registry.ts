import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { CoreError } from "../core/errors.js";

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly allow_write?: boolean | undefined;
}

export interface WorkspaceLookup {
  readonly id: string;
  readonly root: string;
  readonly allowWrite: boolean;
  readonly source: "approved" | "managed";
}

type Registration = {
  root: string;
  canonicalRoot: string;
  allowWrite: boolean;
  source: "approved" | "managed";
};

export class RegisteredWorkspaceRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly canonicalRoots = new Map<string, string>();
  private readonly canonicalize: (root: string) => string;

  constructor(
    entries: readonly WorkspaceRegistration[],
    canonicalize: (root: string) => string = bestEffortCanonicalRoot
  ) {
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
      if (!this.canonicalRoots.has(canonicalRoot)) this.canonicalRoots.set(canonicalRoot, entry.id);
    }
  }

  resolve(workspaceId: string): string {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return registration.root;
  }

  resolveExecution(workspaceId: string): { root: string; allowWrite: boolean } {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return { root: registration.root, allowWrite: registration.allowWrite };
  }

  resolveWritable(workspaceId: string): string {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    if (!registration.allowWrite) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return registration.root;
  }

  findByRoot(canonicalRoot: string): WorkspaceLookup | undefined {
    const id = this.canonicalRoots.get(canonicalRoot);
    if (id === undefined) return undefined;
    const registration = this.registrations.get(id);
    if (registration === undefined) return undefined;
    return {
      id,
      root: registration.root,
      allowWrite: registration.allowWrite,
      source: registration.source
    };
  }

  registerManaged(id: string, root: string, allowWrite = false): void {
    this.register(id, root, allowWrite, "managed");
  }

  registerApproved(id: string, root: string, allowWrite = false): void {
    this.register(id, root, allowWrite, "approved");
  }

  rebind(workspaceId: string, root: string): void {
    const existing = this.registrations.get(workspaceId);
    if (existing === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
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

  private register(id: string, root: string, allowWrite: boolean, source: "approved" | "managed"): void {
    const existing = this.registrations.get(id);
    if (existing !== undefined) {
      if (existing.root === root && existing.source === source && existing.allowWrite === allowWrite) return;
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    const canonicalRoot = this.canonicalize(root);
    if (this.canonicalRoots.has(canonicalRoot)) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    this.registrations.set(id, { root, canonicalRoot, allowWrite, source });
    this.canonicalRoots.set(canonicalRoot, id);
  }

  sourceOf(workspaceId: string): "approved" | "managed" {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return registration.source;
  }

  // Grants controlled-write authorization for one managed workspace. Approved
  // seed policies stay authoritative through workspaces.json. Idempotent.
  authorizeWrite(workspaceId: string): void {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    if (registration.source !== "managed") throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    registration.allowWrite = true;
  }
}

function bestEffortCanonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}
