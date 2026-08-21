import { z } from "zod";
import type {
  CollaborationCanvasBindingReplicaProjection,
  CollaborationCanvasBindingReplicaSignal
} from "./canvasReplicaIpc.js";
import type { CollaborationCanvasBindingInput } from "./collaborationCanvasBinding.js";
import type {
  ExportServerDataArchiveInput,
  ExportServerDataArchiveResult,
  ListServerDataExportSourcesResult,
  RestoreServerDataArchiveInput,
  RestoreServerDataArchiveResult,
  ServerDataExportSource
} from "./serverDataMigration.js";
import { COMMENT_ATTACHMENT_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import type { CollaborationInvitationHandoffResponse } from "@planweave-ai/collaboration-protocol/handoff/invitation";
import {
  canvasCommandIntentSchema,
  type CanvasCommandOutcome,
  type CanvasJournalEntry,
  type CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  canvasPresencePointerSchema,
  canvasPresenceSelectionIdsSchema,
  type CanvasPresenceServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import {
  accessMutationRequestSchema,
  type CurrentCanvasAccessView,
  type AccessMutationResult
} from "@planweave-ai/collaboration-protocol/access/control";
import {
  collaborationConnectionProfileSchema,
  collaborationServerOriginSchema,
  type ActiveWorkspaceConnectionView,
  type CollaborationConnectionProfile,
  type DeploymentEndpoint,
  type WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import {
  commentContentSha256Schema,
  commentIdSchema,
  humanDisplayNameSchema,
  humanDeviceLabelSchema,
  setupCodeTokenSchema,
  humanDeviceTokenSchema,
  pendingAttachmentUploadIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  createPendingAttachmentRequestSchema,
  type CreatePendingAttachmentRequest,
  type FinalizePendingAttachmentResponse,
  type PendingAttachmentView
} from "@planweave-ai/collaboration-protocol/activity/attachments";
import {
  type ConnectivityValidationView,
  type DeploymentGuidanceView,
  type DesktopDeploymentActionRequest
} from "@planweave-ai/collaboration-protocol/deployment";
import {
  type CanvasAccessPage,
  type ProjectAccessPage,
  type RegistryPageQuery
} from "@planweave-ai/collaboration-protocol/access/project";
import {
  type CreatePackageSnapshotRequest,
  type CreatePackageSnapshotResult,
  type PackageSnapshot,
  type RestorePackageSnapshotRequest,
  type RestorePackageSnapshotResult
} from "@planweave-ai/collaboration-protocol/content/snapshot";
import {
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  humanCreateInvitationRequestSchema,
  humanRevokeInvitationsRequestSchema,
  humanUpdateDisplayNameRequestSchema,
  type HumanBootstrapRequest,
  type HumanConsumeInvitationRequest,
  type HumanCreateInvitationResponse,
  type HumanDevicePage,
  type HumanDeviceView,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanRevokeInvitationsResponse,
  type HumanMemberPage,
  type HumanMembershipView,
  type HumanPrincipalView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  commentAttachmentMediaTypeSchema,
  commentAttachmentSizeBytesSchema,
  type ActivityListPage,
  type CommentDisplayProjection,
  type CommentListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";
import {
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type EligibleAssigneesResponse,
  type EligibleHostBatchRequest,
  type EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import { type CanvasLiveSyncServerMessage } from "@planweave-ai/collaboration-protocol/canvas/live-sync";
import type { PlanWeaveCollaborationRuntimeAvailabilityApi } from "./collaborationRuntimeAvailability.js";
import {
  type RemoteActionView,
  type RemoteDispatchIntentV3,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteAgentEndpointList } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { type ResponsibilityReadModel } from "@planweave-ai/collaboration-protocol/work/responsibility";
import { type ReviewAssignmentReadModel } from "@planweave-ai/collaboration-protocol/work/review";
import { type WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import {
  contentVersionDesktopReadModelSchema,
  type ContentVersionDesktopReadModel
} from "@planweave-ai/collaboration-protocol/content/authority";
import {
  type LoopbackProjectRegistrationView,
  type LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-protocol/loopback";
import type {
  CollaborationActivityListQueryInput,
  CollaborationAssignmentListQueryInput,
  CollaborationAssignmentUpdateInput,
  CollaborationCommentCreateInput,
  CollaborationCommentEditInput,
  CollaborationCommentListQueryInput,
  CollaborationCommentTombstoneInput,
  CollaborationDeviceListQueryInput,
  CollaborationInvitationListQueryInput,
  CollaborationObserverSignal,
  CollaborationPageQueryInput,
  CollaborationRemoteEventQueryInput,
  CollaborationRemoteInteractionPageQueryInput,
  CollaborationRemoteOperationIdInput,
  CollaborationResponsibilityUpdateInput,
  CollaborationReviewerUpdateInput,
  CollaborationWorkAuthorityScopeInput,
  CollaborationWorkItemInput
} from "./collaborationReadModels.js";
import type {
  LocalCollaborationLanSharingInput,
  LocalCollaborationRegistrationInput,
  LocalCollaborationServerStatus,
  LocalCollaborationScopeCatalog,
  LocalCollaborationScopeSelectionInput
} from "./localCollaborationScopes.js";
import type {
  DesktopServerExposureModeInput,
  DesktopServerExposureView
} from "./deploymentExposure.js";
export {
  desktopServerExposureErrorCodeSchema,
  desktopServerExposureModeInputSchema,
  desktopServerExposureModeSchema,
  desktopServerExposureViewSchema,
  type DesktopServerExposureErrorCode,
  type DesktopServerExposureMode,
  type DesktopServerExposureModeInput,
  type DesktopServerExposureView
} from "./deploymentExposure.js";
export {
  localCollaborationLanSharingInputSchema,
  localCollaborationRegistrationInputSchema,
  localCollaborationServerStatusSchema,
  localCollaborationScopeSchema,
  localCollaborationScopeSelectionInputSchema,
  isLocalCollaborationProfileId,
  LOCAL_COLLABORATION_PROFILE_PREFIX,
  type LocalCollaborationCanvasCatalogItem,
  type LocalCollaborationProjectCatalogItem,
  type LocalCollaborationRegistrationInput,
  type LocalCollaborationLanSharingInput,
  type LocalCollaborationServerStatus,
  type LocalCollaborationScope,
  type LocalCollaborationScopeCatalog,
  type LocalCollaborationScopeSelectionInput
} from "./localCollaborationScopes.js";

/** Whether the OS-backed encryptor can persist device credentials across restarts. */
export type CollaborationCredentialStorage = "available" | "unavailable";

/** How the current device credential is held for a profile. */
export type CollaborationCredentialPersistence = "persisted" | "session-only" | "missing";

/**
 * Public profile view for renderer/preload.
 * Never includes deviceToken, encrypted ciphertext, credential path, or Authorization.
 */
type CollaborationProfileViewBase = {
  profileId: string;
  displayName: string;
  serverBaseUrl: string;
  projectId: string;
  allowInsecureTransport: boolean;
  hasDeviceCredential: boolean;
  deviceCredentialPersistence: CollaborationCredentialPersistence;
  deviceCredentialId: string | null;
  humanPrincipalId: string | null;
  updatedAt: string;
};

export type CollaborationProfileView = CollaborationProfileViewBase &
  (
    | { endpoint: DeploymentEndpoint; connectionState: "ready" }
    | { endpoint: null; connectionState: "reconnect_required" }
  );

export type CollaborationSessionPhase = "idle" | "ready" | "connecting" | "connected" | "error";

export type CollaborationSessionView = {
  phase: CollaborationSessionPhase;
  activeProfileId: string | null;
  /** Observer/client lifecycle status for the active session (non-secret). */
  detail: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type CollaborationStatus = {
  profiles: CollaborationProfileView[];
  activeProfileId: string | null;
  credentialStorage: CollaborationCredentialStorage;
  /**
   * Explicit warning when a session-only credential is held because configured storage is unavailable.
   * Null when every credential is either missing or restorable from encrypted storage.
   */
  nonPersistenceWarning: string | null;
  session: CollaborationSessionView;
  /**
   * Single Server/Workspace connection. Defaults to local_only until the user
   * explicitly redeems a setup code or connects a stored Workspace profile.
   * Never includes secrets.
   */
  workspaceConnection: ActiveWorkspaceConnectionView;
  /** Redacted Workspace picker rows last authenticated by the connected Server. */
  workspacePicker: WorkspacePickerPage;
  updatedAt: string;
};

/** Bootstrap / consume handoff returned to renderer — deviceToken always stripped. */
export type CollaborationAuthHandoffView = {
  workspaceId: string;
  principal: HumanPrincipalView;
  membership: HumanMembershipView;
  device: HumanDeviceView;
  invitation?: HumanInvitationView;
  created?: boolean;
  principalCreated?: boolean;
  /** Mirrors credential vault persistence after main stored the one-shot token. */
  deviceCredentialPersistence: CollaborationCredentialPersistence;
  nonPersistenceWarning: string | null;
};

const forbiddenSecretKeys = [
  "deviceToken",
  "encryptedDeviceToken",
  "encryptedRuntimeApiKey",
  "authorization",
  "Authorization",
  "credentialPath",
  "credentialsPath",
  "existingDeviceToken",
  "setupCode",
  "operatorToken",
  "hostCredentialToken",
  "hostEnrollmentCode",
  "enrollmentCode",
  "projectRoot",
  "localRoot",
  "url",
  "headers",
  "path",
  "command"
] as const;

/**
 * Reject payloads that try to smuggle secrets or credential paths into main via renderer IPC.
 * Profile upserts must only carry logical identity fields.
 */
export function assertNoSmuggledCollaborationSecrets(value: unknown, context: string): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of forbiddenSecretKeys) {
    if (key in record && record[key] !== undefined) {
      throw new Error(
        `Collaboration IPC rejected ${context}: field "${key}" is not allowed across the renderer boundary.`
      );
    }
  }
}

export const collaborationProfileInputSchema = collaborationConnectionProfileSchema;
export type CollaborationProfileInput = CollaborationConnectionProfile;

export const collaborationUpsertProfileInputSchema = collaborationConnectionProfileSchema;
export type CollaborationUpsertProfileInput = z.infer<typeof collaborationUpsertProfileInputSchema>;

export const collaborationProfileIdInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128)
  })
  .strict();
export type CollaborationProfileIdInput = z.infer<typeof collaborationProfileIdInputSchema>;

/**
 * One-shot device credential import for recovery/tests.
 * Token is accepted only on this dedicated method; it is never returned later.
 */
export const collaborationImportDeviceCredentialInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    deviceToken: humanDeviceTokenSchema,
    deviceCredentialId: z.string().trim().min(1).max(128).optional(),
    humanPrincipalId: z.string().trim().min(1).max(128).optional()
  })
  .strict();
export type CollaborationImportDeviceCredentialInput = z.infer<
  typeof collaborationImportDeviceCredentialInputSchema
>;

export const collaborationBootstrapInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    request: humanBootstrapRequestSchema
  })
  .strict();
export type CollaborationBootstrapInput = z.infer<typeof collaborationBootstrapInputSchema>;

/**
 * Dedicated setup-code redeem input. `setupCode` is accepted only on this method;
 * main stores the resulting device token and never returns secrets.
 */
export const collaborationRedeemSetupCodeInputSchema = z
  .object({
    serverBaseUrl: collaborationServerOriginSchema,
    allowInsecureTransport: z.boolean().default(false),
    setupCode: setupCodeTokenSchema,
    displayName: humanDisplayNameSchema,
    deviceLabel: humanDeviceLabelSchema.optional()
  })
  .strict();
export type CollaborationRedeemSetupCodeInput = z.infer<
  typeof collaborationRedeemSetupCodeInputSchema
>;

/**
 * HTTPS origin only. Renderer never sends a setup code; main issues and redeems it.
 */
export const collaborationConnectExistingServerByOriginInputSchema = z
  .object({
    serverBaseUrl: z.string().trim().min(1).max(2048),
    displayName: humanDisplayNameSchema.optional()
  })
  .strict();
export type CollaborationConnectExistingServerByOriginInput = z.infer<
  typeof collaborationConnectExistingServerByOriginInputSchema
>;

/** Redacted remembered Server for quick reconnect. Never includes credentials. */
export const rememberedServerConnectionViewSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(128),
    workspaceDisplayName: z.string().trim().min(1).max(128),
    serverBaseUrl: collaborationServerOriginSchema,
    hasDeviceCredential: z.boolean()
  })
  .strict();
export type RememberedServerConnectionView = z.infer<typeof rememberedServerConnectionViewSchema>;

export function parseCollaborationServerOriginInput(value: string): string {
  return collaborationServerOriginSchema.parse(`${new URL(value.trim()).origin}/`);
}

export const collaborationWorkspacePickerQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type CollaborationWorkspacePickerQuery = z.infer<
  typeof collaborationWorkspacePickerQuerySchema
>;

/**
 * Invitation consume from renderer.
 * `existingDeviceToken` is forbidden here — main injects a vault token when present.
 */
export const collaborationConsumeInvitationInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    request: humanConsumeInvitationRequestSchema.omit({ existingDeviceToken: true })
  })
  .strict();
export type CollaborationConsumeInvitationInput = z.infer<
  typeof collaborationConsumeInvitationInputSchema
>;

export type HumanBootstrapRequestInput = HumanBootstrapRequest;
export type HumanConsumeInvitationRequestInput = Omit<
  HumanConsumeInvitationRequest,
  "existingDeviceToken"
>;

export const collaborationUpdateOwnDisplayNameInputSchema = humanUpdateDisplayNameRequestSchema;
export type CollaborationUpdateOwnDisplayNameInput = z.infer<
  typeof collaborationUpdateOwnDisplayNameInputSchema
>;

/**
 * Create-invitation request from renderer.
 * Response includes a one-shot invitationToken (shareable secret) — never a device token.
 */
export const collaborationCreateInvitationInputSchema = humanCreateInvitationRequestSchema;
export type CollaborationCreateInvitationInput = z.input<
  typeof collaborationCreateInvitationInputSchema
>;

/** IPC identity payloads use plain opaque ids; main re-validates against wire schemas. */
const collaborationOpaqueIdSchema = z.string().trim().min(1).max(128);

export const collaborationInvitationIdInputSchema = z
  .object({
    invitationId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationInvitationIdInput = z.infer<typeof collaborationInvitationIdInputSchema>;

export const collaborationInvitationIdsInputSchema = humanRevokeInvitationsRequestSchema;
export type CollaborationInvitationIdsInput = z.infer<typeof collaborationInvitationIdsInputSchema>;

export const collaborationHumanPrincipalIdInputSchema = z
  .object({
    humanPrincipalId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationHumanPrincipalIdInput = z.infer<
  typeof collaborationHumanPrincipalIdInputSchema
>;

export const collaborationDeviceCredentialIdInputSchema = z
  .object({
    deviceCredentialId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationDeviceCredentialIdInput = z.infer<
  typeof collaborationDeviceCredentialIdInputSchema
>;

/** Create a staged comment attachment upload (metadata only — no bytes). */
export const collaborationCreatePendingAttachmentInputSchema = createPendingAttachmentRequestSchema;
export type CollaborationCreatePendingAttachmentInput = CreatePendingAttachmentRequest;

/**
 * Upload staged attachment bytes over IPC as base64.
 * Renderer never sends filesystem paths; only basename + content + declared media type.
 * Max payload tracks COMMENT_ATTACHMENT_MAX_BYTES (base64 expansion ~4/3).
 */
export const collaborationUploadPendingAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    mediaType: z.string().min(1).max(128),
    bodyBase64: z
      .string()
      .min(1)
      .max(Math.ceil((COMMENT_ATTACHMENT_MAX_BYTES * 4) / 3) + 8),
    digestSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/)
      .optional()
  })
  .strict();
export type CollaborationUploadPendingAttachmentInput = z.infer<
  typeof collaborationUploadPendingAttachmentInputSchema
>;

export const collaborationFinalizePendingAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    expectedDigestSha256: commentContentSha256Schema.optional()
  })
  .strict();
export type CollaborationFinalizePendingAttachmentInput = z.infer<
  typeof collaborationFinalizePendingAttachmentInputSchema
>;

export const collaborationReadCommentAttachmentInputSchema = z
  .object({
    commentId: commentIdSchema,
    digestSha256: commentContentSha256Schema
  })
  .strict();
export type CollaborationReadCommentAttachmentInput = z.input<
  typeof collaborationReadCommentAttachmentInputSchema
>;

export const collaborationCommentAttachmentBodySchema = z
  .object({
    digestSha256: commentContentSha256Schema,
    mediaType: commentAttachmentMediaTypeSchema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    bodyBase64: z
      .string()
      .min(1)
      .max(Math.ceil((COMMENT_ATTACHMENT_MAX_BYTES * 4) / 3) + 8)
  })
  .strict();
export type CollaborationCommentAttachmentBody = z.infer<
  typeof collaborationCommentAttachmentBodySchema
>;

/** One-shot invitation create view — token is display/copy-once only; never persisted by Desktop. */
export type CollaborationInvitationCreateView = HumanCreateInvitationResponse;
export type CollaborationInvitationHandoffView = CollaborationInvitationHandoffResponse;

/** Selected canvas binding for the ephemeral presence socket. */
export const collaborationPresenceCanvasInputSchema = z
  .object({ canvasId: z.string().trim().min(1).max(128) })
  .strict();
export type CollaborationPresenceCanvasInput = z.infer<
  typeof collaborationPresenceCanvasInputSchema
>;

/** Renderer may publish only bounded pointer/selection state; identity and scope stay in main. */
export const collaborationPresenceUpdateInputSchema = z
  .object({
    pointer: canvasPresencePointerSchema.nullable(),
    selectionIds: canvasPresenceSelectionIdsSchema
  })
  .strict();
export type CollaborationPresenceUpdateInput = z.infer<
  typeof collaborationPresenceUpdateInputSchema
>;

export type CollaborationRegistryPageInput = Partial<RegistryPageQuery>;
export type CollaborationAuthorizedCanvasesInput = CollaborationRegistryPageInput & {
  projectId: string;
};
export type CollaborationRegistryReadSnapshotInput = Pick<
  RestorePackageSnapshotRequest,
  "projectId" | "canvasId" | "snapshotId"
>;

export type CollaborationPresenceSignal =
  | {
      profileId: string;
      message: CanvasPresenceServerMessage;
    }
  | {
      profileId: string;
      reset: {
        canvasId: string;
        reason: "disconnected" | "auth_expired" | "error";
      };
    };

/** Renderer supplies only opaque local scope; main resolves remote IDs and session revision. */
export const collaborationCanvasLiveSyncInputSchema = z
  .object({
    localProjectId: collaborationOpaqueIdSchema,
    canvasId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationCanvasLiveSyncInput = z.infer<
  typeof collaborationCanvasLiveSyncInputSchema
>;

/** Validated read-only live-sync signal. No token, header, local path, or disk content crosses IPC. */
export type CollaborationCanvasLiveSyncSignal = {
  profileId: string;
  projectId: string;
  canvasId: string;
  message: CanvasLiveSyncServerMessage;
};

/** Renderer → main: submit one durable canvas command intent (no actor/path/revision override authority). */
export const collaborationCanvasCommandSubmitInputSchema = z
  .object({
    canvasId: z.string().trim().min(1).max(128),
    intent: canvasCommandIntentSchema
  })
  .strict();
export type CollaborationCanvasCommandSubmitInput = z.infer<
  typeof collaborationCanvasCommandSubmitInputSchema
>;

export const collaborationCanvasReconnectInputSchema = z
  .object({
    canvasId: z.string().trim().min(1).max(128),
    afterRevision: z.number().int().nonnegative().optional(),
    afterContentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
export type CollaborationCanvasReconnectInput = z.infer<
  typeof collaborationCanvasReconnectInputSchema
>;

export {
  collaborationCanvasBindingInputSchema,
  type CollaborationCanvasBindingInput,
  type LocalCollaborationCanvasBindingInput,
  type RemoteCollaborationCanvasBindingInput
} from "./collaborationCanvasBinding.js";

export type CollaborationCanvasCommandSessionView = {
  canvasId: string;
  revision: number;
  contentDigest: string | null;
  lastOperationId: string | null;
  lastJournalEntryId: string | null;
  pendingOperationId: string | null;
  lastConflict: {
    expectedRevision: number;
    authoritativeRevision: number;
    authoritativeContentDigest: string;
  } | null;
  lastRejectCode: string | null;
};

export type CollaborationCanvasCommandSubmitResult = {
  outcome: CanvasCommandOutcome;
  session: CollaborationCanvasCommandSessionView | null;
};

export type CollaborationCanvasReconnectResult = {
  response: CanvasReconnectResponse;
  entriesToApply: CanvasJournalEntry[];
  snapshotRequired: boolean;
  session: CollaborationCanvasCommandSessionView | null;
};

export const collaborationCanvasScopeResolutionSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: collaborationOpaqueIdSchema,
    canvasId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationCanvasScopeResolution = z.infer<
  typeof collaborationCanvasScopeResolutionSchema
>;
export type CollaborationContentAuthorityView = ContentVersionDesktopReadModel;

export const collaborationContentBootstrapInputSchema = z
  .object({
    workspaceId: collaborationOpaqueIdSchema,
    projectId: collaborationOpaqueIdSchema,
    canvasId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationContentBootstrapInput = z.infer<
  typeof collaborationContentBootstrapInputSchema
>;

const collaborationLocalContentReplicaViewSchema = z
  .object({
    projectId: collaborationOpaqueIdSchema,
    canvasId: collaborationOpaqueIdSchema
  })
  .strict();

export const collaborationContentBootstrapCandidateSchema = z
  .object({
    workspaceId: collaborationOpaqueIdSchema,
    projectId: collaborationOpaqueIdSchema,
    canvasId: collaborationOpaqueIdSchema,
    visibility: z.enum(["private", "shared"]),
    authority: contentVersionDesktopReadModelSchema,
    localReplica: collaborationLocalContentReplicaViewSchema.nullable()
  })
  .strict();
export type CollaborationContentBootstrapCandidate = z.infer<
  typeof collaborationContentBootstrapCandidateSchema
>;

export const collaborationContentBootstrapResultSchema = z
  .object({
    outcome: z.enum(["created", "reused"]),
    localProjectId: collaborationOpaqueIdSchema,
    localCanvasId: collaborationOpaqueIdSchema,
    remoteCanvasId: collaborationOpaqueIdSchema,
    acknowledgement: z.enum(["acknowledged", "pending"]),
    authority: contentVersionDesktopReadModelSchema
  })
  .strict();
export type CollaborationContentBootstrapResult = z.infer<
  typeof collaborationContentBootstrapResultSchema
>;

/** Renderer supplies a selected opaque canvas id; main derives and verifies the full active scope. */
export const collaborationCurrentCanvasAccessInputSchema = z
  .object({ canvasId: z.string().trim().min(1).max(128) })
  .strict();
export type CollaborationCurrentCanvasAccessInput = z.infer<
  typeof collaborationCurrentCanvasAccessInputSchema
>;

/** ACL mutations carry an opaque route canvas plus B-001's scope + CAS request. */
export const collaborationAccessMutationInputSchema = z
  .object({
    canvasId: z.string().trim().min(1).max(128),
    request: accessMutationRequestSchema
  })
  .strict();
export type CollaborationAccessMutationInput = z.infer<
  typeof collaborationAccessMutationInputSchema
>;
export type CollaborationCurrentCanvasAccessView = CurrentCanvasAccessView;
export type CollaborationAccessMutationResult = AccessMutationResult;

/** Opaque selection only; main resolves the local project root and manifest. */
export const collaborationCurrentSelectionInputSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    canvasId: z.string().trim().min(1).max(128)
  })
  .strict();
export type CollaborationCurrentSelectionInput = z.infer<
  typeof collaborationCurrentSelectionInputSchema
>;

export {
  collaborationInvokeChannels,
  collaborationCanvasLiveSyncSignalChannel,
  collaborationCanvasBindingReplicaSignalChannel,
  collaborationObserverSignalChannel,
  collaborationPresenceSignalChannel,
  collaborationStatusChangedChannel
} from "./collaborationIpc.js";
export type {
  ExportServerDataArchiveInput,
  ExportServerDataArchiveResult,
  ListServerDataExportSourcesResult,
  RestoreServerDataArchiveInput,
  RestoreServerDataArchiveResult,
  ServerDataExportSource
};

export type PlanWeaveCollaborationApi = {
  getCollaborationStatus: () => Promise<CollaborationStatus>;
  upsertCollaborationProfile: (
    input: CollaborationUpsertProfileInput
  ) => Promise<CollaborationStatus>;
  removeCollaborationProfile: (input: CollaborationProfileIdInput) => Promise<CollaborationStatus>;
  setActiveCollaborationProfile: (
    input: CollaborationProfileIdInput
  ) => Promise<CollaborationStatus>;
  clearActiveCollaborationProfile: () => Promise<CollaborationStatus>;
  importDeviceCredential: (
    input: CollaborationImportDeviceCredentialInput
  ) => Promise<CollaborationStatus>;
  clearDeviceCredential: (input: CollaborationProfileIdInput) => Promise<CollaborationStatus>;
  bootstrapCollaborationOwner: (
    input: CollaborationBootstrapInput
  ) => Promise<CollaborationAuthHandoffView>;
  consumeCollaborationInvitation: (
    input: CollaborationConsumeInvitationInput
  ) => Promise<CollaborationAuthHandoffView>;
  connectCollaborationSession: (input: CollaborationProfileIdInput) => Promise<CollaborationStatus>;
  disconnectCollaborationSession: () => Promise<CollaborationStatus>;
  /**
   * Redeem a one-time device setup code. Accepts setupCode once; never returns
   * device tokens or the submitted code.
   */
  redeemCollaborationSetupCode: (
    input: CollaborationRedeemSetupCodeInput
  ) => Promise<CollaborationStatus>;
  connectExistingServerByOrigin: (
    input: CollaborationConnectExistingServerByOriginInput
  ) => Promise<CollaborationStatus>;
  getActiveWorkspaceConnection: () => Promise<ActiveWorkspaceConnectionView>;
  listRememberedServerConnections: () => Promise<RememberedServerConnectionView[]>;
  forgetRememberedServerConnection: (
    input: CollaborationProfileIdInput
  ) => Promise<CollaborationStatus>;
  listWorkspacePicker: (input?: CollaborationWorkspacePickerQuery) => Promise<WorkspacePickerPage>;
  selectWorkspaceConnection: (
    input: CollaborationProfileIdInput | { workspaceId: string }
  ) => Promise<CollaborationStatus>;
  connectWorkspaceConnection: () => Promise<CollaborationStatus>;
  disconnectWorkspaceConnection: () => Promise<CollaborationStatus>;
  retryWorkspaceConnection: () => Promise<CollaborationStatus>;
  getDeploymentGuidance: (
    input: Extract<DesktopDeploymentActionRequest, { action: "request_deployment_guidance" }>
  ) => Promise<DeploymentGuidanceView>;
  copyDeploymentComposeHandoff: (
    input: Extract<DesktopDeploymentActionRequest, { action: "copy_supported_compose_handoff" }>
  ) => Promise<{ state: "copied"; copiedAt: string }>;
  exportDeploymentComposeBundle: (
    input: Extract<DesktopDeploymentActionRequest, { action: "export_supported_compose_bundle" }>
  ) => Promise<
    import("@planweave-ai/collaboration-protocol/deployment").DeploymentBundleExportView
  >;
  listServerDataExportSources: () => Promise<ListServerDataExportSourcesResult>;
  exportServerDataArchive: (
    input: ExportServerDataArchiveInput
  ) => Promise<ExportServerDataArchiveResult>;
  restoreServerDataArchive: (
    input?: RestoreServerDataArchiveInput
  ) => Promise<RestoreServerDataArchiveResult>;
  validateDeploymentConnectivity: (
    input: Extract<DesktopDeploymentActionRequest, { action: "validate_connectivity" }>
  ) => Promise<ConnectivityValidationView>;
  getDesktopServerExposure: () => Promise<DesktopServerExposureView>;
  setDesktopServerExposureMode: (
    input: DesktopServerExposureModeInput
  ) => Promise<DesktopServerExposureView>;
  startCollaborationPresence: (input: CollaborationPresenceCanvasInput) => Promise<void>;
  stopCollaborationPresence: () => Promise<void>;
  startCollaborationCanvasBindingLiveSync: (
    input: CollaborationCanvasBindingInput
  ) => Promise<void>;
  stopCollaborationCanvasLiveSync: () => Promise<void>;
  publishCollaborationPresence: (input: CollaborationPresenceUpdateInput) => Promise<void>;
  submitCollaborationCanvasCommand: (
    input: CollaborationCanvasCommandSubmitInput
  ) => Promise<CollaborationCanvasCommandSubmitResult>;
  reconnectCollaborationCanvas: (
    input: CollaborationCanvasReconnectInput
  ) => Promise<CollaborationCanvasReconnectResult>;
  bindCollaborationCanvasBindingSession: (
    input: CollaborationCanvasBindingInput
  ) => Promise<CollaborationCanvasCommandSessionView | null>;
  getCollaborationCanvasCommandSession: () => Promise<CollaborationCanvasCommandSessionView | null>;
  flushCollaborationCanvasReplicaMaterialization: () => Promise<void>;
  resolveCollaborationCanvasBindingScope: (
    input: CollaborationCanvasBindingInput
  ) => Promise<CollaborationCanvasScopeResolution | null>;
  getCollaborationCanvasBindingReplicaProjection: (
    input: CollaborationCanvasBindingInput
  ) => Promise<CollaborationCanvasBindingReplicaProjection | null>;
  bindCollaborationCanvasBindingContentAuthority: (
    input: CollaborationCanvasBindingInput
  ) => Promise<CollaborationContentAuthorityView>;
  getCollaborationContentAuthority: () => Promise<CollaborationContentAuthorityView | null>;
  refreshCollaborationContentAuthority: () => Promise<CollaborationContentAuthorityView>;
  publishCollaborationInitialContent: () => Promise<CollaborationContentAuthorityView>;
  materializeCollaborationContentHead: () => Promise<CollaborationContentAuthorityView>;
  listCollaborationContentBootstrapCandidates: () => Promise<
    CollaborationContentBootstrapCandidate[]
  >;
  bootstrapCollaborationContent: (
    input: CollaborationContentBootstrapInput
  ) => Promise<CollaborationContentBootstrapResult>;
  getCurrentCanvasAccess: (
    input: CollaborationCurrentCanvasAccessInput
  ) => Promise<CollaborationCurrentCanvasAccessView>;
  mutateCurrentCanvasAccess: (
    input: CollaborationAccessMutationInput
  ) => Promise<CollaborationAccessMutationResult>;
  setCollaborationCurrentSelection: (input: CollaborationCurrentSelectionInput) => Promise<void>;
  clearCollaborationCurrentSelection: () => Promise<void>;
  getLocalCollaborationServerStatus: () => Promise<LocalCollaborationServerStatus>;
  getLocalCollaborationScopeCatalog: () => Promise<LocalCollaborationScopeCatalog>;
  setLocalCollaborationTrustedScopes: (
    input: LocalCollaborationScopeSelectionInput
  ) => Promise<LocalCollaborationScopeCatalog>;
  startLocalCollaborationServer: () => Promise<LocalCollaborationServerStatus>;
  stopLocalCollaborationServer: () => Promise<LocalCollaborationServerStatus>;
  setLocalCollaborationLanSharing: (
    input: LocalCollaborationLanSharingInput
  ) => Promise<LocalCollaborationServerStatus>;
  listLocalCollaborationTrustedScopes: () => Promise<readonly LoopbackTrustedProjectScope[]>;
  registerLocalCollaborationCurrentProject: (
    input?: LocalCollaborationRegistrationInput
  ) => Promise<LoopbackProjectRegistrationView>;
  listCollaborationMembers: (input?: CollaborationPageQueryInput) => Promise<HumanMemberPage>;
  updateOwnCollaborationDisplayName: (
    input: CollaborationUpdateOwnDisplayNameInput
  ) => Promise<HumanPrincipalView>;
  listCollaborationDevices: (input?: CollaborationDeviceListQueryInput) => Promise<HumanDevicePage>;
  listCollaborationInvitations: (
    input?: CollaborationInvitationListQueryInput
  ) => Promise<HumanInvitationPage>;
  createCollaborationInvitation: (
    input?: CollaborationCreateInvitationInput
  ) => Promise<CollaborationInvitationCreateView>;
  createCollaborationInvitationHandoff: (
    input?: CollaborationCreateInvitationInput
  ) => Promise<CollaborationInvitationHandoffView>;
  getCollaborationInvitationSecret: (
    input: CollaborationInvitationIdInput
  ) => Promise<CollaborationInvitationCreateView>;
  getCollaborationInvitationHandoff: (
    input: CollaborationInvitationIdInput
  ) => Promise<CollaborationInvitationHandoffView>;
  revokeCollaborationInvitation: (
    input: CollaborationInvitationIdInput
  ) => Promise<HumanInvitationView>;
  revokeCollaborationInvitations: (
    input: CollaborationInvitationIdsInput
  ) => Promise<HumanRevokeInvitationsResponse>;
  removeCollaborationMember: (input: CollaborationHumanPrincipalIdInput) => Promise<void>;
  promoteCollaborationOwner: (input: CollaborationHumanPrincipalIdInput) => Promise<void>;
  demoteCollaborationOwner: (input: CollaborationHumanPrincipalIdInput) => Promise<void>;
  revokeCollaborationDevice: (input: CollaborationDeviceCredentialIdInput) => Promise<void>;
  listCollaborationAssignments: (
    input?: CollaborationAssignmentListQueryInput
  ) => Promise<AssignmentListPage>;
  getCollaborationAssignment: (
    input: CollaborationWorkItemInput
  ) => Promise<AssignmentDisplayProjection>;
  listCollaborationEligibleAssignees: (
    input: CollaborationWorkItemInput
  ) => Promise<EligibleAssigneesResponse>;
  listCollaborationEligibleHostsBatch: (
    input: EligibleHostBatchRequest
  ) => Promise<EligibleHostBatchResponse>;
  getCollaborationWorkAuthority: (
    input: CollaborationWorkAuthorityScopeInput
  ) => Promise<WorkAuthorityProjection>;
  updateCollaborationResponsibility: (
    input: CollaborationResponsibilityUpdateInput
  ) => Promise<ResponsibilityReadModel>;
  updateCollaborationReviewer: (
    input: CollaborationReviewerUpdateInput
  ) => Promise<ReviewAssignmentReadModel>;
  listCollaborationComments: (
    input: CollaborationCommentListQueryInput
  ) => Promise<CommentListPage>;
  listCollaborationActivity: (
    input?: CollaborationActivityListQueryInput
  ) => Promise<ActivityListPage>;
  listCollaborationAuthorizedProjects: (
    input?: CollaborationRegistryPageInput
  ) => Promise<ProjectAccessPage>;
  listCollaborationAuthorizedCanvases: (
    input: CollaborationAuthorizedCanvasesInput
  ) => Promise<CanvasAccessPage>;
  readCollaborationPackageSnapshot: (
    input: CollaborationRegistryReadSnapshotInput
  ) => Promise<PackageSnapshot>;
  createCollaborationPackageSnapshot: (
    input: CreatePackageSnapshotRequest
  ) => Promise<CreatePackageSnapshotResult>;
  restoreCollaborationPackageSnapshot: (
    input: RestorePackageSnapshotRequest
  ) => Promise<RestorePackageSnapshotResult>;
  updateCollaborationAssignment: (
    input: CollaborationAssignmentUpdateInput
  ) => Promise<AssignmentDisplayProjection>;
  createCollaborationComment: (
    input: CollaborationCommentCreateInput
  ) => Promise<CommentDisplayProjection>;
  editCollaborationComment: (
    input: CollaborationCommentEditInput
  ) => Promise<CommentDisplayProjection>;
  tombstoneCollaborationComment: (
    input: CollaborationCommentTombstoneInput
  ) => Promise<CommentDisplayProjection>;
  createCollaborationPendingAttachment: (
    input: CollaborationCreatePendingAttachmentInput
  ) => Promise<PendingAttachmentView>;
  uploadCollaborationPendingAttachment: (
    input: CollaborationUploadPendingAttachmentInput
  ) => Promise<PendingAttachmentView>;
  finalizeCollaborationPendingAttachment: (
    input: CollaborationFinalizePendingAttachmentInput
  ) => Promise<FinalizePendingAttachmentResponse>;
  readCollaborationCommentAttachment: (
    input: CollaborationReadCommentAttachmentInput
  ) => Promise<CollaborationCommentAttachmentBody>;
  listCollaborationAgentEndpoints: () => Promise<RemoteAgentEndpointList>;
  dispatchCollaborationRemoteOperation: (
    input: RemoteDispatchIntentV3
  ) => Promise<RemoteOperationObservation>;
  observeCollaborationRemoteOperation: (
    input: CollaborationRemoteOperationIdInput
  ) => Promise<RemoteOperationObservation>;
  executeCollaborationRemoteOperationAction: (input: {
    operationId: string;
    action: RemoteHumanExecutionActionCommand;
  }) => Promise<RemoteActionView>;
  replayCollaborationRemoteOperationEvents: (input: {
    operationId: string;
    query?: CollaborationRemoteEventQueryInput;
  }) => Promise<RemoteEventReplay>;
  listCollaborationRemoteOperationInteractions: (input: {
    operationId: string;
    query?: CollaborationRemoteInteractionPageQueryInput;
  }) => Promise<RemoteInteractionPage>;
  settleCollaborationRemoteOperationInteraction: (input: {
    operationId: string;
    settlement: RemoteInteractionResponse;
  }) => Promise<RemoteInteractionView>;
  onCollaborationStatusChanged: (callback: (status: CollaborationStatus) => void) => () => void;
  onCollaborationObserverSignal: (
    callback: (signal: CollaborationObserverSignal) => void
  ) => () => void;
  onCollaborationPresenceSignal: (
    callback: (signal: CollaborationPresenceSignal) => void
  ) => () => void;
  onCollaborationCanvasLiveSyncSignal: (
    callback: (signal: CollaborationCanvasLiveSyncSignal) => void
  ) => () => void;
  onCollaborationCanvasBindingReplicaSignal: (
    callback: (signal: CollaborationCanvasBindingReplicaSignal) => void
  ) => () => void;
} & PlanWeaveCollaborationRuntimeAvailabilityApi;

export const COLLABORATION_SESSION_ONLY_WARNING =
  "Configured credential storage is unavailable, so the collaboration device credential is held only for this PlanWeave process and will not be saved.";

export type {
  CollaborationActivityListQueryInput,
  CollaborationAssignmentListQueryInput,
  CollaborationAssignmentUpdateInput,
  CollaborationCommentCreateInput,
  CollaborationCommentEditInput,
  CollaborationCommentListQueryInput,
  CollaborationCommentTombstoneInput,
  CollaborationDeviceListQueryInput,
  CollaborationInvitationListQueryInput,
  CollaborationObserverSignal,
  CollaborationPageQueryInput,
  CollaborationResponsibilityUpdateInput,
  CollaborationReviewerUpdateInput,
  CollaborationWorkAuthorityScopeInput,
  CollaborationWorkItemInput
} from "./collaborationReadModels.js";
