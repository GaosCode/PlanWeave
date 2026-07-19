import { isAbsolute } from "node:path";
import { z } from "zod";
import { readJsonFile } from "./json.js";

export const projectKinds = ["external", "managed"] as const;

export type ProjectKind = (typeof projectKinds)[number];

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), { message: "must be an absolute path" });

/**
 * On-disk `project.json` shape before workspace normalization.
 * `kind` is optional so legacy managed metadata under mcp-projects/mcp-imports can still parse;
 * {@link normalizeProjectMetadata} applies the intentional missing-`kind` rule.
 */
export const projectMetadataSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    rootPath: absolutePathSchema,
    kind: z.enum(projectKinds).optional(),
    sourceRoot: absolutePathSchema.nullable().optional(),
    createdAt: z.string().datetime()
  })
  .strict();

export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

export function formatProjectMetadataIssues(
  issues: z.ZodError["issues"],
  projectFile: string
): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Project metadata at ${projectFile} is invalid: ${details}`;
}

export function parseProjectMetadata(raw: unknown, projectFile: string): ProjectMetadata {
  const parsed = projectMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatProjectMetadataIssues(parsed.error.issues, projectFile));
  }
  return parsed.data;
}

/**
 * Read and validate `project.json` at the file boundary.
 * Callers that treat absence as a product state must check existence first.
 * Malformed JSON and schema failures become path-specific errors; other I/O failures surface unchanged.
 */
export async function readProjectMetadataFile(projectFile: string): Promise<ProjectMetadata> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(projectFile);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Project metadata at ${projectFile} is malformed JSON: ${error.message}`
      );
    }
    throw error;
  }
  return parseProjectMetadata(raw, projectFile);
}
