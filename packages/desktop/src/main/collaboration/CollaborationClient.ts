import { createHash } from "node:crypto";
import {
  accessMutationRequestSchema,
  accessMutationResultSchema,
  currentCanvasAccessViewSchema,
  type AccessMutationResult,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import {
  activityListPageSchema,
  activityListWireQuerySchema,
  commentAttachmentMediaTypeSchema,
  commentAttachmentSizeBytesSchema,
  commentCreateWireCommandSchema,
  commentDisplayProjectionSchema,
  commentEditWireCommandSchema,
  commentListPageSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema,
  type ActivityListPage,
  type CommentAttachmentMediaType,
  type CommentCreateWireCommand,
  type CommentDisplayProjection,
  type CommentEditWireCommand,
  type CommentListPage,
  type CommentListWireQuery,
  type CommentTombstoneWireCommand
} from "@planweave-ai/collaboration-protocol/activity/comments";
import { COMMENT_ATTACHMENT_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import type { HumanObserverCursor } from "@planweave-ai/collaboration-protocol/activity/observer";
import {
  assignmentListQuerySchema,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type AssignmentUpdateWireCommand,
  type EligibleAssigneesResponse,
  type EligibleHostBatchRequest,
  type EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import {
  createPendingAttachmentRequestSchema,
  finalizePendingAttachmentResponseSchema,
  pendingAttachmentViewSchema,
  uploadPendingAttachmentResponseSchema,
  type CreatePendingAttachmentRequest,
  type FinalizePendingAttachmentResponse,
  type PendingAttachmentView
} from "@planweave-ai/collaboration-protocol/activity/attachments";
import {
  executionTargetReadModelSchema,
  type ExecutionTargetReadModel
} from "@planweave-ai/collaboration-protocol/work/execution-target";
import {
  humanBootstrapRequestSchema,
  humanBootstrapResponseSchema,
  humanConsumeInvitationRequestSchema,
  humanConsumeInvitationResponseSchema,
  humanCreateInvitationRequestSchema,
  humanCreateInvitationResponseSchema,
  humanDeviceListQuerySchema,
  humanDevicePageSchema,
  humanInvitationListQuerySchema,
  humanInvitationPageSchema,
  humanInvitationViewSchema,
  humanRevokeInvitationsRequestSchema,
  humanRevokeInvitationsResponseSchema,
  humanMemberPageSchema,
  humanPageQuerySchema,
  humanPrincipalViewSchema,
  humanUpdateDisplayNameRequestSchema,
  type HumanBootstrapRequest,
  type HumanBootstrapResponse,
  type HumanConsumeInvitationRequest,
  type HumanConsumeInvitationResponse,
  type HumanCreateInvitationResponse,
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanRevokeInvitationsResponse,
  type HumanMemberPage,
  type HumanPrincipalView,
  type HumanUpdateDisplayNameRequest
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  remoteEventQuerySchema,
  remoteInteractionPageQuerySchema,
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
import {
  responsibilityReadModelSchema,
  responsibilityUpdateWireCommandSchema,
  type CollaborationWorkScope,
  type ResponsibilityReadModel,
  type ResponsibilityUpdateWireCommand
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import {
  reviewAssignmentReadModelSchema,
  reviewAssignmentUpdateWireCommandSchema,
  type ReviewAssignmentReadModel,
  type ReviewAssignmentUpdateWireCommand
} from "@planweave-ai/collaboration-protocol/work/review";
import {
  workAuthorityProjectionSchema,
  type WorkAuthorityProjection
} from "@planweave-ai/collaboration-protocol/work/authority";
import {
  contentVersionAcknowledgementSchema,
  firstContentVersionPublishResultSchema,
  type AuthoritativeContentVersion,
  type CompleteContentVersion,
  type CompletedContentVersionRef,
  type ContentVersionAcknowledgement,
  type FirstContentVersionPublishResult
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  contentVersionAuthorityDiscoveryResultSchema,
  type ContentVersionAuthorityDiscoveryResult
} from "@planweave-ai/collaboration-protocol/content/authority";
import {
  canvasRuntimeAvailabilitySchema,
  canvasRuntimeStateAvailabilitySchema,
  importCanvasRuntimeStatusRequestSchema,
  type CanvasRuntimeAvailability,
  type CanvasRuntimeStateAvailability,
  type ImportCanvasRuntimeStatusRequest
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  type CanvasCommandOutcome,
  type CanvasRevision
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  type CanvasScopeRef,
  type WorkItemRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  type CanvasPresencePointer,
  type CanvasPresenceSelectionId
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import {
  type CollaborationClientLimits,
  type CollaborationConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import type { z, ZodType } from "zod";
import { CollaborationClientError, collaborationErrorFromHttp } from "./collaborationErrors.js";
import { CanvasPresenceClient } from "./CanvasPresenceClient.js";
import {
  CanvasLiveSyncClient,
  type CanvasLiveSyncHandlers,
  type CanvasLiveSyncStatus
} from "./CanvasLiveSyncClient.js";
import { CollaborationRegistryClient } from "./CollaborationRegistryClient.js";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort,
  CollaborationObserverHandlers,
  CollaborationObserverStatus,
  CollaborationPresenceHandlers,
  CollaborationPresenceStatus,
  CollaborationWebSocketConstructor
} from "./collaborationClientTypes.js";
import { systemCollaborationClock } from "./collaborationClientTypes.js";
import { CollaborationHttpTransport } from "./collaborationHttpTransport.js";
import { fetchContentVersionTransfer } from "./contentVersionTransfer.js";
import {
  CanvasCommandClient,
  type CanvasCommandMaterializationHooks,
  type CanvasCommandReconnectInput,
  type CanvasCommandSubmitInput
} from "./CanvasCommandClient.js";
import type { CanvasCommandSessionSnapshot } from "./canvasCommandSession.js";
import {
  CollaborationRemoteOperationsClient,
  type CollaborationRemoteOperationsPort
} from "./CollaborationRemoteOperationsClient.js";
import { HumanObserverClient } from "./HumanObserverClient.js";
import { CollaborationAssignmentClient } from "./CollaborationAssignmentClient.js";

export type {
  CollaborationClientClock,
  CollaborationCredentialPort,
  CollaborationObserverHandlers,
  CollaborationObserverStatus,
  CollaborationPresenceHandlers,
  CollaborationPresenceStatus,
  CollaborationWebSocketConstructor,
  CollaborationWebSocketLike
} from "./collaborationClientTypes.js";

export type CollaborationClientOptions = {
  profile: CollaborationConnectionProfile;
  credential: CollaborationCredentialPort;
  limits?: Partial<CollaborationClientLimits>;
  request?: typeof fetch;
  WebSocketImpl?: CollaborationWebSocketConstructor;
  clock?: CollaborationClientClock;
  random?: () => number;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

/**
 * Electron-main human collaboration client.
 *
 * Application-shaped methods only — no raw `request(path)` or socket access for callers.
 * Validates every JSON response/event with collaboration-protocol Zod schemas.
 */
export class CollaborationClient {
  private readonly transport: CollaborationHttpTransport;
  private readonly clock: CollaborationClientClock;
  private readonly random: () => number;
  private disposed = false;

  private readonly presence: CanvasPresenceClient;
  private readonly liveSync: CanvasLiveSyncClient;
  private readonly registryClient: CollaborationRegistryClient;
  private readonly canvasCommands: CanvasCommandClient;
  private readonly remoteOperationsClient: CollaborationRemoteOperationsClient;
  private readonly assignmentClient: CollaborationAssignmentClient;
  private readonly observer: HumanObserverClient;

  constructor(private readonly options: CollaborationClientOptions) {
    if (options.profile.endpoint.tlsTrust === "configured_ca") {
      throw new Error("collaboration_configured_ca_unsupported");
    }
    this.transport = new CollaborationHttpTransport({
      serverBaseUrl: options.profile.serverBaseUrl,
      credential: options.credential,
      limits: options.limits,
      request: options.request,
      clock: options.clock
    });
    this.clock = options.clock ?? systemCollaborationClock;
    this.random = options.random ?? Math.random;
    this.presence = new CanvasPresenceClient({
      profile: options.profile,
      credential: options.credential,
      WebSocketImpl: options.WebSocketImpl,
      clock: this.clock,
      random: this.random,
      reconnectInitialDelayMs: this.transport.limits.reconnectInitialDelayMs,
      reconnectMaxDelayMs: this.transport.limits.reconnectMaxDelayMs,
      logger: options.logger
    });
    this.liveSync = new CanvasLiveSyncClient({
      profile: options.profile,
      credential: options.credential,
      WebSocketImpl: options.WebSocketImpl,
      clock: this.clock,
      random: this.random,
      reconnectInitialDelayMs: this.transport.limits.reconnectInitialDelayMs,
      reconnectMaxDelayMs: this.transport.limits.reconnectMaxDelayMs,
      logger: options.logger
    });
    this.registryClient = new CollaborationRegistryClient((method, path, schema, requestOptions) =>
      this.transport.json(method, path, schema, {
        ...requestOptions,
        auth: true
      })
    );
    this.canvasCommands = new CanvasCommandClient(this.transport, options.profile.projectId);
    this.remoteOperationsClient = new CollaborationRemoteOperationsClient(
      options.profile.projectId,
      this.transport
    );
    this.assignmentClient = new CollaborationAssignmentClient(
      this.transport,
      options.profile.projectId
    );
    this.observer = new HumanObserverClient({
      profile: options.profile,
      credential: options.credential,
      WebSocketImpl: options.WebSocketImpl,
      clock: this.clock,
      random: this.random,
      limits: this.transport.limits,
      logger: options.logger
    });
  }

  get projectId(): string {
    return this.options.profile.projectId;
  }

  get connectionProfile(): CollaborationConnectionProfile {
    return this.options.profile;
  }

  private get profile(): CollaborationConnectionProfile {
    return this.options.profile;
  }

  private get limits(): CollaborationClientLimits {
    return this.transport.limits;
  }

  registry(): CollaborationRegistryClient {
    return this.registryClient;
  }

  remoteOperations(): CollaborationRemoteOperationsPort {
    return this.remoteOperationsClient;
  }

  observerState(): CollaborationObserverStatus {
    return this.observer.state();
  }

  lastObserverCursor(): HumanObserverCursor {
    return this.observer.lastCursor();
  }

  presenceState(): CollaborationPresenceStatus {
    return this.presence.state();
  }

  presenceCanvas(): string | null {
    return this.presence.canvas();
  }

  liveSyncState(): CanvasLiveSyncStatus {
    return this.liveSync.state();
  }

  liveSyncCanvas(): string | null {
    return this.liveSync.canvas();
  }

  liveSyncHelloRevision(): CanvasRevision | null {
    return this.liveSync.helloRevision();
  }

  /** Non-owning live listeners (renderer signals, etc.). Does not restart the socket. */
  subscribeLiveSync(handlers: CanvasLiveSyncHandlers): () => void {
    return this.liveSync.subscribe(handlers);
  }

  /**
   * Advance the live hello cursor by exactly one after a single live entry was applied.
   */
  acknowledgeLiveSyncRevision(revision: CanvasRevision): void {
    this.liveSync.acknowledgeAppliedRevision(revision);
  }

  /**
   * Advance the live hello cursor to a recovered store head after HTTP catch-up.
   * Allows monotone jumps across multiple missing revisions.
   */
  acknowledgeLiveSyncMaterializedHead(revision: CanvasRevision): void {
    this.liveSync.acknowledgeMaterializedHead(revision);
  }

  reportLiveSyncCatchupRecovering(canvasId: string, attempt: number, delayMs: number): void {
    this.liveSync.reportCatchupRecovering(canvasId, attempt, delayMs);
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  async bootstrapOwner(
    input: HumanBootstrapRequest,
    signal?: AbortSignal
  ): Promise<HumanBootstrapResponse> {
    const body = humanBootstrapRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/bootstrap`,
      humanBootstrapResponseSchema,
      { body, auth: false, signal }
    );
  }

  async consumeInvitation(
    input: HumanConsumeInvitationRequest,
    signal?: AbortSignal
  ): Promise<HumanConsumeInvitationResponse> {
    const body = humanConsumeInvitationRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations/consume`,
      humanConsumeInvitationResponseSchema,
      { body, auth: false, signal }
    );
  }

  async createInvitation(
    input: z.input<typeof humanCreateInvitationRequestSchema> = {},
    signal?: AbortSignal
  ): Promise<HumanCreateInvitationResponse> {
    const body = humanCreateInvitationRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations`,
      humanCreateInvitationResponseSchema,
      { body, signal }
    );
  }

  async listInvitations(
    query: z.input<typeof humanInvitationListQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<HumanInvitationPage> {
    const q = humanInvitationListQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit)
    });
    if (q.openOnly !== undefined) params.set("openOnly", q.openOnly ? "true" : "false");
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations?${params}`,
      humanInvitationPageSchema,
      { signal }
    );
  }

  async revokeInvitation(invitationId: string, signal?: AbortSignal): Promise<HumanInvitationView> {
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations/${encodeURIComponent(invitationId)}/revoke`,
      humanInvitationViewSchema,
      { body: {}, signal }
    );
  }

  async revokeInvitations(
    input: z.input<typeof humanRevokeInvitationsRequestSchema>,
    signal?: AbortSignal
  ): Promise<HumanRevokeInvitationsResponse> {
    const body = humanRevokeInvitationsRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations/revoke-batch`,
      humanRevokeInvitationsResponseSchema,
      { body, signal }
    );
  }

  async listMembers(
    query: z.input<typeof humanPageQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<HumanMemberPage> {
    const q = humanPageQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit)
    });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members?${params}`,
      humanMemberPageSchema,
      { signal }
    );
  }

  async verifyAccess(signal?: AbortSignal): Promise<void> {
    await this.listMembers({ cursor: 0, limit: 1 }, signal);
  }

  async updateOwnDisplayName(
    input: HumanUpdateDisplayNameRequest,
    signal?: AbortSignal
  ): Promise<HumanPrincipalView> {
    const body = humanUpdateDisplayNameRequestSchema.parse(input);
    return this.json(
      "PATCH",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/me`,
      humanPrincipalViewSchema,
      { body, signal }
    );
  }

  async removeMember(humanPrincipalId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members/${encodeURIComponent(humanPrincipalId)}/remove`,
      { body: {}, signal }
    );
  }

  async promoteOwner(humanPrincipalId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members/${encodeURIComponent(humanPrincipalId)}/promote`,
      { body: {}, signal }
    );
  }

  async demoteOwner(humanPrincipalId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members/${encodeURIComponent(humanPrincipalId)}/demote`,
      { body: {}, signal }
    );
  }

  async listDevices(
    query: z.input<typeof humanDeviceListQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<HumanDevicePage> {
    const q = humanDeviceListQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit),
      scope: q.scope
    });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/devices?${params}`,
      humanDevicePageSchema,
      { signal }
    );
  }

  async revokeDevice(deviceCredentialId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/devices/${encodeURIComponent(deviceCredentialId)}/revoke`,
      { body: {}, signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Assignments (application wire paths; Server HTTP may land after domain)
  // ---------------------------------------------------------------------------

  async getAssignment(
    workItem: WorkItemRef,
    signal?: AbortSignal
  ): Promise<AssignmentDisplayProjection> {
    return this.assignmentClient.getAssignment(workItem, signal);
  }

  async listAssignments(
    query: z.input<typeof assignmentListQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<AssignmentListPage> {
    return this.assignmentClient.listAssignments(query, signal);
  }

  async updateAssignment(
    command: AssignmentUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<AssignmentDisplayProjection> {
    return this.assignmentClient.updateAssignment(command, signal);
  }

  async listEligibleAssignees(
    workItem: WorkItemRef,
    signal?: AbortSignal
  ): Promise<EligibleAssigneesResponse> {
    return this.assignmentClient.listEligibleAssignees(workItem, signal);
  }

  async listEligibleHostsBatch(
    request: EligibleHostBatchRequest,
    signal?: AbortSignal
  ): Promise<EligibleHostBatchResponse> {
    return this.assignmentClient.listEligibleHostsBatch(request, signal);
  }

  // ---------------------------------------------------------------------------
  // Separated responsibility / reviewer / execution-target authorities (OSS-003)
  // ---------------------------------------------------------------------------

  async getWorkAuthority(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<WorkAuthorityProjection> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/authority?${params}`,
      workAuthorityProjectionSchema,
      { signal }
    );
  }

  async getResponsibility(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<ResponsibilityReadModel | null> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.jsonNullable(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/responsibility?${params}`,
      responsibilityReadModelSchema,
      { signal }
    );
  }

  async updateResponsibility(
    command: ResponsibilityUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<ResponsibilityReadModel> {
    const body = responsibilityUpdateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/responsibility`,
      responsibilityReadModelSchema,
      { body, signal }
    );
  }

  async getReviewer(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<ReviewAssignmentReadModel | null> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.jsonNullable(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/reviewer?${params}`,
      reviewAssignmentReadModelSchema,
      { signal }
    );
  }

  async updateReviewer(
    command: ReviewAssignmentUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<ReviewAssignmentReadModel> {
    const body = reviewAssignmentUpdateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/reviewer`,
      reviewAssignmentReadModelSchema,
      { body, signal }
    );
  }

  async getExecutionTarget(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<ExecutionTargetReadModel | null> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.jsonNullable(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/execution-target?${params}`,
      executionTargetReadModelSchema,
      { signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Comments / activity
  // ---------------------------------------------------------------------------

  async listComments(query: CommentListWireQuery, signal?: AbortSignal): Promise<CommentListPage> {
    const q = commentListWireQuerySchema.parse(query);
    const params = new URLSearchParams({
      workItem: JSON.stringify(q.workItem),
      limit: String(q.limit),
      includeTombstoned: q.includeTombstoned ? "true" : "false"
    });
    if (q.cursor) params.set("cursor", JSON.stringify(q.cursor));
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments?${params}`,
      commentListPageSchema,
      { signal }
    );
  }

  async createComment(
    command: CommentCreateWireCommand,
    signal?: AbortSignal
  ): Promise<CommentDisplayProjection> {
    const body = commentCreateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments`,
      commentDisplayProjectionSchema,
      { body, signal }
    );
  }

  async editComment(
    command: CommentEditWireCommand,
    signal?: AbortSignal
  ): Promise<CommentDisplayProjection> {
    const body = commentEditWireCommandSchema.parse(command);
    return this.json(
      "PATCH",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments/${encodeURIComponent(body.commentId)}`,
      commentDisplayProjectionSchema,
      {
        body: { body: body.body, expectedRevision: body.expectedRevision },
        signal
      }
    );
  }

  async tombstoneComment(
    command: CommentTombstoneWireCommand,
    signal?: AbortSignal
  ): Promise<CommentDisplayProjection> {
    const body = commentTombstoneWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments/${encodeURIComponent(body.commentId)}/tombstone`,
      commentDisplayProjectionSchema,
      {
        body: { expectedRevision: body.expectedRevision, reason: body.reason },
        signal
      }
    );
  }

  async listActivity(
    query: z.input<typeof activityListWireQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<ActivityListPage> {
    const q = activityListWireQuerySchema.parse(query);
    const params = new URLSearchParams({ limit: String(q.limit) });
    if (q.workItem) params.set("workItem", JSON.stringify(q.workItem));
    if (q.cursor) params.set("cursor", JSON.stringify(q.cursor));
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/activity?${params}`,
      activityListPageSchema,
      { signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Remote ACP run observation / control (human remote_run_control)
  // Distinct from local Runtime Auto Run and Host mailbox.
  // ---------------------------------------------------------------------------

  async listAgentEndpoints(signal?: AbortSignal): Promise<RemoteAgentEndpointList> {
    return this.remoteOperationsClient.listAgentEndpoints(signal);
  }

  async dispatchRemoteOperation(
    command: RemoteDispatchIntentV3,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    return this.remoteOperationsClient.dispatchRemoteOperation(command, signal);
  }

  async observeRemoteOperation(
    operationId: string,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    return this.remoteOperationsClient.observeRemoteOperation(operationId, signal);
  }

  async executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand,
    signal?: AbortSignal
  ): Promise<RemoteActionView> {
    return this.remoteOperationsClient.executeRemoteOperationAction(operationId, action, signal);
  }

  async replayRemoteOperationEvents(
    operationId: string,
    query: z.input<typeof remoteEventQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteEventReplay> {
    return this.remoteOperationsClient.replayRemoteOperationEvents(operationId, query, signal);
  }

  async listRemoteOperationInteractions(
    operationId: string,
    query: z.input<typeof remoteInteractionPageQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteInteractionPage> {
    return this.remoteOperationsClient.listRemoteOperationInteractions(operationId, query, signal);
  }

  async settleRemoteOperationInteraction(
    operationId: string,
    settlement: RemoteInteractionResponse,
    signal?: AbortSignal
  ): Promise<RemoteInteractionView> {
    return this.remoteOperationsClient.settleRemoteOperationInteraction(
      operationId,
      settlement,
      signal
    );
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  async createPendingAttachment(
    input: CreatePendingAttachmentRequest,
    signal?: AbortSignal
  ): Promise<PendingAttachmentView> {
    const body = createPendingAttachmentRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/attachments/pending`,
      pendingAttachmentViewSchema,
      { body, signal }
    );
  }

  async uploadPendingAttachment(
    pendingUploadId: string,
    input: { body: Uint8Array; mediaType: string; digestSha256?: string },
    signal?: AbortSignal
  ): Promise<PendingAttachmentView> {
    this.ensureOpen();
    const path =
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}` +
      `/attachments/pending/${encodeURIComponent(pendingUploadId)}`;
    const headers: Record<string, string> = {
      "content-type": input.mediaType,
      "content-length": String(input.body.byteLength)
    };
    if (input.digestSha256) headers["x-planweave-content-sha256"] = input.digestSha256;
    await this.transport.applyAuth(headers);
    const response = await this.transport.send(path, {
      method: "PUT",
      headers,
      body: input.body,
      signal
    });
    // Reuse transport JSON body budget via a raw send + manual size check path.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.limits.jsonBodyMaxBytes) {
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_response_too_large",
        message: "Response exceeded body size limit.",
        httpStatus: response.status
      });
    }
    const text = Buffer.from(buffer).toString("utf8");
    if (!response.ok) {
      throw collaborationErrorFromHttp(response.status, text, response.headers.get("retry-after"));
    }
    const parsed = uploadPendingAttachmentResponseSchema.parse(JSON.parse(text));
    return pendingAttachmentViewSchema.parse({
      pendingUploadId: parsed.pendingUploadId,
      projectId: this.profile.projectId,
      expectedSizeBytes: parsed.sizeBytes ?? input.body.byteLength,
      mediaType: parsed.mediaType,
      status: parsed.status === "finalized" ? "finalized" : "uploaded",
      createdAt: this.clock.now().toISOString(),
      expiresAt: this.clock.now().toISOString(),
      digestSha256: parsed.digestSha256,
      uploadedAt: parsed.uploadedAt
    });
  }

  async finalizePendingAttachment(
    pendingUploadId: string,
    input: { expectedDigestSha256?: string } = {},
    signal?: AbortSignal
  ): Promise<FinalizePendingAttachmentResponse> {
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/attachments/pending/${encodeURIComponent(pendingUploadId)}/finalize`,
      finalizePendingAttachmentResponseSchema,
      { body: input, signal }
    );
  }

  async readCommentAttachment(
    commentId: string,
    digestSha256: string,
    signal?: AbortSignal
  ): Promise<{
    digestSha256: string;
    mediaType: CommentAttachmentMediaType;
    sizeBytes: number;
    bodyBase64: string;
  }> {
    this.ensureOpen();
    const path =
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}` +
      `/attachments/comments/${encodeURIComponent(commentId)}/${encodeURIComponent(digestSha256)}`;
    const headers: Record<string, string> = { accept: "*/*" };
    await this.transport.applyAuth(headers);
    const response = await this.transport.send(path, {
      method: "GET",
      headers,
      signal
    });
    if (!response.ok) {
      const text = await this.transport.readBoundedError(response);
      throw collaborationErrorFromHttp(response.status, text, response.headers.get("retry-after"));
    }
    const mediaType = commentAttachmentMediaTypeSchema.parse(
      response.headers.get("content-type")?.split(";", 1)[0]?.trim()
    );
    const bytes = await this.transport.readBytesLimited(response, COMMENT_ATTACHMENT_MAX_BYTES);
    const sizeBytes = commentAttachmentSizeBytesSchema.parse(bytes.byteLength);
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== digestSha256) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_attachment_digest_mismatch",
        message: "Attachment content did not match its declared digest.",
        retryable: true
      });
    }
    return {
      digestSha256: actualDigest,
      mediaType,
      sizeBytes,
      bodyBase64: Buffer.from(bytes).toString("base64")
    };
  }

  // ---------------------------------------------------------------------------
  // Ephemeral canvas presence subscription
  // ---------------------------------------------------------------------------

  startPresence(canvasId: string, handlers: CollaborationPresenceHandlers = {}): void {
    this.ensureOpen();
    this.presence.start(canvasId, handlers);
  }

  /** Publish only bounded pointer/selection state for the currently selected canvas. */
  publishPresence(input: {
    pointer: CanvasPresencePointer | null;
    selectionIds: CanvasPresenceSelectionId[];
  }): void {
    this.ensureOpen();
    this.presence.publish(input);
  }

  stopPresence(): void {
    this.presence.stop();
  }

  /**
   * Own the live socket for one canvas. Handlers are subscribed (not exclusive);
   * additional consumers must use subscribeLiveSync so they never replace replica handlers.
   */
  startLiveSync(
    canvasId: string,
    lastRevision: CanvasRevision,
    handlers: CanvasLiveSyncHandlers = {}
  ): void {
    this.ensureOpen();
    this.liveSync.start(canvasId, lastRevision, handlers);
  }

  stopLiveSync(): void {
    this.liveSync.stop();
  }

  // ---------------------------------------------------------------------------
  // Server-authoritative canvas commands (durable; not presence)
  // ---------------------------------------------------------------------------

  canvasCommandSession(): CanvasCommandSessionSnapshot | null {
    return this.canvasCommands.sessionSnapshot();
  }

  bindCanvasCommandSession(canvasId: string): void {
    this.ensureOpen();
    this.canvasCommands.bindCanvas(canvasId);
  }

  /** Drop durable canvas command session cursor after a failed rebind or disconnect. */
  clearCanvasCommandSession(): void {
    this.canvasCommands.clearSession();
  }

  async submitCanvasCommand(
    input: CanvasCommandSubmitInput,
    signal?: AbortSignal,
    hooks?: CanvasCommandMaterializationHooks
  ): Promise<CanvasCommandOutcome> {
    this.ensureOpen();
    return this.canvasCommands.submit(input, signal, hooks);
  }

  async reconnectCanvasCommands(
    input: CanvasCommandReconnectInput,
    signal?: AbortSignal,
    hooks?: CanvasCommandMaterializationHooks
  ): Promise<ReturnType<CanvasCommandClient["reconnect"]>> {
    this.ensureOpen();
    return this.canvasCommands.reconnect(input, signal, hooks);
  }

  /** Read the authoritative access view for one canvas through the device-authenticated transport. */
  async getCurrentCanvasAccess(canvasId: string): Promise<CurrentCanvasAccessView> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/access`,
      currentCanvasAccessViewSchema
    );
  }

  /** Apply one CAS-protected ACL mutation against the current-canvas endpoint. */
  async mutateCurrentCanvasAccess(input: {
    canvasId: string;
    request: unknown;
  }): Promise<AccessMutationResult> {
    const body = accessMutationRequestSchema.parse(input.request);
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/access`,
      accessMutationResultSchema,
      { body, acceptedStatus: [403, 409] }
    );
  }

  async discoverContentAuthority(input: {
    canvasId: string;
    localReplica: CompletedContentVersionRef | null;
    knownRevision: number | null;
  }): Promise<ContentVersionAuthorityDiscoveryResult> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/content/head`,
      contentVersionAuthorityDiscoveryResultSchema,
      { body: input }
    );
  }

  async publishInitialContent(input: {
    canvasId: string;
    content: CompleteContentVersion;
  }): Promise<FirstContentVersionPublishResult> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/content/initial-publish`,
      firstContentVersionPublishResultSchema,
      {
        body: {
          expectedHeadRevision: 0,
          expectedHeadVersionId: null,
          content: input.content
        },
        acceptedStatus: 409
      }
    );
  }

  async fetchContentVersion(input: {
    scope: CanvasScopeRef;
    content: CompletedContentVersionRef;
  }): Promise<AuthoritativeContentVersion> {
    return fetchContentVersionTransfer({
      transport: this.transport,
      scope: input.scope,
      content: input.content
    });
  }

  async acknowledgeContentVersion(input: {
    canvasId: string;
    content: CompletedContentVersionRef;
  }): Promise<ContentVersionAcknowledgement> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/content/acknowledgements`,
      contentVersionAcknowledgementSchema,
      { body: { content: input.content } }
    );
  }

  async readRuntimeAvailability(
    canvasId: string,
    signal?: AbortSignal
  ): Promise<CanvasRuntimeAvailability> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/runtime-availability`,
      canvasRuntimeAvailabilitySchema,
      { signal }
    );
  }

  async importRuntimeStatus(
    canvasId: string,
    input: ImportCanvasRuntimeStatusRequest
  ): Promise<CanvasRuntimeStateAvailability> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/runtime-status/import`,
      canvasRuntimeStateAvailabilitySchema,
      { body: importCanvasRuntimeStatusRequestSchema.parse(input) }
    );
  }

  // ---------------------------------------------------------------------------
  // Human observer subscription
  // ---------------------------------------------------------------------------

  /**
   * Start the distinct human observer WSS subscription.
   * Uses the last validated cursor for reconnect catch-up.
   */
  startObserver(handlers: CollaborationObserverHandlers = {}, options?: { cursor?: number }): void {
    this.ensureOpen();
    this.observer.start(handlers, options);
  }

  stopObserver(): void {
    this.observer.stop();
  }

  /**
   * Abort in-flight HTTP and tear down the observer. Irreversible for this instance.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.dispose();
    this.stopPresence();
    this.stopLiveSync();
    this.canvasCommands.clearSession();
    this.transport.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ensureOpen(): void {
    if (this.disposed) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CollaborationClient has been disposed."
      });
    }
    this.transport.ensureOpen();
  }

  private async jsonEmpty(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    await this.transport.jsonEmpty(method, path, options);
  }

  private async json<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    schema: ZodType<T> | undefined,
    options: {
      body?: unknown;
      auth?: boolean;
      signal?: AbortSignal;
      acceptedStatus?: number | number[];
    }
  ): Promise<T> {
    return this.transport.json(method, path, schema, options);
  }

  private async jsonNullable<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal }
  ): Promise<T | null> {
    return this.transport.jsonNullable(method, path, schema, options);
  }
}
