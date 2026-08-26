export {
  agentAccessAuthoritySchema,
  agentAccessAuthoritySnapshotSchema,
  authorizedRemoteAgentUseSchema,
  persistedRemoteAgentAccessSnapshotSchema,
  remoteAgentAccessModeSchema,
  remoteAgentAuthorizationErrorCodeSchema,
  remoteAgentEndpointAccessViewSchema,
  remoteAgentGrantRevisionSchema,
  remoteAgentPolicyRevisionSchema,
  remoteAgentRecordSchema,
  remoteAgentUseTargetSchema,
  remoteAgentWorkspaceGrantRecordSchema,
  runtimeAuthoritySchema,
  type AgentAccessAuthority,
  type AgentAccessAuthoritySnapshot,
  type AuthorizedRemoteAgentUse,
  type PersistedRemoteAgentAccessSnapshot,
  type RemoteAgentAccessMode,
  type RemoteAgentAuthorizationErrorCode,
  type RemoteAgentEndpointAccessView,
  type RemoteAgentGrantRevision,
  type RemoteAgentPolicyRevision,
  type RemoteAgentRecord,
  type RemoteAgentUseTarget,
  type RemoteExecutionTarget,
  type RemoteAgentWorkspaceGrantRecord,
  type RuntimeAuthority
} from "./schema.js";

export {
  RemoteAgentAuthorizationError,
  remoteAgentAuthorizationErrorCode
} from "./errors.js";

export {
  RemoteAgentRepository,
  RemoteAgentRepositoryError,
  type GrantRemoteAgentWorkspaceInput,
  type RegisterOrRestoreRemoteAgentInput,
  type RepairRemoteAgentOwnershipInput,
  type RevokeRemoteAgentGrantInput,
  type SetRemoteAgentAccessModeInput
} from "./repository.js";

export {
  RemoteAgentManagementService,
  type RemoteAgentManagementGetInput,
  type RemoteAgentManagementGrantWorkspaceInput,
  type RemoteAgentManagementRepairOwnershipInput,
  type RemoteAgentManagementRevokeAgentInput,
  type RemoteAgentManagementRevokeGrantInput,
  type RemoteAgentManagementSetAccessModeInput
} from "./management.js";

export { syncRemoteAgentsFromHost } from "./sync.js";

export {
  RemoteAgentAccessPolicy,
  authorizeRemoteAgentUseInputSchema,
  evaluateRemoteAgentAccessInputSchema,
  type AuthorizeRemoteAgentTargetPort,
  type AuthorizeRemoteAgentUseInput,
  type EvaluateRemoteAgentAccessInput,
  type EvaluatedRemoteAgentAccess,
  type RemoteAgentAccessPolicyOptions
} from "./accessPolicy.js";

export {
  listAuthorizedRemoteAgentEndpoints,
  type ListAuthorizedRemoteAgentEndpointsInput
} from "./catalog.js";

export {
  controlPlaneForTarget,
  deriveEndpointAvailabilityPolicy,
  deriveEndpointAvailabilityPolicyFromAuthorized,
  dispatchTarget,
  retryTarget,
  type EndpointAvailabilityPolicy
} from "./dispatchTarget.js";
