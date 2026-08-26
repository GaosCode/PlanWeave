import { inventoryEntry } from "./workspaceExecutionPlaneInventoryTypes.js";

export const workspaceMappingMissingInventory = [
  inventoryEntry(
    "wmm-test-agentEndpoint-retired-reasons",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/collaboration-protocol/src/__tests__/agentEndpoint.test.ts",
    "rejects workspace_mapping_missing / workspace_mapping_invalid",
    "Catalog protocol test asserts retired mapping reasons are no longer valid unavailableReason values."
  ),
  inventoryEntry(
    "wmm-deployment-availability",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/collaboration-protocol/src/deployment.ts",
    "agentHostAvailabilityViewSchema.reason",
    "Deployment Host availability view still lists mapping-missing as a reason."
  ),
  inventoryEntry(
    "wmm-operatorSessionProvisioning-substring",
    "workspace_mapping_missing",
    "unknown",
    "packages/server/src/identity/operatorSessionProvisioning.ts",
    "operator_project_workspace_mapping_missing",
    "Substring hit: project→workspace mapping for operator sessions, not Agent catalog. Blocks deletion until this token is renamed or scoped out."
  ),
  inventoryEntry(
    "wmm-test-hostReservations-helper",
    "workspace_mapping_missing",
    "unknown",
    "packages/server/src/__tests__/hostReservations.test.ts",
    'throw new Error("workspace_mapping_missing")',
    "Test helper when fixture workspaceId is absent; not the protocol enum. Blocks deletion until renamed."
  ),
  inventoryEntry(
    "wmm-test-remoteBlockCoordinator-helper",
    "workspace_mapping_missing",
    "unknown",
    "packages/server/src/__tests__/remoteBlockCoordinator.test.ts",
    'throw new Error("workspace_mapping_missing")',
    "Test helper when fixture workspaceId is absent; not the protocol enum. Blocks deletion until renamed."
  )
];
