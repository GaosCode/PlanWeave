import { z } from "zod";
import { readJsonFile } from "../json.js";

/**
 * On-disk `results/<task>/feedback/<FE-*>/submissions/<FS-*>/metadata.json` shape.
 * Runtime owns this family. Incomplete mid-write candidates may omit identity fields
 * so directory scans can skip them; present fields must match these types.
 */
export const feedbackSubmissionMetadataSchema = z
  .object({
    feedbackId: z.string().min(1).optional(),
    submissionId: z.string().min(1).optional(),
    sourceReviewBlockRef: z.string().min(1).optional(),
    reportHash: z.string().min(1).optional(),
    submittedAt: z.string().min(1).optional()
  })
  .passthrough();

export type FeedbackSubmissionMetadata = z.infer<typeof feedbackSubmissionMetadataSchema>;

export function formatFeedbackSubmissionMetadataIssues(
  issues: z.ZodError["issues"],
  metadataPath: string
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Feedback submission metadata at ${metadataPath} is invalid: ${details}`;
}

export function parseFeedbackSubmissionMetadata(
  raw: unknown,
  metadataPath: string
): FeedbackSubmissionMetadata {
  const parsed = feedbackSubmissionMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatFeedbackSubmissionMetadataIssues(parsed.error.issues, metadataPath));
  }
  return parsed.data;
}

/**
 * Read and validate a present feedback-submission `metadata.json`.
 * Callers that treat absence as incomplete must check existence first.
 * Malformed JSON and schema failures become path-specific errors; other I/O failures surface unchanged.
 */
export async function readFeedbackSubmissionMetadataFile(
  metadataPath: string
): Promise<FeedbackSubmissionMetadata> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(metadataPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Feedback submission metadata at ${metadataPath} is malformed JSON: ${error.message}`
      );
    }
    throw error;
  }
  return parseFeedbackSubmissionMetadata(raw, metadataPath);
}
