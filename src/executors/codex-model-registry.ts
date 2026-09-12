import { CoreError } from "../core/errors.js";

export const CODEX_LOGICAL_ROLES = ["implementer", "local_lead", "repo_principal"] as const;
export type CodexLogicalRole = (typeof CODEX_LOGICAL_ROLES)[number];

export interface CodexModelConfig {
  readonly model: string;
  readonly effort: "max";
  readonly summary: "concise";
}

export type CodexModelRegistry = Readonly<Record<CodexLogicalRole, CodexModelConfig>>;

// Model generations live only in this registry. Routing and execution consume
// logical roles, so a future generation changes this mapping rather than the
// routing/business logic.
export const DEFAULT_CODEX_MODEL_REGISTRY: CodexModelRegistry = Object.freeze({
  implementer: Object.freeze({ model: "gpt-5.6-luna", effort: "max", summary: "concise" }),
  local_lead: Object.freeze({ model: "gpt-5.6-terra", effort: "max", summary: "concise" }),
  repo_principal: Object.freeze({ model: "gpt-5.6-sol", effort: "max", summary: "concise" })
});

export interface CodexTaskMetadata {
  readonly logicalRole: CodexLogicalRole;
  readonly model: string;
  readonly reasoningEffort: "max";
  readonly codexVersion: string;
}

export interface CodexRoleAvailability extends CodexModelConfig {
  readonly available: boolean;
  readonly maxSupported: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function entryFor(modelList: unknown, model: string): Record<string, unknown> | undefined {
  if (!object(modelList) || !Array.isArray(modelList.data)) return undefined;
  return modelList.data.find((entry) => object(entry) && entry.model === model && entry.hidden !== true) as
    Record<string, unknown> | undefined;
}

function supportsMax(entry: Record<string, unknown> | undefined): boolean {
  return entry !== undefined && Array.isArray(entry.supportedReasoningEfforts) &&
    entry.supportedReasoningEfforts.some((effort) => object(effort) && effort.reasoningEffort === "max");
}

export function registryAvailability(
  modelList: unknown,
  registry: CodexModelRegistry = DEFAULT_CODEX_MODEL_REGISTRY
): Record<CodexLogicalRole, CodexRoleAvailability> {
  return Object.fromEntries(CODEX_LOGICAL_ROLES.map((role) => {
    const config = registry[role];
    const entry = entryFor(modelList, config.model);
    return [role, { ...config, available: entry !== undefined, maxSupported: supportsMax(entry) }];
  })) as Record<CodexLogicalRole, CodexRoleAvailability>;
}

export function requireModelRegistry(
  modelList: unknown,
  registry: CodexModelRegistry = DEFAULT_CODEX_MODEL_REGISTRY
): void {
  for (const role of CODEX_LOGICAL_ROLES) {
    const entry = entryFor(modelList, registry[role].model);
    if (entry === undefined) throw new CoreError("CODEX_ROLE_MODEL_UNAVAILABLE");
    if (!supportsMax(entry)) throw new CoreError("CODEX_MAX_REASONING_UNAVAILABLE");
  }
}

export function taskMetadata(
  logicalRole: CodexLogicalRole,
  codexVersion: string,
  registry: CodexModelRegistry = DEFAULT_CODEX_MODEL_REGISTRY
): CodexTaskMetadata {
  const config = registry[logicalRole];
  return {
    logicalRole,
    model: config.model,
    reasoningEffort: config.effort,
    codexVersion
  };
}
