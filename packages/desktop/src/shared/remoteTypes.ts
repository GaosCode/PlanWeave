export const REMOTE_ROLES = ["viewer", "contributor", "maintainer", "owner"] as const
export type RemoteRole = (typeof REMOTE_ROLES)[number]

export type RemoteProfile = {
  id: string
  name: string
  serverUrl: string
  deviceId: string
  projectId?: string
  userId?: string
  createdAt: string
}

export type RemoteConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error"

export type LocalTeamHost = {
  profile: RemoteProfile
  localUrl: string
  inviteUrl: string
  port: number
  networkScope: "local" | "lan"
}

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
  description?: string
  baselineId?: string | null
  requirementIds?: string[]
  status: string
  version: number
  dependsOnTaskIds?: string[]
  policy: { parallel: boolean; locks: string[]; ownershipScopes: string[]; acceptanceChecks: string[]; reviewers: string[] }
}

export type RemoteConsensusBaseline = {
  id: string
  projectId: string
  revision: number
  status: "draft" | "frozen" | "superseded"
  title: string
  summary: string
  requirements: string[]
  constraints: string[]
  decisions: string[]
  acceptanceCriteria: string[]
  risks: string[]
  openQuestions: string[]
  citations: Array<{ kind: "message" | "attachment"; id: string }>
  createdByUserId: string
  createdAt: string
  frozenAt: string | null
}

export type RemoteCoordinationSnapshot = {
  phase: "planning" | "consensus" | "execution" | "review" | "completed"
  version: number
  activeBaselineId: string | null
  baselines: RemoteConsensusBaseline[]
  approvals: Array<{ baselineId: string; userId: string; decision: "approve" | "reject"; reason: string | null; createdAt: string }>
  preferences: Array<{ projectId: string; taskId: string; userId: string; note: string; createdAt: string }>
  agentProfiles: Array<{ projectId: string; userId: string; deviceId: string; kind: "codex" | "claude-code" | "opencode" | "pi" | "manual"; name: string; version: string | null; capabilities: string[]; updatedAt: string }>
  submissionEvidence: Array<{ submissionId: string; projectId: string; submittedByUserId: string; localChecks: Array<{ name: string; passed: boolean; output?: string }>; agentReport: string | null; bundleDigest: string | null; bundleSize: number | null; bundleStatus: "missing" | "imported" | "failed"; createdAt: string; updatedAt: string }>
}

export type RemoteAttachment = { id: string; projectId: string; uploaderUserId: string; size: number; digest: string; status: string; originalName: string; mediaType: string; createdAt: string; promotedAt: string | null }
export type RemoteAssignment = { id: string; projectId: string; taskId: string; taskTitle: string; assigneeUserId: string; status: string; version: number; branchName: string; baseCommit: string; leaseExpiresAt: string; currentSubmissionId: string | null; createdAt: string; updatedAt: string }
export type LocalTaskValidation = { assignmentId: string; headCommit: string; baseCommit: string; localChecks: Array<{ name: string; passed: boolean; output?: string }>; agentKind: string; agentVersion: string | null; agentReport: string; passed: boolean }
export type RemoteMergeQueue = { configured: boolean; submissions: Array<{ entryId: string; submissionId: string; headCommit: string; baseCommit: string; targetBranch: string; status: string; checkLogs: unknown; reviewVerdict: string | null; error: string | null; agentReview: string | null; agentVerdict: "approve" | "reject" | null; agentReviewedAt: string | null; sourceProjectionStatus: "updated" | "tracking_ref" | "failed" | null; sourceProjectionDetails: string | null; createdAt: string; updatedAt: string }> }

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
  eventId: string
  eventType: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  occurredAt: string
}

export const remoteCollaborationInvokeChannels = {
  createRemoteProfile: "planweave-remote:createRemoteProfile",
  startLocalTeamHost: "planweave-remote:startLocalTeamHost",
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
  getRemoteMergeStatus: "planweave-remote:getRemoteMergeStatus",
  getRemoteCoordination: "planweave-remote:getRemoteCoordination",
  createRemoteBaseline: "planweave-remote:createRemoteBaseline",
  decideRemoteBaseline: "planweave-remote:decideRemoteBaseline",
  freezeRemoteBaseline: "planweave-remote:freezeRemoteBaseline",
  uploadRemoteAttachment: "planweave-remote:uploadRemoteAttachment",
  registerRemoteAgent: "planweave-remote:registerRemoteAgent",
  preferRemoteTask: "planweave-remote:preferRemoteTask",
  getRemoteAssignments: "planweave-remote:getRemoteAssignments",
  heartbeatRemoteAssignment: "planweave-remote:heartbeatRemoteAssignment",
  validateRemoteAssignmentLocally: "planweave-remote:validateRemoteAssignmentLocally",
  submitRemoteAssignment: "planweave-remote:submitRemoteAssignment",
  getRemoteMergeQueue: "planweave-remote:getRemoteMergeQueue",
  reviewRemoteMerge: "planweave-remote:reviewRemoteMerge",
  generateRemoteBaseline: "planweave-remote:generateRemoteBaseline",
  generateRemoteTasks: "planweave-remote:generateRemoteTasks"
} as const

export const remoteEventChannel = "planweave-remote:remoteEvent"
export const remoteConnectChannel = "planweave-remote:remoteConnect"

export type PlanWeaveRemoteApi = {
  createRemoteProfile: (input: { name: string; serverUrl: string; deviceId: string; apiKey: string; projectId?: string; userId?: string }) => Promise<RemoteProfile>
  startLocalTeamHost: (input: { projectId: string; projectName: string; userId: string; deviceId: string; joinToken: string; port?: number; allowInsecureLan?: boolean; repositoryPath?: string; targetBranch?: string }) => Promise<LocalTeamHost>
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
  claimRemoteTask: (profileId: string, projectId: string, taskId: string, branchName: string, repositoryPath: string) => Promise<unknown>
  getRemoteMergeStatus: (profileId: string, projectId: string) => Promise<RemoteMergeStatus>
  getRemoteCoordination: (profileId: string, projectId: string) => Promise<RemoteCoordinationSnapshot>
  createRemoteBaseline: (profileId: string, projectId: string, input: Omit<RemoteConsensusBaseline, "id" | "projectId" | "revision" | "status" | "createdByUserId" | "createdAt" | "frozenAt">) => Promise<RemoteConsensusBaseline>
  decideRemoteBaseline: (profileId: string, projectId: string, baselineId: string, decision: "approve" | "reject", reason?: string) => Promise<unknown>
  freezeRemoteBaseline: (profileId: string, projectId: string, baselineId: string) => Promise<RemoteConsensusBaseline>
  uploadRemoteAttachment: (profileId: string, projectId: string, filePath: string) => Promise<RemoteAttachment>
  registerRemoteAgent: (profileId: string, projectId: string) => Promise<unknown>
  preferRemoteTask: (profileId: string, projectId: string, taskId: string, note: string) => Promise<unknown>
  getRemoteAssignments: (profileId: string, projectId: string) => Promise<RemoteAssignment[]>
  heartbeatRemoteAssignment: (profileId: string, projectId: string, assignmentId: string, expectedVersion: number) => Promise<unknown>
  validateRemoteAssignmentLocally: (profileId: string, projectId: string, assignmentId: string, repositoryPath: string) => Promise<LocalTaskValidation>
  submitRemoteAssignment: (profileId: string, projectId: string, assignmentId: string, repositoryPath: string, validation: LocalTaskValidation) => Promise<unknown>
  getRemoteMergeQueue: (profileId: string, projectId: string) => Promise<RemoteMergeQueue>
  reviewRemoteMerge: (profileId: string, projectId: string, entryId: string, decision: "approve" | "reject", repositoryPath: string) => Promise<unknown>
  generateRemoteBaseline: (profileId: string, projectId: string, repositoryPath: string) => Promise<unknown>
  generateRemoteTasks: (profileId: string, projectId: string, repositoryPath: string) => Promise<unknown>
  onRemoteEvent: (callback: (payload: RemoteEventPayload) => void) => () => void
  onRemoteConnect: (callback: (payload: RemoteConnectEventPayload) => void) => () => void
}
