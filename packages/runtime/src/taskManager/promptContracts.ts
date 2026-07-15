import { z } from "zod";

export const promptSourceKinds = [
  "global",
  "projectCanvas",
  "projectGraph",
  "taskNode",
  "block"
] as const;

export const promptSourceSummarySchema = z
  .object({
    kind: z.enum(promptSourceKinds),
    label: z.string().min(1),
    included: z.boolean(),
    empty: z.boolean(),
    missing: z.boolean(),
    disabledReason: z.string().min(1).nullable(),
    preview: z.string()
  })
  .strict();

export type PromptSourceKind = (typeof promptSourceKinds)[number];
export type PromptSourceSummary = z.infer<typeof promptSourceSummarySchema>;

export type PromptSurface = {
  markdown: string;
  sources: PromptSourceSummary[];
};
