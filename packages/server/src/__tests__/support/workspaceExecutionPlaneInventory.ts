import { workspaceMappingMissingInventory } from "./workspaceExecutionPlaneInventory.mappingMissing.js";
import {
  canvasRuntimeHostBindingInventory,
  runtimeNotAttachedInventory
} from "./workspaceExecutionPlaneInventory.runtimeAttachment.js";
import { workspaceAgentHostsInventory } from "./workspaceExecutionPlaneInventory.workspaceAgentHosts.js";
import { workspaceMappingsInventory } from "./workspaceExecutionPlaneInventory.workspaceMappings.js";
import type { WorkspaceExecutionPlaneInventoryEntry } from "./workspaceExecutionPlaneInventoryTypes.js";

export {
  WORKSPACE_EXECUTION_PLANE_CLASSIFICATIONS,
  WORKSPACE_EXECUTION_PLANE_INVENTORY_IGNORE_PATH_SUBSTRINGS,
  WORKSPACE_EXECUTION_PLANE_TOKENS,
  type WorkspaceExecutionPlaneClassification,
  type WorkspaceExecutionPlaneInventoryEntry,
  type WorkspaceExecutionPlaneInventoryKind
} from "./workspaceExecutionPlaneInventoryTypes.js";

export const WORKSPACE_EXECUTION_PLANE_INVENTORY: readonly WorkspaceExecutionPlaneInventoryEntry[] =
  [
    ...workspaceAgentHostsInventory,
    ...workspaceMappingsInventory,
    ...canvasRuntimeHostBindingInventory,
    ...workspaceMappingMissingInventory,
    ...runtimeNotAttachedInventory
  ];

/** Explicit unknown list so later phases cannot drop blockers by omitting a filter. */
export const WORKSPACE_EXECUTION_PLANE_UNKNOWN_ENTRIES: readonly WorkspaceExecutionPlaneInventoryEntry[] =
  WORKSPACE_EXECUTION_PLANE_INVENTORY.filter((entry) => entry.classification === "unknown");
