import {
  applyCanvasReplicaIntent,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument,
  overlayCanvasReplicaRuntimeStatus,
  projectCanvasReplicaDocument,
  type CanvasReplicaDocument
} from "@planweave-ai/runtime";
import type {
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CanvasJournalEntry,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import {
  collaborationCanvasBindingReplicaProjectionSchema,
  type CollaborationCanvasBindingReplicaProjection
} from "../../shared/canvasReplicaIpc.js";
import { CollaborationClientError } from "./collaborationErrors.js";

type CanvasReplicaRemoteScope = {
  /** Profile/server/project identity — prevents cross-authority replica reuse. */
  authorityId: string;
  projectId: string;
  canvasId: string;
  workspaceId: CanvasRuntimeStatusProjection["scope"]["workspaceId"];
};

export type CanvasReplicaScope = CanvasReplicaRemoteScope &
  (
    | { bindingKind: "local"; localProjectId: string; localCanvasId: string }
    | { bindingKind: "remote" }
  );

export type CanvasReplicaPendingOperation = {
  operationId: string;
  intent: CanvasCommandIntent;
};

type ReplicaState = {
  scope: CanvasReplicaScope;
  document: CanvasReplicaDocument | null;
  revision: number;
  contentDigest: string | null;
  pending: CanvasReplicaPendingOperation[];
  runtimeStatus: CanvasRuntimeStatusProjection | null;
  canEdit: boolean;
  rejections: Array<{ operationId: string; code: string }>;
};

export type CanvasReplicaMutationResult = {
  droppedPending: CanvasReplicaPendingOperation[];
};

export type CanvasReplicaCommittedSnapshot = {
  scope: CanvasReplicaScope;
  revision: number;
  contentDigest: string;
  content: CompleteContentVersion;
};

function replicaError(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({ kind: "protocol", code, message: code, retryable });
}

function key(
  scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
): string {
  return JSON.stringify([scope.authorityId, scope.workspaceId, scope.projectId, scope.canvasId]);
}

function sameRemoteScope(
  left: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">,
  right: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

/**
 * Main-process authority cache for one remote Canvas.
 * Visible state is committed document + ordered optimistic pending ops.
 * Disk materialization is intentionally outside this store.
 */
export class CanvasReplicaStore {
  private readonly replicas = new Map<string, ReplicaState>();

  constructor(
    private readonly onChange: (projection: CollaborationCanvasBindingReplicaProjection) => void,
    private readonly onCommitted: (snapshot: CanvasReplicaCommittedSnapshot) => void = () =>
      undefined
  ) {}

  bind(scope: CanvasReplicaScope): void {
    const current = this.replicas.get(key(scope));
    if (current) {
      current.scope = scope;
      return;
    }
    this.replicas.set(key(scope), {
      scope,
      document: null,
      revision: 0,
      contentDigest: null,
      pending: [],
      runtimeStatus: null,
      canEdit: false,
      rejections: []
    });
  }

  /**
   * Install one atomic baseline from a reconnect snapshot's immutable content +
   * snapshot.metadata.revision (command revision, not content-authority revision).
   */
  installBaseline(
    scope: CanvasReplicaScope,
    baseline: {
      content: CompleteContentVersion;
      revision: number;
      contentDigest: string;
    }
  ): CanvasReplicaMutationResult {
    const replica = this.require(scope);
    if (baseline.content.canonicalDigest !== baseline.contentDigest) {
      throw replicaError("canvas_replica_baseline_content_digest_mismatch", true);
    }
    const document = decodeCanvasReplicaDocument(baseline.content);
    // The authority digest covers the exact immutable member bytes. Decoding the
    // manifest intentionally loses JSON whitespace, so decode -> encode is not a
    // valid integrity check for a freshly captured (non-normalized) baseline.
    // The transfer boundary has already validated baseline.content itself.
    replica.document = document;
    replica.revision = baseline.revision;
    replica.contentDigest = baseline.contentDigest;
    const droppedPending = this.rebasePending(replica);
    this.publishCommitted(replica, baseline.content);
    this.publish(replica);
    return { droppedPending };
  }

  clear(scope: CanvasReplicaScope): void {
    this.replicas.delete(key(scope));
  }

  clearAll(): void {
    this.replicas.clear();
  }

  has(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
  ): boolean {
    return this.replicas.has(key(scope));
  }

  projection(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
  ): CollaborationCanvasBindingReplicaProjection | null {
    const replica = this.replicas.get(key(scope));
    return replica?.document ? this.toProjection(replica) : null;
  }

  /**
   * Atomically enqueue one optimistic operation.
   * Validates intent on the current visible document and builds the projection before
   * mutating pending — never leaves a ghost pending without a published projection.
   */
  enqueue(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">,
    pending: CanvasReplicaPendingOperation
  ): void {
    const replica = this.require(scope);
    if (!replica.canEdit) throw replicaError("canvas_replica_command_forbidden");
    if (replica.pending.some((item) => item.operationId === pending.operationId)) {
      throw replicaError("canvas_replica_operation_duplicate");
    }
    if (!replica.document || replica.contentDigest === null) {
      throw replicaError("canvas_replica_baseline_required", true);
    }
    // Validate on a temporary pending list before committing store state.
    const previousPending = replica.pending;
    replica.pending = [...previousPending, pending];
    try {
      // toProjection applies all pending intents; throw before notifying subscribers.
      const projection = this.toProjection(replica);
      this.onChange(projection);
    } catch (error) {
      replica.pending = previousPending;
      if (error instanceof CollaborationClientError) throw error;
      throw replicaError("canvas_replica_pending_invalid");
    }
  }

  reject(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">,
    operationId: string,
    code: string
  ): void {
    const replica = this.require(scope);
    const before = replica.pending.length;
    replica.pending = replica.pending.filter((pending) => pending.operationId !== operationId);
    if (replica.pending.length === before) return;
    this.recordRejection(replica, operationId, code);
    this.publish(replica);
  }

  /** Drop every pending op (e.g. forbidden / disconnect) and publish once. */
  clearPending(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">,
    code: string
  ): CanvasReplicaPendingOperation[] {
    const replica = this.require(scope);
    const removed = replica.pending;
    if (removed.length === 0) return [];
    for (const pending of removed) {
      this.recordRejection(replica, pending.operationId, code);
    }
    replica.pending = [];
    if (replica.document) this.publish(replica);
    return removed;
  }

  /**
   * Apply one durable journal entry (live broadcast or catch-up).
   * Contiguous next-revision entries advance committed state and drop matching pending.
   * Same-head duplicates are idempotent and only clear a matching pending operationId.
   */
  applyEntry(entry: CanvasJournalEntry): CanvasReplicaMutationResult {
    const replica = this.requireByRemoteScope(entry.scope);
    if (!replica.document || replica.contentDigest === null) {
      throw replicaError("canvas_replica_baseline_required", true);
    }
    if (entry.revision === replica.revision && entry.contentDigest === replica.contentDigest) {
      // Already at this head (duplicate event or self-accept race). Never re-apply.
      if (replica.pending.some((pending) => pending.operationId === entry.operationId)) {
        return this.acknowledgeIncluded(replica.scope, entry.operationId);
      }
      return { droppedPending: [] };
    }
    if (entry.previousRevision !== replica.revision || entry.revision !== replica.revision + 1) {
      throw replicaError("canvas_replica_revision_gap", true);
    }
    const next = applyCanvasReplicaIntent(replica.document, entry.intent);
    this.assertDigest(next, entry.contentDigest);
    replica.document = next;
    replica.revision = entry.revision;
    replica.contentDigest = entry.contentDigest;
    replica.pending = replica.pending.filter(
      (pending) => pending.operationId !== entry.operationId
    );
    const droppedPending = this.rebasePending(replica);
    this.publishCommitted(replica);
    this.publish(replica);
    return { droppedPending };
  }

  /**
   * Drop one pending operation that authority has already absorbed (snapshot head
   * or idempotent confirmation) without re-applying its intent.
   */
  acknowledgeIncluded(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">,
    operationId: string
  ): CanvasReplicaMutationResult {
    const replica = this.require(scope);
    const before = replica.pending.length;
    replica.pending = replica.pending.filter((pending) => pending.operationId !== operationId);
    if (replica.pending.length === before) {
      return { droppedPending: [] };
    }
    const droppedPending = this.rebasePending(replica);
    if (replica.document) this.publish(replica);
    return { droppedPending };
  }

  /**
   * Own HTTP acceptance carries no entry; fold with the exact queued intent.
   * When authority head already includes this operationId (idempotent replay or
   * snapshot that already absorbed the change), only clear the pending op —
   * do not re-apply the intent.
   */
  accept(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">,
    outcome: Extract<CanvasCommandOutcome, { type: "canvas.command.accepted" }>
  ): CanvasReplicaMutationResult {
    const replica = this.require(scope);
    const pendingIndex = replica.pending.findIndex(
      (pending) => pending.operationId === outcome.operationId
    );
    if (pendingIndex < 0) {
      if (
        outcome.revision === replica.revision &&
        outcome.contentDigest === replica.contentDigest
      ) {
        return { droppedPending: [] };
      }
      throw replicaError("canvas_replica_acceptance_without_pending", true);
    }
    if (!replica.document || replica.contentDigest === null) {
      throw replicaError("canvas_replica_baseline_required", true);
    }

    // Authority already reflects this operation (same head revision/digest).
    if (outcome.contentDigest === replica.contentDigest && outcome.revision <= replica.revision) {
      replica.pending = replica.pending.filter((item) => item.operationId !== outcome.operationId);
      const droppedPending = this.rebasePending(replica);
      this.publish(replica);
      return { droppedPending };
    }

    if (outcome.revision !== replica.revision + 1) {
      throw replicaError("canvas_replica_acceptance_revision_mismatch", true);
    }
    const pending = replica.pending[pendingIndex]!;
    const next = applyCanvasReplicaIntent(replica.document, pending.intent);
    this.assertDigest(next, outcome.contentDigest);
    replica.document = next;
    replica.revision = outcome.revision;
    replica.contentDigest = outcome.contentDigest;
    replica.pending = replica.pending.filter((item) => item.operationId !== outcome.operationId);
    const droppedPending = this.rebasePending(replica);
    this.publishCommitted(replica);
    this.publish(replica);
    return { droppedPending };
  }

  /**
   * Validate reconnect snapshot/delta fully against a temporary state, then replace once
   * and publish a single projection.
   */
  replaceFromReconnect(input: {
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">;
    response: CanvasReconnectResponse;
    snapshotContent?: CompleteContentVersion;
  }): CanvasReplicaMutationResult {
    const replica = this.require(input.scope);
    const { response } = input;
    if (response.type === "canvas.reconnect.error") {
      throw replicaError(`canvas_replica_reconnect_${response.code}`);
    }

    if (response.type === "canvas.reconnect.snapshot") {
      if (!input.snapshotContent)
        throw replicaError("canvas_replica_snapshot_content_required", true);
      if (
        !sameRemoteScope(response.scope, replica.scope) ||
        !sameRemoteScope(response.snapshot.metadata.scope, replica.scope)
      ) {
        throw replicaError("canvas_replica_scope_mismatch");
      }
      // Late recovery must never roll an applied head backwards.
      if (replica.document !== null && response.snapshot.metadata.revision < replica.revision) {
        throw replicaError("canvas_replica_reconnect_stale_snapshot", true);
      }
      if (response.snapshot.metadata.contentDigest !== input.snapshotContent.canonicalDigest) {
        throw replicaError("canvas_replica_snapshot_metadata_digest_mismatch", true);
      }
      if (
        response.snapshot.content.canonicalDigest !== response.snapshot.metadata.contentDigest ||
        response.snapshot.content.canonicalDigest !== input.snapshotContent.canonicalDigest
      ) {
        throw replicaError("canvas_replica_snapshot_content_ref_mismatch", true);
      }
      const document = decodeCanvasReplicaDocument(input.snapshotContent);
      // snapshotContent is already validated against both the content ref and
      // metadata above. Do not compare it with a re-encoded parsed document:
      // canonical JSON formatting is first established by the next command.
      replica.document = document;
      replica.revision = response.snapshot.metadata.revision;
      replica.contentDigest = response.snapshot.metadata.contentDigest;
      const droppedPending = this.rebasePending(replica);
      this.publishCommitted(replica, input.snapshotContent);
      this.publish(replica);
      return { droppedPending };
    }

    // delta — fold into temporary state first; never mutate committed fields until complete
    if (!sameRemoteScope(response.scope, replica.scope)) {
      throw replicaError("canvas_replica_scope_mismatch");
    }
    if (!replica.document || replica.contentDigest === null) {
      throw replicaError("canvas_replica_baseline_required", true);
    }
    if (response.afterRevision !== replica.revision) {
      throw replicaError("canvas_replica_reconnect_after_revision_mismatch", true);
    }

    let document = replica.document;
    let revision = replica.revision;
    let digest = replica.contentDigest;
    const acceptedIds = new Set<string>();

    for (const entry of response.entries) {
      if (!sameRemoteScope(entry.scope, replica.scope)) {
        throw replicaError("canvas_replica_reconnect_delta_invalid", true);
      }
      if (entry.previousRevision !== revision || entry.revision !== revision + 1) {
        throw replicaError("canvas_replica_reconnect_delta_invalid", true);
      }
      document = applyCanvasReplicaIntent(document, entry.intent);
      this.assertDigest(document, entry.contentDigest);
      revision = entry.revision;
      digest = entry.contentDigest;
      acceptedIds.add(entry.operationId);
    }

    if (revision !== response.headRevision || digest !== response.headContentDigest) {
      throw replicaError("canvas_replica_reconnect_head_mismatch", true);
    }

    replica.document = document;
    replica.revision = revision;
    replica.contentDigest = digest;
    replica.pending = replica.pending.filter((pending) => !acceptedIds.has(pending.operationId));
    const droppedPending = this.rebasePending(replica);
    if (response.entries.length > 0) this.publishCommitted(replica);
    this.publish(replica);
    return { droppedPending };
  }

  setRuntimeStatus(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">,
    status: CanvasRuntimeStatusProjection | null
  ): void {
    const replica = this.require(scope);
    replica.runtimeStatus = status;
    if (replica.document) this.publish(replica);
  }

  setCanEdit(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">,
    canEdit: boolean
  ): void {
    const replica = this.require(scope);
    if (replica.canEdit === canEdit) return;
    replica.canEdit = canEdit;
    if (replica.document) this.publish(replica);
  }

  revision(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
  ): number {
    return this.require(scope).revision;
  }

  digest(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
  ): string | null {
    return this.require(scope).contentDigest;
  }

  canEdit(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
  ): boolean {
    return this.require(scope).canEdit;
  }

  pendingOperationIds(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
  ): string[] {
    return this.require(scope).pending.map((pending) => pending.operationId);
  }

  private require(
    scope: Pick<CanvasReplicaScope, "authorityId" | "workspaceId" | "projectId" | "canvasId">
  ): ReplicaState {
    const replica = this.replicas.get(key(scope));
    if (!replica) throw replicaError("canvas_replica_scope_unbound");
    return replica;
  }

  private requireByRemoteScope(
    scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">
  ): ReplicaState {
    const matches = [...this.replicas.values()].filter(
      (replica) =>
        replica.scope.workspaceId === scope.workspaceId &&
        replica.scope.projectId === scope.projectId &&
        replica.scope.canvasId === scope.canvasId
    );
    if (matches.length === 0) throw replicaError("canvas_replica_scope_unbound");
    if (matches.length > 1) throw replicaError("canvas_replica_scope_ambiguous");
    return matches[0]!;
  }

  private assertDigest(document: CanvasReplicaDocument, expected: string): void {
    if (encodeCanvasReplicaDocument(document).canonicalDigest !== expected) {
      throw replicaError("canvas_replica_canonical_digest_mismatch", true);
    }
  }

  private recordRejection(replica: ReplicaState, operationId: string, code: string): void {
    replica.rejections.push({ operationId, code });
    replica.rejections = replica.rejections.slice(-100);
  }

  private publish(replica: ReplicaState): void {
    if (!replica.document) return;
    this.onChange(this.toProjection(replica));
  }

  private publishCommitted(replica: ReplicaState, exactContent?: CompleteContentVersion): void {
    if (!replica.document || !replica.contentDigest) return;
    const content = exactContent ?? encodeCanvasReplicaDocument(replica.document);
    if (content.canonicalDigest !== replica.contentDigest) {
      throw replicaError("canvas_replica_committed_content_digest_mismatch", true);
    }
    this.onCommitted({
      scope: replica.scope,
      revision: replica.revision,
      contentDigest: replica.contentDigest,
      content
    });
  }

  private toProjection(replica: ReplicaState): CollaborationCanvasBindingReplicaProjection {
    if (!replica.document || !replica.contentDigest) {
      throw replicaError("canvas_replica_baseline_required");
    }
    const visibleDocument = this.visibleDocument(replica);
    const content = overlayCanvasReplicaRuntimeStatus({
      content: projectCanvasReplicaDocument(visibleDocument),
      status: replica.runtimeStatus,
      scope: {
        workspaceId: replica.scope.workspaceId,
        projectId: replica.scope.projectId,
        canvasId: replica.scope.canvasId
      }
    });
    const projection = {
      authorityId: replica.scope.authorityId,
      workspaceId: replica.scope.workspaceId,
      projectId: replica.scope.projectId,
      canvasId: replica.scope.canvasId,
      revision: replica.revision,
      contentDigest: replica.contentDigest,
      canEdit: replica.canEdit,
      optimisticOperationIds: replica.pending.map((pending) => pending.operationId),
      rejections: replica.rejections,
      content: {
        projectTitle: content.projectTitle,
        graphVersion: content.graphVersion,
        packageFingerprint: content.packageFingerprint,
        tasks: content.tasks,
        edges: content.edges,
        sharedResourceGroups: content.sharedResourceGroups,
        diagnostics: content.diagnostics,
        layout: content.layout,
        blockDependenciesByRef: content.blockDependenciesByRef,
        taskOpenFeedbackCountByTaskId: content.taskOpenFeedbackCountByTaskId,
        blockPromptMarkdownByRef: content.blockPromptMarkdownByRef
      }
    };
    return collaborationCanvasBindingReplicaProjectionSchema.parse(
      replica.scope.bindingKind === "local"
        ? {
            ...projection,
            localProjectId: replica.scope.localProjectId,
            localCanvasId: replica.scope.localCanvasId
          }
        : { ...projection, bindingKind: "remote" }
    );
  }

  private visibleDocument(replica: ReplicaState): CanvasReplicaDocument {
    if (!replica.document) throw replicaError("canvas_replica_baseline_required");
    let visible = replica.document;
    for (const pending of replica.pending) {
      visible = applyCanvasReplicaIntent(visible, pending.intent);
    }
    return visible;
  }

  /** Replay pending ops on the committed document; return ops that can no longer apply. */
  private rebasePending(replica: ReplicaState): CanvasReplicaPendingOperation[] {
    if (!replica.document) return [];
    let visible = replica.document;
    const retained: CanvasReplicaPendingOperation[] = [];
    const dropped: CanvasReplicaPendingOperation[] = [];
    for (const pending of replica.pending) {
      try {
        visible = applyCanvasReplicaIntent(visible, pending.intent);
        retained.push(pending);
      } catch {
        dropped.push(pending);
        this.recordRejection(replica, pending.operationId, "canvas_replica_pending_rebase_failed");
      }
    }
    replica.pending = retained;
    return dropped;
  }
}
