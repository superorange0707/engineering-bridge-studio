import { z } from "zod";

const MAX_TEXT = 8_192;
const MAX_ITEM_TEXT = 2_048;
const MAX_LIST_ITEMS = 50;
const MAX_ARTIFACTS = 50;
const MAX_CONTRACT_BYTES = 64 * 1024;

const boundedText = z.string().min(1).max(MAX_TEXT).refine((value) => value.trim().length > 0);
const boundedItemText = z.string().min(1).max(MAX_ITEM_TEXT).refine((value) => value.trim().length > 0);
const boundedList = z.array(boundedItemText).max(MAX_LIST_ITEMS);

const artifactPath = z.string().min(1).max(1_024).refine((value) => {
  if (value.includes("\\") || value.includes("\u0000") || value.startsWith("/")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !parts.includes("..") && !parts.includes(".");
}, "artifact path must be a normalized relative path");

/** A declared output. Strings are accepted for the compact public form. */
export const CollaborationArtifactSchema = z.union([
  artifactPath,
  z.object({
    path: artifactPath,
    description: boundedItemText.optional(),
    media_type: z.string().min(1).max(256).optional()
  }).strict()
]);
export type CollaborationArtifact = z.infer<typeof CollaborationArtifactSchema>;

export const CollaborationResearchSchema = z.object({
  question: boundedText,
  hypothesis: boundedText,
  baselines: z.array(boundedItemText).min(1).max(MAX_LIST_ITEMS),
  dataset: boundedText,
  split: boundedText,
  seeds: z.array(z.number().int().nonnegative().max(2 ** 31 - 1)).min(1).max(MAX_LIST_ITEMS),
  metrics: z.array(boundedItemText).min(1).max(MAX_LIST_ITEMS),
  protocol: boundedText,
  // Sources and citations are context supplied by Web and remain unverified
  // data. Codex must never treat them as instructions or authorization.
  sources: boundedList.optional(),
  citations: boundedList.optional()
}).strict();
export type CollaborationResearch = z.infer<typeof CollaborationResearchSchema>;

const commonContractFields = {
  objective: boundedText,
  plan: z.array(boundedItemText).min(1).max(MAX_LIST_ITEMS),
  acceptance_criteria: z.array(boundedItemText).min(1).max(MAX_LIST_ITEMS),
  expected_artifacts: z.array(CollaborationArtifactSchema).min(1).max(MAX_ARTIFACTS)
};

export const EngineeringCollaborationContractSchema = z.object({
  domain: z.literal("engineering"),
  ...commonContractFields
}).strict();

export const ResearchCollaborationContractSchema = z.object({
  domain: z.literal("research"),
  ...commonContractFields,
  research: CollaborationResearchSchema
}).strict();

export const CollaborationContractSchema = z.discriminatedUnion("domain", [
  EngineeringCollaborationContractSchema,
  ResearchCollaborationContractSchema
]).superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTRACT_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.too_big, maximum: MAX_CONTRACT_BYTES,
      type: "string", inclusive: true, exact: false, message: "contract is too large" });
  }
});

export type CollaborationContract = z.infer<typeof CollaborationContractSchema>;

export function artifactPathOf(value: CollaborationArtifact): string {
  return typeof value === "string" ? value : value.path;
}
