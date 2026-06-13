import { z } from "zod";
import { projectGraphEdgeTypes, supportedProjectGraphVersion } from "./types.js";

const projectTaskRefSchema = z
  .object({
    canvasId: z.string().min(1),
    taskId: z.string().min(1)
  })
  .strict();

const projectCanvasNodeSchema = z
  .object({
    id: z.string().min(1),
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
    from: z.string().min(1),
    to: z.string().min(1),
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

export const projectGraphManifestSchema = z
  .object({
    version: z.literal(supportedProjectGraphVersion),
    canvases: z.array(projectCanvasNodeSchema).min(1),
    edges: z.array(projectCanvasEdgeSchema).default([]),
    crossTaskEdges: z.array(projectCrossTaskEdgeSchema).default([])
  })
  .strict();

export type ParsedProjectGraphManifest = z.infer<typeof projectGraphManifestSchema>;
