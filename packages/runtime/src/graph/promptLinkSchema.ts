import { z } from "zod";

export const promptLinkRestoreSchema = z
  .object({
    packagePath: z.string().min(1),
    linkTarget: z.string().min(1),
    targetPackagePath: z.string().min(1),
    targetContentHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export type PromptLinkRestore = z.infer<typeof promptLinkRestoreSchema>;
