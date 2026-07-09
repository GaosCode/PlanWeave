import type * as z from "zod/v4";
import type { PlanweaveToolName } from "../toolTypes.js";

export const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false
} as const;

export const writeAnnotations = {
  readOnlyHint: false,
  openWorldHint: false
} as const;

export type ToolDefinition = {
  title: string;
  description: string;
  inputSchema?: z.core.$ZodLooseShape;
  annotations: typeof readOnlyAnnotations | typeof writeAnnotations;
};

export type PlanweavePartialToolDefinitionRegistry = Partial<
  Record<PlanweaveToolName, ToolDefinition>
>;

export type PlanweavePartialToolOutputSchemaRegistry = Partial<
  Record<PlanweaveToolName, z.core.$ZodLooseShape>
>;
