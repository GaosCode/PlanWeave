import { inventoryEntry } from "./workspaceExecutionPlaneInventoryTypes.js";

export const canvasRuntimeHostBindingInventory = [
  inventoryEntry(
    "crhb-type",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/canvas/runtimeHostLocator.ts",
    "export type CanvasRuntimeHostBinding",
    "Logical workspace/project/host binding that materializes Canvas runtime."
  ),
  inventoryEntry(
    "crhb-repository",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/canvas/runtimeHostLocator.ts",
    "CanvasRuntimeHostBindingRepository",
    "Persists canvas_runtime_host_bindings from Host runtimeProjects observations."
  ),
  inventoryEntry(
    "crhb-locator",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/canvas/runtimeHostLocator.ts",
    "CanvasRuntimeHostLocator.locate / locateAuthorizedHost",
    "Resolves which attached Host currently carries a Canvas runtime; locateAuthorizedHost routes an already-authorized Host without a persisted ready binding."
  ),
  inventoryEntry(
    "crhb-hosts-runtimeBindings",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/hosts.ts",
    "runtimeBindings: CanvasRuntimeHostBindingRepository",
    "AgentHostRepository owns the binding repository used by runtime location."
  ),
  inventoryEntry(
    "crhb-ddl",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/migrations/canvasRuntimeHostBinding.ts",
    "CREATE TABLE canvas_runtime_host_bindings",
    "DDL for logical Canvas-to-Host bindings; filesystem locations stay private."
  ),
  inventoryEntry(
    "crhb-evidence-migration",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/migrations/canvasRuntimeHostBindingEvidence.ts",
    "canvasRuntimeHostBindingEvidenceMigration",
    "Adds operation/attempt/generation/revision evidence columns; PK unchanged."
  ),
  inventoryEntry(
    "crhb-ensure-attachment",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/canvas/runtimeAttachment.ts",
    "ensureRuntimeAttachmentForOperation",
    "Server-internal operation-scoped attachment after an accepted operation+reservation; not Grant."
  ),
  inventoryEntry(
    "crhb-upsert-operation",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/canvas/runtimeHostLocator.ts",
    "upsertOperationAttachment",
    "Repository API that upserts attachment evidence without renaming the table."
  ),
  inventoryEntry(
    "crhb-test-ensure-attachment",
    "CanvasRuntimeHostBinding",
    "runtime_attachment",
    "packages/server/src/__tests__/runtimeAttachment.test.ts",
    "ensureRuntimeAttachmentForOperation",
    "First run creates one binding; idempotent reenter does not duplicate; active lease refuses Host swap; Host row id is the generation; later attempt can write a new generation; attachment requires an accepted operation."
  )
];

export const runtimeNotAttachedInventory = [
  inventoryEntry(
    "rna-collaboration-schema",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/collaboration-protocol/src/runtimeAvailability.ts",
    "canvasRuntimeUnavailableReasonSchema",
    "Desktop/Server availability contract reason when no Host is attached."
  ),
  inventoryEntry(
    "rna-host-protocol-schema",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/agent-host-protocol/src/canvasRuntimeProtocol.ts",
    "canvasRuntimeUnavailableReasonSchema",
    "Host protocol availability/error reason when runtime is not attached."
  ),
  inventoryEntry(
    "rna-locator-unavailable",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/canvas/runtimeHostLocator.ts",
    "LocatedCanvasRuntimeHost reason runtime_not_attached",
    "Locator returns this when no canvas_runtime_host_bindings exist for the scope."
  ),
  inventoryEntry(
    "rna-executionRuntimePort",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/canvas/executionRuntimePort.ts",
    "CanvasRuntimeUnavailableError",
    "Default Canvas runtime unavailable reason is runtime_not_attached."
  ),
  inventoryEntry(
    "rna-localFilesystemAdapter",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/canvas/localFilesystemRuntimeAdapter.ts",
    "readAvailability / acquire reason runtime_not_attached",
    "Local filesystem adapter reports unattached when no exact location exists."
  ),
  inventoryEntry(
    "rna-remoteHostAdapter",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/canvas/remoteHostRuntimeAdapter.ts",
    "acquire/readAvailability map locator unavailable",
    "Remote adapter maps locator miss (non-offline) to runtime_not_attached."
  ),
  inventoryEntry(
    "rna-work-runtimePort",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/work/runtimePort.ts",
    "WorkRuntimeUnavailableError runtime_not_attached",
    "Work facts port throws this when no runtime package lease exists."
  ),
  inventoryEntry(
    "rna-http-availability",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/canvas/http.ts",
    "GET canvas runtime availability",
    "HTTP availability payload can carry runtime_not_attached from the adapter."
  ),
  inventoryEntry(
    "rna-availabilityService",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/canvas/runtimeAvailabilityService.ts",
    "CanvasRuntimeAvailabilityService",
    "Projects execution-device availability including unattached into collaboration DTO."
  ),
  inventoryEntry(
    "rna-ipc-channel",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/shared/collaborationIpc.ts",
    "readCollaborationCanvasBindingRuntimeAvailability / initializeWorkspaceCanvasRuntime",
    "IPC channels that transport availability (including unattached) and explicit initialize."
  ),
  inventoryEntry(
    "rna-ipc-contract-types",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/shared/collaborationRuntimeAvailability.ts",
    "PlanWeaveCollaborationRuntimeAvailabilityApi",
    "Renderer/main contract for availability read and workspace initialize/reset."
  ),
  inventoryEntry(
    "rna-preload",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/preload/preload.ts",
    "readCollaborationCanvasBindingRuntimeAvailability / initializeWorkspaceCanvasRuntime",
    "Preload forwards availability and initialize IPC; payload may be runtime_not_attached."
  ),
  inventoryEntry(
    "rna-collaborationHandlers",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/main/collaboration/collaborationHandlers.ts",
    "initializeWorkspaceCanvasRuntime / readCanvasRuntimeAvailability handlers",
    "Main process IPC handlers for initialize and availability read."
  ),
  inventoryEntry(
    "rna-collaborationService",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/main/collaboration/collaborationService.ts",
    "initializeWorkspaceCanvasRuntime / readCanvasRuntimeAvailability",
    "Desktop collaboration service performs initialize and availability reads."
  ),
  inventoryEntry(
    "rna-availabilityCoordinator",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/main/collaboration/CanvasRuntimeAvailabilityCoordinator.ts",
    "readRuntimeAvailability",
    "Main-process coordinator parses CanvasRuntimeAvailability including unattached."
  ),
  inventoryEntry(
    "rna-useWorkspaceRuntime",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/renderer/hooks/useWorkspaceRuntime.ts",
    "api.initializeWorkspaceCanvasRuntime",
    "Renderer still calls explicit initialize when availability is unattached."
  ),
  inventoryEntry(
    "rna-graphView",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/renderer/views/GraphView.tsx",
    "availability.reason === runtime_not_attached",
    "Graph view suppresses user-facing copy for unattached (returns null)."
  ),
  inventoryEntry(
    "rna-test-runtimeAvailability-protocol",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/collaboration-protocol/src/__tests__/runtimeAvailability.test.ts",
    "reason: runtime_not_attached",
    "Protocol tests accept unattached as a valid unavailable reason."
  ),
  inventoryEntry(
    "rna-test-agentHostState",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/agent-host/src/__tests__/agentHostState.test.ts",
    "kind unavailable reason runtime_not_attached",
    "Agent Host state tests stub unattached availability."
  ),
  inventoryEntry(
    "rna-test-canvasRuntimeService",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/agent-host/src/__tests__/canvasRuntimeService.test.ts",
    "error.code runtime_not_attached",
    "Agent Host canvas runtime service tests error with unattached."
  ),
  inventoryEntry(
    "rna-test-collaborationClient",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/collaborationClient.test.ts",
    "reason: runtime_not_attached",
    "Collaboration client tests parse unattached availability."
  ),
  inventoryEntry(
    "rna-test-graphViewViewport",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/graphViewViewport.test.tsx",
    "reason: runtime_not_attached",
    "Graph viewport tests stub unattached availability."
  ),
  inventoryEntry(
    "rna-test-preloadBridge",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/preloadBridge.test.ts",
    "readCollaborationCanvasBindingRuntimeAvailability reason runtime_not_attached",
    "Preload bridge tests return unattached over the availability IPC channel."
  ),
  inventoryEntry(
    "rna-test-observerRefresh",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/useCollaborationRuntimeObserverRefresh.test.tsx",
    "reason: runtime_not_attached",
    "Observer refresh tests stub unattached availability."
  ),
  inventoryEntry(
    "rna-test-ownerFleet",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/workspaceAgentEndpointOwnerFleet.test.tsx",
    "reason: runtime_not_attached",
    "Owner-fleet UI tests stub unattached execution availability."
  ),
  inventoryEntry(
    "rna-test-endpointRun",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/workspaceAgentEndpointRun.test.tsx",
    "reason: runtime_not_attached",
    "Run-flow tests stub unattached availability before initialize."
  ),
  inventoryEntry(
    "rna-test-workspaceCanvasCommands",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/workspaceCanvasCommands.test.tsx",
    "reason: runtime_not_attached",
    "Canvas command tests stub unattached availability."
  ),
  inventoryEntry(
    "rna-test-workspaceCanvasSession",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/desktop/src/__tests__/workspaceCanvasSession.test.ts",
    "reason: runtime_not_attached",
    "Workspace canvas session tests stub unattached availability."
  ),
  inventoryEntry(
    "rna-test-adapterContract",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/distributed-integration/src/__tests__/canvasRuntimeAdapterContract.test.ts",
    "reason: runtime_not_attached",
    "Adapter contract expects unattached when no binding/location exists."
  ),
  inventoryEntry(
    "rna-test-canvasCommandHttp",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/canvasCommandHttp.test.ts",
    "reason: runtime_not_attached",
    "Canvas command HTTP tests return unattached availability."
  ),
  inventoryEntry(
    "rna-test-gapHttp",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/workspaceExecutionPlaneGapHttp.test.ts",
    "reason: runtime_not_attached",
    "Gap HTTP tests drive canvas command HTTP with unattached execution to lock view/edit."
  ),
  inventoryEntry(
    "rna-test-availabilityService",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/canvasRuntimeAvailabilityService.test.ts",
    "reason: runtime_not_attached",
    "Availability service tests project unattached execution device state."
  ),
  inventoryEntry(
    "rna-test-remoteHostRuntimeAdapter",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/remoteHostRuntimeAdapter.test.ts",
    "code/reason runtime_not_attached",
    "Remote adapter tests map missing bindings to unattached."
  ),
  inventoryEntry(
    "rna-test-runtimeHostLocator",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/runtimeHostLocator.test.ts",
    "reason: runtime_not_attached",
    "Locator tests expect unattached when binding rows are absent."
  ),
  inventoryEntry(
    "rna-test-runtimeProjectRegistry",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/runtimeProjectRegistry.test.ts",
    "reason: runtime_not_attached",
    "Registry tests report unattached when the exact binding path is gone."
  ),
  inventoryEntry(
    "rna-test-runtimeRpcBroker",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/runtimeRpcBroker.test.ts",
    "availabilityResponse runtime_not_attached",
    "Runtime RPC broker tests propagate unattached availability."
  ),
  inventoryEntry(
    "rna-test-serverComposition",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/serverComposition.test.ts",
    "error: runtime_not_attached",
    "Composition tests surface unattached on assignment/availability."
  ),
  inventoryEntry(
    "rna-test-serverCompositionCleanup",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/serverCompositionCleanup.test.ts",
    "reason: runtime_not_attached",
    "Cleanup tests stub unattached availability."
  ),
  inventoryEntry(
    "rna-test-workRuntimeFactsPort",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/workRuntimeFactsPort.test.ts",
    "WorkRuntimeUnavailableError runtime_not_attached",
    "Work facts port tests throw unattached when no lease exists."
  ),
  inventoryEntry(
    "rna-test-wsServer",
    "runtime_not_attached",
    "runtime_attachment",
    "packages/server/src/__tests__/wsServer.test.ts",
    "kind unavailable reason runtime_not_attached",
    "WS server tests return unattached runtime availability."
  )
];
