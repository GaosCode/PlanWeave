import { z } from "zod";
import { readJsonFile } from "../json.js";
import { reviewResultSchema, type ReviewResult } from "./reviewResultContract.js";

/**
 * On-disk `results/<task>/reviews/<block>/attempts/<REV-*>/metadata.json` shape.
 * Runtime owns this family; incomplete mid-write candidates may omit identity fields
 * (optional) so directory scans can skip them without treating absence as a match.
 * Present fields must match these types.
 */
export const reviewAttemptMetadataSchema = z
  .object({
    reviewBlockRef: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    reviewedWorkRevision: z.string().min(1).optional(),
    resultHash: z.string().min(1).optional(),
    sourceResultPath: z.string().optional(),
    reviewedAt: z.string().min(1).optional()
  })
  .passthrough();

export type ReviewAttemptMetadata = z.infer<typeof reviewAttemptMetadataSchema>;

export function formatReviewAttemptMetadataIssues(
  issues: z.ZodError["issues"],
  metadataPath: string
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Review attempt metadata at ${metadataPath} is invalid: ${details}`;
}

export function parseReviewAttemptMetadata(
  raw: unknown,
  metadataPath: string
): ReviewAttemptMetadata {
  const parsed = reviewAttemptMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatReviewAttemptMetadataIssues(parsed.error.issues, metadataPath));
  }
  return parsed.data;
}

/**
 * Read and validate a present review-attempt `metadata.json`.
 * Callers that treat absence as incomplete must check existence first.
 * Malformed JSON and schema failures become path-specific errors; other I/O failures surface unchanged.
 */
export async function readReviewAttemptMetadataFile(
  metadataPath: string
): Promise<ReviewAttemptMetadata> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(metadataPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Review attempt metadata at ${metadataPath} is malformed JSON: ${error.message}`
      );
    }
    throw error;
  }
  return parseReviewAttemptMetadata(raw, metadataPath);
}

export function formatReviewResultArtifactIssues(
  issues: z.ZodError["issues"],
  resultPath: string
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Review result at ${resultPath} is invalid: ${details}`;
}

export function parseReviewResultArtifact(raw: unknown, resultPath: string): ReviewResult {
  const parsed = reviewResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatReviewResultArtifactIssues(parsed.error.issues, resultPath));
  }
  return parsed.data;
}

/**
 * Read and validate a present `review-result.json` next to an attempt metadata file.
 * Malformed JSON and schema failures become path-specific errors; other I/O failures surface unchanged.
 */
export async function readReviewResultArtifactFile(resultPath: string): Promise<ReviewResult> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(resultPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Review result at ${resultPath} is malformed JSON: ${error.message}`);
    }
    throw error;
  }
  return parseReviewResultArtifact(raw, resultPath);
}
