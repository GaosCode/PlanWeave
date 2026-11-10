import { z } from "zod";

export const reviewPipelinePromptWriteSchema = z
  .object({
    blockId: z.string(),
    markdown: z.string(),
    intent: z.literal("restore").optional()
  })
  .strict();

export type ReviewPipelinePromptWrite = z.infer<typeof reviewPipelinePromptWriteSchema>;

export const reviewPipelinePromptFileRestoreSchema = z
  .object({
    packagePath: z.string().min(1),
    markdown: z.string()
  })
  .strict();

export type ReviewPipelinePromptFileRestore = z.infer<typeof reviewPipelinePromptFileRestoreSchema>;
