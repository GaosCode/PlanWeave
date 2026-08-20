import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(128);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const packageFingerprintSchema = z.string().regex(/^pkg-[a-f0-9]{64}$/);
const blockStatusSchema = z.enum([
  "planned",
  "ready",
  "in_progress",
  "completed",
  "blocked",
  "diverged",
  "needs_changes"
]);
const taskStatusSchema = z.enum(["planned", "ready", "in_progress", "implemented"]);

const blockSchema = z
  .object({
    ref: identifierSchema,
    blockId: identifierSchema,
    type: z.enum(["implementation", "review"]),
    title: z.string(),
    status: blockStatusSchema,
    executor: z.string().nullable(),
    requiredCapabilities: z.array(z.string()),
    promptMissing: z.boolean(),
    exceptionReason: z.string().nullable(),
    dispatchable: z.boolean(),
    remoteExecution: z.null()
  })
  .strict();

const taskSchema = z
  .object({
    taskId: identifierSchema,
    title: z.string(),
    status: taskStatusSchema,
    executor: z.string().nullable(),
    executorLabel: z.string(),
    promptMarkdown: z.string(),
    promptHash: z.string().optional(),
    promptMissing: z.boolean(),
    promptPreview: z.string(),
    sharedResources: z.array(z.string()),
    blocks: z.array(blockSchema),
    blockPreview: z.array(blockSchema),
    hiddenBlockRefs: z.array(z.string()),
    overflowBlockCount: z.number().int().nonnegative(),
    exceptions: z.array(
      z
        .object({
          ref: z.string(),
          reason: z.string(),
          source: z.enum(["blocked", "diverged", "needs_changes"])
        })
        .strict()
    )
  })
  .strict();

const layoutSchema = z
  .object({
    version: z.literal("desktop-layout/v1"),
    projectId: z.string().min(1),
    nodes: z.array(
      z
        .object({
          nodeId: z.string(),
          x: z.number(),
          y: z.number()
        })
        .strict()
    ),
    updatedAt: z.string().min(1)
  })
  .strict();

/**
 * Renderer-ready replica content — the sole authoritative canvas projection for shared mode.
 * Must carry graph, layout, prompts, dependencies, and runtime overlay fields together.
 */
export const collaborationCanvasReplicaProjectionSchema = z
  .object({
    authorityId: z.string().min(1),
    localProjectId: identifierSchema,
    localCanvasId: identifierSchema,
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema,
    revision: z.number().int().nonnegative(),
    contentDigest: digestSchema,
    canEdit: z.boolean(),
    optimisticOperationIds: z.array(identifierSchema),
    rejections: z
      .array(z.object({ operationId: identifierSchema, code: z.string() }).strict())
      .max(100),
    content: z
      .object({
        projectTitle: z.string(),
        graphVersion: z.string(),
        packageFingerprint: packageFingerprintSchema,
        tasks: z.array(taskSchema).max(10_000),
        edges: z
          .array(
            z
              .object({
                from: identifierSchema,
                to: identifierSchema,
                type: z.literal("depends_on")
              })
              .strict()
          )
          .max(50_000),
        sharedResourceGroups: z.array(
          z
            .object({
              name: z.string(),
              memberTaskIds: z.array(identifierSchema),
              memberBlockRefs: z.array(identifierSchema),
              activeBlockRefs: z.array(identifierSchema)
            })
            .strict()
        ),
        diagnostics: z.array(
          z.object({ code: z.string(), message: z.string(), path: z.string().optional() }).strict()
        ),
        layout: layoutSchema,
        blockDependenciesByRef: z.record(z.string(), z.array(z.string())),
        taskOpenFeedbackCountByTaskId: z.record(z.string(), z.number().int().nonnegative()),
        blockPromptMarkdownByRef: z.record(z.string(), z.string())
      })
      .strict()
  })
  .strict();
export type CollaborationCanvasReplicaProjection = z.infer<
  typeof collaborationCanvasReplicaProjectionSchema
>;

export const collaborationRemoteCanvasReplicaProjectionSchema =
  collaborationCanvasReplicaProjectionSchema
    .omit({ localProjectId: true, localCanvasId: true })
    .extend({ bindingKind: z.literal("remote") })
    .strict();
export type CollaborationRemoteCanvasReplicaProjection = z.infer<
  typeof collaborationRemoteCanvasReplicaProjectionSchema
>;

export const collaborationCanvasBindingReplicaProjectionSchema = z.union([
  collaborationCanvasReplicaProjectionSchema,
  collaborationRemoteCanvasReplicaProjectionSchema
]);
export type CollaborationCanvasBindingReplicaProjection = z.infer<
  typeof collaborationCanvasBindingReplicaProjectionSchema
>;

export const collaborationCanvasReplicaSignalSchema = z
  .object({
    type: z.literal("canvas.replica.changed"),
    projection: collaborationCanvasReplicaProjectionSchema
  })
  .strict();
export type CollaborationCanvasReplicaSignal = z.infer<
  typeof collaborationCanvasReplicaSignalSchema
>;
