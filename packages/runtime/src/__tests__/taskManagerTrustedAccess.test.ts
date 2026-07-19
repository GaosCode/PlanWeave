import { describe, expect, it } from "vitest";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { inspectGraph } from "../graph/inspectGraph.js";
import { runtimeSnapshotFromGraphState } from "../projectGraph/runtimeAggregation.js";
import { createEmptyState, ensureStateForManifest } from "../state.js";
import { buildClaimHints } from "../taskManager/claimHints.js";
import { buildClaimReadiness } from "../taskManager/claimReadiness.js";
import { noProjectGraphBlockers } from "../taskManager/claimReadinessRules.js";
import { buildExecutionStatus } from "../taskManager/executionStatus.js";
import type { RuntimeContext } from "../taskManager/runtimeContext.js";
import {
  blockDependenciesCompleted,
  canClaimReviewBlock,
  canDispatchImplementationBlock,
  getBlock,
  getTask,
  requireBlockState,
  requireTaskState,
  taskDependenciesSatisfied
} from "../taskManager/selectors.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

const missingBlockStateMessage =
  "Internal runtime invariant violated: missing block state for 'T-001#B-001' after load/reconcile.";
const missingTaskStateMessage =
  "Internal runtime invariant violated: missing task state for 'T-001' after load/reconcile.";

describe("trusted task-manager access pattern", () => {
  it("returns reconciled task/block state for every manifest-order key", () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const graph = compileTaskGraph(manifest);
    const state = ensureStateForManifest(manifest, createEmptyState());

    for (const taskId of graph.taskNodesInManifestOrder) {
      const taskState = requireTaskState(state, taskId);
      expect(taskState.status).toBeDefined();
      expect(getTask(graph, taskId).id).toBe(taskId);
    }
    for (const ref of graph.blockRefsInManifestOrder) {
      const blockState = requireBlockState(state, ref);
      expect(blockState.status).toBeDefined();
      expect(getBlock(graph, ref).id).toBeDefined();
    }
  });

  it("throws a named internal invariant when guaranteed task state is missing", () => {
    const manifest = basicManifest();
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.tasks["T-001"];

    expect(() => requireTaskState(state, "T-001")).toThrow(missingTaskStateMessage);
  });

  it("throws a named internal invariant when guaranteed block state is missing", () => {
    const manifest = basicManifest();
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.blocks["T-001#B-001"];

    expect(() => requireBlockState(state, "T-001#B-001")).toThrow(missingBlockStateMessage);
  });

  it("keeps public probe semantics for unknown graph entities", () => {
    const graph = compileTaskGraph(basicManifest());

    expect(() => getTask(graph, "T-404")).toThrow("Task 'T-404' does not exist.");
    expect(() => getBlock(graph, "T-404#B-001")).toThrow("Block 'T-404#B-001' does not exist.");
  });

  it("keeps soft false for free-form claimability probes on unknown refs", () => {
    const manifest = basicManifest();
    const graph = compileTaskGraph(manifest);
    const state = ensureStateForManifest(manifest, createEmptyState());

    expect(canClaimReviewBlock(graph, state, "T-404#R-001")).toBe(false);
    expect(canDispatchImplementationBlock(graph, state, "T-404#B-001", { maxConcurrent: 2 })).toBe(
      false
    );
  });
});

describe("claim readiness/hints refuse missing guaranteed state as unready", () => {
  it("throws named internal error from readiness helpers when block state is deleted", () => {
    const manifest = basicManifest();
    const graph = compileTaskGraph(manifest);
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.blocks["T-001#B-001"];

    expect(() => blockDependenciesCompleted(graph, state, "T-001#R-001")).toThrow(
      missingBlockStateMessage
    );
    expect(() =>
      canDispatchImplementationBlock(graph, state, "T-001#B-001", { maxConcurrent: 2 })
    ).toThrow(missingBlockStateMessage);
    expect(() => buildClaimHints(graph, state, noProjectGraphBlockers, null, 2, "default")).toThrow(
      missingBlockStateMessage
    );
    expect(() =>
      buildClaimReadiness({
        graph,
        manifest,
        state
      })
    ).toThrow(missingBlockStateMessage);
  });

  it("throws named internal error when a task dependency state entry is missing", () => {
    // Edge direction: from depends on to → T-002 depends on T-001.
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
    const graph = compileTaskGraph(manifest);
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.tasks["T-001"];

    expect(() => taskDependenciesSatisfied(graph, state, "T-002")).toThrow(missingTaskStateMessage);
  });

  it("does not treat missing guaranteed block state as merely not ready", () => {
    const manifest = basicManifest();
    const graph = compileTaskGraph(manifest);
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.blocks["T-001#B-001"];

    let threw = false;
    try {
      buildClaimReadiness({ graph, manifest, state });
    } catch (error) {
      threw = true;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(missingBlockStateMessage);
      expect((error as Error).message).not.toMatch(/not ready|no_claimable|planned/i);
    }
    expect(threw).toBe(true);
  });
});

describe("execution status and projections refuse missing guaranteed state as planned", () => {
  function contextWithState(
    workspace: RuntimeContext["workspace"],
    manifest: ReturnType<typeof basicManifest>,
    state: ReturnType<typeof ensureStateForManifest>,
    rawState: ReturnType<typeof ensureStateForManifest> = state
  ): RuntimeContext {
    return {
      workspace,
      manifest,
      graph: compileTaskGraph(manifest),
      rawState,
      state
    };
  }

  it("throws named internal error from buildExecutionStatus when task state is deleted", async () => {
    const { init } = await createTestWorkspace();
    const manifest = basicManifest();
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.tasks["T-001"];

    await expect(
      buildExecutionStatus(contextWithState(init.workspace, manifest, state))
    ).rejects.toThrow(missingTaskStateMessage);
  });

  it("throws named internal error from buildExecutionStatus when block state is deleted", async () => {
    const { init } = await createTestWorkspace();
    const manifest = basicManifest();
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.blocks["T-001#B-001"];

    let threw = false;
    try {
      await buildExecutionStatus(contextWithState(init.workspace, manifest, state));
    } catch (error) {
      threw = true;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(missingBlockStateMessage);
      expect((error as Error).message).not.toMatch(/planned|empty|not ready/i);
    }
    expect(threw).toBe(true);
  });

  it("projects reconciled status without inventing planned for present records", async () => {
    const { init } = await createTestWorkspace();
    const manifest = basicManifest();
    const state = ensureStateForManifest(manifest, createEmptyState());
    const status = await buildExecutionStatus(contextWithState(init.workspace, manifest, state));

    expect(status.tasks.find((task) => task.taskId === "T-001")?.status).toBe("ready");
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
    // Optional historical fields remain null when absent.
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.lastRunId).toBeNull();
    expect(
      status.blocks.find((block) => block.ref === "T-001#B-001")?.latestReviewAttemptId
    ).toBeNull();
    expect(status.orphanState).toEqual([]);
    expect(status.orphanResults).toEqual([]);
  });

  it("reports orphan state from rawState rather than empty-array stub", async () => {
    const { init } = await createTestWorkspace();
    const manifest = basicManifest();
    const reconciled = ensureStateForManifest(manifest, createEmptyState());
    const rawState = {
      ...reconciled,
      tasks: {
        ...reconciled.tasks,
        "T-ORPHAN": { status: "ready" as const, openFeedbackCount: 0 }
      },
      blocks: {
        ...reconciled.blocks,
        "T-ORPHAN#B-001": { status: "planned" as const, lastRunId: null }
      }
    };
    const status = await buildExecutionStatus(
      contextWithState(init.workspace, manifest, reconciled, rawState)
    );

    expect(status.orphanState).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "T-ORPHAN", status: "ready" }),
        expect.objectContaining({ ref: "T-ORPHAN#B-001", status: "planned" })
      ])
    );
    // Reconciled package tasks/blocks are still projected from guaranteed state only.
    expect(status.tasks.map((task) => task.taskId)).toEqual(["T-001"]);
    expect(status.blocks.map((block) => block.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
  });

  it("throws named internal error from canvas runtime snapshot when task state is deleted", () => {
    const manifest = basicManifest();
    const graph = compileTaskGraph(manifest);
    const state = ensureStateForManifest(manifest, createEmptyState());
    delete state.tasks["T-001"];

    expect(() => runtimeSnapshotFromGraphState(graph, state)).toThrow(missingTaskStateMessage);
  });

  it("keeps graph inspection on reconciled package workspaces", async () => {
    const { root } = await createTestWorkspace();
    await expect(inspectGraph({ projectRoot: root, view: "summary" })).resolves.toMatchObject({
      view: "summary",
      counts: { taskCount: 1, blockCount: 2 }
    });
    await expect(
      inspectGraph({ projectRoot: root, view: "slice", taskId: "T-001" })
    ).resolves.toMatchObject({
      view: "slice",
      blocks: {
        items: expect.arrayContaining([
          expect.objectContaining({ ref: "T-001#B-001", status: "ready" })
        ])
      }
    });
  });
});
