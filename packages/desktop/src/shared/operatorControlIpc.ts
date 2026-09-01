/**
 * Operator-control IPC names are loadable by the sandboxed preload process.
 * Keep this module free of runtime agent-host-protocol imports.
 */
export const operatorControlInvokeChannels = {
  getStatus: "planweave-operator:getStatus",
  upsertProfile: "planweave-operator:upsertProfile",
  removeProfile: "planweave-operator:removeProfile",
  setActiveProfile: "planweave-operator:setActiveProfile",
  clearActiveProfile: "planweave-operator:clearActiveProfile",
  importCredential: "planweave-operator:importCredential",
  clearCredential: "planweave-operator:clearCredential",
  listHosts: "planweave-operator:listHosts",
  listAgentEndpoints: "planweave-operator:listAgentEndpoints",
  copyHostBootstrapHandoff: "planweave-operator:copyHostBootstrapHandoff",
  copyMemberSetupCode: "planweave-operator:copyMemberSetupCode",
  revokeHost: "planweave-operator:revokeHost",
  renewHostCredential: "planweave-operator:renewHostCredential",
  getLocalAgentHostStatus: "planweave-operator:getLocalAgentHostStatus",
  repairLocalAgentHost: "planweave-operator:repairLocalAgentHost",
  registerLocalAgentHost: "planweave-operator:registerLocalAgentHost",
  enrollLocalAgentHost: "planweave-operator:enrollLocalAgentHost",
  observeOwnerFleetRemoteOperation: "planweave-operator:observeOwnerFleetRemoteOperation",
  replayOwnerFleetRemoteOperationEvents: "planweave-operator:replayOwnerFleetRemoteOperationEvents",
  listRemoteAgents: "planweave-operator:listRemoteAgents",
  setRemoteAgentAccessMode: "planweave-operator:setRemoteAgentAccessMode",
  grantRemoteAgentWorkspace: "planweave-operator:grantRemoteAgentWorkspace",
  revokeRemoteAgentGrant: "planweave-operator:revokeRemoteAgentGrant",
  revokeRemoteAgent: "planweave-operator:revokeRemoteAgent",
  repairRemoteAgentOwnership: "planweave-operator:repairRemoteAgentOwnership"
} as const;

export const operatorControlStatusChangedChannel = "planweave-operator:statusChanged";
