import { workspaceMappingMissingInventory } from "./workspaceExecutionPlaneInventory.mappingMissing.js";
import {
  canvasRuntimeHostBindingInventory,
  runtimeNotAttachedInventory
} from "./workspaceExecutionPlaneInventory.runtimeAttachment.js";
import { workspaceAgentHostsInventory } from "./workspaceExecutionPlaneInventory.workspaceAgentHosts.js";
import { workspaceMappingsInventory } from "./workspaceExecutionPlaneInventory.workspaceMappings.js";
import {
  inventoryEntry,
  type WorkspaceExecutionPlaneInventoryEntry
} from "./workspaceExecutionPlaneInventoryTypes.js";

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
    ...runtimeNotAttachedInventory,
    inventoryEntry(
      "rna-localFilesystemSnapshotEvidence-test",
      "runtime_not_attached",
      "runtime_attachment",
      "packages/server/src/__tests__/localFilesystemSnapshotEvidence.test.ts",
      "permission failure availability reason runtime_not_attached",
      "Local filesystem snapshot permission failures retain the existing runtime attachment response."
    ),
    inventoryEntry(
      "wm-wsServerErrorIsolation-test",
      "workspaceMappings",
      "endpoint_readiness",
      "packages/server/src/__tests__/wsServerErrorIsolation.test.ts",
      "readiness.workspaceMappings: []",
      "WS transport isolation clients report empty mapping observations in Host hello."
    ),
    inventoryEntry(
      "rna-wsServerErrorIsolation-test",
      "runtime_not_attached",
      "runtime_attachment",
      "packages/server/src/__tests__/wsServerErrorIsolation.test.ts",
      "availability response reason runtime_not_attached",
      "WS transport isolation verifies healthy and replacement Host RPC availability responses."
    )
  ];

/** Explicit unknown list so later phases cannot drop blockers by omitting a filter. */
export const WORKSPACE_EXECUTION_PLANE_UNKNOWN_ENTRIES: readonly WorkspaceExecutionPlaneInventoryEntry[] =
  WORKSPACE_EXECUTION_PLANE_INVENTORY.filter((entry) => entry.classification === "unknown");
