import { inventoryEntry } from "./workspaceExecutionPlaneInventoryTypes.js";

export const workspaceMappingsInventory = [
  inventoryEntry(
    "wm-hostReadiness-schema",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/agent-host-protocol/src/hostReadiness.ts",
    "hostReadinessObservationSchema.workspaceMappings",
    "Host protocol field: redacted workspace mapping observations."
  ),
  inventoryEntry(
    "wm-observeHostReadiness",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/agent-host/src/config/readiness.ts",
    "observeHostReadiness workspaceMappings",
    "Agent Host produces mapping status without exposing local paths."
  ),
  inventoryEntry(
    "wm-operatorHostAvailability",
    "workspaceMappings",
    "legacy_agent_access",
    "packages/server/src/hosts.ts",
    "operatorHostAvailability observation.workspaceMappings.find",
    "Workspace-scoped Host usability still fails closed when mapping is missing."
  ),
  inventoryEntry(
    "wm-proto-agentHostProtocol-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/agent-host-protocol/src/__tests__/agentHostProtocol.test.ts",
    "readiness fixture workspaceMappings",
    "Protocol tests round-trip Host readiness mapping observations."
  ),
  inventoryEntry(
    "wm-proto-canvasRuntimeProtocol-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/agent-host-protocol/src/__tests__/canvasRuntimeProtocol.test.ts",
    "readiness: { workspaceMappings: [] }",
    "Canvas runtime protocol fixtures include empty mapping observations."
  ),
  inventoryEntry(
    "wm-agentHostClient-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/agent-host/src/__tests__/agentHostClient.test.ts",
    "readiness.workspaceMappings",
    "Agent Host client tests report empty mapping observations."
  ),
  inventoryEntry(
    "wm-agentHostConfig-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/agent-host/src/__tests__/agentHostConfig.test.ts",
    "workspaceMappings status ready",
    "Config/readiness tests expect observed workspace mappings."
  ),
  inventoryEntry(
    "wm-desktop-collaborationServerE2E",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/desktop/src/__tests__/collaborationServerE2E.test.ts",
    "reportOnline workspaceMappings",
    "E2E Host heartbeat supplies mapping observations."
  ),
  inventoryEntry(
    "wm-desktop-hostAdministration",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/desktop/src/__tests__/hostAdministration.test.tsx",
    "operator host view workspaceMappings",
    "Host administration UI tests stub mapping observations."
  ),
  inventoryEntry(
    "wm-desktop-selfHostedTwoClientE2E",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/desktop/src/__tests__/support/selfHostedTwoClientE2E.ts",
    "reportOnline workspaceMappings",
    "Two-client E2E harness reports mapping ready."
  ),
  inventoryEntry(
    "wm-desktop-tailscaleProxyTwoDesktopE2E",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/desktop/src/__tests__/tailscaleProxyTwoDesktopE2E.test.ts",
    "reportOnline workspaceMappings",
    "Tailscale two-desktop E2E reports mapping ready."
  ),
  inventoryEntry(
    "wm-dist-adapterContract",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/distributed-integration/src/__tests__/canvasRuntimeAdapterContract.test.ts",
    "workspaceMappings: []",
    "Adapter contract Host readiness includes mapping array."
  ),
  inventoryEntry(
    "wm-dist-artifactLoopback",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/distributed-integration/src/__tests__/canvasRuntimeArtifactLoopback.test.ts",
    "workspaceMappings: []",
    "Loopback Host readiness includes mapping array."
  ),
  inventoryEntry(
    "wm-catalog-test-ready-fixture",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/agentEndpointCatalog.test.ts",
    "readyHost readinessObservation.workspaceMappings",
    "Catalog unit fixture supplies a ready mapping observation."
  ),
  inventoryEntry(
    "wm-catalog-test-empty-observation",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/agentEndpointCatalog.test.ts",
    "workspaceMappings: [] / status missing",
    "Catalog unit tests treat empty or missing mapping observations as valid availability payload."
  ),
  inventoryEntry(
    "wm-agentEndpointHttp-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/agentEndpointHttp.test.ts",
    "reportOnline workspaceMappings ready",
    "HTTP catalog tests report mapping ready; grant-without-mapping is not covered."
  ),
  inventoryEntry(
    "wm-authorityEnforcement-ready",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/authorityEnforcement.test.ts",
    "reportOnline workspaceMappings ready",
    "Authority tests usually report mapping ready as Host observation."
  ),
  inventoryEntry(
    "wm-authorityEnforcement-empty-gate",
    "workspaceMappings",
    "legacy_agent_access",
    "packages/server/src/__tests__/authorityEnforcement.test.ts",
    "name: workspace_mapping_missing setup workspaceMappings: []",
    "Authority matrix still treats empty mappings as Host not ready."
  ),
  inventoryEntry(
    "wm-canvasRuntimeCommandCoordinator-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/canvasRuntimeCommandCoordinator.test.ts",
    "workspaceMappings ready",
    "Runtime command tests report mapping ready."
  ),
  inventoryEntry(
    "wm-hostEnrollment-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/hostEnrollment.test.ts",
    "workspaceMappings workspace-readiness",
    "Enrollment tests report mapping observations after register."
  ),
  inventoryEntry(
    "wm-hostLiveness-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/hostLiveness.test.ts",
    "workspaceMappings workspace-a ready",
    "Liveness tests carry mapping observations in heartbeats."
  ),
  inventoryEntry(
    "wm-hostReservations-ready",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/hostReservations.test.ts",
    "workspaceMappings ready",
    "Reservation tests usually report mapping ready."
  ),
  inventoryEntry(
    "wm-hostReservations-empty",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/hostReservations.test.ts",
    "workspaceMappings: []",
    "Grant-authorized reservation fixture uses empty mapping observations as valid Host readiness."
  ),
  inventoryEntry(
    "wm-hosts-test-empty-fleet",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/hosts.test.ts",
    "readyObservation workspaceMappings: []",
    "Fleet readiness tests use empty mappings as a valid observation payload."
  ),
  inventoryEntry(
    "wm-humanRemoteHttp-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/humanRemoteHttp.test.ts",
    "workspaceMappings ready",
    "Human remote HTTP fixture reports mapping ready."
  ),
  inventoryEntry(
    "wm-remoteAgentAccessPolicy-ready",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentAccessPolicy.test.ts",
    "workspaceMappings ready",
    "Access-policy tests report mapping ready for overlay hosts."
  ),
  inventoryEntry(
    "wm-remoteAgentAccessPolicy-empty",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentAccessPolicy.test.ts",
    "workspaceMappings: []",
    "Access-policy repair-host fixture reports empty mapping observations."
  ),
  inventoryEntry(
    "wm-remoteAgentAuthorizationMatrix-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentAuthorizationMatrix.test.ts",
    "workspaceMappings ready",
    "Authorization matrix Host observations include mappings."
  ),
  inventoryEntry(
    "wm-remoteAgentCatalogDispatchFeatures-ready",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentCatalogDispatchFeatures.test.ts",
    "reportReady workspaceMappings",
    "Catalog/dispatch feature tests report mapping ready."
  ),
  inventoryEntry(
    "wm-remoteAgentCatalogDispatchFeatures-empty",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentCatalogDispatchFeatures.test.ts",
    "workspaceMappings: []",
    "Feature tests report empty mapping observations as valid catalog availability payload."
  ),
  inventoryEntry(
    "wm-remoteAgentEnrollment-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentEnrollment.test.ts",
    "workspaceMappings: []",
    "Enrollment tests report empty mapping observations for fleet Hosts."
  ),
  inventoryEntry(
    "wm-remoteAgentRegistryMigration-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentRegistryMigration.test.ts",
    "workspaceMappings ready/empty",
    "Registry migration Host heartbeats include mapping observations."
  ),
  inventoryEntry(
    "wm-remoteAgentRepository-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentRepository.test.ts",
    "workspaceMappings: []",
    "Repository tests report empty mapping observations."
  ),
  inventoryEntry(
    "wm-remoteAgentSync-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteAgentSync.test.ts",
    "workspaceMappings: []",
    "Sync tests report empty mapping observations."
  ),
  inventoryEntry(
    "wm-remoteBlockCoordinator-ready",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteBlockCoordinator.test.ts",
    "workspaceMappings ready",
    "Coordinator tests usually report mapping ready."
  ),
  inventoryEntry(
    "wm-remoteBlockCoordinator-empty",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteBlockCoordinator.test.ts",
    "workspaceMappings: []",
    "Coordinator fleet-unbound fixtures report empty mapping observations."
  ),
  inventoryEntry(
    "wm-remoteBlockCoordinatorCrash-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteBlockCoordinatorCrash.test.ts",
    "workspaceMappings ready",
    "Crash-recovery Host heartbeats report mapping ready."
  ),
  inventoryEntry(
    "wm-remoteBlockCoordinatorStartup-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteBlockCoordinatorStartup.test.ts",
    "workspaceMappings ready",
    "Startup Host heartbeats report mapping ready."
  ),
  inventoryEntry(
    "wm-remoteControlService-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteControlService.test.ts",
    "workspaceMappings: []",
    "Operator control tests report empty mapping observations."
  ),
  inventoryEntry(
    "wm-remoteHostRuntimeAdapter-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteHostRuntimeAdapter.test.ts",
    "workspaceMappings ready",
    "Remote runtime adapter tests report mapping ready."
  ),
  inventoryEntry(
    "wm-remoteObservations-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteObservations.test.ts",
    "workspaceMappings ready",
    "Observation HTTP tests report mapping ready."
  ),
  inventoryEntry(
    "wm-remoteOperations-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/remoteOperations.test.ts",
    "workspaceMappings ready",
    "Remote operation tests report mapping ready."
  ),
  inventoryEntry(
    "wm-runtimeHostLocator-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/runtimeHostLocator.test.ts",
    "workspaceMappings ready",
    "Locator tests report mapping ready on the Host heartbeat."
  ),
  inventoryEntry(
    "wm-runtimeRpcWebSocket-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/runtimeRpcWebSocket.test.ts",
    "readiness.workspaceMappings: []",
    "Runtime RPC WS fixtures include empty mapping observations."
  ),
  inventoryEntry(
    "wm-serverCompositionStageH-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/serverCompositionStageH.test.ts",
    "workspaceMappings ready",
    "Composition stage H Host heartbeats report mapping ready."
  ),
  inventoryEntry(
    "wm-fixture-remoteBlockCoordinator",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/support/remoteBlockCoordinatorFixture.ts",
    "workspaceMappings ready",
    "Coordinator fixture reports mapping ready."
  ),
  inventoryEntry(
    "wm-fixture-remoteDispatch",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/support/remoteDispatchFixture.ts",
    "workspaceMappings ready",
    "Dispatch fixture reports mapping ready."
  ),
  inventoryEntry(
    "wm-fixture-gapHttp",
    "workspaceMappings",
    "legacy_agent_access",
    "packages/server/src/__tests__/support/workspaceExecutionPlaneGapHttpFixture.ts",
    "workspaceMappings empty or ready",
    "Gap HTTP fixtures report empty mappings for grant-without-mapping and ready mappings to isolate auto-prepare."
  ),
  inventoryEntry(
    "wm-fixture-gapCanvasRuntimeHost",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/support/workspaceExecutionPlaneGapCanvasRuntimeHost.ts",
    "workspaceMappings ready",
    "Pathless auto-prepare Host hello reports mapping ready plus canvas-runtime capability."
  ),
  inventoryEntry(
    "wm-tailscaleProxyTransport-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/tailscaleProxyTransport.test.ts",
    "workspaceMappings ready",
    "Tailscale proxy transport tests report mapping ready."
  ),
  inventoryEntry(
    "wm-workAssignmentDispatch-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/workAssignmentDispatch.test.ts",
    "workspaceMappings ready",
    "Work assignment dispatch tests report mapping ready."
  ),
  inventoryEntry(
    "wm-workAssignmentDispatchFixture",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/workAssignmentDispatchFixture.ts",
    "workspaceMappings ready",
    "Work assignment fixture reports mapping ready."
  ),
  inventoryEntry(
    "wm-workAssignmentService-ready",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/workAssignmentService.test.ts",
    "workspaceMappings ready",
    "Work assignment service tests usually report mapping ready."
  ),
  inventoryEntry(
    "wm-workAssignmentService-empty",
    "workspaceMappings",
    "legacy_agent_access",
    "packages/server/src/__tests__/workAssignmentService.test.ts",
    "workspaceMappings: []",
    "Some assignment cases empty mappings to change Host ready facts."
  ),
  inventoryEntry(
    "wm-wsServer-test",
    "workspaceMappings",
    "endpoint_readiness",
    "packages/server/src/__tests__/wsServer.test.ts",
    "workspaceMappings ready",
    "WS server tests report mapping ready."
  )
];
