import { z } from "zod";
import {
  edgeTypes,
  executorProfileSchema,
  reviewTriggerConditions,
  supportedManifestVersion
} from "../types.js";

/** Reserved lock name: mutually exclusive with every other in-progress block. */
export const EXCLUSIVE_LOCK = "exclusive" as const;

export const PARALLEL_SAFE_DEPRECATION_MESSAGE =
  '`parallel.safe` is deprecated; use `locks: ["exclusive"]` for mutual exclusion. Absent `parallel` means parallel-eligible with no locks.';

const blockParallelPolicySchema = z
  .object({
    /** @deprecated Use locks: ["exclusive"] instead of safe: false. */
    safe: z.boolean().optional(),
    locks: z.array(z.string().min(1)).default([]),
    /** Soft hints only; these never affect readiness or claimability. */
    sharedResources: z.array(z.string().min(1)).optional()
  })
  .strict();

const reviewHookSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("executable"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    executionPolicy: z.literal("trusted-local")
  })
  .strict();

const implementationBlockSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("implementation"),
    title: z.string().min(1),
    prompt: z.string().min(1),
    depends_on: z.array(z.string().min(1)).default([]),
    executor: z.string().min(1).optional(),
    parallel: blockParallelPolicySchema.default({ locks: [] })
  })
  .strict();

const reviewBlockSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("review"),
    title: z.string().min(1),
    prompt: z.string().min(1),
    depends_on: z.array(z.string().min(1)).default([]),
    executor: z.string().min(1).optional(),
    review: z
      .object({
        required: z.boolean().default(true),
        maxFeedbackCycles: z.number().int().nonnegative().default(1),
        preset: z.string().min(1).optional(),
        triggerCondition: z.enum(reviewTriggerConditions).optional(),
        inputContext: z.string().min(1).optional(),
        passCriteria: z.string().min(1).optional(),
        feedbackFormat: z.string().min(1).optional(),
        hook: reviewHookSchema.nullable().default(null)
      })
      .strict()
  })
  .strict();

export const manifestBlockSchema = z.discriminatedUnion("type", [
  implementationBlockSchema,
  reviewBlockSchema
]);

const taskNodeSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("task"),
    title: z.string().min(1),
    prompt: z.string().min(1),
    executor: z.string().min(1).optional(),
    acceptance: z.array(z.string().min(1)).min(1),
    blocks: z.array(manifestBlockSchema).min(1)
  })
  .strict();

export const manifestNodeSchema = taskNodeSchema;

const manifestSchemaShape = {
  version: z.literal(supportedManifestVersion),
  project: z
    .object({
      title: z.string().min(1),
      description: z.string()
    })
    .strict(),
  execution: z
    .object({
      defaultExecutor: z.string().min(1).optional(),
      parallel: z
        .object({
          enabled: z.boolean(),
          maxConcurrent: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  review: z
    .object({
      maxFeedbackCycles: z.number().int().nonnegative().default(1),
      completionPolicy: z.literal("strict")
    })
    .strict(),
  executors: z.record(z.string().min(1), executorProfileSchema).default({}),
  nodes: z.array(manifestNodeSchema),
  edges: z.array(
    z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.enum(edgeTypes)
      })
      .strict()
  )
};

export const manifestSchemaTopLevelFields = Object.freeze(Object.keys(manifestSchemaShape));

export const manifestSchema = z
  .object(manifestSchemaShape)
  .passthrough()
  .superRefine((manifest, context) => {
    const allowedTopLevelKeys = new Set(manifestSchemaTopLevelFields);
    for (const key of Object.keys(manifest)) {
      if (allowedTopLevelKeys.has(key)) {
        continue;
      }
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          key === "global_prompt"
            ? "manifest.global_prompt is not supported in plan-package/v1."
            : `Unrecognized key: "${key}"`,
        path: [key]
      });
    }
    const knownExecutors = new Set([
      "default",
      "manual",
      "codex",
      "codex-auto",
      "opencode",
      "claude-code",
      "claude-code-auto",
      "codex-acp",
      "opencode-acp",
      "claude-code-acp",
      "pi",
      "pi-auto",
      "pi-acp",
      ...Object.keys(manifest.executors ?? {})
    ]);
    if (
      manifest.execution.defaultExecutor &&
      !knownExecutors.has(manifest.execution.defaultExecutor)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `defaultExecutor '${manifest.execution.defaultExecutor}' does not reference a known executor profile.`,
        path: ["execution", "defaultExecutor"]
      });
    }
    for (const [nodeIndex, node] of manifest.nodes.entries()) {
      if (node.type !== "task") {
        continue;
      }
      if (node.executor && !knownExecutors.has(node.executor)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `task executor '${node.executor}' does not reference a known executor profile.`,
          path: ["nodes", nodeIndex, "executor"]
        });
      }
      for (const [blockIndex, block] of node.blocks.entries()) {
        if (block.executor && !knownExecutors.has(block.executor)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `block executor '${block.executor}' does not reference a known executor profile.`,
            path: ["nodes", nodeIndex, "blocks", blockIndex, "executor"]
          });
        }
      }
    }
  });

export type ParsedManifest = z.infer<typeof manifestSchema>;
