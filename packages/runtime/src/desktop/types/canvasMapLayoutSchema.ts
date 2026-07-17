import { ZodError, z } from "zod";

export const CANVAS_MAP_LAYOUT_VERSION = "desktop-canvas-map-layout/v1" as const;

export const canvasMapLayoutNodeSchema = z
  .object({
    canvasId: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite()
  })
  .strict();

export const canvasMapLayoutFileSchema = z
  .object({
    version: z.literal(CANVAS_MAP_LAYOUT_VERSION),
    projectId: z.string().min(1),
    nodes: z.array(canvasMapLayoutNodeSchema).superRefine((nodes, ctx) => {
      const seen = new Set<string>();
      for (let index = 0; index < nodes.length; index += 1) {
        const canvasId = nodes[index]?.canvasId;
        if (!canvasId) {
          continue;
        }
        if (seen.has(canvasId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate canvasId '${canvasId}'`,
            path: [index, "canvasId"]
          });
        }
        seen.add(canvasId);
      }
    }),
    updatedAt: z.string().datetime()
  })
  .strict();

export type DesktopCanvasMapLayoutNode = z.infer<typeof canvasMapLayoutNodeSchema>;
export type DesktopCanvasMapLayout = z.infer<typeof canvasMapLayoutFileSchema>;

export type CanvasMapLayoutIssue = {
  path: string;
  message: string;
};

export type CanvasMapLayoutErrorCode =
  | "canvas_map_layout_json"
  | "canvas_map_layout_invalid"
  | "canvas_map_layout_project_mismatch";

export class CanvasMapLayoutError extends Error {
  readonly code: CanvasMapLayoutErrorCode;
  readonly path: string;
  readonly issues: CanvasMapLayoutIssue[];

  constructor(input: {
    code: CanvasMapLayoutErrorCode;
    path: string;
    message: string;
    issues?: CanvasMapLayoutIssue[];
  }) {
    super(input.message);
    this.name = "CanvasMapLayoutError";
    this.code = input.code;
    this.path = input.path;
    this.issues = input.issues ?? [];
  }

  static fromZod(filePath: string, error: ZodError): CanvasMapLayoutError {
    const issues = error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "",
      message: issue.message
    }));
    const detail =
      issues.length > 0
        ? issues
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join("; ")
        : error.message;
    return new CanvasMapLayoutError({
      code: "canvas_map_layout_invalid",
      path: filePath,
      message: `Invalid canvas map layout file '${filePath}': ${detail}`,
      issues
    });
  }

  static fromJson(filePath: string, cause: unknown): CanvasMapLayoutError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new CanvasMapLayoutError({
      code: "canvas_map_layout_json",
      path: filePath,
      message: `Invalid JSON in canvas map layout file '${filePath}': ${message}`,
      issues: [{ path: "", message }]
    });
  }

  static projectMismatch(
    filePath: string,
    fileProjectId: string,
    expectedProjectId: string
  ): CanvasMapLayoutError {
    return new CanvasMapLayoutError({
      code: "canvas_map_layout_project_mismatch",
      path: filePath,
      message: `Canvas map layout projectId '${fileProjectId}' does not match project '${expectedProjectId}' (file: ${filePath}).`,
      issues: [
        {
          path: "projectId",
          message: `Expected '${expectedProjectId}', received '${fileProjectId}'`
        }
      ]
    });
  }
}

/**
 * Structural parse only. Does not reconcile against the current project canvas set.
 */
export function parseCanvasMapLayoutFile(input: unknown, filePath: string): DesktopCanvasMapLayout {
  const parsed = canvasMapLayoutFileSchema.safeParse(input);
  if (!parsed.success) {
    throw CanvasMapLayoutError.fromZod(filePath, parsed.error);
  }
  return parsed.data;
}
