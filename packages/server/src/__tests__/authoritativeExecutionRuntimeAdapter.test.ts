import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { PlanPackageManifest, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { AuthoritativeExecutionRuntimeAdapter } from "../canvas/authoritativeExecutionRuntimeAdapter.js";
import { createInvalidatingCanvasRuntimeStatusRepository } from "../canvas/runtimeStatusInvalidation.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" };
const fingerprint = `pkg-${"a".repeat(64)}`;
const claimInput = {
  ref: "T-001#B-001",
  operationId: "operation-1",
  controlPlane: "owner" as const,
  sourceRevision: "source-1",
  graphFingerprint: fingerprint
};
const binding = { ref: claimInput.ref, status: "in_progress" as const };
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function statusAuthority() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const runtimeStatuses = createInvalidatingCanvasRuntimeStatusRepository({
    database,
    observerJournal: new HumanObserverJournal(database, 100)
  });
  return { database, runtimeStatuses };
}

function runtimeInvalidations(database: SqliteDatabase): unknown[] {
  return database
    .prepare(
      `SELECT event_json FROM human_observer_events
        WHERE json_extract(event_json, '$.kind') = 'runtime'
        ORDER BY cursor`
    )
    .all()
    .map((row) => JSON.parse(String(row.event_json)));
}

function runtime(): RemoteBlockRuntimePort {
  return {
    inspect: vi.fn(),
    claim: vi.fn(async () => binding),
    activate: vi.fn(),
    query: vi.fn(),
    reconcile: vi.fn(),
    markInterrupted: vi.fn(),
    resumeAttempt: vi.fn(),
    retryAttempt: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn()
  };
}

function status(packageFingerprint = fingerprint): CanvasRuntimeStatusProjection {
  return {
    schemaVersion: "canvas-runtime-status/v2",
    scope,
    packageFingerprint,
    capturedAt: "2026-08-21T00:00:00.000Z",
    tasks: [{ taskId: "T-001", status: "in_progress", openFeedbackCount: 0 }],
    blocks: [
      {
        ref: "T-001#B-001",
        status: "in_progress",
        completionReason: null,
        blockedReason: null,
        divergenceReason: null,
        dispatchable: false
      }
    ]
  };
}

function resetStatus(capturedAt = "2026-08-21T00:00:00.000Z"): CanvasRuntimeStatusProjection {
  return {
    ...status(),
    capturedAt,
    tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
    blocks: [
      {
        ref: "T-001#B-001",
        status: "ready",
        completionReason: null,
        blockedReason: null,
        divergenceReason: null,
        dispatchable: true
      }
    ]
  };
}

function manifestForStatus(
  projection: CanvasRuntimeStatusProjection,
  dependencies: Record<string, string[]> = {}
): PlanPackageManifest {
  const manifest = basicManifest();
  const taskTemplate = manifest.nodes[0];
  const blockTemplate = taskTemplate.blocks[0];
  manifest.nodes = projection.tasks.map((task) => ({
    ...taskTemplate,
    id: task.taskId,
    title: task.taskId,
    prompt: `prompts/${task.taskId}.md`,
    depends_on: dependencies[task.taskId] ?? [],
    blocks: projection.blocks
      .filter((block) => block.ref.startsWith(`${task.taskId}#`))
      .map((block) => {
        const blockId = block.ref.slice(task.taskId.length + 1);
        return {
          ...blockTemplate,
          id: blockId,
          title: blockId,
          prompt: `prompts/${task.taskId}/${blockId}.md`,
          depends_on: []
        };
      })
  }));
  return manifest;
}

const noResetBaselines = { latestAcceptedBaseline: () => null };

describe("AuthoritativeExecutionRuntimeAdapter", () => {
  it("persists the real Runtime projection after a shared-canvas mutation", async () => {
    const mergeRemoteMutationFromExecution = vi.fn(
      (value: CanvasRuntimeStatusProjection, _blockRef: string, _manifest: PlanPackageManifest) =>
        value
    );
    const readStatus = vi.fn(async () => status());
    const authority = {
      packageFingerprint: fingerprint,
      manifest: manifestForStatus(status())
    };
    const readContentAuthority = vi.fn(() => authority);
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus,
          release: vi.fn()
        }))
      },
      readContentAuthority,
      resetBaselines: noResetBaselines,
      runtimeStatuses: { read: () => null, mergeRemoteMutationFromExecution }
    });

    const lease = await adapter.acquire(scope);
    await expect(lease.runtime.claim(claimInput)).resolves.toEqual(binding);
    expect(readContentAuthority).toHaveBeenCalledOnce();
    expect(readStatus).toHaveBeenCalledOnce();
    expect(mergeRemoteMutationFromExecution).toHaveBeenCalledWith(
      status(),
      claimInput.ref,
      authority.manifest
    );
  });

  it("commits an invalidation with the authoritative revision after a mutation", async () => {
    const { database, runtimeStatuses } = await statusAuthority();
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus: vi.fn(async () => status()),
          release: vi.fn()
        }))
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(status())
      }),
      resetBaselines: noResetBaselines,
      runtimeStatuses
    });

    const lease = await adapter.acquire(scope);
    await lease.runtime.claim(claimInput);

    expect(runtimeStatuses.read(scope)).toEqual({ runtimeRevision: 1, status: status() });
    expect(runtimeInvalidations(database)).toEqual([
      { kind: "runtime", canvasId: "default", runtimeRevision: 1 }
    ]);
  });

  it("applies the current Server reset baseline to the selected Host before inspect", async () => {
    const { runtimeStatuses } = await statusAuthority();
    const baselineStatus = resetStatus();
    runtimeStatuses.replaceFromExecution(baselineStatus);
    const reset = vi.fn(async () => ({
      operationId: "reset-selected-host",
      sourceRevision: "source-1",
      graphFingerprint: fingerprint,
      status: resetStatus("2026-08-21T00:00:01.000Z")
    }));
    const selectedRuntime = runtime();
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: selectedRuntime,
          artifacts: { read: vi.fn() },
          reset,
          release: vi.fn()
        })),
        acquireForHost: vi.fn(async () => ({
          runtime: selectedRuntime,
          artifacts: { read: vi.fn() },
          reset,
          release: vi.fn()
        }))
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(baselineStatus)
      }),
      resetBaselines: {
        latestAcceptedBaseline: () => ({
          runtimeRevision: 1,
          command: {
            operationId: "reset-selected-host",
            expectedSourceRevision: "source-1",
            expectedGraphFingerprint: fingerprint
          },
          status: baselineStatus
        })
      },
      runtimeStatuses
    });

    const lease = await adapter.acquireForHost(scope, "mac-host");
    await lease.runtime.inspect({ ref: "T-001#B-001" });

    expect(reset).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledWith({
      operationId: "reset-selected-host",
      expectedSourceRevision: "source-1",
      expectedGraphFingerprint: fingerprint
    });
    expect(selectedRuntime.inspect).toHaveBeenCalledOnce();
  });

  it("does not expose a reset Host lease when the Server baseline advances during reset", async () => {
    const { runtimeStatuses } = await statusAuthority();
    const baselineStatus = resetStatus();
    runtimeStatuses.replaceFromExecution(baselineStatus);
    let finishReset:
      | ((value: {
          operationId: string;
          sourceRevision: string;
          graphFingerprint: string;
          status: CanvasRuntimeStatusProjection;
        }) => void)
      | undefined;
    const reset = vi.fn(
      () =>
        new Promise<{
          operationId: string;
          sourceRevision: string;
          graphFingerprint: string;
          status: CanvasRuntimeStatusProjection;
        }>((resolve) => {
          finishReset = resolve;
        })
    );
    const release = vi.fn();
    const selectedRuntime = runtime();
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(),
        acquireForHost: vi.fn(async () => ({
          runtime: selectedRuntime,
          artifacts: { read: vi.fn() },
          reset,
          release
        }))
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(baselineStatus)
      }),
      resetBaselines: {
        latestAcceptedBaseline: () => ({
          runtimeRevision: 1,
          command: {
            operationId: "reset-racing-host",
            expectedSourceRevision: "source-1",
            expectedGraphFingerprint: fingerprint
          },
          status: baselineStatus
        })
      },
      runtimeStatuses
    });

    const acquiring = adapter.acquireForHost(scope, "mac-host");
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    runtimeStatuses.replaceFromExecution(status());
    finishReset?.({
      operationId: "reset-racing-host",
      sourceRevision: "source-1",
      graphFingerprint: fingerprint,
      status: resetStatus("2026-08-21T00:00:01.000Z")
    });

    await expect(acquiring).rejects.toThrow("canvas_runtime_reset_baseline_superseded");
    expect(release).toHaveBeenCalledOnce();
    expect(selectedRuntime.inspect).not.toHaveBeenCalled();
  });

  it("preserves terminal Server statuses when another Host returns a stale full projection", async () => {
    const { runtimeStatuses } = await statusAuthority();
    const initial = {
      ...status(),
      capturedAt: "2026-08-20T00:00:00.000Z",
      tasks: [
        { taskId: "T-CODEX", status: "implemented" as const, openFeedbackCount: 0 },
        { taskId: "T-OPENCODE", status: "implemented" as const, openFeedbackCount: 0 },
        { taskId: "T-PI", status: "ready" as const, openFeedbackCount: 0 }
      ],
      blocks: [
        {
          ref: "T-CODEX#B-CODEX",
          status: "completed" as const,
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        },
        {
          ref: "T-OPENCODE#B-OPENCODE",
          status: "completed" as const,
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        },
        {
          ref: "T-PI#B-PI",
          status: "ready" as const,
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: true
        }
      ]
    } satisfies CanvasRuntimeStatusProjection;
    runtimeStatuses.replaceFromExecution(initial);

    const piHostProjection = {
      ...initial,
      capturedAt: "2026-08-21T00:00:00.000Z",
      tasks: initial.tasks.map((task) => ({
        ...task,
        status: task.taskId === "T-PI" ? ("implemented" as const) : ("ready" as const)
      })),
      blocks: initial.blocks.map((block) => ({
        ...block,
        status: block.ref === "T-PI#B-PI" ? ("completed" as const) : ("ready" as const),
        dispatchable: false
      }))
    } satisfies CanvasRuntimeStatusProjection;
    const acquireForHost = vi.fn(async () => ({
      runtime: runtime(),
      artifacts: { read: vi.fn() },
      readStatus: vi.fn(async () => piHostProjection),
      release: vi.fn()
    }));
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: acquireForHost,
        acquireForHost
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(initial)
      }),
      resetBaselines: noResetBaselines,
      runtimeStatuses
    });

    const lease = await adapter.acquireForHost(scope, "pi-host");
    await lease.runtime.claim({ ...claimInput, ref: "T-PI#B-PI" });

    expect(runtimeStatuses.read(scope)).toMatchObject({
      runtimeRevision: 2,
      status: {
        capturedAt: piHostProjection.capturedAt,
        tasks: [
          { taskId: "T-CODEX", status: "implemented" },
          { taskId: "T-OPENCODE", status: "implemented" },
          { taskId: "T-PI", status: "implemented" }
        ],
        blocks: [
          { ref: "T-CODEX#B-CODEX", status: "completed" },
          { ref: "T-OPENCODE#B-OPENCODE", status: "completed" },
          { ref: "T-PI#B-PI", status: "completed" }
        ]
      }
    });
  });

  it("derives a multi-block task from the merged Server block states", async () => {
    const { runtimeStatuses } = await statusAuthority();
    const block = (
      ref: string,
      blockStatus: "ready" | "completed"
    ): CanvasRuntimeStatusProjection["blocks"][number] => ({
      ref,
      status: blockStatus,
      completionReason: null,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: blockStatus === "ready"
    });
    const initial = {
      ...status(),
      tasks: [{ taskId: "T-MULTI", status: "in_progress" as const, openFeedbackCount: 0 }],
      blocks: [block("T-MULTI#B-ONE", "completed"), block("T-MULTI#B-TWO", "ready")]
    } satisfies CanvasRuntimeStatusProjection;
    runtimeStatuses.replaceFromExecution(initial);
    const secondHostProjection = {
      ...initial,
      capturedAt: "2026-08-21T00:00:00.000Z",
      tasks: [{ taskId: "T-MULTI", status: "implemented" as const, openFeedbackCount: 0 }],
      blocks: [block("T-MULTI#B-ONE", "ready"), block("T-MULTI#B-TWO", "completed")]
    } satisfies CanvasRuntimeStatusProjection;
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus: vi.fn(async () => secondHostProjection),
          release: vi.fn()
        }))
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(initial)
      }),
      resetBaselines: noResetBaselines,
      runtimeStatuses
    });

    const lease = await adapter.acquire(scope);
    await lease.runtime.claim({ ...claimInput, ref: "T-MULTI#B-TWO" });

    expect(runtimeStatuses.read(scope)).toMatchObject({
      runtimeRevision: 2,
      status: {
        tasks: [{ taskId: "T-MULTI", status: "implemented", openFeedbackCount: 0 }],
        blocks: [
          { ref: "T-MULTI#B-ONE", status: "completed" },
          { ref: "T-MULTI#B-TWO", status: "completed" }
        ]
      }
    });
  });

  it("rejects a stale Host task completion when a Server sibling is not complete", async () => {
    const { runtimeStatuses } = await statusAuthority();
    const initial = {
      ...status(),
      tasks: [{ taskId: "T-MULTI", status: "in_progress" as const, openFeedbackCount: 0 }],
      blocks: [
        {
          ref: "T-MULTI#B-ONE",
          status: "blocked" as const,
          completionReason: null,
          blockedReason: "authoritative failure",
          divergenceReason: null,
          dispatchable: false
        },
        {
          ref: "T-MULTI#B-TWO",
          status: "ready" as const,
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: true
        }
      ]
    } satisfies CanvasRuntimeStatusProjection;
    runtimeStatuses.replaceFromExecution(initial);
    const staleProjection = {
      ...initial,
      capturedAt: "2026-08-21T00:00:00.000Z",
      tasks: [{ taskId: "T-MULTI", status: "implemented" as const, openFeedbackCount: 0 }],
      blocks: initial.blocks.map((block) => ({
        ...block,
        status: "completed" as const,
        blockedReason: null,
        dispatchable: false
      }))
    } satisfies CanvasRuntimeStatusProjection;
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus: vi.fn(async () => staleProjection),
          release: vi.fn()
        }))
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(initial)
      }),
      resetBaselines: noResetBaselines,
      runtimeStatuses
    });

    const lease = await adapter.acquire(scope);
    await lease.runtime.claim({ ...claimInput, ref: "T-MULTI#B-TWO" });

    expect(runtimeStatuses.read(scope)).toMatchObject({
      status: {
        tasks: [{ taskId: "T-MULTI", status: "in_progress" }],
        blocks: [
          { ref: "T-MULTI#B-ONE", status: "blocked" },
          { ref: "T-MULTI#B-TWO", status: "completed" }
        ]
      }
    });
  });

  it("derives downstream readiness from the authoritative dependency graph", async () => {
    const { runtimeStatuses } = await statusAuthority();
    const projectionBlock = (
      ref: string,
      blockStatus: "planned" | "ready" | "completed"
    ): CanvasRuntimeStatusProjection["blocks"][number] => ({
      ref,
      status: blockStatus,
      completionReason: null,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: blockStatus === "ready"
    });
    const initial = {
      ...status(),
      tasks: [
        { taskId: "T-UPSTREAM", status: "ready" as const, openFeedbackCount: 0 },
        { taskId: "T-DOWNSTREAM", status: "planned" as const, openFeedbackCount: 0 }
      ],
      blocks: [
        projectionBlock("T-UPSTREAM#B-UPSTREAM", "ready"),
        projectionBlock("T-DOWNSTREAM#B-DOWNSTREAM", "planned")
      ]
    } satisfies CanvasRuntimeStatusProjection;
    runtimeStatuses.replaceFromExecution(initial);
    const completedProjection = {
      ...initial,
      capturedAt: "2026-08-21T00:00:00.000Z",
      tasks: [
        { taskId: "T-UPSTREAM", status: "implemented" as const, openFeedbackCount: 0 },
        { taskId: "T-DOWNSTREAM", status: "ready" as const, openFeedbackCount: 0 }
      ],
      blocks: [
        projectionBlock("T-UPSTREAM#B-UPSTREAM", "completed"),
        projectionBlock("T-DOWNSTREAM#B-DOWNSTREAM", "ready")
      ]
    } satisfies CanvasRuntimeStatusProjection;
    const manifest = manifestForStatus(initial, { "T-DOWNSTREAM": ["T-UPSTREAM"] });
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus: vi.fn(async () => completedProjection),
          release: vi.fn()
        }))
      },
      readContentAuthority: () => ({ packageFingerprint: fingerprint, manifest }),
      resetBaselines: noResetBaselines,
      runtimeStatuses
    });

    const lease = await adapter.acquire(scope);
    await lease.runtime.claim({ ...claimInput, ref: "T-UPSTREAM#B-UPSTREAM" });

    expect(runtimeStatuses.read(scope)).toMatchObject({
      status: {
        tasks: [
          { taskId: "T-UPSTREAM", status: "implemented" },
          { taskId: "T-DOWNSTREAM", status: "ready" }
        ],
        blocks: [
          { ref: "T-UPSTREAM#B-UPSTREAM", status: "completed" },
          { ref: "T-DOWNSTREAM#B-DOWNSTREAM", status: "ready", dispatchable: true }
        ]
      }
    });
  });

  it("does not persist status or invalidation when the Runtime mutation fails", async () => {
    const { database, runtimeStatuses } = await statusAuthority();
    const failedRuntime = runtime();
    failedRuntime.claim = vi.fn(async () => {
      throw new Error("mutation_failed");
    });
    const readStatus = vi.fn(async () => status());
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: failedRuntime,
          artifacts: { read: vi.fn() },
          readStatus,
          release: vi.fn()
        }))
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(status())
      }),
      resetBaselines: noResetBaselines,
      runtimeStatuses
    });

    const lease = await adapter.acquire(scope);
    await expect(lease.runtime.claim(claimInput)).rejects.toThrow("mutation_failed");
    expect(readStatus).not.toHaveBeenCalled();
    expect(runtimeStatuses.read(scope)).toBeNull();
    expect(runtimeInvalidations(database)).toEqual([]);
  });

  it("does not involve Server state for a local-only canvas", async () => {
    const readStatus = vi.fn(async () => status());
    const mergeRemoteMutationFromExecution = vi.fn(
      (value: CanvasRuntimeStatusProjection, _blockRef: string, _manifest: PlanPackageManifest) =>
        value
    );
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus,
          release: vi.fn()
        }))
      },
      readContentAuthority: () => undefined,
      resetBaselines: noResetBaselines,
      runtimeStatuses: { read: () => null, mergeRemoteMutationFromExecution }
    });

    const lease = await adapter.acquire(scope);
    await lease.runtime.claim(claimInput);
    expect(readStatus).not.toHaveBeenCalled();
    expect(mergeRemoteMutationFromExecution).not.toHaveBeenCalled();
  });

  it("refuses to overwrite Server state with a different content fingerprint", async () => {
    const mergeRemoteMutationFromExecution = vi.fn(
      (value: CanvasRuntimeStatusProjection, _blockRef: string, _manifest: PlanPackageManifest) =>
        value
    );
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: vi.fn(async () => ({
          runtime: runtime(),
          artifacts: { read: vi.fn() },
          readStatus: vi.fn(async () => status(`pkg-${"b".repeat(64)}`)),
          release: vi.fn()
        }))
      },
      readContentAuthority: () => ({
        packageFingerprint: fingerprint,
        manifest: manifestForStatus(status())
      }),
      resetBaselines: noResetBaselines,
      runtimeStatuses: { read: () => null, mergeRemoteMutationFromExecution }
    });

    const lease = await adapter.acquire(scope);
    await expect(lease.runtime.claim(claimInput)).rejects.toThrow(
      "canvas_runtime_status_content_out_of_sync"
    );
    expect(mergeRemoteMutationFromExecution).not.toHaveBeenCalled();
  });
});
