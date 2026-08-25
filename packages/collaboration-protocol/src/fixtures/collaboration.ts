import {
  agentHostEnrollmentSchema,
  agentHostIdentitySchema,
  agentHostIdentityViewSchema,
  deviceSessionSchema,
  humanBootstrapResponseSchema,
  humanPrincipalSchema,
  operatorSessionSchema,
  workspaceIdentityViewSchema,
  workspaceHumanPrincipalViewSchema,
  workspaceMembershipSchema,
  workspaceMembershipViewSchema,
  workspaceSchema,
  humanMemberPageSchema
} from "../identity.js";
import {
  identityMigrationMatrixSchema,
  identityMigrationStateSchema,
  legacyProjectWorkspaceMappingSchema
} from "../migration.js";
import {
  assignmentDisplayProjectionSchema,
  assignmentUpdateWireCommandSchema
} from "../assignment.js";
import {
  activityListPageSchema,
  activityRecordSchema,
  commentDisplayProjectionSchema,
  commentListPageSchema
} from "../comments.js";
import {
  activeWorkspaceConnectionViewSchema,
  parseCollaborationConnectionProfile,
  parseWorkspaceConnectionProfile,
  workspacePickerPageSchema
} from "../connection.js";
import {
  humanObserverCatchupRequiredSchema,
  humanObserverEventSchema,
  humanObserverWelcomeSchema
} from "../observer.js";
import { canvasAccessRecordSchema, projectAccessRecordSchema } from "../projectAccess.js";
import { packageSnapshotSchema } from "../packageSnapshot.js";
import {
  humanDeviceTokenSchema,
  humanIdentityTokenSchema,
  operatorCredentialTokenSchema,
  projectInvitationTokenSchema,
  setupCodeTokenSchema
} from "../primitives.js";
import {
  hostBootstrapEnrollmentSecretSchema,
  hostBootstrapHandoffViewSchema,
  setupCodeGrantSchema,
  setupCodeGrantViewSchema,
  setupCodeIssueResponseSchema,
  setupCodeRedeemDeviceResponseSchema,
  setupCodeRedeemHostResponseSchema,
  setupCodeRedeemOperatorResponseSchema,
  setupCodeRevocationSchema
} from "../setup.js";
import {
  canvasCommandAcceptedSchema,
  canvasCommandRejectedSchema,
  canvasCommandSubmitSchema,
  canvasJournalEntrySchema,
  canvasReconnectDeltaSchema,
  canvasReconnectRequestSchema,
  canvasReconnectSnapshotSchema,
  canvasSnapshotContentSchema
} from "../canvasCommands.js";
import { exampleCompleteContentVersion } from "./contentVersion.js";

/** Deterministic 43-char base64url secret segment (test-only; not a real secret). */
const SECRET_SEGMENT = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const exampleHumanDeviceToken = humanDeviceTokenSchema.parse(`pw_hdev_${SECRET_SEGMENT}`);
export const exampleHumanIdentityToken = humanIdentityTokenSchema.parse(`pw_hid_${SECRET_SEGMENT}`);
export const exampleInvitationToken = projectInvitationTokenSchema.parse(
  `pw_inv_${SECRET_SEGMENT}`
);

export const exampleConnectionProfile = parseCollaborationConnectionProfile({
  profileId: "profile-demo-001",
  displayName: "Local collab server",
  serverBaseUrl: "https://collab.example.com/",
  projectId: "project-demo-001",
  allowInsecureTransport: false,
  endpoint: {
    topology: "public_https",
    serverOrigin: "https://collab.example.com/",
    allowedClientOrigins: ["https://collab.example.com/"],
    tlsTrust: "system_ca"
  }
});

export const exampleLoopbackConnectionProfile = parseCollaborationConnectionProfile({
  profileId: "profile-loopback-001",
  displayName: "Loopback",
  serverBaseUrl: "http://127.0.0.1:8787/",
  projectId: "project-demo-001",
  allowInsecureTransport: true,
  endpoint: {
    topology: "loopback_http",
    serverOrigin: "http://127.0.0.1:8787/",
    allowedClientOrigins: ["http://127.0.0.1:8787/"],
    tlsTrust: "not_applicable"
  }
});

export const exampleWorkspaceConnectionProfile = parseWorkspaceConnectionProfile({
  schemaVersion: "workspace-identity/v1",
  profileId: "profile-workspace-001",
  displayName: "Workspace collaboration server",
  serverBaseUrl: "https://collab.example.com/",
  workspaceId: "workspace-demo-001",
  allowInsecureTransport: false
});

export const exampleWorkspace = workspaceSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  displayName: "PlanWeave Demo",
  createdAt: "2030-01-01T00:00:00.000Z",
  archivedAt: null
});

export const exampleProjectAccessRecord = projectAccessRecordSchema.parse({
  schemaVersion: "project-access/v1",
  registry: {
    projectRegistryId: "registry-project-demo-001",
    workspaceId: "workspace-demo-001",
    projectId: "project-demo-001"
  },
  visibility: "private",
  acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
  owner: "human-owner-001",
  updatedAt: "2030-01-01T00:00:00.000Z"
});

export const exampleCanvasAccessRecord = canvasAccessRecordSchema.parse({
  schemaVersion: "project-access/v1",
  registry: {
    projectRegistryId: "registry-project-demo-001",
    canvasRegistryId: "registry-canvas-demo-001",
    workspaceId: "workspace-demo-001",
    projectId: "project-demo-001",
    canvasId: "canvas-default"
  },
  visibility: "shared",
  acl: { revision: 2, updatedAt: "2030-01-01T00:00:00.000Z" },
  owner: "human-owner-001",
  publishSource: {
    localProjectId: "local-project-demo-001",
    localCanvasId: "canvas-default"
  },
  updatedAt: "2030-01-01T00:00:00.000Z"
});

export const examplePackageSnapshot = packageSnapshotSchema.parse({
  schemaVersion: "package-snapshot/v1",
  immutable: {
    snapshotId: "snapshot-demo-001",
    registry: {
      projectRegistryId: "registry-project-demo-001",
      canvasRegistryId: "registry-canvas-demo-001",
      workspaceId: "workspace-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-default"
    },
    sourceRevision: "git:demo-revision",
    createdAt: "2030-01-01T00:00:00.000Z",
    creator: { kind: "human", id: "human-owner-001", displayName: "Owner" },
    digestManifest: {
      manifest: { digestSha256: "a".repeat(64), sizeBytes: 128 },
      prompts: [],
      totalBytes: 128
    },
    migrationMarker: "digest_verified"
  },
  mutable: {
    state: "available",
    aclRevision: 2,
    visibility: { project: "private", canvas: "shared" },
    updatedAt: "2030-01-01T00:00:00.000Z",
    revokedAt: null,
    retentionOrder: 1,
    restoreMarker: "none"
  }
});

export const exampleWorkspacePrincipal = humanPrincipalSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  humanPrincipalId: "human-owner-001",
  displayName: "Owner",
  createdAt: "2030-01-01T00:00:00.000Z",
  revokedAt: null
});

export const exampleWorkspaceMembership = workspaceMembershipSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  membershipId: "membership-workspace-001",
  humanPrincipalId: "human-owner-001",
  role: "owner",
  revision: 1,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  revokedAt: null
});

export const exampleDeviceSession = deviceSessionSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  deviceSessionId: "device-session-001",
  humanPrincipalId: "human-owner-001",
  credentialSha256: "a".repeat(64),
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-02T00:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null
});

export const exampleOperatorSession = operatorSessionSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  operatorSessionId: "operator-session-001",
  operatorId: "operator-001",
  credentialSha256: "b".repeat(64),
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-02T00:00:00.000Z",
  revokedAt: null
});

export const exampleAgentHostIdentity = agentHostIdentitySchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  hostId: "host-001",
  displayName: "Build Host",
  capabilities: ["acp.codex", "workspace.git"],
  capacity: 2,
  credentialSha256: "c".repeat(64),
  createdAt: "2030-01-01T00:00:00.000Z",
  lastSeenAt: "2030-01-01T00:01:00.000Z",
  credentialExpiresAt: "2030-01-02T00:00:00.000Z",
  revokedAt: null
});

export const exampleAgentHostEnrollment = agentHostEnrollmentSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  enrollmentId: "enrollment-001",
  enrollmentCodeSha256: "d".repeat(64),
  credentialExpiresAt: "2030-01-03T00:00:00.000Z",
  expiresAt: "2030-01-02T00:00:00.000Z",
  usedAt: null,
  hostId: null,
  revokedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z"
});

export const exampleIdentityMigrationState = identityMigrationStateSchema.parse({
  schemaVersion: "workspace-identity-migration/v1",
  migrationId: "migration-001",
  legacyProjectId: "project-demo-001",
  workspaceId: "workspace-demo-001",
  fromVersion: 0,
  toVersion: 1,
  step: "map_legacy_project",
  status: "in_progress",
  interruptionMarker: "mapping_written",
  authoritativeReadVersion: "workspace-identity/v1",
  failureCode: null,
  updatedAt: "2030-01-01T00:01:00.000Z"
});

export const exampleLegacyProjectWorkspaceMapping = legacyProjectWorkspaceMappingSchema.parse({
  schemaVersion: "workspace-identity-migration/v1",
  mappingVersion: "legacy-project-workspace/v1",
  legacyProjectId: "project-demo-001",
  normalizedLegacyProjectIdentity: "legacy-project:project-demo-001",
  workspaceId: "workspace-demo-001",
  mappedAt: "2030-01-01T00:00:00.000Z"
});

export const exampleIdentityMigrationMatrix = identityMigrationMatrixSchema.parse({
  schemaVersion: "workspace-identity-migration/v1",
  migrationVersion: 1,
  readCutoverVersion: "workspace-identity/v1",
  entries: [
    {
      legacyVersion: 0,
      migrationStep: "map_legacy_project",
      authoritativeReadVersion: "workspace-identity/v1",
      interruptionMarker: "mapping_written",
      retryResult: "retry_idempotent",
      repairResult: "repair_required",
      rollbackResult: "rollback_to_legacy",
      readCutover: "legacy",
      partialFailureReadPolicy: "fail_closed"
    },
    {
      legacyVersion: 1,
      migrationStep: "cutover_authoritative_reads",
      authoritativeReadVersion: "workspace-identity/v1",
      interruptionMarker: "read_cutover_complete",
      retryResult: "resume_from_marker",
      repairResult: "repair_required",
      rollbackResult: "rollback_to_legacy",
      readCutover: "workspace",
      partialFailureReadPolicy: "fail_closed"
    }
  ]
});

export const exampleIdentityMigrationStateFixtures = [
  exampleIdentityMigrationState,
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "completed",
    step: "verify_cutover",
    interruptionMarker: "read_cutover_complete",
    failureCode: null
  }),
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "interrupted",
    interruptionMarker: "partial_backfill_failed",
    failureCode: "membership_backfill_failed"
  }),
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "repair_required",
    interruptionMarker: "partial_backfill_failed",
    failureCode: "repair_required"
  }),
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "rolled_back",
    step: "verify_cutover",
    interruptionMarker: "rollback_complete",
    failureCode: null
  })
] as const;

export const exampleWorkspaceRedactedViews = {
  workspace: workspaceIdentityViewSchema.parse(exampleWorkspace),
  principal: workspaceHumanPrincipalViewSchema.parse(exampleWorkspacePrincipal),
  membership: workspaceMembershipViewSchema.parse({
    ...exampleWorkspaceMembership,
    displayName: "Owner"
  }),
  host: agentHostIdentityViewSchema.parse({
    schemaVersion: exampleAgentHostIdentity.schemaVersion,
    workspaceId: exampleAgentHostIdentity.workspaceId,
    hostId: exampleAgentHostIdentity.hostId,
    displayName: exampleAgentHostIdentity.displayName,
    capabilities: exampleAgentHostIdentity.capabilities,
    capacity: exampleAgentHostIdentity.capacity,
    lastSeenAt: exampleAgentHostIdentity.lastSeenAt,
    credentialExpiresAt: exampleAgentHostIdentity.credentialExpiresAt,
    revokedAt: exampleAgentHostIdentity.revokedAt
  })
};

export const exampleBootstrapResponse = humanBootstrapResponseSchema.parse({
  workspaceId: "workspace-demo-001",
  principal: {
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    createdAt: "2030-01-01T00:00:00.000Z"
  },
  membership: {
    membershipId: "membership-001",
    projectId: "project-demo-001",
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    role: "owner",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  },
  device: {
    deviceCredentialId: "device-001",
    humanPrincipalId: "human-owner-001",
    mintedForProjectId: "project-demo-001",
    label: "Desktop",
    createdAt: "2030-01-01T00:00:00.000Z"
  },
  deviceToken: exampleHumanDeviceToken,
  created: true
});

export const exampleMemberPage = humanMemberPageSchema.parse({
  items: [
    {
      membershipId: "membership-001",
      projectId: "project-demo-001",
      humanPrincipalId: "human-owner-001",
      displayName: "Owner",
      role: "owner",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z"
    }
  ],
  nextCursor: null
});

export const exampleAssignmentProjection = assignmentDisplayProjectionSchema.parse({
  projectId: "project-demo-001",
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  target: { kind: "human", humanPrincipalId: "human-owner-001" },
  revision: 1,
  updatedBy: { kind: "human", id: "human-owner-001", displayName: "Owner" },
  updatedAt: "2030-01-01T00:01:00.000Z",
  human: {
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    membershipActive: true
  },
  availability: { status: "ready", reason: "ready" }
});

export const exampleAssignmentUpdateCommand = assignmentUpdateWireCommandSchema.parse({
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  target: { kind: "unassigned" },
  expectedRevision: 1,
  reason: "hand back to pool"
});

export const exampleCommentProjection = commentDisplayProjectionSchema.parse({
  commentId: "comment-001",
  projectId: "project-demo-001",
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  author: {
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    membershipActive: true
  },
  body: "Looks good so far.",
  bodyFormat: "markdown",
  revision: 1,
  createdAt: "2030-01-01T00:02:00.000Z",
  updatedAt: "2030-01-01T00:02:00.000Z",
  tombstoned: false,
  attachments: [],
  workItemPresence: "present"
});

export const exampleCommentListPage = commentListPageSchema.parse({
  items: [exampleCommentProjection],
  nextCursor: null
});

export const exampleActivityRecord = activityRecordSchema.parse({
  activityId: "activity-001",
  projectId: "project-demo-001",
  type: "comment_created",
  source: { kind: "comment", sourceId: "comment-001" },
  summary: {
    headline: "Owner commented on task-1",
    workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
    commentId: "comment-001",
    humanPrincipalId: "human-owner-001"
  },
  subjects: [
    {
      kind: "human",
      humanPrincipalId: "human-owner-001",
      displayName: "Owner"
    }
  ],
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  occurredAt: "2030-01-01T00:02:00.000Z"
});

export const exampleActivityListPage = activityListPageSchema.parse({
  items: [exampleActivityRecord],
  nextCursor: null
});

export const exampleObserverWelcome = humanObserverWelcomeSchema.parse({
  type: "human.observer.welcome",
  protocolVersion: 1,
  projectId: "project-demo-001",
  serverTime: "2030-01-01T00:03:00.000Z",
  cursor: 10
});

export const exampleObserverEvent = humanObserverEventSchema.parse({
  type: "human.observer.event",
  protocolVersion: 1,
  cursor: 11,
  previousCursor: 10,
  occurredAt: "2030-01-01T00:03:01.000Z",
  kind: "assignment",
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" }
});

export const exampleObserverCatchupRequired = humanObserverCatchupRequiredSchema.parse({
  type: "human.observer.catchup_required",
  protocolVersion: 1,
  reason: "retention_gap",
  resumeCursor: 100,
  droppedThroughCursor: 50
});

const canvasDigestA = "a".repeat(64);
const canvasDigestB = "b".repeat(64);
const canvasDigestC = "c".repeat(64);

const exampleCanvasAuthorizedScope = {
  workspaceId: "workspace-demo-001",
  projectId: "project-demo-001",
  canvasId: "canvas-default"
} as const;

const exampleCanvasIntent = {
  kind: "update_task_prompt" as const,
  taskId: "task-1",
  promptMarkdown: "# Updated task prompt"
};

/** Happy-path client submit (no actor / auth / path / revision override). */
export const exampleCanvasCommandSubmit = canvasCommandSubmitSchema.parse({
  type: "canvas.command.submit",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  projectId: "project-demo-001",
  canvasId: "canvas-default",
  operationId: "op-canvas-001",
  expectedRevision: 3,
  intent: exampleCanvasIntent
});

export const exampleCanvasCommandAccepted = canvasCommandAcceptedSchema.parse({
  type: "canvas.command.accepted",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  scope: exampleCanvasAuthorizedScope,
  operationId: "op-canvas-001",
  revision: 4,
  previousRevision: 3,
  contentDigest: canvasDigestB,
  journalEntryId: "journal-entry-004",
  actor: { kind: "human", id: "human-owner-001", displayName: "Owner" },
  acceptedAt: "2030-01-01T00:04:00.000Z",
  idempotentReplay: false
});

/** Duplicate operationId with identical intent → same accepted outcome, replay flag set. */
export const exampleCanvasCommandDuplicateOperationIdReplay = canvasCommandAcceptedSchema.parse({
  ...exampleCanvasCommandAccepted,
  idempotentReplay: true
});

/** Stale expectedRevision CAS rejection with authoritative conflict details. */
export const exampleCanvasCommandStaleRevisionRejected = canvasCommandRejectedSchema.parse({
  type: "canvas.command.rejected",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  projectId: "project-demo-001",
  canvasId: "canvas-default",
  operationId: "op-canvas-stale-001",
  code: "stale_revision",
  conflict: {
    expectedRevision: 2,
    authoritativeRevision: 4,
    authoritativeContentDigest: canvasDigestB
  }
});

/** ACL denial after Server authorization (client never supplies actor). */
export const exampleCanvasCommandRejectedAcl = canvasCommandRejectedSchema.parse({
  type: "canvas.command.rejected",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  projectId: "project-demo-001",
  canvasId: "canvas-default",
  operationId: "op-canvas-acl-001",
  code: "forbidden",
  detail: "canvas_write_denied"
});

export const exampleCanvasJournalEntry = canvasJournalEntrySchema.parse({
  schemaVersion: "canvas-journal/v1",
  entryId: "journal-entry-004",
  scope: exampleCanvasAuthorizedScope,
  revision: 4,
  previousRevision: 3,
  operationId: "op-canvas-001",
  intent: exampleCanvasIntent,
  intentDigest: canvasDigestC,
  contentDigest: canvasDigestB,
  actor: { kind: "human", id: "human-owner-001", displayName: "Owner" },
  acceptedAt: "2030-01-01T00:04:00.000Z"
});

/** Journal truncated: client afterRevision is before retained history → full snapshot. */
export const exampleCanvasReconnectTruncatedJournal = canvasReconnectSnapshotSchema.parse({
  type: "canvas.reconnect.snapshot",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  scope: exampleCanvasAuthorizedScope,
  reason: "truncated_journal",
  afterRevision: 1,
  snapshot: canvasSnapshotContentSchema.parse({
    metadata: {
      schemaVersion: "canvas-snapshot/v2",
      scope: exampleCanvasAuthorizedScope,
      revision: 4,
      contentDigest: exampleCompleteContentVersion.canonicalDigest,
      createdAt: "2030-01-01T00:04:00.000Z",
      sizeBytes: exampleCompleteContentVersion.totalBytes
    },
    encoding: "content_version_ref",
    content: {
      versionId: `version-${exampleCompleteContentVersion.canonicalDigest}`,
      canonicalDigest: exampleCompleteContentVersion.canonicalDigest,
      verification: "complete"
    }
  })
});

/** Malformed snapshot fixture for negative Server recovery tests (invalid digest length). */
export const exampleCanvasMalformedSnapshotInput = {
  type: "canvas.reconnect.snapshot",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  scope: exampleCanvasAuthorizedScope,
  reason: "digest_mismatch",
  afterRevision: 0,
  snapshot: {
    metadata: {
      schemaVersion: "canvas-snapshot/v2",
      scope: exampleCanvasAuthorizedScope,
      revision: 4,
      contentDigest: "not-a-sha256",
      createdAt: "2030-01-01T00:04:00.000Z"
    },
    encoding: "content_version_ref",
    content: {
      versionId: `version-${exampleCompleteContentVersion.canonicalDigest}`,
      canonicalDigest: exampleCompleteContentVersion.canonicalDigest,
      verification: "complete"
    }
  }
} as const;

/** Reconnect after disconnect with contiguous journal delta. */
export const exampleCanvasReconnectAfterDisconnect = canvasReconnectDeltaSchema.parse({
  type: "canvas.reconnect.delta",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  scope: exampleCanvasAuthorizedScope,
  afterRevision: 3,
  headRevision: 4,
  headContentDigest: canvasDigestB,
  entries: [exampleCanvasJournalEntry]
});

export const exampleCanvasReconnectRequest = canvasReconnectRequestSchema.parse({
  type: "canvas.reconnect.request",
  protocolVersion: 1,
  schemaVersion: "canvas-command/v1",
  projectId: "project-demo-001",
  canvasId: "canvas-default",
  afterRevision: 3,
  afterContentDigest: canvasDigestA
});

export const exampleSetupCode = setupCodeTokenSchema.parse(`pw_setup_${SECRET_SEGMENT}`);
export const exampleOperatorCredentialToken = operatorCredentialTokenSchema.parse(
  `pw_operator_${SECRET_SEGMENT}`
);
export const exampleHostCredentialToken = `pw_host_${SECRET_SEGMENT}` as const;
export const exampleHostEnrollmentCode = `pw_enroll_${SECRET_SEGMENT}` as const;

export const exampleSetupCodeGrant = setupCodeGrantSchema.parse({
  schemaVersion: "workspace-setup/v1",
  setupCodeId: "setup-code-001",
  workspaceId: "workspace-demo-001",
  purpose: "device_session",
  codeSha256: "e".repeat(64),
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T01:00:00.000Z",
  displayedAt: "2030-01-01T00:00:01.000Z",
  redeemedAt: null,
  revokedAt: null,
  redemptionSubjectId: null
});

export const exampleSetupCodeGrantView = setupCodeGrantViewSchema.parse({
  schemaVersion: "workspace-setup/v1",
  setupCodeId: exampleSetupCodeGrant.setupCodeId,
  workspaceId: exampleSetupCodeGrant.workspaceId,
  purpose: exampleSetupCodeGrant.purpose,
  state: "displayed",
  issuedAt: exampleSetupCodeGrant.issuedAt,
  expiresAt: exampleSetupCodeGrant.expiresAt,
  displayedAt: exampleSetupCodeGrant.displayedAt,
  redeemedAt: null,
  revokedAt: null
});

export const exampleSetupCodeIssueResponse = setupCodeIssueResponseSchema.parse({
  schemaVersion: "workspace-setup/v1",
  grant: exampleSetupCodeGrantView,
  setupCode: exampleSetupCode,
  displayOnce: true
});

export const exampleSetupCodeRedeemDeviceResponse = setupCodeRedeemDeviceResponseSchema.parse({
  schemaVersion: "workspace-setup/v1",
  purpose: "device_session",
  workspaceId: "workspace-demo-001",
  workspaceDisplayName: "PlanWeave Demo",
  connectionProfile: exampleWorkspaceConnectionProfile,
  humanPrincipalId: "human-owner-001",
  membershipId: "membership-workspace-001",
  role: "owner",
  deviceSessionId: "device-session-001",
  deviceToken: exampleHumanDeviceToken,
  deviceExpiresAt: "2030-01-02T00:00:00.000Z",
  identityCredentialId: "identity-credential-001",
  identityToken: exampleHumanIdentityToken,
  identityExpiresAt: "2031-01-01T00:00:00.000Z"
});

export const exampleSetupCodeRedeemOperatorResponse = setupCodeRedeemOperatorResponseSchema.parse({
  schemaVersion: "workspace-setup/v1",
  purpose: "operator_session",
  workspaceId: "workspace-demo-001",
  workspaceDisplayName: "PlanWeave Demo",
  connectionProfile: exampleWorkspaceConnectionProfile,
  operatorId: "operator-001",
  operatorSessionId: "operator-session-001",
  operatorToken: exampleOperatorCredentialToken,
  sessionExpiresAt: "2030-01-02T00:00:00.000Z"
});

export const exampleSetupCodeRedeemHostResponse = setupCodeRedeemHostResponseSchema.parse({
  schemaVersion: "workspace-setup/v1",
  purpose: "host_enrollment",
  workspaceId: "workspace-demo-001",
  workspaceDisplayName: "PlanWeave Demo",
  connectionProfile: exampleWorkspaceConnectionProfile,
  enrollmentAttemptId: "enroll-setup-001",
  enrollmentId: "enrollment-001",
  hostId: "host-001",
  hostCredentialExpiresAt: "2030-01-03T00:00:00.000Z"
});

export const exampleSetupCodeRevocation = setupCodeRevocationSchema.parse({
  schemaVersion: "workspace-setup/v1",
  revocationId: "setup-revocation-001",
  setupCodeId: "setup-code-001",
  workspaceId: "workspace-demo-001",
  purpose: "device_session",
  revokedAt: "2030-01-01T00:30:00.000Z",
  reason: "operator rotated onboarding code"
});

export const exampleWorkspacePickerPage = workspacePickerPageSchema.parse({
  schemaVersion: "workspace-setup/v1",
  items: [
    {
      schemaVersion: "workspace-setup/v1",
      workspaceId: "workspace-demo-001",
      displayName: "PlanWeave Demo",
      role: "owner",
      archivedAt: null,
      membershipActive: true
    },
    {
      schemaVersion: "workspace-setup/v1",
      workspaceId: "workspace-other-001",
      displayName: "Other Workspace",
      role: "member",
      archivedAt: null,
      membershipActive: true
    }
  ],
  nextCursor: null
});

export const exampleActiveWorkspaceConnectionLocalOnly = activeWorkspaceConnectionViewSchema.parse({
  schemaVersion: "workspace-setup/v1",
  status: "local_only",
  profile: null,
  workspaceId: null,
  workspaceDisplayName: null,
  connectedAt: null,
  error: null
});

export const exampleActiveWorkspaceConnectionConnected = activeWorkspaceConnectionViewSchema.parse({
  schemaVersion: "workspace-setup/v1",
  status: "connected",
  profile: exampleWorkspaceConnectionProfile,
  workspaceId: "workspace-demo-001",
  workspaceDisplayName: "PlanWeave Demo",
  connectedAt: "2030-01-01T00:05:00.000Z",
  error: null
});

export const exampleHostBootstrapHandoffView = hostBootstrapHandoffViewSchema.parse({
  schemaVersion: "workspace-setup/v1",
  workspaceId: "workspace-demo-001",
  workspaceDisplayName: "PlanWeave Demo",
  serverBaseUrl: "https://collab.example.com/",
  allowInsecureTransport: false,
  state: "pending",
  hostId: null,
  enrollmentId: null,
  reason: null,
  updatedAt: "2030-01-01T00:06:00.000Z"
});

export const exampleHostBootstrapEnrollmentSecret = hostBootstrapEnrollmentSecretSchema.parse({
  schemaVersion: "workspace-setup/v1",
  workspaceId: "workspace-demo-001",
  serverBaseUrl: "https://collab.example.com/",
  allowInsecureTransport: false,
  kind: "setup_code",
  setupCode: exampleSetupCode
});

/** Negative fixtures for redeem/expiry/replay/malformed/wrong-credential coverage. */
export const exampleSetupCodeNegativeFixtures = {
  expiredGrant: setupCodeGrantSchema.parse({
    ...exampleSetupCodeGrant,
    setupCodeId: "setup-code-expired",
    expiresAt: "2030-01-01T00:30:00.000Z",
    displayedAt: "2030-01-01T00:00:01.000Z"
  }),
  revokedGrant: setupCodeGrantSchema.parse({
    ...exampleSetupCodeGrant,
    setupCodeId: "setup-code-revoked",
    revokedAt: "2030-01-01T00:10:00.000Z"
  }),
  redeemedGrant: setupCodeGrantSchema.parse({
    ...exampleSetupCodeGrant,
    setupCodeId: "setup-code-redeemed",
    redeemedAt: "2030-01-01T00:20:00.000Z",
    redemptionSubjectId: "device-session-001"
  }),
  crossWorkspaceGrant: setupCodeGrantSchema.parse({
    ...exampleSetupCodeGrant,
    setupCodeId: "setup-code-cross-ws",
    workspaceId: "workspace-other-001"
  }),
  hostPurposeGrant: setupCodeGrantSchema.parse({
    ...exampleSetupCodeGrant,
    setupCodeId: "setup-code-host",
    purpose: "host_enrollment"
  }),
  malformedIssueRequest: {
    schemaVersion: "workspace-setup/v1",
    workspaceId: "workspace-demo-001",
    purpose: "device_session",
    projectRoot: "/srv/planweave",
    command: "curl https://evil.example"
  },
  mixedCredentialRedeem: {
    schemaVersion: "workspace-setup/v1",
    setupCode: exampleSetupCode,
    purpose: "device_session",
    displayName: "Owner",
    operatorToken: exampleOperatorCredentialToken,
    hostCredentialToken: exampleHostCredentialToken
  },
  wrongCredentialPrefix: {
    schemaVersion: "workspace-setup/v1",
    setupCode: exampleHumanDeviceToken,
    purpose: "device_session",
    displayName: "Owner"
  },
  arbitraryUrlHandoff: {
    schemaVersion: "workspace-setup/v1",
    workspaceId: "workspace-demo-001",
    workspaceDisplayName: "PlanWeave Demo",
    serverBaseUrl: "https://collab.example.com/admin/shell?cmd=id",
    allowInsecureTransport: false,
    state: "pending",
    hostId: null,
    enrollmentId: null,
    reason: null,
    updatedAt: "2030-01-01T00:06:00.000Z"
  }
} as const;

/** Fixtures that must never appear in redacted logs. */
export const exampleSecretsForRedaction = {
  deviceToken: exampleHumanDeviceToken,
  identityToken: exampleHumanIdentityToken,
  invitationToken: exampleInvitationToken,
  setupCode: exampleSetupCode,
  operatorToken: exampleOperatorCredentialToken,
  hostCredentialToken: exampleHostCredentialToken,
  hostEnrollmentCode: exampleHostEnrollmentCode,
  authorizationHeader: `Bearer ${exampleHumanDeviceToken}`
} as const;
