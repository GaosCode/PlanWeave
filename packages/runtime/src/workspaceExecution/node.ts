export {
  assertValidatedWorkspaceAuthorityBinding,
  assertRemoteWorkAuthorityMatchesBinding,
  isOwnerCanvasRemoteAuthorityBinding,
  createLocalPackageAuthoritySource,
  createWorkspaceAuthorityBindingResolver
} from "./authorityBinding.js";
export type {
  LocalWorkspaceAuthoritySnapshot,
  LocalWorkspaceAuthoritySourcePort,
  RemoteWorkspaceAuthoritySnapshot,
  RemoteWorkspaceAuthoritySourcePort,
  ValidatedWorkspaceAuthorityBinding,
  WorkspaceAuthorityBindingPort
} from "./authorityBinding.js";
export { WorkspaceExecutionCoordinator } from "./coordinator.js";
export type { WorkspaceExecutionCoordinatorResult } from "./coordinator.js";
export { projectWorkspaceExecutionCoordinatorView } from "./nodeView.js";
export {
  createPackageWorkspaceExecutionSessionRepository,
  parseWorkspaceExecutionSessionRecord,
  packageSessionStorageForBinding,
  WorkspaceExecutionSessionVersionConflictError
} from "./sessionRepository.js";
export type {
  WorkspaceExecutionSessionRecord,
  WorkspaceExecutionSessionCreateInput,
  WorkspaceExecutionSessionRepositoryPort,
  WorkspaceExecutionSessionStorage
} from "./sessionRepository.js";
export { WorkspaceExecutionError } from "./errors.js";
export { workspaceExecutionPortError } from "./errors.js";
export type { WorkspaceExecutionErrorCode, WorkspaceExecutionFailureKind } from "./errors.js";
export {
  executionScopeEquals,
  projectActionRequiredEvent,
  projectExecutionSelectedEvent,
  projectLocalTerminalEvent,
  projectRemoteExecutionEvents,
  projectRemoteInteractionEvent
} from "./eventProjection.js";
export { createLocalWorkspaceExecutionAdapter } from "./localExecutionAdapter.js";
export { createRemoteWorkspaceExecutionAdapter } from "./remoteExecutionAdapter.js";
export { resolveWorkspaceExecutionTarget } from "./targetResolution.js";
export type {
  LocalWorkspaceAdapterSnapshot,
  LocalWorkspaceExecutionAdapter,
  RemoteAgentCatalogPort,
  RemoteOperationCommandPort,
  RemoteOperationQueryPort,
  RemoteWorkspaceAdapterSnapshot,
  RemoteWorkspaceExecutionAdapter,
  WorkAuthorityPort,
  WorkspaceExecutionAdapterHandle,
  WorkspaceExecutionAdapterSnapshot,
  WorkspaceExecutionInteractionPort,
  WorkspaceExecutionTerminal
} from "./ports.js";
export * from "./browser.js";
