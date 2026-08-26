import { inventoryEntry } from "./workspaceExecutionPlaneInventoryTypes.js";

export const workspaceAgentHostsInventory = [
  inventoryEntry(
    "wah-identity-ddl",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/migrations/identity.ts",
    "CREATE TABLE workspace_agent_hosts",
    "Identity-cutover DDL for the workspace-scoped host projection table."
  ),
  inventoryEntry(
    "wah-identity-enrollment-fk",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/migrations/identity.ts",
    "FOREIGN KEY(workspace_id,host_id) REFERENCES workspace_agent_hosts",
    "workspace_host_enrollments rows must point at a projected host binding."
  ),
  inventoryEntry(
    "wah-stock-host-fleet-marker",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/migrations/stockHostFleet.ts",
    "stockHostFleetMigration comment",
    "Idempotent marker: exclusive rows stay as projection, not a usability wipe."
  ),
  inventoryEntry(
    "wah-workspaceIdsForHost",
    "workspace_agent_hosts",
    "unknown",
    "packages/server/src/identity/workspaceRepository.ts",
    "workspaceIdsForHost / workspaceForHost SELECT",
    "Same read feeds exclusive-bind, fleet-unbound detection, and grant checks. Blocks deletion until split."
  ),
  inventoryEntry(
    "wah-listHostViews",
    "workspace_agent_hosts",
    "legacy_agent_access",
    "packages/server/src/identity/workspaceRepository.ts",
    "listHostViews JOIN workspace_agent_hosts",
    "Operator/workspace identity HTTP lists hosts from projection rows."
  ),
  inventoryEntry(
    "wah-writeHostProjection",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/identity/workspaceRepository.ts",
    "writeHostProjection INSERT INTO workspace_agent_hosts",
    "bindHostToWorkspace / synchronizeHost write the identity projection."
  ),
  inventoryEntry(
    "wah-hostUsable",
    "workspace_agent_hosts",
    "unknown",
    "packages/server/src/identity/workspaceRepository.ts",
    "hostUsable SELECT workspace_id,revoked_at,credential_expires_at",
    "Unbound fleet is usable, but existing rows still act as a workspace access filter. Blocks deletion until split."
  ),
  inventoryEntry(
    "wah-writeEnrollmentProjection",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/identity/workspaceRepository.ts",
    "writeEnrollmentProjection SELECT host_id FROM workspace_agent_hosts",
    "Used enrollment grants require an existing workspace-host projection row."
  ),
  inventoryEntry(
    "wah-hosts-workspaceIdsForHosts",
    "workspace_agent_hosts",
    "unknown",
    "packages/server/src/hosts.ts",
    "workspaceIdsForHosts SELECT host_id,workspace_id",
    "Batch read of the mixed projection; Work assignment uses it as grant. Blocks deletion until split."
  ),
  inventoryEntry(
    "wah-hosts-listExclusivelyBoundToWorkspace",
    "workspace_agent_hosts",
    "unknown",
    "packages/server/src/hosts.ts",
    "listExclusivelyBoundToWorkspace HAVING COUNT(*)=1",
    "Comment calls this enrollment/runtime mapping, not grant. Dual purpose. Blocks deletion until split."
  ),
  inventoryEntry(
    "wah-hosts-bindToWorkspace",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/hosts.ts",
    "bindToWorkspace",
    "Explicit workspace projection write delegated to WorkspaceIdentityRepository."
  ),
  inventoryEntry(
    "wah-hostEnrollment-bind",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/hostEnrollment.ts",
    "hosts.bindToWorkspace(registration.host.id, workspaceId)",
    "Successful Host enrollment writes the workspace projection row."
  ),
  inventoryEntry(
    "wah-setupCode-bind",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/identity/setupCodeService.ts",
    "hosts.bindToWorkspace(registration.host.id, grant.workspaceId)",
    "Setup-code Host enrollment writes the same projection."
  ),
  inventoryEntry(
    "wah-identity-http-listHostViews",
    "workspace_agent_hosts",
    "legacy_agent_access",
    "packages/server/src/identity/workspaceIdentityHttp.ts",
    "GET identity hosts: listHostViews",
    "Workspace identity HTTP exposes projection hosts as membership visibility."
  ),
  inventoryEntry(
    "wah-remoteControl-listHostViews",
    "workspace_agent_hosts",
    "legacy_agent_access",
    "packages/server/src/remoteControlService.ts",
    "listHosts -> listHostViews",
    "Operator host page scoped to a workspace reads projection rows."
  ),
  inventoryEntry(
    "wah-remoteControl-workspaceIdForHost",
    "workspace_agent_hosts",
    "unknown",
    "packages/server/src/remoteControlService.ts",
    "workspaceIdForHost -> workspaceForHost",
    "Operator host workspace association and authorizeHostAccess share exclusive-bind. Blocks deletion until split."
  ),
  inventoryEntry(
    "wah-work-ports-authorizedForProject",
    "workspace_agent_hosts",
    "legacy_agent_access",
    "packages/server/src/work/ports.ts",
    "authorizedForProject via workspaceForHost / workspaceIdsForHosts",
    "Work assignment still treats exclusive projection bind as Host grant."
  ),
  inventoryEntry(
    "wah-authorityPolicy-workspaceForHost",
    "workspace_agent_hosts",
    "legacy_agent_access",
    "packages/server/src/work/authorityPolicy.ts",
    "assertExecutionTargetMutation workspaceForHost",
    "Exact-host assignment rejects Hosts whose exclusive bind is not this workspace."
  ),
  inventoryEntry(
    "wah-authorityService-workspaceForHost",
    "workspace_agent_hosts",
    "legacy_agent_access",
    "packages/server/src/work/authorityService.ts",
    "selectionAvailabilityReason workspaceForHost",
    "Host selection returns host_not_authorized unless exclusive bind matches the scope."
  ),
  inventoryEntry(
    "wah-distributedCoordination-workspaceForHost",
    "workspace_agent_hosts",
    "unknown",
    "packages/server/src/distributedCoordination.ts",
    "fleetUnbound / hostWorkspaceId / ownerPackageLocatorForHost",
    "Same exclusive-bind read drives fleet readiness, auth facts, and owner-package routing. Blocks deletion until split."
  ),
  inventoryEntry(
    "wah-test-agentEndpointHttp-delete",
    "workspace_agent_hosts",
    "legacy_agent_access",
    "packages/server/src/__tests__/agentEndpointHttp.test.ts",
    "DELETE FROM workspace_agent_hosts WHERE host_id=?",
    "HTTP catalog tests delete projection rows to observe exclusive-bind vs overlay."
  ),
  inventoryEntry(
    "wah-test-hostEnrollment-select",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/__tests__/hostEnrollment.test.ts",
    "SELECT workspace_id FROM workspace_agent_hosts WHERE host_id=?",
    "Enrollment tests assert the projection row written at register time."
  ),
  inventoryEntry(
    "wah-test-migrationReconciliation",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/__tests__/migrationReconciliation.test.ts",
    'table list includes "workspace_agent_hosts"',
    "Schema reconciliation lock for the identity projection table."
  ),
  inventoryEntry(
    "wah-test-remoteAgentRegistryMigration",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/__tests__/remoteAgentRegistryMigration.test.ts",
    "SELECT COUNT(*) FROM workspace_agent_hosts WHERE host_id=?",
    "Registry migration asserts projection rows survive Remote Agent cutover."
  ),
  inventoryEntry(
    "wah-test-stockHostFleetMigration",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/__tests__/stockHostFleetMigration.test.ts",
    "SELECT workspace_id, host_id FROM workspace_agent_hosts",
    "Stock-fleet lift keeps historical projection rows without wiping them."
  ),
  inventoryEntry(
    "wah-test-workspaceIdentityMigration",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/__tests__/workspaceIdentityMigration.test.ts",
    "workspace_agent_hosts table + SELECT COUNT/row",
    "Identity cutover tests create, copy, and count projection rows."
  ),
  inventoryEntry(
    "wah-test-hostReservations-unmapped",
    "workspace_agent_hosts",
    "enrollment_migration",
    "packages/server/src/__tests__/hostReservations.test.ts",
    "SELECT COUNT(*) FROM workspace_agent_hosts WHERE host_id=?",
    "Positive lock: grant-authorized reservation does not require a projection row."
  )
];
