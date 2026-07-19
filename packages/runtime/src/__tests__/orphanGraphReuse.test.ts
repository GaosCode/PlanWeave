import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as taskGraphCompiler from "../graph/compileTaskGraph.js";
import * as orphans from "../package/orphans.js";
import {
  findOrphanResultsFromGraph,
  findOrphanStateFromGraph,
  identitySetsFromGraph
} from "../package/orphans.js";
import { createEmptyState } from "../state.js";
import { noProjectGraphBlockers } from "../taskManager/claimReadinessRules.js";
import { buildExecutionStatus } from "../taskManager/executionStatus.js";
import { validateCanvasPackageForDoctor } from "../taskManager/projectDoctorCanvas.js";
import { loadRuntimeReadonly } from "../taskManager/runtimeContext.js";
import { validatePackage } from "../validatePackage.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
});

describe("orphan helpers reuse compiled graphs", () => {
  it("projects identity and orphans from graph without calling compileTaskGraph", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const graph = taskGraphCompiler.compileTaskGraph(manifest);
    const compileSpy = vi.spyOn(taskGraphCompiler, "compileTaskGraph");
    const { init } = await createTestWorkspace(manifest);
    await mkdir(join(init.workspace.resultsDir, "T-ORPHAN"), { recursive: true });
    const rawState = createEmptyState();
    rawState.tasks["T-ORPHAN"] = {
      status: "planned",
      openFeedbackCount: 0
    };

    compileSpy.mockClear();
    const identity = identitySetsFromGraph(graph);
    const orphanState = findOrphanStateFromGraph(graph, rawState);
    const orphanResults = await findOrphanResultsFromGraph(init.workspace, graph);

    expect(compileSpy).not.toHaveBeenCalled();
    expect(identity.taskIds.has("T-001")).toBe(true);
    expect(orphanState).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "T-ORPHAN" })])
    );
    expect(orphanResults).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "T-ORPHAN" })])
    );
  });

  it("uses FromGraph orphan helpers in validatePackage (no FromManifest recompile path)", async () => {
    const { root } = await createTestWorkspace();
    const fromGraphState = vi.spyOn(orphans, "findOrphanStateFromGraph");
    const fromGraphResults = vi.spyOn(orphans, "findOrphanResultsFromGraph");
    const fromManifestState = vi.spyOn(orphans, "findOrphanStateFromManifest");
    const fromManifestResults = vi.spyOn(orphans, "findOrphanResultsFromManifest");

    const result = await validatePackage({ projectRoot: root });

    expect(result.ok).toBe(true);
    expect(fromGraphState).toHaveBeenCalledTimes(1);
    expect(fromGraphResults).toHaveBeenCalledTimes(1);
    expect(fromManifestState).not.toHaveBeenCalled();
    expect(fromManifestResults).not.toHaveBeenCalled();
  });

  it("uses FromGraph orphan helpers in project-doctor canvas validation", async () => {
    const { init } = await createTestWorkspace();
    const fromGraphState = vi.spyOn(orphans, "findOrphanStateFromGraph");
    const fromManifestState = vi.spyOn(orphans, "findOrphanStateFromManifest");

    const diagnostics = await validateCanvasPackageForDoctor({
      canvasId: "default",
      workspace: init.workspace
    });

    expect(diagnostics.errors).toEqual([]);
    expect(fromGraphState).toHaveBeenCalledTimes(1);
    expect(fromManifestState).not.toHaveBeenCalled();
  });

  it("does not recompile when building execution status from an existing runtime context", async () => {
    const { root } = await createTestWorkspace();
    const context = await loadRuntimeReadonly({ projectRoot: root });
    const compileSpy = vi.spyOn(taskGraphCompiler, "compileTaskGraph");
    const fromGraphState = vi.spyOn(orphans, "findOrphanStateFromGraph");
    const fromGraphResults = vi.spyOn(orphans, "findOrphanResultsFromGraph");
    const fromManifestState = vi.spyOn(orphans, "findOrphanStateFromManifest");
    const fromManifestResults = vi.spyOn(orphans, "findOrphanResultsFromManifest");

    compileSpy.mockClear();
    await buildExecutionStatus(context, { claimGuard: noProjectGraphBlockers });

    // Orphan projection and status assembly must not recompile; claimGuard is injected
    // so project-graph aggregation work is out of scope for this assertion.
    expect(compileSpy).not.toHaveBeenCalled();
    expect(fromGraphState).toHaveBeenCalledTimes(1);
    expect(fromGraphResults).toHaveBeenCalledTimes(1);
    expect(fromManifestState).not.toHaveBeenCalled();
    expect(fromManifestResults).not.toHaveBeenCalled();
  });
});
