import {
  canvasRuntimeStatusProjectionSchema,
  canvasRuntimeStatusSnapshotSchema,
  type CanvasRuntimeStatusProjection,
  type CanvasRuntimeStatusSnapshot
} from "@planweave-ai/collaboration-protocol/canvas/status";
import {
  canvasScopeRefSchema,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  compileTaskGraph,
  createEmptyState,
  ensureStateForManifest,
  parseBlockRef,
  type PlanPackageManifest,
  type RuntimeState
} from "@planweave-ai/runtime";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";

type CanvasRuntimeStatusCommittedListener = (snapshot: CanvasRuntimeStatusSnapshot) => void;

function sameScope(left: CanvasScopeRef, right: CanvasScopeRef): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

function parseSnapshot(
  status: CanvasRuntimeStatusProjection,
  runtimeRevision: number
): CanvasRuntimeStatusSnapshot {
  return canvasRuntimeStatusSnapshotSchema.parse({ runtimeRevision, status });
}

function assertSameIdentityUniverse(
  current: CanvasRuntimeStatusProjection,
  incoming: CanvasRuntimeStatusProjection
): void {
  const currentTaskIds = new Set(current.tasks.map((task) => task.taskId));
  const currentBlockRefs = new Set(current.blocks.map((block) => block.ref));
  if (
    currentTaskIds.size !== incoming.tasks.length ||
    incoming.tasks.some((task) => !currentTaskIds.has(task.taskId)) ||
    currentBlockRefs.size !== incoming.blocks.length ||
    incoming.blocks.some((block) => !currentBlockRefs.has(block.ref))
  ) {
    throw new Error("canvas_runtime_status_identity_mismatch");
  }
}

function requireMutationTarget(status: CanvasRuntimeStatusProjection, blockRef: string): string {
  const { taskId } = parseBlockRef(blockRef);
  if (
    !status.tasks.some((task) => task.taskId === taskId) ||
    !status.blocks.some((block) => block.ref === blockRef)
  ) {
    throw new Error("canvas_runtime_status_mutation_target_missing");
  }
  return taskId;
}

function requireCurrentEntry<T>(entry: T | undefined): T {
  if (!entry) throw new Error("canvas_runtime_status_identity_mismatch");
  return entry;
}

function mergeRemoteMutationStatus(
  current: CanvasRuntimeStatusProjection,
  incoming: CanvasRuntimeStatusProjection,
  blockRef: string,
  manifest: PlanPackageManifest
): CanvasRuntimeStatusProjection {
  if (current.packageFingerprint !== incoming.packageFingerprint) {
    throw new Error("canvas_runtime_status_fingerprint_mismatch");
  }
  assertSameIdentityUniverse(current, incoming);
  const taskId = requireMutationTarget(incoming, blockRef);
  const graph = compileTaskGraph(manifest);
  if (graph.diagnostics.errors.length > 0) {
    throw new Error("canvas_runtime_status_graph_invalid");
  }
  if (
    graph.taskNodesInManifestOrder.length !== incoming.tasks.length ||
    graph.taskNodesInManifestOrder.some(
      (candidate) => !incoming.tasks.some((task) => task.taskId === candidate)
    ) ||
    graph.blockRefsInManifestOrder.length !== incoming.blocks.length ||
    graph.blockRefsInManifestOrder.some(
      (candidate) => !incoming.blocks.some((block) => block.ref === candidate)
    )
  ) {
    throw new Error("canvas_runtime_status_graph_identity_mismatch");
  }
  const currentTasks = new Map(current.tasks.map((task) => [task.taskId, task]));
  const currentBlocks = new Map(current.blocks.map((block) => [block.ref, block]));
  const incomingBlocks = new Map(incoming.blocks.map((block) => [block.ref, block]));
  const selectedBlocks = incoming.blocks.map((block) => {
    if (block.ref === blockRef) return block;
    return requireCurrentEntry(currentBlocks.get(block.ref));
  });
  const targetBlock = requireCurrentEntry(graph.blocksByRef.get(blockRef));
  const feedbackCounts = new Map(
    current.tasks.map((task) => [task.taskId, task.openFeedbackCount])
  );
  if (targetBlock.type === "review") {
    feedbackCounts.set(
      taskId,
      requireCurrentEntry(incoming.tasks.find((task) => task.taskId === taskId)).openFeedbackCount
    );
  }
  const state: RuntimeState = {
    ...createEmptyState(),
    tasks: Object.fromEntries(currentTasks),
    blocks: Object.fromEntries(
      selectedBlocks.map((block) => [
        block.ref,
        {
          status: block.status,
          lastRunId: null,
          completionReason: block.completionReason,
          blockedReason: block.blockedReason,
          divergenceReason: block.divergenceReason
        }
      ])
    )
  };
  for (const [feedbackTaskId, count] of feedbackCounts) {
    if (count === 0) continue;
    const reviewRef = graph.reviewBlocksByTask.get(feedbackTaskId)?.[0];
    if (!reviewRef) throw new Error("canvas_runtime_status_feedback_source_missing");
    for (let index = 0; index < count; index += 1) {
      state.feedback[`projection:${feedbackTaskId}:${index}`] = {
        status: "open",
        sourceReviewBlockRef: reviewRef,
        latestSubmissionId: null,
        content: ""
      };
    }
  }
  const derived = ensureStateForManifest(manifest, state);
  return canvasRuntimeStatusProjectionSchema.parse({
    ...incoming,
    tasks: incoming.tasks.map((task) => ({
      taskId: task.taskId,
      ...requireCurrentEntry(derived.tasks[task.taskId])
    })),
    blocks: incoming.blocks.map((block) => {
      const selected = requireCurrentEntry(selectedBlocks.find((entry) => entry.ref === block.ref));
      const status = requireCurrentEntry(derived.blocks[block.ref]).status;
      const matchingIncoming = requireCurrentEntry(incomingBlocks.get(block.ref));
      return {
        ...selected,
        status,
        dispatchable:
          selected.status === status
            ? selected.dispatchable
            : matchingIncoming.status === status
              ? matchingIncoming.dispatchable
              : false
      };
    })
  });
}

/** Durable Server authority for the shared Runtime status projection. */
export class CanvasRuntimeStatusRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly onCommittedInTransaction?: CanvasRuntimeStatusCommittedListener
  ) {}

  read(rawScope: CanvasScopeRef): CanvasRuntimeStatusSnapshot | null {
    const scope = canvasScopeRefSchema.parse(rawScope);
    const row = this.database
      .prepare(
        `SELECT package_fingerprint,status_json,runtime_revision
           FROM canvas_runtime_status_snapshots
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId);
    if (!row) return null;
    const status = canvasRuntimeStatusProjectionSchema.parse(JSON.parse(String(row.status_json)));
    if (
      !sameScope(status.scope, scope) ||
      status.packageFingerprint !== String(row.package_fingerprint)
    ) {
      throw new Error("canvas_runtime_status_snapshot_corrupt");
    }
    return parseSnapshot(status, Number(row.runtime_revision));
  }

  replaceFromExecution(rawStatus: CanvasRuntimeStatusProjection): CanvasRuntimeStatusSnapshot {
    const status = canvasRuntimeStatusProjectionSchema.parse(rawStatus);
    return inWriteTransaction(this.database, () => {
      const existing = this.read(status.scope);
      const runtimeRevision = existing ? existing.runtimeRevision + 1 : 1;
      this.write(status, runtimeRevision);
      return this.readCommitted(status.scope);
    });
  }

  mergeRemoteMutationFromExecution(
    rawStatus: CanvasRuntimeStatusProjection,
    blockRef: string,
    manifest: PlanPackageManifest
  ): CanvasRuntimeStatusSnapshot {
    const incoming = canvasRuntimeStatusProjectionSchema.parse(rawStatus);
    requireMutationTarget(incoming, blockRef);
    return inWriteTransaction(this.database, () => {
      const existing = this.read(incoming.scope);
      const status = existing
        ? mergeRemoteMutationStatus(existing.status, incoming, blockRef, manifest)
        : incoming;
      const runtimeRevision = existing ? existing.runtimeRevision + 1 : 1;
      this.write(status, runtimeRevision);
      return this.readCommitted(status.scope);
    });
  }

  private readCommitted(scope: CanvasScopeRef): CanvasRuntimeStatusSnapshot {
    const snapshot = this.read(scope);
    if (!snapshot) throw new Error("canvas_runtime_status_snapshot_missing");
    this.onCommittedInTransaction?.(snapshot);
    return snapshot;
  }

  private write(status: CanvasRuntimeStatusProjection, runtimeRevision: number): void {
    const values = [
      status.scope.workspaceId,
      status.scope.projectId,
      status.scope.canvasId,
      status.packageFingerprint,
      JSON.stringify(status),
      "execution",
      this.clock().toISOString(),
      runtimeRevision
    ] as const;
    this.database
      .prepare(
        `INSERT INTO canvas_runtime_status_snapshots(
           workspace_id,project_id,canvas_id,package_fingerprint,status_json,origin,updated_at,runtime_revision
         ) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,project_id,canvas_id) DO UPDATE SET
           package_fingerprint=excluded.package_fingerprint,
           status_json=excluded.status_json,
           origin=excluded.origin,
           updated_at=excluded.updated_at,
           runtime_revision=excluded.runtime_revision`
      )
      .run(...values);
  }
}
