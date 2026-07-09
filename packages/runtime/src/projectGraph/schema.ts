import { z } from "zod";
import { projectGraphEdgeTypes, supportedProjectGraphVersion } from "./types.js";

const canvasIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Canvas id must be CLI-safe: start with a letter or number, then use only letters, numbers, dots, underscores, or hyphens."
  );

const projectTaskRefSchema = z
  .object({
    canvasId: canvasIdSchema,
    taskId: z.string().min(1)
  })
  .strict();

const projectCanvasNodeSchema = z
  .object({
    id: canvasIdSchema,
    type: z.literal("canvas"),
    title: z.string().min(1),
    description: z.string().optional(),
    packageDir: z.string().min(1),
    stateFile: z.string().min(1),
    resultsDir: z.string().min(1)
  })
  .strict();

const projectCanvasEdgeSchema = z
  .object({
    from: canvasIdSchema,
    to: canvasIdSchema,
    type: z.enum(projectGraphEdgeTypes)
  })
  .strict();

const projectCrossTaskEdgeSchema = z
  .object({
    from: projectTaskRefSchema,
    to: projectTaskRefSchema,
    type: z.enum(projectGraphEdgeTypes)
  })
  .strict();

const projectGraphManifestSchemaShape = {
  version: z.literal(supportedProjectGraphVersion),
  canvases: z.array(projectCanvasNodeSchema).min(1),
  edges: z.array(projectCanvasEdgeSchema).default([]),
  crossTaskEdges: z.array(projectCrossTaskEdgeSchema).default([])
};

export const projectGraphManifestSchemaTopLevelFields = Object.freeze(
  Object.keys(projectGraphManifestSchemaShape)
);

export const projectGraphManifestSchema = z.object(projectGraphManifestSchemaShape).strict();

export type ParsedProjectGraphManifest = z.infer<typeof projectGraphManifestSchema>;
