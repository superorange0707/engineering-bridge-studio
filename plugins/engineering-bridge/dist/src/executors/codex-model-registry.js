import { CoreError } from "../core/errors.js";
export const CODEX_LOGICAL_ROLES = ["implementer", "local_lead", "repo_principal"];
// Model generations live only in this registry. Routing and execution consume
// logical roles, so a future generation changes this mapping rather than the
// routing/business logic.
export const DEFAULT_CODEX_MODEL_REGISTRY = Object.freeze({
    implementer: Object.freeze({ model: "gpt-5.6-luna", effort: "max", summary: "concise" }),
    local_lead: Object.freeze({ model: "gpt-5.6-terra", effort: "max", summary: "concise" }),
    repo_principal: Object.freeze({ model: "gpt-5.6-sol", effort: "max", summary: "concise" })
});
function object(value) {
    return typeof value === "object" && value !== null;
}
function entryFor(modelList, model) {
    if (!object(modelList) || !Array.isArray(modelList.data))
        return undefined;
    return modelList.data.find((entry) => object(entry) && entry.model === model && entry.hidden !== true);
}
function supportsMax(entry) {
    return entry !== undefined && Array.isArray(entry.supportedReasoningEfforts) &&
        entry.supportedReasoningEfforts.some((effort) => object(effort) && effort.reasoningEffort === "max");
}
export function registryAvailability(modelList, registry = DEFAULT_CODEX_MODEL_REGISTRY) {
    return Object.fromEntries(CODEX_LOGICAL_ROLES.map((role) => {
        const config = registry[role];
        const entry = entryFor(modelList, config.model);
        return [role, { ...config, available: entry !== undefined, maxSupported: supportsMax(entry) }];
    }));
}
export function requireModelRegistry(modelList, registry = DEFAULT_CODEX_MODEL_REGISTRY) {
    for (const role of CODEX_LOGICAL_ROLES) {
        const entry = entryFor(modelList, registry[role].model);
        if (entry === undefined)
            throw new CoreError("CODEX_ROLE_MODEL_UNAVAILABLE");
        if (!supportsMax(entry))
            throw new CoreError("CODEX_MAX_REASONING_UNAVAILABLE");
    }
}
export function taskMetadata(logicalRole, codexVersion, registry = DEFAULT_CODEX_MODEL_REGISTRY) {
    const config = registry[logicalRole];
    return {
        logicalRole,
        model: config.model,
        reasoningEffort: config.effort,
        codexVersion
    };
}
