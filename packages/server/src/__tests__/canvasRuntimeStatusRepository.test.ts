import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CanvasRuntimeStatusRepository } from "../canvas/runtimeStatusRepository.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;
const fingerprint = `pkg-${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function status(capturedAt: string) {
  return {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope,
    packageFingerprint: fingerprint,
    capturedAt,
    tasks: [],
    blocks: []
  };
}

function implementationCandidatesManifest(): PlanPackageManifest {
  const manifest = basicManifest({ parallel: true, maxConcurrent: 1 });
  const task = manifest.nodes[0];
  const template = task.blocks.find((block) => block.type === "implementation");
  if (!template) throw new Error("implementation_block_template_missing");
  task.blocks = ["B-IMPLEMENT", "B-REVIEW", "B-DECOY"].map((id) => ({
    ...template,
    id,
    title: id,
    prompt: `nodes/${task.id}/blocks/${id}.prompt.md`,
    depends_on: []
  }));
  return manifest;
}

function projectedBlock(
  ref: string,
  blockStatus: CanvasRuntimeStatusProjection["blocks"][number]["status"],
  dispatchable: boolean
): CanvasRuntimeStatusProjection["blocks"][number] {
  return {
    ref,
    status: blockStatus,
    completionReason: null,
    blockedReason: null,
    divergenceReason: null,
    dispatchable
  };
}

async function repository() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  return new CanvasRuntimeStatusRepository(database, () => new Date("2026-08-21T00:00:00.000Z"));
}

describe("CanvasRuntimeStatusRepository", () => {
  it("allows an execution result to replace the authoritative projection", async () => {
    const statuses = await repository();
    const initial = status("2026-08-20T00:00:00.000Z");
    expect(statuses.replaceFromExecution(initial)).toEqual({ runtimeRevision: 1, status: initial });

    const refreshed = status("2026-08-21T00:00:00.000Z");
    expect(statuses.replaceFromExecution(refreshed)).toEqual({
      runtimeRevision: 2,
      status: refreshed
    });
    expect(statuses.read(scope)).toEqual({ runtimeRevision: 2, status: refreshed });

    const third = status("2026-08-22T00:00:00.000Z");
    expect(statuses.replaceFromExecution(third)).toEqual({ runtimeRevision: 3, status: third });
  });

  it("rolls back both status and invalidation when the commit listener fails", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, 10);
    const statuses = new CanvasRuntimeStatusRepository(database, undefined, (snapshot) => {
      journal.appendInCallerTransaction(
        { workspaceId: scope.workspaceId, projectId: scope.projectId },
        { kind: "runtime", canvasId: scope.canvasId, runtimeRevision: snapshot.runtimeRevision }
      );
      throw new Error("simulated_invalidation_failure");
    });

    expect(() => statuses.replaceFromExecution(status("2026-08-20T00:00:00.000Z"))).toThrow(
      "simulated_invalidation_failure"
    );
    expect(statuses.read(scope)).toBeNull();
    expect(journal.head({ workspaceId: scope.workspaceId, projectId: scope.projectId })).toBe(0);
  });

  it("recomputes a stable ready candidate after the target mutation releases capacity", async () => {
    const statuses = await repository();
    const manifest = implementationCandidatesManifest();
    const current = {
      ...status("2026-08-20T00:00:00.000Z"),
      tasks: [{ taskId: "T-001", status: "in_progress" as const, openFeedbackCount: 0 }],
      blocks: [
        projectedBlock("T-001#B-IMPLEMENT", "in_progress", false),
        projectedBlock("T-001#B-REVIEW", "ready", false),
        projectedBlock("T-001#B-DECOY", "completed", false)
      ]
    } satisfies CanvasRuntimeStatusProjection;
    statuses.replaceFromExecution(current);

    const incoming = {
      ...current,
      capturedAt: "2026-08-21T00:00:00.000Z",
      blocks: [
        projectedBlock("T-001#B-IMPLEMENT", "completed", false),
        projectedBlock("T-001#B-REVIEW", "ready", true),
        projectedBlock("T-001#B-DECOY", "planned", true)
      ]
    } satisfies CanvasRuntimeStatusProjection;
    const merged = statuses.mergeRemoteMutationFromExecution(
      incoming,
      "T-001#B-IMPLEMENT",
      manifest
    );

    expect(merged).toMatchObject({
      runtimeRevision: 2,
      status: {
        blocks: [
          { ref: "T-001#B-IMPLEMENT", status: "completed", dispatchable: false },
          { ref: "T-001#B-REVIEW", status: "ready", dispatchable: true },
          { ref: "T-001#B-DECOY", status: "completed", dispatchable: false }
        ]
      }
    });
  });

  it("preserves required-review and feedback semantics while ignoring non-target Host state", async () => {
    const statuses = await repository();
    const manifest = basicManifest({ parallel: true, maxConcurrent: 1, includeSecondTask: true });
    const current = {
      ...status("2026-08-20T00:00:00.000Z"),
      tasks: [
        { taskId: "T-001", status: "in_progress" as const, openFeedbackCount: 0 },
        { taskId: "T-002", status: "ready" as const, openFeedbackCount: 0 }
      ],
      blocks: [
        projectedBlock("T-001#B-001", "in_progress", false),
        projectedBlock("T-001#R-001", "planned", false),
        projectedBlock("T-002#B-001", "ready", false),
        projectedBlock("T-002#R-001", "planned", false)
      ]
    } satisfies CanvasRuntimeStatusProjection;
    statuses.replaceFromExecution(current);

    const implementationCompleted = {
      ...current,
      capturedAt: "2026-08-21T00:00:00.000Z",
      blocks: [
        projectedBlock("T-001#B-001", "completed", false),
        {
          ...projectedBlock("T-001#R-001", "completed", true),
          completionReason: "passed" as const
        },
        projectedBlock("T-002#B-001", "completed", false),
        {
          ...projectedBlock("T-002#R-001", "completed", true),
          completionReason: "passed" as const
        }
      ]
    } satisfies CanvasRuntimeStatusProjection;
    const afterImplementation = statuses.mergeRemoteMutationFromExecution(
      implementationCompleted,
      "T-001#B-001",
      manifest
    );
    expect(afterImplementation.status).toMatchObject({
      tasks: [
        { taskId: "T-001", status: "in_progress", openFeedbackCount: 0 },
        { taskId: "T-002", status: "ready", openFeedbackCount: 0 }
      ],
      blocks: [
        { ref: "T-001#B-001", status: "completed", dispatchable: false },
        {
          ref: "T-001#R-001",
          status: "ready",
          completionReason: null,
          dispatchable: true
        },
        { ref: "T-002#B-001", status: "ready", dispatchable: true },
        { ref: "T-002#R-001", status: "planned", dispatchable: false }
      ]
    });

    const feedbackOpened = {
      ...implementationCompleted,
      capturedAt: "2026-08-22T00:00:00.000Z",
      tasks: [
        {
          taskId: "T-001",
          status: "in_progress" as const,
          openFeedbackCount: 1_000_000_000
        },
        { taskId: "T-002", status: "implemented" as const, openFeedbackCount: 0 }
      ],
      blocks: [
        projectedBlock("T-001#B-001", "planned", true),
        projectedBlock("T-001#R-001", "in_progress", true),
        projectedBlock("T-002#B-001", "completed", false),
        {
          ...projectedBlock("T-002#R-001", "completed", true),
          completionReason: "passed" as const
        }
      ]
    } satisfies CanvasRuntimeStatusProjection;
    const afterFeedback = statuses.mergeRemoteMutationFromExecution(
      feedbackOpened,
      "T-001#R-001",
      manifest
    );
    expect(afterFeedback.status).toMatchObject({
      tasks: [
        { taskId: "T-001", status: "in_progress", openFeedbackCount: 1_000_000_000 },
        { taskId: "T-002", status: "ready", openFeedbackCount: 0 }
      ],
      blocks: [
        { ref: "T-001#B-001", status: "completed", dispatchable: false },
        { ref: "T-001#R-001", status: "in_progress", dispatchable: false },
        { ref: "T-002#B-001", status: "ready", dispatchable: true },
        {
          ref: "T-002#R-001",
          status: "planned",
          completionReason: null,
          dispatchable: false
        }
      ]
    });
  });
});
