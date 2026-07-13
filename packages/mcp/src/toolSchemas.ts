import type * as z from "zod/v4";
import { authoringToolOutputSchemas } from "./toolContracts/authoringOutputSchemas.js";
import { contentToolOutputSchemas } from "./toolContracts/contentOutputSchemas.js";
import { debugToolOutputSchemas } from "./toolContracts/debugOutputSchemas.js";
import { githubToolOutputSchemas } from "./toolContracts/githubOutputSchemas.js";
import { graphToolOutputSchemas } from "./toolContracts/graphOutputSchemas.js";
import { projectToolOutputSchemas } from "./toolContracts/projectOutputSchemas.js";
import { readToolOutputSchemas } from "./toolContracts/readOutputSchemas.js";
import { buildToolContractRegistry } from "./toolContracts/registry.js";
import { planweaveToolNames, type PlanweaveToolName } from "./toolTypes.js";

export const planweaveToolOutputSchemaRegistries = [
  authoringToolOutputSchemas,
  readToolOutputSchemas,
  projectToolOutputSchemas,
  graphToolOutputSchemas,
  contentToolOutputSchemas,
  debugToolOutputSchemas,
  githubToolOutputSchemas
] as const;

export const planweaveToolOutputSchemas = buildToolContractRegistry<z.core.$ZodLooseShape>(
  planweaveToolOutputSchemaRegistries,
  planweaveToolNames,
  "PlanWeave tool output schema"
) satisfies Record<PlanweaveToolName, z.core.$ZodLooseShape>;
