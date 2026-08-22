import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import { WORK_ELIGIBLE_HOST_BATCH_MAX } from "@planweave-ai/collaboration-protocol/core/limits";
import type { CommentDisplayProjection } from "@planweave-ai/collaboration-protocol/activity/comments";
import type { HumanObserverEvent } from "@planweave-ai/collaboration-protocol/activity/observer";
import type { ResponsibilityReadModel } from "@planweave-ai/collaboration-protocol/work/responsibility";
import type { ReviewAssignmentReadModel } from "@planweave-ai/collaboration-protocol/work/review";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import {
  workItemKey,
  type CollaborationActivityListQueryInput,
  type CollaborationAssignmentListQueryInput,
  type CollaborationAssignmentUpdateInput,
  type CollaborationBoundaryErrorView,
  type CollaborationCommentCreateInput,
  type CollaborationCommentEditInput,
  type CollaborationCommentListQueryInput,
  type CollaborationCommentTombstoneInput,
  type CollaborationHostProjection,
  type CollaborationMutationRecord,
  type CollaborationObserverSignal,
  type CollaborationReadModelSnapshot,
  type CollaborationRemoteRunProjection,
  type CollaborationRemoteRunStatus,
  type CollaborationResponsibilityUpdateInput,
  type CollaborationReviewerUpdateInput,
  type CollaborationSyncPhase,
  type HumanMembershipView
} from "../../shared/collaborationReadModels.js";
import { isCollaborationSessionConnected } from "./sessionState";
import { readBoundedNumberCursorPages } from "./boundedPagination.js";
import {
  buildAssignmentRefreshProjection,
  mergeAssignmentHosts
} from "./assignmentRefreshProjection.js";
import { beginLoading } from "./loadingLease.js";
import {
  collaborationBoundaryErrorFromUnknown,
  syncPhaseAfterCollaborationBoundaryError
} from "./collaborationBoundaryError.js";
import { CollaborationObserverQueue } from "./collaborationObserverQueue.js";
import { CollaborationObserverRecovery } from "./collaborationObserverRecovery.js";
import { ingestAssignmentHost, upsertCommentProjection } from "./collaborationProjectionUpdates.js";
import { buildCollaborationSnapshot } from "./collaborationSnapshot.js";
import {
  CollaborationEventCursorWindow,
  CollaborationMutationLedger
} from "./collaborationRetention.js";
import {
  AuthoritativeRefreshArbitrator,
  type AggregateRefreshApplication
} from "./refreshArbitration.js";

export type CollaborationReadBridgePort = Pick<
  PlanWeaveCollaborationApi,
  | "getCollaborationStatus"
  | "listCollaborationMembers"
  | "listCollaborationAssignments"
  | "listCollaborationEligibleAssignees"
  | "listCollaborationEligibleHostsBatch"
  | "getCollaborationWorkAuthority"
  | "updateCollaborationResponsibility"
  | "updateCollaborationReviewer"
  | "listCollaborationComments"
  | "listCollaborationActivity"
  | "updateCollaborationAssignment"
  | "createCollaborationComment"
  | "editCollaborationComment"
  | "tombstoneCollaborationComment"
  | "onCollaborationStatusChanged"
  | "onCollaborationObserverSignal"
>;

export type CollaborationReadModelControllerOptions = {
  api: CollaborationReadBridgePort;
  pageLimit?: number;
  clock?: { now(): Date };
  createMutationId?: () => string;
};

type InternalState = {
  profileId: string | null;
  projectId: string | null;
  canvasId: string | null;
  syncPhase: CollaborationSyncPhase;
  observerCursor: number;
  members: HumanMembershipView[];
  hosts: Map<string, CollaborationHostProjection>;
  assignments: Map<string, AssignmentDisplayProjection>;
  workAuthorities: Map<string, WorkAuthorityProjection>;
  comments: Map<string, CommentDisplayProjection[]>;
  activity: CollaborationReadModelSnapshot["activity"];
  remoteRuns: Map<string, CollaborationRemoteRunProjection>;
  mutations: CollaborationMutationLedger;
  lastError: CollaborationBoundaryErrorView | null;
  loadingKinds: Map<string, number>;
  trackedCommentWorkItems: Map<string, WorkItemRef>;
  trackedAuthorityWorkItems: Map<string, WorkItemRef>;
  eventCursors: CollaborationEventCursorWindow;
  generation: number;
  updatedAt: string;
};

const DEFAULT_PAGE_LIMIT = WORK_ELIGIBLE_HOST_BATCH_MAX;
type RefreshApplication = "applied" | "superseded";
type ObserverEventSignal = Extract<CollaborationObserverSignal, { type: "human.observer.event" }>;
type ObserverEventQueueEntry = {
  signal: ObserverEventSignal;
  generation: number;
  eventCursors: CollaborationEventCursorWindow;
};

const OBSERVER_INVALIDATION_CONCURRENCY = 4;
const OBSERVER_EVENT_QUEUE_LIMIT = 128;

function emptyState(now: string): InternalState {
  return {
    profileId: null,
    projectId: null,
    canvasId: null,
    syncPhase: "idle",
    observerCursor: 0,
    members: [],
    hosts: new Map(),
    assignments: new Map(),
    workAuthorities: new Map(),
    comments: new Map(),
    activity: [],
    remoteRuns: new Map(),
    mutations: new CollaborationMutationLedger(),
    lastError: null,
    loadingKinds: new Map(),
    trackedCommentWorkItems: new Map(),
    trackedAuthorityWorkItems: new Map(),
    eventCursors: new CollaborationEventCursorWindow(),
    generation: 0,
    updatedAt: now
  };
}

function mapSessionPhaseToSync(
  status: CollaborationStatus,
  current: CollaborationSyncPhase
): CollaborationSyncPhase {
  const phase = status.session.phase;
  const detail = status.session.detail ?? "";
  if (phase === "idle" || phase === "ready") return "disconnected";
  if (phase === "connecting") {
    if (detail.includes("reconnecting")) return "reconnecting";
    return current === "ready" || current === "degraded" ? "reconnecting" : "loading";
  }
  if (phase === "error") {
    if (
      status.session.lastErrorCode === "human_device_expired" ||
      detail.includes("auth_expired")
    ) {
      return "auth_expired";
    }
    if (
      status.session.lastErrorCode?.includes("forbidden") ||
      status.session.lastErrorCode === "http_403"
    ) {
      return "forbidden";
    }
    return "error";
  }
  if (isCollaborationSessionConnected(status)) {
    if (status.session.lastErrorCode?.startsWith("collaboration_observer_")) {
      return "degraded";
    }
    if (current === "loading") return "loading";
    if (current === "stale_conflict") return "stale_conflict";
    if (current === "degraded") return "degraded";
    return current === "idle" || current === "disconnected" || current === "error"
      ? "loading"
      : current === "reconnecting"
        ? "ready"
        : current;
  }
  return current;
}

function remoteStatusFromActivityType(type: string): CollaborationRemoteRunStatus | null {
  switch (type) {
    case "remote_run_started":
      return "started";
    case "remote_run_succeeded":
      return "succeeded";
    case "remote_run_failed":
      return "failed";
    case "remote_run_interrupted":
      return "interrupted";
    default:
      return null;
  }
}

/**
 * Owns server collaboration projections for one active profile/project.
 * Components subscribe to snapshots; they never open their own observer connections.
 */
export class CollaborationReadModelController {
  private readonly api: CollaborationReadBridgePort;
  private readonly pageLimit: number;
  private readonly clock: { now(): Date };
  private readonly createMutationId: () => string;
  private state: InternalState;
  private listeners = new Set<(snapshot: CollaborationReadModelSnapshot) => void>();
  private unsubscribers: Array<() => void> = [];
  private disposed = false;
  private generationEpoch = 0;
  private mutationSeq = 0;
  private observerAttemptSeq = 0;
  private refreshRequestSeq = 0;
  private lastSuccessfulRefreshRequest = 0;
  private readonly observerCursorRecovery = new CollaborationObserverRecovery();
  private readonly observerEventQueue = new CollaborationObserverQueue<ObserverEventQueueEntry>({
    concurrency: OBSERVER_INVALIDATION_CONCURRENCY,
    queueLimit: OBSERVER_EVENT_QUEUE_LIMIT,
    key: (entry) => entry.signal.event.cursor,
    isCurrent: (entry) => this.matchesObserverContext(entry),
    execute: (entry) => this.applyObserverEvent(entry)
  });
  private refreshArbitration = new AuthoritativeRefreshArbitrator();
  private assignmentReloadSeqByKey = new Map<string, number>();
  private assignmentChangeVersionByKey = new Map<string, number>();
  private refreshQueue: Promise<void> = Promise.resolve();
  /** Cached for useSyncExternalStore — must be referentially stable between emissions. */
  private cachedSnapshot: CollaborationReadModelSnapshot;

  constructor(options: CollaborationReadModelControllerOptions) {
    this.api = options.api;
    this.pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.clock = options.clock ?? { now: () => new Date() };
    this.createMutationId =
      options.createMutationId ??
      (() => {
        this.mutationSeq += 1;
        return `mut-${this.mutationSeq}`;
      });
    this.state = emptyState(this.clock.now().toISOString());
    this.cachedSnapshot = buildCollaborationSnapshot(this.state);
  }

  getSnapshot(): CollaborationReadModelSnapshot {
    return this.cachedSnapshot;
  }

  subscribe(listener: (snapshot: CollaborationReadModelSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Bind to an active collaboration profile/project and load authoritative projections.
   * Stops previous subscriptions when the project identity changes.
   */
  async setActiveProject(input: {
    profileId: string;
    projectId: string;
    canvasId?: string | null;
  }): Promise<void> {
    this.assertOpen();
    const sameIdentity =
      this.state.profileId === input.profileId && this.state.projectId === input.projectId;
    if (!sameIdentity) {
      this.teardownSubscriptions();
      this.observerEventQueue.cancelQueued();
      this.state = {
        ...emptyState(this.clock.now().toISOString()),
        profileId: input.profileId,
        projectId: input.projectId,
        canvasId: input.canvasId ?? null,
        syncPhase: "loading",
        generation: this.nextGeneration()
      };
      this.attachSubscriptions();
      this.emit();
    } else if ((input.canvasId ?? null) !== this.state.canvasId) {
      this.state.canvasId = input.canvasId ?? null;
      this.state.generation = this.nextGeneration();
      this.state.loadingKinds = new Map();
    }

    const generation = this.state.generation;
    await this.refreshAuthoritative({ reason: "set_active_project" }, generation);
  }

  /** Stop all subscriptions and clear server projections (project switch / logout). */
  clear(): void {
    this.teardownSubscriptions();
    this.observerEventQueue.cancelQueued();
    this.observerCursorRecovery.clear();
    this.state = {
      ...emptyState(this.clock.now().toISOString()),
      generation: this.nextGeneration()
    };
    this.emit();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.listeners.clear();
  }

  /** Track comments for a work item and load the authoritative page. */
  async trackWorkItemComments(workItem: WorkItemRef): Promise<void> {
    this.assertOpen();
    if (!this.state.projectId) return;
    const key = workItemKey(workItem);
    this.state.trackedCommentWorkItems.set(key, workItem);
    await this.reloadComments(workItem, this.state.generation);
  }

  async refreshAuthoritative(
    _meta: { reason: string } = { reason: "manual" },
    generation = this.state.generation
  ): Promise<void> {
    this.assertOpen();
    if (!this.state.profileId || !this.state.projectId) return;
    this.refreshRequestSeq += 1;
    const refreshRequest = this.refreshRequestSeq;

    this.refreshQueue = this.refreshQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed || generation !== this.state.generation) return;
        this.refreshArbitration.beginAggregate();
        const snapshotLoading = beginLoading(this.state, "snapshot");
        if (this.state.syncPhase !== "reconnecting" && this.state.syncPhase !== "auth_expired") {
          this.state.syncPhase = "loading";
        }
        this.emit();

        const results = await Promise.allSettled([
          this.reloadMembers(generation),
          this.reloadAssignments(generation),
          this.reloadActivity(generation),
          ...[...this.state.trackedCommentWorkItems.values()].map((workItem) =>
            this.reloadComments(workItem, generation)
          ),
          ...[...this.state.trackedAuthorityWorkItems.values()].map((workItem) =>
            this.reloadWorkAuthority(workItem, generation)
          )
        ]);

        snapshotLoading.release();
        if (this.disposed || generation !== this.state.generation) return;

        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length === 0) {
          const replacements = results.flatMap((result) =>
            result.status === "fulfilled" && result.value && typeof result.value === "object"
              ? [result.value as AggregateRefreshApplication]
              : []
          );
          if (this.refreshArbitration.settleAggregate(generation, replacements)) {
            this.lastSuccessfulRefreshRequest = refreshRequest;
            this.markReadyUnlessTerminal();
          }
        } else {
          this.refreshArbitration.cancelAggregate();
          const first = failures[0] as PromiseRejectedResult;
          const mapped = collaborationBoundaryErrorFromUnknown(first.reason);
          this.applyBoundaryError(mapped);
          this.markIncompleteAuthoritativeRefresh();
        }
        this.emit();
      });

    await this.refreshQueue;
  }

  async updateAssignment(
    command: CollaborationAssignmentUpdateInput
  ): Promise<AssignmentDisplayProjection | null> {
    return this.runMutation({
      kind: "assignment",
      workItem: command.workItem,
      expectedRevision: command.expectedRevision,
      execute: () => this.api.updateCollaborationAssignment(command),
      onConfirmed: (projection) => {
        this.state.assignments.set(workItemKey(projection.workItem), projection);
        ingestAssignmentHost(this.state.hosts, projection);
      }
    });
  }

  async updateResponsibility(
    command: CollaborationResponsibilityUpdateInput
  ): Promise<ResponsibilityReadModel | null> {
    const result = await this.runMutation({
      kind: "responsibility",
      workItem: command.workItem,
      expectedRevision: command.expectedRevision,
      execute: () => this.api.updateCollaborationResponsibility(command),
      onConfirmed: () => undefined
    });
    if (result) {
      try {
        await this.reloadWorkAuthority(command.workItem, this.state.generation);
      } catch {
        // Mutation succeeded; projection refresh errors surface via lastError on next load.
      }
    }
    return result;
  }

  async updateReviewer(
    command: CollaborationReviewerUpdateInput
  ): Promise<ReviewAssignmentReadModel | null> {
    const result = await this.runMutation({
      kind: "reviewer",
      workItem: command.workItem,
      expectedRevision: command.expectedRevision,
      execute: () => this.api.updateCollaborationReviewer(command),
      onConfirmed: () => undefined
    });
    if (result) {
      try {
        await this.reloadWorkAuthority(command.workItem, this.state.generation);
      } catch {
        // Mutation succeeded; projection refresh errors surface via lastError on next load.
      }
    }
    return result;
  }

  /** Track and load the independent authority projection for one work item. */
  async ensureWorkAuthority(workItem: WorkItemRef): Promise<WorkAuthorityProjection | null> {
    this.assertOpen();
    const key = workItemKey(workItem);
    this.state.trackedAuthorityWorkItems.set(key, workItem);
    await this.reloadWorkAuthority(workItem, this.state.generation);
    return this.state.workAuthorities.get(key) ?? null;
  }

  async createComment(
    command: CollaborationCommentCreateInput
  ): Promise<CommentDisplayProjection | null> {
    return this.runMutation({
      kind: "comment_create",
      workItem: command.workItem,
      execute: () => this.api.createCollaborationComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  async editComment(
    command: CollaborationCommentEditInput
  ): Promise<CommentDisplayProjection | null> {
    return this.runMutation({
      kind: "comment_edit",
      expectedRevision: command.expectedRevision,
      execute: () => this.api.editCollaborationComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  async tombstoneComment(
    command: CollaborationCommentTombstoneInput
  ): Promise<CommentDisplayProjection | null> {
    return this.runMutation({
      kind: "comment_tombstone",
      expectedRevision: command.expectedRevision,
      execute: () => this.api.tombstoneCollaborationComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  /** Test / advanced: inject status without bridge. */
  handleStatusForTests(status: CollaborationStatus): void {
    this.handleStatus(status);
  }

  /** Test / advanced: inject observer signal without bridge. */
  handleObserverSignalForTests(signal: CollaborationObserverSignal): void {
    const generation = this.state.generation;
    void this.handleObserverSignal(signal).catch((error: unknown) => {
      this.handleObserverSignalFailure(error, signal, generation);
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private attachSubscriptions(): void {
    this.unsubscribers.push(
      this.api.onCollaborationStatusChanged((status) => this.handleStatus(status)),
      this.api.onCollaborationObserverSignal((signal) => {
        const generation = this.state.generation;
        void this.handleObserverSignal(signal).catch((error: unknown) => {
          this.handleObserverSignalFailure(error, signal, generation);
        });
      })
    );
  }

  private handleObserverSignalFailure(
    error: unknown,
    signal: CollaborationObserverSignal,
    generation: number
  ): void {
    if (
      this.disposed ||
      generation !== this.state.generation ||
      this.state.profileId !== signal.profileId ||
      this.state.projectId !== signal.projectId
    ) {
      return;
    }
    this.applyBoundaryError(collaborationBoundaryErrorFromUnknown(error));
    if (
      signal.type === "human.observer.event" &&
      (signal.event.kind === "membership" ||
        signal.event.kind === "project" ||
        (signal.event.kind === "assignment" && !signal.event.workItem))
    ) {
      this.markIncompleteAuthoritativeRefresh();
    }
    this.emit();
  }

  private teardownSubscriptions(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // ignore unsubscribe races
      }
    }
  }

  private handleStatus(status: CollaborationStatus): void {
    if (this.disposed) return;
    if (this.state.profileId && status.session.activeProfileId) {
      if (status.session.activeProfileId !== this.state.profileId) {
        // Active profile switched elsewhere — clear this controller's cache.
        this.clear();
        return;
      }
    }
    const nextPhase = mapSessionPhaseToSync(status, this.state.syncPhase);
    if (nextPhase !== this.state.syncPhase) {
      this.state.syncPhase = nextPhase;
      this.state.updatedAt = this.clock.now().toISOString();
      if (status.session.lastErrorCode) {
        this.state.lastError = {
          kind: nextPhase === "auth_expired" ? "auth" : "unknown",
          code: status.session.lastErrorCode,
          message: status.session.lastErrorMessage ?? status.session.lastErrorCode,
          retryable: nextPhase === "reconnecting"
        };
      }
      this.emit();
    }
  }

  private async handleObserverSignal(signal: CollaborationObserverSignal): Promise<void> {
    if (this.disposed) return;
    if (this.state.profileId && signal.profileId !== this.state.profileId) return;
    if (this.state.projectId && signal.projectId !== this.state.projectId) return;

    const generation = this.state.generation;

    if (signal.type === "human.observer.cursor") {
      if (signal.cursor >= this.state.observerCursor) {
        this.state.observerCursor = signal.cursor;
        this.emit();
      }
      return;
    }

    if (signal.type === "human.observer.catchup_required") {
      // Retention gap / cursor reset: drop cached projections and reload bounded APIs.
      this.observerEventQueue.cancelQueued();
      this.state.generation = this.nextGeneration();
      this.state.observerCursor = signal.resumeCursor;
      this.state.eventCursors.resetForCatchup();
      this.state.assignments.clear();
      this.state.workAuthorities.clear();
      this.state.comments.clear();
      this.state.activity = [];
      this.state.remoteRuns.clear();
      this.state.hosts.clear();
      this.state.members = [];
      this.state.syncPhase = "loading";
      this.emit();
      await this.refreshAuthoritative({ reason: "catchup_required" }, this.state.generation);
      return;
    }

    await this.enqueueObserverEvent(signal, generation);
  }

  private enqueueObserverEvent(signal: ObserverEventSignal, generation: number): Promise<void> {
    const event = signal.event;
    const eventCursors = this.state.eventCursors;
    if (
      eventCursors.hasApplied(event.cursor) ||
      eventCursors.isInFlight(event.cursor) ||
      this.observerEventQueue.hasQueued(event.cursor)
    ) {
      return Promise.resolve();
    }
    if (event.cursor <= this.state.observerCursor && this.state.observerCursor > 0) {
      // Out-of-order or stale duplicate relative to validated high-water mark.
      if (
        event.previousCursor < this.state.observerCursor &&
        !eventCursors.isFailed(event.cursor) &&
        !eventCursors.requiresRefresh()
      ) {
        return Promise.resolve();
      }
    }

    const entry = { signal, generation, eventCursors };
    const queued = this.observerEventQueue.enqueue(entry);
    if (!queued) {
      eventCursors.requestRefresh();
      this.scheduleObserverCursorRefresh(generation, eventCursors);
      return Promise.resolve();
    }
    return queued;
  }

  private async applyObserverEvent(entry: ObserverEventQueueEntry): Promise<void> {
    const { event } = entry.signal;
    this.observerAttemptSeq += 1;
    const attemptToken = this.observerAttemptSeq;
    entry.eventCursors.begin(event.cursor, attemptToken);
    try {
      const application = await this.invalidateFromEvent(event.kind, event, entry.generation);
      if (!this.matchesObserverContext(entry)) return;
      if (application === "superseded") {
        entry.eventCursors.markFailed(event.cursor);
        this.scheduleObserverCursorRefresh(entry.generation, entry.eventCursors);
        return;
      }
      entry.eventCursors.markApplied(event.cursor);
      this.scheduleObserverCursorRefresh(entry.generation, entry.eventCursors);
      if (event.cursor > this.state.observerCursor) {
        this.state.observerCursor = event.cursor;
      }
      this.emit();
    } catch (error) {
      if (this.matchesObserverContext(entry)) {
        entry.eventCursors.markFailed(event.cursor);
        this.scheduleObserverCursorRefresh(entry.generation, entry.eventCursors);
      }
      throw error;
    } finally {
      entry.eventCursors.finish(event.cursor, attemptToken);
    }
  }

  private matchesObserverContext(entry: {
    signal: ObserverEventSignal;
    generation: number;
    eventCursors: CollaborationEventCursorWindow;
  }): boolean {
    return (
      !this.disposed &&
      entry.generation === this.state.generation &&
      entry.signal.profileId === this.state.profileId &&
      entry.signal.projectId === this.state.projectId &&
      entry.eventCursors === this.state.eventCursors
    );
  }

  private nextGeneration(): number {
    this.generationEpoch += 1;
    return this.generationEpoch;
  }

  private async invalidateFromEvent(
    kind: HumanObserverEvent["kind"],
    event: HumanObserverEvent,
    generation: number
  ): Promise<RefreshApplication> {
    if (generation !== this.state.generation) return "superseded";

    switch (kind) {
      case "membership":
      case "project":
        return (await this.reloadMembers(generation)).application;
      case "invitation":
        // Invitations are owned by the on-demand People details projection.
        // They do not invalidate membership and must not fan out member reads.
        return "applied";
      case "assignment":
        if (event.workItem) {
          return this.reloadAssignmentForWorkItem(event.workItem, generation);
        } else {
          return (await this.reloadAssignments(generation)).application;
        }
      case "comment":
        if (event.workItem) {
          this.state.trackedCommentWorkItems.set(workItemKey(event.workItem), event.workItem);
          await this.reloadComments(event.workItem, generation);
        }
        return "applied";
      case "activity":
        await this.reloadActivity(generation);
        return "applied";
      case "remote_run":
        if (event.dispatchId && event.remoteRunStatus) {
          const existing = this.state.remoteRuns.get(event.dispatchId);
          this.state.remoteRuns.set(event.dispatchId, {
            dispatchId: event.dispatchId,
            projectId: this.state.projectId ?? existing?.projectId ?? "",
            workItem: event.workItem ?? existing?.workItem,
            hostId: existing?.hostId,
            status: event.remoteRunStatus,
            lastActivityId: existing?.lastActivityId,
            updatedAt: event.occurredAt
          });
          this.emit();
        } else {
          await this.reloadActivity(generation);
        }
        return "applied";
      case "attachment":
        if (event.workItem) {
          this.state.trackedCommentWorkItems.set(workItemKey(event.workItem), event.workItem);
          await this.reloadComments(event.workItem, generation);
        }
        return "applied";
      case "canvas":
        // Durable canvas reconciliation is owned by useWorkspaceCanvasCommands.
        return "applied";
      default:
        return "applied";
    }
  }

  private async reloadMembers(generation: number): Promise<AggregateRefreshApplication> {
    const reloadToken = this.refreshArbitration.next("members");
    const isCurrentReload = () =>
      generation === this.state.generation &&
      this.refreshArbitration.isLatest("members", reloadToken);
    const loading = beginLoading(this.state, "members");
    this.emit();
    try {
      const members = await readBoundedNumberCursorPages({
        resource: "members",
        readPage: (cursor) =>
          this.api.listCollaborationMembers({
            cursor,
            limit: this.pageLimit
          })
      });
      if (!isCurrentReload()) {
        loading.release();
        this.emit();
        return { application: "superseded", resource: "members", token: reloadToken };
      }
      const uniqueMembers = new Map<string, HumanMembershipView>();
      for (const member of members) uniqueMembers.set(member.membershipId, member);
      this.state.members = [...uniqueMembers.values()];
      loading.release();
      if (this.refreshArbitration.markApplied("members", reloadToken, generation)) {
        this.markReadyUnlessTerminal();
      }
      this.emit();
      return { application: "applied", resource: "members", token: reloadToken };
    } catch (error) {
      if (!isCurrentReload()) {
        loading.release();
        this.emit();
        return { application: "superseded", resource: "members", token: reloadToken };
      }
      loading.release();
      throw error;
    }
  }

  private async reloadAssignments(generation: number): Promise<AggregateRefreshApplication> {
    const reloadToken = this.refreshArbitration.next("assignments");
    const changeVersionsAtStart = new Map(this.assignmentChangeVersionByKey);
    const loading = beginLoading(this.state, "assignments");
    this.emit();
    const profileId = this.state.profileId;
    const projectId = this.state.projectId;
    const isCurrentProject = () =>
      generation === this.state.generation &&
      this.refreshArbitration.isLatest("assignments", reloadToken) &&
      profileId === this.state.profileId &&
      projectId === this.state.projectId;
    try {
      const canvasId = this.state.canvasId;
      const items = await readBoundedNumberCursorPages({
        resource: "assignments",
        readPage: (cursor) => {
          const query: CollaborationAssignmentListQueryInput = {
            cursor,
            limit: this.pageLimit,
            ...(canvasId ? { canvasId } : {})
          };
          return this.api.listCollaborationAssignments(query);
        }
      });
      if (!isCurrentProject()) {
        loading.release();
        this.emit();
        return { application: "superseded", resource: "assignments", token: reloadToken };
      }

      const projection = await buildAssignmentRefreshProjection({
        items,
        readEligibleHosts: (workItems) =>
          this.api.listCollaborationEligibleHostsBatch({ workItems }),
        isCurrent: isCurrentProject
      });
      if (!projection) {
        loading.release();
        this.emit();
        return { application: "superseded", resource: "assignments", token: reloadToken };
      }
      if (!isCurrentProject()) {
        loading.release();
        this.emit();
        return { application: "superseded", resource: "assignments", token: reloadToken };
      }
      for (const [key, current] of this.state.assignments) {
        if (
          (this.assignmentChangeVersionByKey.get(key) ?? 0) > (changeVersionsAtStart.get(key) ?? 0)
        ) {
          projection.assignments.set(key, current);
        }
      }
      const mergedHosts = mergeAssignmentHosts(projection.assignments, projection.eligibleHosts);
      const replacementReady = this.refreshArbitration.markApplied(
        "assignments",
        reloadToken,
        generation
      );
      this.state.assignments = projection.assignments;
      this.state.hosts = mergedHosts;
      loading.release();
      if (replacementReady) this.markReadyUnlessTerminal();
      this.emit();
      return { application: "applied", resource: "assignments", token: reloadToken };
    } catch (error) {
      if (!isCurrentProject()) {
        loading.release();
        this.emit();
        return { application: "superseded", resource: "assignments", token: reloadToken };
      }
      loading.release();
      throw error;
    }
  }

  private async reloadAssignmentForWorkItem(
    workItem: WorkItemRef,
    generation: number
  ): Promise<RefreshApplication> {
    const key = workItemKey(workItem);
    const fullReloadSeqAtStart = this.refreshArbitration.latestToken("assignments");
    const reloadToken = (this.assignmentReloadSeqByKey.get(key) ?? 0) + 1;
    this.assignmentReloadSeqByKey.set(key, reloadToken);
    const isCurrentReload = () =>
      generation === this.state.generation &&
      reloadToken === this.assignmentReloadSeqByKey.get(key) &&
      this.refreshArbitration.appliedToken("assignments") <= fullReloadSeqAtStart;
    const loading = beginLoading(this.state, "assignments");
    this.emit();
    try {
      const page = await this.api.listCollaborationAssignments({
        cursor: 0,
        limit: 1,
        workItems: [workItem]
      });
      if (!isCurrentReload()) {
        loading.release();
        this.emit();
        return "superseded";
      }
      const item = page.items[0];
      if (item) {
        this.state.assignments.set(key, item);
        ingestAssignmentHost(this.state.hosts, item);
        this.assignmentChangeVersionByKey.set(
          key,
          (this.assignmentChangeVersionByKey.get(key) ?? 0) + 1
        );
      }
      loading.release();
      this.emit();
    } catch (error) {
      if (!isCurrentReload()) {
        loading.release();
        this.emit();
        return "superseded";
      }
      loading.release();
      throw error;
    }
    // Keep independent authorities in sync when assignment events fire.
    this.state.trackedAuthorityWorkItems.set(key, workItem);
    await this.reloadWorkAuthority(workItem, generation);
    return "applied";
  }

  private async reloadWorkAuthority(workItem: WorkItemRef, generation: number): Promise<void> {
    const key = workItemKey(workItem);
    const loading = beginLoading(this.state, `authority:${key}`);
    this.emit();
    try {
      const projection = await this.api.getCollaborationWorkAuthority({ workItem });
      loading.release();
      if (generation !== this.state.generation) return;
      this.state.workAuthorities.set(key, projection);
      this.state.trackedAuthorityWorkItems.set(key, workItem);
      this.emit();
    } catch (error) {
      loading.release();
      throw error;
    }
  }

  private async reloadComments(workItem: WorkItemRef, generation: number): Promise<void> {
    const key = workItemKey(workItem);
    const loading = beginLoading(this.state, `comments:${key}`);
    this.emit();
    try {
      const query: CollaborationCommentListQueryInput = {
        workItem,
        limit: this.pageLimit,
        includeTombstoned: true
      };
      const page = await this.api.listCollaborationComments(query);
      loading.release();
      if (generation !== this.state.generation) return;
      this.state.comments.set(key, page.items);
      this.emit();
    } catch (error) {
      loading.release();
      throw error;
    }
  }

  private async reloadActivity(generation: number): Promise<void> {
    const loading = beginLoading(this.state, "activity");
    this.emit();
    try {
      const query: CollaborationActivityListQueryInput = {
        limit: this.pageLimit
      };
      const page = await this.api.listCollaborationActivity(query);
      loading.release();
      if (generation !== this.state.generation) return;
      this.state.activity = page.items;
      for (const record of page.items) {
        const status = remoteStatusFromActivityType(record.type);
        if (!status) continue;
        const dispatchId = record.summary.dispatchId ?? record.source.sourceId;
        if (!dispatchId) continue;
        const next: CollaborationRemoteRunProjection = {
          dispatchId,
          projectId: record.projectId,
          workItem: record.workItem ?? record.summary.workItem,
          hostId: record.summary.hostId,
          status,
          lastActivityId: record.activityId,
          updatedAt: record.occurredAt
        };
        const existing = this.state.remoteRuns.get(dispatchId);
        // Prefer newer observer progress over older activity replay.
        if (!existing || existing.updatedAt <= next.updatedAt) {
          this.state.remoteRuns.set(dispatchId, next);
        }
      }
      this.emit();
    } catch (error) {
      loading.release();
      throw error;
    }
  }

  private async runMutation<T extends { revision?: number; workItem?: WorkItemRef }>(input: {
    kind: CollaborationMutationRecord["kind"];
    workItem?: WorkItemRef;
    expectedRevision?: number;
    execute: () => Promise<T>;
    onConfirmed: (result: T) => void;
  }): Promise<T | null> {
    this.assertOpen();
    const mutationId = this.createMutationId();
    const workItemKeyValue = input.workItem ? workItemKey(input.workItem) : undefined;
    const record: CollaborationMutationRecord = {
      mutationId,
      kind: input.kind,
      workItemKey: workItemKeyValue,
      status: "pending",
      expectedRevision: input.expectedRevision,
      submittedAt: this.clock.now().toISOString()
    };
    this.state.mutations.setPending(record);
    this.emit();

    try {
      const result = await input.execute();
      const confirmed: CollaborationMutationRecord = {
        ...record,
        status: "confirmed",
        confirmedRevision:
          typeof result.revision === "number" ? result.revision : input.expectedRevision,
        resolvedAt: this.clock.now().toISOString()
      };
      this.state.mutations.setTerminal(confirmed);
      input.onConfirmed(result);
      if (this.state.syncPhase === "stale_conflict") {
        this.state.syncPhase = "ready";
      }
      this.state.lastError = null;
      this.emit();
      return result;
    } catch (error) {
      const mapped = collaborationBoundaryErrorFromUnknown(error);
      const status: CollaborationMutationRecord["status"] =
        mapped.kind === "offline" || mapped.kind === "timeout" ? "offline" : "rejected";
      this.state.mutations.setTerminal({
        ...record,
        status,
        errorKind: mapped.kind,
        errorCode: mapped.code,
        errorMessage: mapped.message,
        resolvedAt: this.clock.now().toISOString()
      });
      this.applyBoundaryError(mapped);
      this.emit();
      return null;
    }
  }

  private scheduleObserverCursorRefresh(
    generation: number,
    eventCursors: CollaborationEventCursorWindow
  ): void {
    const profileId = this.state.profileId;
    const projectId = this.state.projectId;
    if (profileId === null || projectId === null) return;
    const isCurrent = () =>
      !this.disposed &&
      generation === this.state.generation &&
      profileId === this.state.profileId &&
      projectId === this.state.projectId &&
      eventCursors === this.state.eventCursors;
    this.observerCursorRecovery.schedule({
      eventCursors,
      isCurrent,
      refresh: () => ({
        completion: this.refreshAuthoritative({ reason: "observer_cursor_window" }, generation),
        requestId: this.refreshRequestSeq
      }),
      wasSuccessful: (requestId) => this.lastSuccessfulRefreshRequest === requestId,
      onError: (error) => {
        this.applyBoundaryError(collaborationBoundaryErrorFromUnknown(error));
        this.markIncompleteAuthoritativeRefresh();
        this.emit();
      },
      onRetired: () => this.emit()
    });
  }

  private markReadyUnlessTerminal(): void {
    const terminal: CollaborationSyncPhase[] = ["auth_expired", "forbidden", "stale_conflict"];
    if (!terminal.includes(this.state.syncPhase)) {
      this.state.syncPhase = "ready";
      this.state.lastError = null;
    }
  }

  private markIncompleteAuthoritativeRefresh(): void {
    const specific: CollaborationSyncPhase[] = ["auth_expired", "forbidden", "stale_conflict"];
    if (!specific.includes(this.state.syncPhase)) this.state.syncPhase = "error";
  }

  private applyBoundaryError(error: CollaborationBoundaryErrorView): void {
    this.state.lastError = error;
    this.state.syncPhase = syncPhaseAfterCollaborationBoundaryError(this.state.syncPhase, error);
  }

  private upsertComment(projection: CommentDisplayProjection): void {
    upsertCommentProjection(this.state.comments, this.state.trackedCommentWorkItems, projection);
  }

  private emit(): void {
    this.state.updatedAt = this.clock.now().toISOString();
    this.cachedSnapshot = buildCollaborationSnapshot(this.state);
    const snapshot = this.cachedSnapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("CollaborationReadModelController has been disposed.");
    }
  }
}
