import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { createInvalidatingCanvasRuntimeStatusRepository } from "../canvas/runtimeStatusInvalidation.js";
import { CanvasRuntimeStatusRepository } from "../canvas/runtimeStatusRepository.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;
const observerScope = { workspaceId: scope.workspaceId, projectId: scope.projectId };
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

  it.each([
    "initialize",
    "replace",
    "merge"
  ] as const)("rolls back %s and invalidation when the commit listener fails", async (operation) => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, 10);
    let failCommit = false;
    const statuses = new CanvasRuntimeStatusRepository(database, undefined, (snapshot) => {
      journal.appendInCallerTransaction(
        { workspaceId: scope.workspaceId, projectId: scope.projectId },
        { kind: "runtime", canvasId: scope.canvasId, runtimeRevision: snapshot.runtimeRevision }
      );
      if (failCommit) throw new Error("simulated_invalidation_failure");
    });
    const manifest = implementationCandidatesManifest();
    const initial = {
      ...status("2026-08-20T00:00:00.000Z"),
      tasks: [{ taskId: "T-001", status: "in_progress" as const, openFeedbackCount: 0 }],
      blocks: manifest.nodes[0].blocks.map((block) =>
        projectedBlock(`T-001#${block.id}`, "ready", true)
      )
    } satisfies CanvasRuntimeStatusProjection;
    const before = operation === "initialize" ? null : statuses.replaceFromExecution(initial);
    const head = journal.head(observerScope);
    failCommit = true;
    const incoming = { ...initial, capturedAt: "2026-08-21T00:00:00.000Z" };
    incoming.blocks = initial.blocks.map((block) => ({ ...block, status: "completed" }));

    expect(() =>
      operation === "merge"
        ? statuses.mergeRemoteMutationFromExecution(incoming, "T-001#B-IMPLEMENT", manifest)
        : statuses.replaceFromExecution(incoming)
    ).toThrow("simulated_invalidation_failure");
    expect(statuses.read(scope)).toEqual(before);
    expect(journal.head(observerScope)).toBe(head);
  });

  const identityChanges: Array<{
    name: string;
    mutate(status: CanvasRuntimeStatusProjection): void;
  }> = [
    {
      name: "replaced task",
      mutate: (value) => {
        value.tasks[1].taskId = "T-003";
      }
    },
    {
      name: "missing task",
      mutate: (value) => {
        value.tasks.pop();
      }
    },
    {
      name: "extra task",
      mutate: (value) => {
        value.tasks.push({ ...value.tasks[1], taskId: "T-003" });
      }
    },
    {
      name: "replaced block",
      mutate: (value) => {
        value.blocks[1].ref = "T-002#B-002";
      }
    },
    {
      name: "missing block",
      mutate: (value) => {
        value.blocks.pop();
      }
    },
    {
      name: "extra block",
      mutate: (value) => {
        value.blocks.push({ ...value.blocks[1], ref: "T-002#B-002" });
      }
    }
  ];
  it.each(
    identityChanges.flatMap((change) => [
      { ...change, authority: "current", error: "canvas_runtime_status_identity_mismatch" },
      { ...change, authority: "graph", error: "canvas_runtime_status_graph_identity_mismatch" }
    ])
  )("rejects $name against $authority without advancing status or journal", async ({
    mutate,
    authority,
    error
  }) => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, 10);
    const statuses = createInvalidatingCanvasRuntimeStatusRepository({
      database,
      observerJournal: journal
    });
    const manifest = basicManifest({ includeSecondTask: true });
    const current = {
      ...status("2026-08-20T00:00:00.000Z"),
      tasks: manifest.nodes.map((task) => ({
        taskId: task.id,
        status: "ready" as const,
        openFeedbackCount: 0
      })),
      blocks: manifest.nodes.flatMap((task) =>
        task.blocks.map((block) => projectedBlock(`${task.id}#${block.id}`, "ready", true))
      )
    } satisfies CanvasRuntimeStatusProjection;
    const incoming = structuredClone(current);
    mutate(incoming);
    if (authority === "graph") mutate(current);
    const before = statuses.replaceFromExecution(current);
    const head = journal.head(observerScope);
    expect(() =>
      statuses.mergeRemoteMutationFromExecution(incoming, "T-001#B-001", manifest)
    ).toThrow(error);
    expect(statuses.read(scope)).toEqual(before);
    expect(journal.head(observerScope)).toBe(head);
  });

  it.each([
    "fingerprint",
    "target task",
    "target block"
  ] as const)("rejects a mismatched %s without advancing revision", async (invalid) => {
    const statuses = await repository();
    const manifest = implementationCandidatesManifest();
    const current = {
      ...status("2026-08-20T00:00:00.000Z"),
      tasks: [{ taskId: "T-001", status: "ready" as const, openFeedbackCount: 0 }],
      blocks: manifest.nodes[0].blocks.map((block) =>
        projectedBlock(`T-001#${block.id}`, "ready", true)
      )
    } satisfies CanvasRuntimeStatusProjection;
    const before = statuses.replaceFromExecution(current);
    const incoming = structuredClone(current);
    if (invalid === "fingerprint") incoming.packageFingerprint = `pkg-${"b".repeat(64)}`;
    if (invalid === "target task") incoming.tasks = [];
    if (invalid === "target block") incoming.blocks.shift();
    expect(() =>
      statuses.mergeRemoteMutationFromExecution(incoming, "T-001#B-IMPLEMENT", manifest)
    ).toThrow(
      invalid === "fingerprint"
        ? "canvas_runtime_status_fingerprint_mismatch"
        : "canvas_runtime_status_mutation_target_missing"
    );
    expect(statuses.read(scope)).toEqual(before);
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
    incoming.blocks.reverse();
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
    feedbackOpened.tasks.reverse();
    feedbackOpened.blocks.reverse();
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
