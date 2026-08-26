export const WORKSPACE_EXECUTION_PLANE_TOKENS = [
  "workspace_agent_hosts",
  "workspaceMappings",
  "CanvasRuntimeHostBinding",
  "workspace_mapping_missing",
  "runtime_not_attached"
] as const;

export type WorkspaceExecutionPlaneInventoryKind =
  (typeof WORKSPACE_EXECUTION_PLANE_TOKENS)[number];

export const WORKSPACE_EXECUTION_PLANE_CLASSIFICATIONS = [
  "legacy_agent_access",
  "endpoint_readiness",
  "runtime_attachment",
  "enrollment_migration",
  "unknown"
] as const;

export type WorkspaceExecutionPlaneClassification =
  (typeof WORKSPACE_EXECUTION_PLANE_CLASSIFICATIONS)[number];

export type WorkspaceExecutionPlaneInventoryEntry = {
  id: string;
  kind: WorkspaceExecutionPlaneInventoryKind;
  classification: WorkspaceExecutionPlaneClassification;
  path: string;
  symbolOrSql: string;
  notes: string;
};

/** Inventory modules and lock test mention every token; completeness must skip them. */
export const WORKSPACE_EXECUTION_PLANE_INVENTORY_IGNORE_PATH_SUBSTRINGS = [
  "workspaceExecutionPlaneInventory"
] as const;

export function inventoryEntry(
  id: string,
  kind: WorkspaceExecutionPlaneInventoryKind,
  classification: WorkspaceExecutionPlaneClassification,
  path: string,
  symbolOrSql: string,
  notes: string
): WorkspaceExecutionPlaneInventoryEntry {
  return { id, kind, classification, path, symbolOrSql, notes };
}
