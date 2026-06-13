import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addTaskNode,
  createTaskCanvas,
  getDesktopLayout,
  getGraphViewModel,
  getProjectOverview,
  getStatistics,
  getTodoGroups,
  listTaskCanvases,
  removeTaskCanvas,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout,
  searchProject
} from "../desktop/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { readProjectPaths } from "../paths.js";
import { writeProjectGraph } from "../projectGraph/index.js";
import { claimNext, getCurrentWork, getExecutionStatus } from "../taskManager/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

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
        blockTypes: ["implementation", "review"],
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
      blockTotal: 4,
      estimatedRemainingBlocks: 4
    });
  });

  it("summarizes canvas package health diagnostics", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Broken canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writeJsonFile(canvasWorkspace.manifestFile, basicManifest());

    const canvases = await listTaskCanvases(root);

    expect(canvases.find((item) => item.canvasId === canvas.canvasId)).toMatchObject({
      canvasId: canvas.canvasId,
      taskCount: 1,
      missingPromptCount: 3,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "prompt_missing" })])
    });
  });

  it("keeps raw task counts visible when a canvas contains removed plan structures", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Imported legacy plan" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    const manifest = basicManifest() as unknown as { nodes: Array<Record<string, unknown> & { blocks?: Array<Record<string, unknown>> }> };
    manifest.nodes.unshift({ id: "G-001", type: "goal", title: "Removed goal" });
    manifest.nodes[1].blocks?.splice(1, 0, {
      id: "C-001",
      type: "check",
      title: "Removed check block",
      prompt: "nodes/T-001/blocks/C-001.prompt.md",
      depends_on: ["B-001"]
    });
    await writeJsonFile(canvasWorkspace.manifestFile, manifest);

    const canvases = await listTaskCanvases(root);

    expect(canvases.find((item) => item.canvasId === canvas.canvasId)).toMatchObject({
      canvasId: canvas.canvasId,
      taskCount: 1,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "manifest_schema" })])
    });
  });

  it("loads legacy canvas registry records with id and inferred state paths", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = basicManifest();
    const legacyPackageDir = join(init.workspace.workspaceRoot, "canvases", "legacy-import", "package");
    await writeJsonFile(join(legacyPackageDir, "manifest.json"), manifest);
    await writePromptFiles(legacyPackageDir, manifest);
    await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), {
      version: "desktop-canvases/v1",
      canvases: [
        {
          id: "legacy-import",
          name: "Legacy imported canvas",
          packageDir: "canvases/legacy-import/package",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z"
        }
      ]
    });

    const canvases = await listTaskCanvases(root);
    const workspace = await resolveTaskCanvasWorkspace(root, "legacy-import");

    expect(canvases).toEqual([
      expect.objectContaining({
        canvasId: "legacy-import",
        name: "Legacy imported canvas",
        taskCount: 1
      })
    ]);
    expect(workspace.stateFile).toBe(join(init.workspace.workspaceRoot, "canvases", "legacy-import", "state.json"));
    expect(workspace.resultsDir).toBe(join(init.workspace.workspaceRoot, "canvases", "legacy-import", "results"));
  });

  it("uses the active canvas for CLI-style package resolution", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Active plan" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    await addTaskNode(secondWorkspace, {
      title: "Active canvas work",
      promptMarkdown: "# Active canvas prompt\n",
      acceptance: ["Active canvas work is claimed through the CLI root."],
      blockTypes: ["implementation"],
      executor: "manual"
    });
    const registryPath = join(init.workspace.workspaceRoot, "desktop", "canvases.json");
    const registry = await readJsonFile<Record<string, unknown>>(registryPath);
    await writeJsonFile(registryPath, { ...registry, activeCanvasId: secondCanvas.canvasId });

    const activeWorkspace = await resolveTaskCanvasWorkspace(root);
    const overview = await getProjectOverview(root);
    const paths = await readProjectPaths(root);
    const status = await getExecutionStatus({ projectRoot: root });
    const claim = await claimNext({ projectRoot: root });
    const current = await getCurrentWork({ projectRoot: root });

    expect(activeWorkspace.packageDir).toBe(secondWorkspace.packageDir);
    expect(overview.activeCanvasId).toBe(secondCanvas.canvasId);
    expect(paths.projectDir).toBe(init.workspace.workspaceRoot);
    expect(paths.packageDir).toBe(secondWorkspace.packageDir);
    expect(paths.statePath).toBe(secondWorkspace.stateFile);
    expect(paths.resultsDir).toBe(secondWorkspace.resultsDir);
    expect(status.nextClaimable).toEqual(["T-ACTIVE-CANVAS-WORK#B-001"]);
    expect(claim).toMatchObject({ kind: "block", ref: "T-ACTIVE-CANVAS-WORK#B-001" });
    expect(current.owner).toMatchObject({ canvasId: secondCanvas.canvasId, taskIds: ["T-ACTIVE-CANVAS-WORK"] });
  });

  it("rejects registry canvas edits when a formal project graph is present", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "default",
          type: "canvas",
          title: "Test Plan",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    await expect(createTaskCanvas(root, { name: "Hidden canvas" })).rejects.toThrow("project-graph.json");
    await expect(removeTaskCanvas(root, "default")).rejects.toThrow("project-graph.json");
  });
});
