import { authoringToolDefinitions } from "./toolContracts/authoringDefinitions.js";
import { contentToolDefinitions } from "./toolContracts/contentDefinitions.js";
import { debugToolDefinitions } from "./toolContracts/debugDefinitions.js";
import { githubToolDefinitions } from "./toolContracts/githubDefinitions.js";
import { graphToolDefinitions } from "./toolContracts/graphDefinitions.js";
import { projectToolDefinitions } from "./toolContracts/projectDefinitions.js";
import { readToolDefinitions } from "./toolContracts/readDefinitions.js";
import { buildToolContractRegistry } from "./toolContracts/registry.js";
import type { ToolDefinition } from "./toolContracts/types.js";
import { planweaveToolNames, type PlanweaveToolName } from "./toolTypes.js";

export type { ToolDefinition } from "./toolContracts/types.js";

export const planweaveToolDefinitionRegistries = [
  authoringToolDefinitions,
  readToolDefinitions,
  projectToolDefinitions,
  graphToolDefinitions,
  contentToolDefinitions,
  debugToolDefinitions,
  githubToolDefinitions
] as const;

export const planweaveToolDefinitions = buildToolContractRegistry<ToolDefinition>(
  planweaveToolDefinitionRegistries,
  planweaveToolNames,
  "PlanWeave tool definition"
) satisfies Record<PlanweaveToolName, ToolDefinition>;
