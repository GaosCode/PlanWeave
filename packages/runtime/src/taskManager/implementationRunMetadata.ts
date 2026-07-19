import { z } from "zod";
import { artifactReferenceSchema } from "../autoRun/runnerContractSchemas.js";
import { readJsonFile } from "../json.js";

/**
 * On-disk `results/<task>/blocks/<block>/runs/<runId>/metadata.json` shape for the
 * fields owned by implementation submit and bounded run-index extraction.
 *
 * Executor/runtime patches may add additional keys (adapter, outcome, sessions, …);
 * those are preserved via `.passthrough()` rather than rejected.
 * Identity and chronology fields that are present must match the narrow types below.
 */
export const implementationRunMetadataSchema = z
  .object({
    ref: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    blockId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    submittedAt: z.string().min(1).optional(),
    startedAt: z.union([z.string().min(1), z.null()]).optional(),
    finishedAt: z.union([z.string().min(1), z.null()]).optional(),
    reportHash: z.string().min(1).optional(),
    sourceReportPath: z.string().optional(),
    artifactReference: artifactReferenceSchema.optional()
  })
  .passthrough();

export type ImplementationRunMetadata = z.infer<typeof implementationRunMetadataSchema>;

export function formatImplementationRunMetadataIssues(
  issues: z.ZodError["issues"],
  metadataPath: string
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Implementation run metadata at ${metadataPath} is invalid: ${details}`;
}

export function parseImplementationRunMetadata(
  raw: unknown,
  metadataPath: string
): ImplementationRunMetadata {
  const parsed = implementationRunMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatImplementationRunMetadataIssues(parsed.error.issues, metadataPath));
  }
  return parsed.data;
}

/**
 * Read and validate a present implementation run `metadata.json`.
 * Callers that treat absence as incomplete must check existence first.
 * Malformed JSON and schema failures become path-specific errors; other I/O failures surface unchanged.
 */
export async function readImplementationRunMetadataFile(
  metadataPath: string
): Promise<ImplementationRunMetadata> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(metadataPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Implementation run metadata at ${metadataPath} is malformed JSON: ${error.message}`
      );
    }
    throw error;
  }
  return parseImplementationRunMetadata(raw, metadataPath);
}
