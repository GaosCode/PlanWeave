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
    "wmm-operatorControl-reason",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/agent-host-protocol/src/operatorControl.ts",
    "operatorHostAvailabilityReasonSchema",
    "Operator Host availability reason enum still includes mapping-missing."
  ),
  inventoryEntry(
    "wmm-hosts-operatorHostAvailability",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/server/src/hosts.ts",
    'operatorHostAvailability reason: "workspace_mapping_missing"',
    "Workspace-scoped Host usability returns mapping-missing when observation lacks the workspace."
  ),
  inventoryEntry(
    "wmm-i18nEn-hostAvailability",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/desktop/src/renderer/i18nEn.ts",
    "hostAvailability_workspace_mapping_missing / hostAvailabilityAction_*",
    "English operator Host availability copy for mapping-missing."
  ),
  inventoryEntry(
    "wmm-i18nZhCn-hostAvailability",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/desktop/src/renderer/i18nZhCn.ts",
    "hostAvailability_workspace_mapping_missing / hostAvailabilityAction_*",
    "Chinese operator Host availability copy for mapping-missing."
  ),
  inventoryEntry(
    "wmm-hostAvailabilityCard",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/desktop/src/renderer/settings/HostAvailabilityCard.tsx",
    "t(`hostAvailability_${reason}`)",
    "Operator Host card interpolates availability reasons including mapping-missing."
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
    "wmm-test-hosts",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/server/src/__tests__/hosts.test.ts",
    "hostExecutionProfileAvailability reason workspace_mapping_missing",
    "Hosts unit tests expect workspace-bound readiness to fail without mappings."
  ),
  inventoryEntry(
    "wmm-test-authorityEnforcement",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/server/src/__tests__/authorityEnforcement.test.ts",
    'name: "workspace_mapping_missing"',
    "Authority matrix case empties mappings to produce mapping-missing unreadiness."
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
