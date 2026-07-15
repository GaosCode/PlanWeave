import { z } from "zod";

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
