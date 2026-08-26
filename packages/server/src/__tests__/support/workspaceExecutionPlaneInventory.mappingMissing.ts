import { inventoryEntry } from "./workspaceExecutionPlaneInventoryTypes.js";

export const workspaceMappingMissingInventory = [
  inventoryEntry(
    "wmm-agentEndpoint-schema",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/collaboration-protocol/src/agentEndpoint.ts",
    "agentEndpointUnavailableReasonSchema",
    "Catalog unavailable reason enum still includes workspace_mapping_missing."
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
    "wmm-catalog-return",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/server/src/agentEndpointCatalog.ts",
    'unavailableReason return "workspace_mapping_missing"',
    "Workspace catalog projection returns this reason when mappings are empty/missing."
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
    "wmm-formatAgentEndpointUnavailableReason",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/desktop/src/renderer/collaboration/formatAgentEndpointUnavailableReason.ts",
    "reasonTranslationKeys.workspace_mapping_missing",
    "Desktop maps catalog mapping-missing onto agentEndpointUnavailableWorkspaceMappingMissing."
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
    "wmm-test-agentEndpointCatalog",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/server/src/__tests__/agentEndpointCatalog.test.ts",
    "unavailableReason: workspace_mapping_missing",
    "Catalog unit tests currently expect mapping-missing unavailability."
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
    "wmm-test-catalogDispatchFeatures",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/server/src/__tests__/remoteAgentCatalogDispatchFeatures.test.ts",
    "unavailableReason: workspace_mapping_missing",
    "Catalog/dispatch feature tests lock overlay mapping-missing."
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
  ),
  inventoryEntry(
    "wmm-test-remoteBlockCoordinator-catalog",
    "workspace_mapping_missing",
    "legacy_agent_access",
    "packages/server/src/__tests__/remoteBlockCoordinator.test.ts",
    "unavailableReason: workspace_mapping_missing",
    "Coordinator test also asserts catalog overlay mapping-missing."
  )
];
