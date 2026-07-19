import { z } from "zod";
import { blockTypes } from "../../types.js";

const blockTypeSchema = z.enum(blockTypes);

export const desktopAddTaskInputSchema = z
  .object({
    title: z.string(),
    promptMarkdown: z.string(),
    acceptance: z.array(z.string()).optional(),
    blockTypes: z.array(blockTypeSchema).optional(),
    executor: z.string().nullable().optional(),
    layoutPosition: z
      .object({
        x: z.number().finite(),
        y: z.number().finite()
      })
      .strict()
      .optional()
  })
  .strict();

export const desktopAddBlockInputSchema = z
  .object({
    taskId: z.string(),
    type: blockTypeSchema,
    title: z.string(),
    promptMarkdown: z.string(),
    executor: z.string().nullable().optional(),
    dependsOn: z.array(z.string()).optional()
  })
  .strict();

export const desktopGraphEditValidationInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("addDependencyEdge"),
      fromTaskId: z.string(),
      toTaskId: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal("removeDependencyEdge"),
      fromTaskId: z.string(),
      toTaskId: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal("removeTaskNode"),
      taskId: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal("removeBlock"),
      blockRef: z.string()
    })
    .strict()
]);

export type DesktopAddTaskInputParsed = z.infer<typeof desktopAddTaskInputSchema>;
export type DesktopAddBlockInputParsed = z.infer<typeof desktopAddBlockInputSchema>;
export type DesktopGraphEditValidationInputParsed = z.infer<
  typeof desktopGraphEditValidationInputSchema
>;
