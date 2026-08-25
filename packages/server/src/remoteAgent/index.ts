export {
  agentAccessAuthoritySchema,
  authorizedRemoteAgentUseSchema,
  remoteAgentAccessModeSchema,
  remoteAgentAuthorizationErrorCodeSchema,
  remoteAgentEndpointAccessViewSchema,
  remoteAgentGrantRevisionSchema,
  remoteAgentPolicyRevisionSchema,
  remoteAgentRecordSchema,
  remoteAgentWorkspaceGrantRecordSchema,
  runtimeAuthoritySchema,
  type AgentAccessAuthority,
  type AuthorizedRemoteAgentUse,
  type RemoteAgentAccessMode,
  type RemoteAgentAuthorizationErrorCode,
  type RemoteAgentEndpointAccessView,
  type RemoteAgentGrantRevision,
  type RemoteAgentPolicyRevision,
  type RemoteAgentRecord,
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
