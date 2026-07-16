import { z } from "zod";

export const REVIEW_RESULT_CONTENT_GUIDANCE = [
  "Write `content` as concise Markdown.",
  "For `needs_changes`, start each actionable finding on its own paragraph with `[P0]`, `[P1]`, `[P2]`, or `[P3]`, ordered by severity.",
  "Add a `## Verification` section listing the evidence and checks actually reviewed.",
  "For `passed`, summarize the acceptance evidence and verification without inventing findings."
].join("\n");

export const reviewResultSchema = z
  .object({
    reviewBlockRef: z.string().min(1),
    taskId: z.string().min(1),
    verdict: z.enum(["passed", "needs_changes"]),
    content: z
      .string()
      .refine((value) => value.trim().length > 0, "Review content must not be blank.")
  })
  .strict();

export type ReviewResult = z.infer<typeof reviewResultSchema>;
