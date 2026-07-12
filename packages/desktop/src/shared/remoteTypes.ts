export const REMOTE_ROLES = ["viewer", "contributor", "maintainer", "owner"] as const
export type RemoteRole = (typeof REMOTE_ROLES)[number]

export type RemoteProfile = {
  id: string
  name: string
  serverUrl: string
  deviceId: string
  apiKey: string
  projectId?: string
  userId?: string
  createdAt: string
}

export type RemoteConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error"

export type RemoteProjectInfo = {
  id: string
  name: string
  version: number
  createdAt: string
}

export type RemoteMember = {
  userId: string
  displayName: string
  role: RemoteRole
  online: boolean
}

export type RemoteMessage = {
  id: string
  roomId: string
  authorUserId: string
  body: string
  kind: "text" | "system"
  createdAt: string
}

export type RemoteProposal = {
  id: string
  projectId: string
  title: string
  body: string
  status: "draft" | "open" | "approved" | "rejected" | "withdrawn"
  version: number
  createdByUserId: string
  createdAt: string
}

export type RemoteApproval = {
  id: string
  proposalId: string
  revisionId: string
  approverUserId: string
  decision: "approve" | "reject"
  reason: string | null
  createdAt: string
}

export type RemoteTask = {
  id: string
  taskId: string
  title: string
  status: string
  version: number
  policy: { parallel: boolean; locks: string[]; ownershipScopes: string[]; acceptanceChecks: string[]; reviewers: string[] }
}

export type RemoteMergeStatus = {
  aheadCount: number
  behindCount: number
  hasConflicts: boolean
  lastSyncedEventId: string | null
}

export type RemoteProjectSnapshot = {
  project: RemoteProjectInfo
  lastEventId: string
  planningRooms: Array<{
    id: string
    name: string
    archivedAt: string | null
  }>
  members: RemoteMember[]
  proposals: RemoteProposal[]
  mergeStatus: RemoteMergeStatus
}

export type RemoteConnectEventPayload = {
  profileId: string
  status: RemoteConnectionStatus
  projectId: string | null
  lastEventId: string | null
}

export type RemoteDisconnectPayload = {
  profileId: string
}

export type RemoteEventPayload = {
  profileId: string
  projectId: string
  eventType: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  occurredAt: string
}

export const remoteCollaborationInvokeChannels = {
  createRemoteProfile: "planweave-remote:createRemoteProfile",
  updateRemoteProfile: "planweave-remote:updateRemoteProfile",
  deleteRemoteProfile: "planweave-remote:deleteRemoteProfile",
  getRemoteProfile: "planweave-remote:getRemoteProfile",
  listRemoteProfiles: "planweave-remote:listRemoteProfiles",
  connectProfile: "planweave-remote:connectProfile",
  disconnectProfile: "planweave-remote:disconnectProfile",
  getRemoteConnectionStatus: "planweave-remote:getRemoteConnectionStatus",
  getRemoteProjectSnapshot: "planweave-remote:getRemoteProjectSnapshot",
  getRemotePlanningRooms: "planweave-remote:getRemotePlanningRooms",
  getRemoteMessages: "planweave-remote:getRemoteMessages",
  sendRemoteMessage: "planweave-remote:sendRemoteMessage",
  getRemoteProposals: "planweave-remote:getRemoteProposals",
  approveRemoteProposal: "planweave-remote:approveRemoteProposal",
  getRemoteMembers: "planweave-remote:getRemoteMembers",
  getRemoteTasks: "planweave-remote:getRemoteTasks",
  claimRemoteTask: "planweave-remote:claimRemoteTask",
  getRemoteMergeStatus: "planweave-remote:getRemoteMergeStatus"
} as const

export const remoteEventChannel = "planweave-remote:remoteEvent"
export const remoteConnectChannel = "planweave-remote:remoteConnect"

export type PlanWeaveRemoteApi = {
  createRemoteProfile: (input: { name: string; serverUrl: string; deviceId: string; apiKey: string; projectId?: string; userId?: string }) => Promise<RemoteProfile>
  updateRemoteProfile: (id: string, input: { name?: string; serverUrl?: string; deviceId?: string; apiKey?: string }) => Promise<RemoteProfile>
  deleteRemoteProfile: (id: string) => Promise<void>
  getRemoteProfile: (id: string) => Promise<RemoteProfile | null>
  listRemoteProfiles: () => Promise<RemoteProfile[]>
  connectProfile: (profileId: string, projectId: string) => Promise<void>
  disconnectProfile: (profileId: string) => Promise<void>
  getRemoteConnectionStatus: (profileId: string) => Promise<RemoteConnectionStatus>
  getRemoteProjectSnapshot: (profileId: string, projectId: string) => Promise<RemoteProjectSnapshot>
  getRemotePlanningRooms: (profileId: string, projectId: string) => Promise<Array<{ id: string; name: string; archivedAt: string | null }>>
  getRemoteMessages: (profileId: string, projectId: string, roomId: string) => Promise<RemoteMessage[]>
  sendRemoteMessage: (profileId: string, projectId: string, roomId: string, body: string) => Promise<RemoteMessage>
  getRemoteProposals: (profileId: string, projectId: string) => Promise<RemoteProposal[]>
  approveRemoteProposal: (profileId: string, projectId: string, proposalId: string, decision: "approve" | "reject", reason?: string) => Promise<RemoteApproval>
  getRemoteMembers: (profileId: string, projectId: string) => Promise<RemoteMember[]>
  getRemoteTasks: (profileId: string, projectId: string) => Promise<RemoteTask[]>
  claimRemoteTask: (profileId: string, projectId: string, taskId: string, branchName: string, baseCommit: string) => Promise<unknown>
  getRemoteMergeStatus: (profileId: string, projectId: string) => Promise<RemoteMergeStatus>
  onRemoteEvent: (callback: (payload: RemoteEventPayload) => void) => () => void
  onRemoteConnect: (callback: (payload: RemoteConnectEventPayload) => void) => () => void
}
