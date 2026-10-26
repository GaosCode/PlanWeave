import { z } from "zod";
import type { ValidationIssue } from "../../types.js";

const searchResultKindSchema = z.enum([
  "task",
  "block",
  "prompt",
  "run_record",
  "review_attempt",
  "feedback"
]);
const searchMatchSchema = z.object({
  field: z.enum(["title", "body"]),
  start: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  excerpt: z.string(),
  excerptStart: z.number().int().nonnegative()
});
const searchResultSchema = z.object({
  kind: searchResultKindSchema,
  canvasId: z.string().optional(),
  canvasName: z.string().optional(),
  ref: z.string(),
  targetRef: z.string().optional(),
  title: z.string(),
  excerpt: z.string(),
  match: searchMatchSchema.optional(),
  recordId: z.string().optional(),
  path: z.string().optional()
});
const searchDiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  transitionId: z.string().optional()
}) satisfies z.ZodType<ValidationIssue>;

export const desktopSearchProjectionSchema = z.object({
  results: z.array(searchResultSchema),
  diagnostics: z.array(searchDiagnosticSchema),
  truncated: z.boolean()
});

export type DesktopSearchResultKind = z.infer<typeof searchResultKindSchema>;
export type DesktopSearchMatch = z.infer<typeof searchMatchSchema>;
export type DesktopSearchMatchField = DesktopSearchMatch["field"];
export type DesktopSearchResult = z.infer<typeof searchResultSchema>;
export type DesktopSearchProjection = z.infer<typeof desktopSearchProjectionSchema>;
