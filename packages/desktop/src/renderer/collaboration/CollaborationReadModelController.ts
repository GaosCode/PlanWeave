import { applyCollaborationSessionStatus } from "./collaborationSessionStatus.js";
import { bindCollaborationReadOperations } from "./scopedReadOperations.js";
import type { CollaborationOperationScope } from "../../shared/collaborationOperationScope.js";
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
  type CollaborationObserverSignal,
  type CollaborationReadModelSnapshot,
  type CollaborationResponsibilityUpdateInput,
  type CollaborationReviewerUpdateInput,
  type CollaborationSyncPhase,
  type CollaborationMemberSummary
} from "../../shared/collaborationReadModels.js";
import { emptyState, type InternalState } from "./collaborationReadModelState.js";
import { AuthoritativeRefreshQueue } from "./authoritativeRefreshQueue.js";
import { readBoundedNumberCursorPages } from "./boundedPagination.js";
import {
  buildAssignmentRefreshProjection,
  mergeAssignmentHosts
} from "./assignmentRefreshProjection.js";
import {
  publishCollaborationMutation,
  type CollaborationMutationInput
} from "./collaborationMutationPublication.js";
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
import {
  WorkAuthorityReadArbitrator,
  type WorkAuthorityReadRequest
} from "./workAuthorityReadArbitration.js";
import { applyObserverRemoteRun, ingestActivityRemoteRun } from "./remoteRunProjection.js";

export type CollaborationReadBridgePort = Pick<
  PlanWeaveCollaborationApi,
  | "getCollaborationStatus"
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
> & {
  listCollaborationMembers: (
    input: Parameters<PlanWeaveCollaborationApi["listCollaborationMembers"]>[0]
  ) => Promise<{ items: CollaborationMemberSummary[]; nextCursor: number | null }>;
};

export type CollaborationReadModelControllerOptions = {
  api: CollaborationReadBridgePort;
  pageLimit?: number;
  clock?: { now(): Date };
  createMutationId?: () => string;
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

/**
 * Owns server collaboration projections for one active profile/project.
 * Components subscribe to snapshots; they never open their own observer connections.
 */
export type AuthoritativeRefreshResult =
  | { status: "applied" | "retired" | "incomplete" }
  | { status: "failed"; error: unknown };

export class CollaborationReadModelController {
  private readonly api: CollaborationReadBridgePort;
  private operationApi: ReturnType<typeof bindCollaborationReadOperations> | null = null;
  private operationSessionId: string | null = null;
  private readonly pageLimit: number;
  private readonly clock: { now(): Date };
  private readonly createMutationId: () => string;
  private state: InternalState;
  private listeners = new Set<(snapshot: CollaborationReadModelSnapshot) => void>();
  private unsubscribers: Array<() => void> = [];
  private disposed = false;
  private generationEpoch = 0;
  private commentInvalidationSeq = 0;
  private mutationScopeGeneration = 0;
  private observerAttemptSeq = 0;
  private refreshRequestSeq = 0;
  private lastSuccessfulRefreshRequest = 0;
  private readonly observerCursorRecovery = new CollaborationObserverRecovery();
  private observerEventQueue = this.createObserverEventQueue();
  private refreshArbitration = new AuthoritativeRefreshArbitrator();
  private assignmentReloadSeqByKey = new Map<string, number>();
  private readonly authorityReads: WorkAuthorityReadArbitrator;
  private assignmentChangeVersionByKey = new Map<string, number>();
  private refreshQueue = new AuthoritativeRefreshQueue();
  /** Cached for useSyncExternalStore — must be referentially stable between emissions. */
  private cachedSnapshot: CollaborationReadModelSnapshot;

  constructor(options: CollaborationReadModelControllerOptions) {
    this.api = options.api;
    this.authorityReads = new WorkAuthorityReadArbitrator({
      isCurrentScope: (generation) => !this.disposed && generation === this.state.generation,
      read: (workItem) => this.captureOperationApi().getWorkAuthority({ workItem }),
      acquire: (key) => beginLoading(this.state, `authority:${key}`),
      emit: () => this.emit(),
      apply: (key, workItem, projection) => {
        this.state.workAuthorities.set(key, projection);
        this.state.trackedAuthorityWorkItems.set(key, workItem);
      },
      applyError: (error) => this.applyBoundaryError(error),
      recoverError: (error) => {
        if (this.state.lastError === error) {
          this.markReadyUnlessTerminal();
          if (this.state.loadingKinds.has("snapshot") && this.state.syncPhase === "ready")
            this.state.syncPhase = "loading";
        }
      }
    });
    this.pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.clock = options.clock ?? { now: () => new Date() };
    this.createMutationId = options.createMutationId ?? (() => crypto.randomUUID());
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
    operationScope: CollaborationOperationScope;
    canvasId?: string | null;
  }): Promise<void> {
    this.assertOpen();
    const sameIdentity =
      this.state.profileId === input.profileId &&
      this.state.projectId === input.projectId &&
      this.operationSessionId === input.operationScope.sessionId;
    this.operationApi = bindCollaborationReadOperations(this.api, input.operationScope);
    this.operationSessionId = input.operationScope.sessionId;
    if (!sameIdentity) {
      this.teardownSubscriptions();
      this.state = {
        ...emptyState(this.clock.now().toISOString()),
        profileId: input.profileId,
        projectId: input.projectId,
        canvasId: input.canvasId ?? null,
        syncPhase: "loading",
        generation: this.nextGeneration(true)
      };
      this.attachSubscriptions();
      this.emit();
    } else if ((input.canvasId ?? null) !== this.state.canvasId) {
      this.state.canvasId = input.canvasId ?? null;
      this.state.mutations = new CollaborationMutationLedger();
      this.state.generation = this.nextGeneration(true);
      this.state.loadingKinds = new Map();
      this.state.comments = new Map();
      this.state.trackedCommentWorkItems = new Map();
      this.state.commentInvalidationVersions = new Map();
      this.state.syncPhase = "loading";
      this.emit();
    }

    const generation = this.state.generation;
    await this.refreshAuthoritative({ reason: "set_active_project" }, generation);
  }

  /** Stop all subscriptions and clear server projections (project switch / logout). */
  clear(): void {
    this.operationApi = null;
    this.operationSessionId = null;
    this.teardownSubscriptions();
    this.observerCursorRecovery.clear();
    this.state = {
      ...emptyState(this.clock.now().toISOString()),
      generation: this.nextGeneration(true)
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
    if (!this.state.commentInvalidationVersions.has(key)) {
      this.state.commentInvalidationVersions.set(key, 0);
    }
    await this.reloadComments(workItem, this.state.generation);
  }

  async refreshAuthoritative(
    meta: { reason: string } = { reason: "manual" },
    generation = this.state.generation
  ): Promise<AuthoritativeRefreshResult> {
    this.assertOpen();
    if (!this.state.profileId || !this.state.projectId) return { status: "retired" };
    this.refreshRequestSeq += 1;
    const refreshRequest = this.refreshRequestSeq;

    return this.refreshQueue.enqueue(async () => {
      if (this.disposed || generation !== this.state.generation) return { status: "retired" };
      if (meta.reason === "observer_cursor_window") {
        for (const workItem of this.state.trackedCommentWorkItems.values()) {
          this.invalidateComments(workItem);
        }
      }
      this.refreshArbitration.beginAggregate();
      const errorAtStart = this.state.lastError;
      const snapshotLoading = beginLoading(this.state, "snapshot");
      if (this.state.syncPhase !== "reconnecting" && this.state.syncPhase !== "auth_expired") {
        this.state.syncPhase = "loading";
      }
      this.emit();

      const trackedComments = [...this.state.trackedCommentWorkItems.values()];
      const authorityRequests = new Map<number, WorkAuthorityReadRequest>();
      const results = await Promise.allSettled([
        this.reloadMembers(generation),
        this.reloadAssignments(generation),
        this.reloadActivity(generation),
        ...trackedComments.map((workItem) => this.reloadComments(workItem, generation)),
        ...[...this.state.trackedAuthorityWorkItems.values()].map((workItem, index) => {
          return this.authorityReads.read(workItem, generation, (request) =>
            authorityRequests.set(3 + trackedComments.length + index, request)
          );
        })
      ]);

      let authorities = authorityRequests.size
        ? await this.authorityReads.waitForAggregate(authorityRequests, generation)
        : [];
      while (
        !this.disposed &&
        generation === this.state.generation &&
        authorities.some(({ request }) => !this.authorityReads.isCurrent(request))
      ) {
        authorities = await this.authorityReads.waitForAggregate(authorityRequests, generation);
      }
      snapshotLoading.release();
      if (this.disposed || generation !== this.state.generation) return { status: "retired" };

      const failures = results.flatMap((result, index) =>
        result.status === "rejected" && !authorityRequests.has(index)
          ? [{ reason: result.reason }]
          : []
      );
      const authorityFailures = authorities.flatMap(({ outcome }) =>
        outcome.status === "failed" ? [outcome] : []
      );
      let outcome: AuthoritativeRefreshResult;
      if (failures.length === 0 && authorityFailures.length === 0) {
        const replacements = results.flatMap((result) =>
          result.status === "fulfilled" && result.value && typeof result.value === "object"
            ? [result.value as AggregateRefreshApplication]
            : []
        );
        if (this.refreshArbitration.settleAggregate(generation, replacements)) {
          this.lastSuccessfulRefreshRequest = refreshRequest;
          if (!this.state.lastError || this.state.lastError === errorAtStart)
            this.markReadyUnlessTerminal();
          outcome = { status: "applied" };
        } else outcome = { status: "incomplete" };
      } else {
        this.refreshArbitration.cancelAggregate();
        // Authority failures were published by their request owner, never remap them here.
        if (failures.length)
          this.applyBoundaryError(collaborationBoundaryErrorFromUnknown(failures[0]!.reason));
        this.markIncompleteAuthoritativeRefresh();
        if (failures.length) outcome = { status: "failed", error: failures[0]!.reason };
        else {
          outcome = { status: "failed", error: authorityFailures[0]!.error };
        }
      }
      this.emit();
      return outcome;
    });
  }

  async updateAssignment(
    command: Omit<CollaborationAssignmentUpdateInput, "operationScope">
  ): Promise<AssignmentDisplayProjection | null> {
    const operationApi = this.captureOperationApi();
    return this.runMutation({
      kind: "assignment",
      workItem: command.workItem,
      expectedRevision: command.expectedRevision,
      execute: () => operationApi.updateAssignment(command),
      onConfirmed: (projection) => {
        this.state.assignments.set(workItemKey(projection.workItem), projection);
        ingestAssignmentHost(this.state.hosts, projection);
      }
    });
  }

  async updateResponsibility(
    command: Omit<CollaborationResponsibilityUpdateInput, "operationScope">
  ): Promise<ResponsibilityReadModel | null> {
    const operationApi = this.captureOperationApi();
    const isCurrentScope = this.captureMutationScope();
    const result = await this.runMutation({
      kind: "responsibility",
      workItem: command.workItem,
      expectedRevision: command.expectedRevision,
      execute: () => operationApi.updateResponsibility(command),
      onConfirmed: () => undefined
    });
    if (result && isCurrentScope()) {
      try {
        await this.authorityReads.read(command.workItem, this.state.generation);
      } catch {
        // Mutation succeeded; projection refresh errors surface via lastError on next load.
      }
    }
    return result;
  }

  async updateReviewer(
    command: Omit<CollaborationReviewerUpdateInput, "operationScope">
  ): Promise<ReviewAssignmentReadModel | null> {
    const operationApi = this.captureOperationApi();
    const isCurrentScope = this.captureMutationScope();
    const result = await this.runMutation({
      kind: "reviewer",
      workItem: command.workItem,
      expectedRevision: command.expectedRevision,
      execute: () => operationApi.updateReviewer(command),
      onConfirmed: () => undefined
    });
    if (result && isCurrentScope()) {
      try {
        await this.authorityReads.read(command.workItem, this.state.generation);
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
    const generation = this.state.generation;
    await this.authorityReads.read(workItem, generation);
    if (this.disposed || generation !== this.state.generation) return null;
    return this.state.workAuthorities.get(key) ?? null;
  }

  async createComment(
    command: Omit<CollaborationCommentCreateInput, "operationScope">
  ): Promise<CommentDisplayProjection | null> {
    const operationApi = this.captureOperationApi();
    return this.runMutation({
      kind: "comment_create",
      workItem: command.workItem,
      execute: () => operationApi.createComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  async editComment(
    command: Omit<CollaborationCommentEditInput, "operationScope">
  ): Promise<CommentDisplayProjection | null> {
    const operationApi = this.captureOperationApi();
    return this.runMutation({
      kind: "comment_edit",
      expectedRevision: command.expectedRevision,
      execute: () => operationApi.editComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  async tombstoneComment(
    command: Omit<CollaborationCommentTombstoneInput, "operationScope">
  ): Promise<CommentDisplayProjection | null> {
    const operationApi = this.captureOperationApi();
    return this.runMutation({
      kind: "comment_tombstone",
      expectedRevision: command.expectedRevision,
      execute: () => operationApi.tombstoneComment(command),
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

  private captureOperationApi(): ReturnType<typeof bindCollaborationReadOperations> {
    if (!this.operationApi) throw new Error("collaboration_session_inactive");
    return this.operationApi;
  }

  private attachSubscriptions(): void {
    const state = this.state;
    this.unsubscribers.push(
      this.api.onCollaborationStatusChanged((status) => {
        if (state === this.state) this.handleStatus(status);
      }),
      this.api.onCollaborationObserverSignal((signal) => {
        if (state !== this.state) return;
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
      signal.type === "workspace.members.invalidated" ||
      signal.type === "workspace.members.observer_error" ||
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
    applyCollaborationSessionStatus({
      state: this.state,
      status,
      now: () => this.clock.now().toISOString(),
      clear: () => this.clear(),
      emit: () => this.emit()
    });
  }

  private async handleObserverSignal(signal: CollaborationObserverSignal): Promise<void> {
    if (
      this.disposed ||
      signal.type === "workspace.members.invalidated" ||
      signal.type === "workspace.members.observer_error"
    )
      return;
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
      // Retention gaps reload bounded APIs; retain comment pages until replacement succeeds.
      this.state.generation = this.nextGeneration();
      this.state.observerCursor = signal.resumeCursor;
      this.state.eventCursors.resetForCatchup();
      this.state.assignments.clear();
      this.state.workAuthorities.clear();
      this.state.commentInvalidationVersions = new Map();
      for (const workItem of this.state.trackedCommentWorkItems.values()) {
        this.invalidateComments(workItem);
      }
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
      if ((event.kind === "comment" || event.kind === "attachment") && event.workItem) {
        this.invalidateComments(event.workItem);
      }
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

  private nextGeneration(scopeChanged = false): number {
    this.observerEventQueue.retire();
    this.observerEventQueue = this.createObserverEventQueue();
    this.refreshQueue.retire();
    this.refreshQueue = new AuthoritativeRefreshQueue();
    this.refreshArbitration.cancelAggregate();
    this.state.loadingKinds = new Map();
    this.authorityReads.reset();
    this.generationEpoch += 1;
    if (scopeChanged) this.mutationScopeGeneration = this.generationEpoch;
    return this.generationEpoch;
  }

  private createObserverEventQueue(): CollaborationObserverQueue<ObserverEventQueueEntry> {
    return new CollaborationObserverQueue({
      concurrency: OBSERVER_INVALIDATION_CONCURRENCY,
      queueLimit: OBSERVER_EVENT_QUEUE_LIMIT,
      key: (entry) => entry.signal.event.cursor,
      isCurrent: (entry) => this.matchesObserverContext(entry),
      execute: (entry) => this.applyObserverEvent(entry)
    });
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
        if (
          applyObserverRemoteRun({
            remoteRuns: this.state.remoteRuns,
            projectId: this.state.projectId,
            event
          })
        ) {
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
        if (generation === this.state.generation) this.emit();
        return { application: "superseded", resource: "members", token: reloadToken };
      }
      const uniqueMembers = new Map<string, CollaborationMemberSummary>();
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
        if (generation === this.state.generation) this.emit();
        return { application: "superseded", resource: "members", token: reloadToken };
      }
      loading.release();
      throw error;
    }
  }

  private async reloadAssignments(generation: number): Promise<AggregateRefreshApplication> {
    const operationApi = this.captureOperationApi();
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
          const query: Omit<CollaborationAssignmentListQueryInput, "operationScope"> = {
            cursor,
            limit: this.pageLimit,
            ...(canvasId ? { canvasId } : {})
          };
          return operationApi.listAssignments(query);
        }
      });
      if (!isCurrentProject()) {
        loading.release();
        if (generation === this.state.generation) this.emit();
        return { application: "superseded", resource: "assignments", token: reloadToken };
      }

      const projection = await buildAssignmentRefreshProjection({
        items,
        readEligibleHosts: (workItems) => operationApi.listEligibleHostsBatch({ workItems }),
        isCurrent: isCurrentProject
      });
      if (!projection) {
        loading.release();
        if (generation === this.state.generation) this.emit();
        return { application: "superseded", resource: "assignments", token: reloadToken };
      }
      if (!isCurrentProject()) {
        loading.release();
        if (generation === this.state.generation) this.emit();
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
        if (generation === this.state.generation) this.emit();
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
    const operationApi = this.captureOperationApi();
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
      const page = await operationApi.listAssignments({
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
    let request: WorkAuthorityReadRequest | undefined;
    try {
      const applied = await this.authorityReads.read(workItem, generation, (started) => {
        request = started;
      });
      if (applied === "applied" || !request) return applied;
      return (await this.authorityReads.waitForCurrent(request)).outcome.status === "applied"
        ? "applied"
        : "superseded";
    } catch {
      // The authority owner published this failure; retain the cursor for retry without remapping.
      return "superseded";
    }
  }

  private async reloadComments(workItem: WorkItemRef, generation: number): Promise<void> {
    const operationApi = this.captureOperationApi();
    const key = workItemKey(workItem);
    const loading = beginLoading(this.state, `comments:${key}`);
    this.emit();
    try {
      const query: Omit<CollaborationCommentListQueryInput, "operationScope"> = {
        workItem,
        limit: this.pageLimit,
        includeTombstoned: true
      };
      const page = await operationApi.listComments(query);
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
    const operationApi = this.captureOperationApi();
    const loading = beginLoading(this.state, "activity");
    this.emit();
    try {
      const query: Omit<CollaborationActivityListQueryInput, "operationScope"> = {
        limit: this.pageLimit
      };
      const page = await operationApi.listActivity(query);
      loading.release();
      if (generation !== this.state.generation) return;
      this.state.activity = page.items;
      for (const record of page.items) {
        ingestActivityRemoteRun(this.state.remoteRuns, record);
      }
      this.emit();
    } catch (error) {
      loading.release();
      throw error;
    }
  }

  private captureMutationScope(): () => boolean {
    const state = this.state;
    const scopeGeneration = this.mutationScopeGeneration;
    return () =>
      !this.disposed && state === this.state && scopeGeneration === this.mutationScopeGeneration;
  }

  private runMutation<T extends { revision?: number; workItem?: WorkItemRef }>(
    input: CollaborationMutationInput<T>
  ): Promise<T | null> {
    this.assertOpen();
    return publishCollaborationMutation(input, {
      mutationId: this.createMutationId(),
      ledger: this.state.mutations,
      now: () => this.clock.now().toISOString(),
      isCurrent: this.captureMutationScope(),
      emit: () => this.emit(),
      onConfirmed: () => {
        if (this.state.syncPhase === "stale_conflict") this.state.syncPhase = "ready";
        this.state.lastError = null;
      },
      onError: (error) => this.applyBoundaryError(error)
    });
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
        completion: this.refreshAuthoritative(
          { reason: "observer_cursor_window" },
          generation
        ).then(() => undefined),
        requestId: this.refreshRequestSeq
      }),
      wasSuccessful: (requestId) => this.lastSuccessfulRefreshRequest === requestId,
      onError: (error) => {
        this.applyBoundaryError(collaborationBoundaryErrorFromUnknown(error));
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
    this.invalidateComments(projection.workItem);
  }

  private invalidateComments(workItem: WorkItemRef): void {
    this.commentInvalidationSeq += 1;
    this.state.commentInvalidationVersions.set(workItemKey(workItem), this.commentInvalidationSeq);
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
