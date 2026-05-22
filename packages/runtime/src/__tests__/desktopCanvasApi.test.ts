import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addTaskNode,
  createTaskCanvas,
  getDesktopLayout,
  getGraphViewModel,
  getStatistics,
  getTodoGroups,
  listTaskCanvases,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout,
  searchProject
} from "../desktop/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop task canvas API", () => {
  it("keeps canvas workspaces independent while project views aggregate across canvases", async () => {
    const { root, init } = await createTestWorkspace();

    const initialCanvases = await listTaskCanvases(root);
    expect(initialCanvases).toHaveLength(1);
    expect(initialCanvases[0]).toMatchObject({
      canvasId: "default",
      name: "Test Plan",
      taskCount: 1
    });

    const defaultWorkspace = await resolveTaskCanvasWorkspace(root, "default");
    expect(defaultWorkspace.packageDir).toBe(init.workspace.packageDir);
    expect(defaultWorkspace.stateFile).toBe(init.workspace.stateFile);
    expect(defaultWorkspace.resultsDir).toBe(init.workspace.resultsDir);

    const secondCanvas = await createTaskCanvas(root, { name: "Second plan" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    expect(secondWorkspace.packageDir).toBe(join(init.workspace.workspaceRoot, "canvases", secondCanvas.canvasId, "package"));
    expect(secondWorkspace.stateFile).toBe(join(init.workspace.workspaceRoot, "canvases", secondCanvas.canvasId, "state.json"));
    expect(secondWorkspace.resultsDir).toBe(join(init.workspace.workspaceRoot, "canvases", secondCanvas.canvasId, "results"));
    await expect(access(secondWorkspace.manifestFile)).resolves.toBeUndefined();
    await expect(access(secondWorkspace.stateFile)).resolves.toBeUndefined();

    await expect(
      addTaskNode(secondWorkspace, {
        title: "Canvas two work",
        promptMarkdown: "# Canvas two prompt\n\nUnique canvas two prompt.",
        acceptance: ["Canvas two work is represented independently."],
        blockTypes: ["implementation", "check", "review"],
        executor: "manual"
      })
    ).resolves.toMatchObject({ ok: true });

    const defaultGraph = await getGraphViewModel(defaultWorkspace);
    const secondGraph = await getGraphViewModel(secondWorkspace);
    expect(defaultGraph.tasks.map((task) => task.title)).toEqual(["Implement test task"]);
    expect(secondGraph.tasks.map((task) => task.title)).toEqual(["Canvas two work"]);

    await saveDesktopLayout(defaultWorkspace, {
      version: "desktop-layout/v1",
      projectId: "ignored",
      nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
      updatedAt: new Date(0).toISOString()
    });
    await saveDesktopLayout(secondWorkspace, {
      version: "desktop-layout/v1",
      projectId: "ignored",
      nodes: [{ nodeId: "T-CANVAS-TWO-WORK", x: 30, y: 40 }],
      updatedAt: new Date(0).toISOString()
    });
    expect((await getDesktopLayout(defaultWorkspace)).nodes).toEqual([{ nodeId: "T-001", x: 10, y: 20 }]);
    expect((await getDesktopLayout(secondWorkspace)).nodes).toEqual([{ nodeId: "T-CANVAS-TWO-WORK", x: 30, y: 40 }]);

    const aggregatedCanvases = await listTaskCanvases(root);
    expect(aggregatedCanvases.map((canvas) => ({ canvasId: canvas.canvasId, name: canvas.name, taskCount: canvas.taskCount }))).toEqual([
      { canvasId: "default", name: "Test Plan", taskCount: 1 },
      { canvasId: secondCanvas.canvasId, name: "Second plan", taskCount: 1 }
    ]);

    const todo = await getTodoGroups(root);
    expect(todo.ready).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canvasId: "default", canvasName: "Test Plan", ref: "T-001#B-001" }),
        expect.objectContaining({ canvasId: secondCanvas.canvasId, canvasName: "Second plan", ref: "T-CANVAS-TWO-WORK#B-001" })
      ])
    );

    const searchResults = await searchProject(root, "Unique canvas two prompt", { kinds: ["prompt"] });
    expect(searchResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canvasId: secondCanvas.canvasId,
          canvasName: "Second plan",
          ref: "T-CANVAS-TWO-WORK"
        })
      ])
    );
    expect(new Set(searchResults.map((result) => result.canvasId))).toEqual(new Set([secondCanvas.canvasId]));
    await expect(getStatistics(root)).resolves.toMatchObject({
      taskTotal: 2,
      blockTotal: 6,
      estimatedRemainingBlocks: 6
    });
  });
});
