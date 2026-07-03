import { access, chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTaskNode,
  createProjectFromTaskCanvas,
  createTaskCanvas,
  duplicateTaskCanvas,
  getDesktopLayout,
  getGraphViewModel,
  getProjectOverview,
  getStatistics,
  getTodoGroups,
  listTaskCanvases,
  renameTaskCanvas,
  removeTaskCanvas,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout,
  searchProject,
  selectTaskCanvas
} from "../desktop/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { readProjectPaths } from "../paths.js";
import { commitCanvasWorkspaceWrite, stageCanvasWorkspaceWrite } from "../projectGraph/canvasWorkspaceRecovery.js";
import { canonicalProjectCanvasNode, loadProjectGraph, projectGraphPath, writeProjectGraph } from "../projectGraph/index.js";
import { readState } from "../state.js";
import { claimNext, getCurrentWork, getExecutionStatus } from "../taskManager/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: vi.fn(actual.cp),
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(cp).mockImplementation((source, destination, options) => actualFs.cp(source, destination, options));
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

describe("desktop task canvas API", () => {
  it("stages canvas workspace writes before committing to the final canvas directory", async () => {
    const { init } = await createTestWorkspace();
    const finalRoot = join(init.workspace.workspaceRoot, "canvases", "staged-create");

    const staged = await stageCanvasWorkspaceWrite(init.workspace, { canvasId: "staged-create", finalRoot });
    expect(basename(staged.stagingRoot)).toMatch(/^staged-create-\d+-[a-f0-9-]+$/);
    await mkdir(join(staged.workspace.packageDir, "nodes"), { recursive: true });
    await writeJsonFile(staged.workspace.manifestFile, basicManifest());
    await writeJsonFile(staged.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });
    await commitCanvasWorkspaceWrite(init.workspace, staged);

    await expect(access(join(finalRoot, "package", "manifest.json"))).resolves.toBeUndefined();
    await expect(access(staged.stagingRoot)).rejects.toThrow();
  });

  it("uses a fallback canvas recovery directory prefix when the canvas id has no safe segment", async () => {
    const { init } = await createTestWorkspace();
    const finalRoot = join(init.workspace.workspaceRoot, "canvases", "punctuation");

    const staged = await stageCanvasWorkspaceWrite(init.workspace, { canvasId: "---", finalRoot });

    expect(basename(staged.stagingRoot)).toMatch(/^canvas-\d+-[a-f0-9-]+$/);
  });

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
    await expect(readdir(join(init.workspace.workspaceRoot, "desktop", "canvas-staging"))).resolves.toEqual([]);

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

  it("duplicates formal project graph canvases with package prompts and fresh runtime state", async () => {
    const { root, init } = await createTestWorkspace();
    const sourceWorkspace = await resolveTaskCanvasWorkspace(root, "default");
    await saveDesktopLayout(sourceWorkspace, {
      version: "desktop-layout/v1",
      projectId: "ignored",
      nodes: [{ nodeId: "T-001", x: 120, y: 80 }],
      updatedAt: new Date(0).toISOString()
    });
    await claimNext({ projectRoot: sourceWorkspace });
    await mkdir(join(sourceWorkspace.resultsDir, "manual"), { recursive: true });
    await writeFile(join(sourceWorkspace.resultsDir, "manual", "source-result.md"), "source result\n", "utf8");

    const duplicated = await duplicateTaskCanvas(root, "default");
    const duplicatedWorkspace = await resolveTaskCanvasWorkspace(root, duplicated.canvasId);
    const loaded = await loadProjectGraph(root);
    const duplicatedManifest = await readJsonFile<{ project: { title: string } }>(duplicatedWorkspace.manifestFile);

    expect(duplicated).toMatchObject({
      canvasId: duplicated.canvasId,
      name: "Test Plan copy",
      taskCount: 1
    });
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", duplicated.canvasId]);
    expect(loaded.manifest.canvases.find((canvas) => canvas.id === duplicated.canvasId)?.title).toBe("Test Plan copy");
    expect(duplicatedManifest.project.title).toBe("Test Plan copy");
    await expect(readFile(join(duplicatedWorkspace.packageDir, "nodes", "T-001", "prompt.md"), "utf8")).resolves.toBe(
      await readFile(join(sourceWorkspace.packageDir, "nodes", "T-001", "prompt.md"), "utf8")
    );
    await expect(readState(duplicatedWorkspace.stateFile)).resolves.toEqual({
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });
    await expect(readdir(duplicatedWorkspace.resultsDir)).resolves.toEqual([]);
    await expect(getDesktopLayout(duplicatedWorkspace)).resolves.toMatchObject({
      nodes: [{ nodeId: "T-001", x: 120, y: 80 }]
    });
  });

  it("copies a task canvas into a new managed project with fresh runtime state", async () => {
    const { root, init, home } = await createTestWorkspace();
    const sourceWorkspace = await resolveTaskCanvasWorkspace(root, "default");
    await saveDesktopLayout(sourceWorkspace, {
      version: "desktop-layout/v1",
      projectId: "ignored",
      nodes: [{ nodeId: "T-001", x: 120, y: 80 }],
      updatedAt: new Date(0).toISOString()
    });
    await claimNext({ projectRoot: sourceWorkspace });
    await mkdir(join(sourceWorkspace.resultsDir, "manual"), { recursive: true });
    await writeFile(join(sourceWorkspace.resultsDir, "manual", "source-result.md"), "source result\n", "utf8");

    const created = await createProjectFromTaskCanvas(root, "default");
    const copiedWorkspace = await resolveTaskCanvasWorkspace(created.rootPath, "default");
    const copiedManifest = await readJsonFile<{ project: { title: string } }>(copiedWorkspace.manifestFile);

    expect(created).toMatchObject({
      name: "Test Plan copy",
      kind: "managed",
      sourceRoot: null,
      activeCanvasId: "default"
    });
    expect(created.rootPath.startsWith(join(home, "projects"))).toBe(true);
    expect(basename(created.rootPath)).toMatch(/^test-plan-copy-[a-f0-9]{8}$/);
    expect(created.taskCanvases).toEqual([
      expect.objectContaining({
        canvasId: "default",
        name: "Test Plan copy",
        taskCount: 1
      })
    ]);
    expect(copiedManifest.project.title).toBe("Test Plan copy");
    await expect(readFile(join(copiedWorkspace.packageDir, "nodes", "T-001", "prompt.md"), "utf8")).resolves.toBe(
      await readFile(join(sourceWorkspace.packageDir, "nodes", "T-001", "prompt.md"), "utf8")
    );
    await expect(readState(copiedWorkspace.stateFile)).resolves.toEqual({
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });
    await expect(readdir(copiedWorkspace.resultsDir)).resolves.toEqual([]);
    await expect(getDesktopLayout(copiedWorkspace)).resolves.toMatchObject({
      nodes: [{ nodeId: "T-001", x: 120, y: 80 }]
    });
  });

  it("removes the new managed project if copying a task canvas to a project fails", async () => {
    const { root, home } = await createTestWorkspace();
    const projectsBefore = (await readdir(join(home, "projects"))).sort();
    vi.mocked(cp).mockImplementation(async (source, destination, options) => {
      if (String(destination).includes("test-plan-copy-")) {
        throw new Error("copy failed");
      }
      return actualFs.cp(source, destination, options);
    });

    await expect(createProjectFromTaskCanvas(root, "default")).rejects.toThrow("copy failed");

    await expect(readdir(join(home, "projects"))).resolves.toEqual(projectsBefore);
  });

  it("duplicates legacy registry canvases and records the new canvas", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));

    const duplicated = await duplicateTaskCanvas(root, "default", { name: "Legacy duplicate" });
    const duplicatedWorkspace = await resolveTaskCanvasWorkspace(root, duplicated.canvasId);
    const registry = await readJsonFile<{ canvases: Array<{ canvasId: string; name: string }> }>(join(init.workspace.workspaceRoot, "desktop", "canvases.json"));
    const duplicatedManifest = await readJsonFile<{ project: { title: string } }>(duplicatedWorkspace.manifestFile);

    expect(duplicated).toMatchObject({
      canvasId: duplicated.canvasId,
      name: "Legacy duplicate",
      taskCount: 1
    });
    expect(registry.canvases.map((canvas) => canvas.canvasId)).toEqual(["default", duplicated.canvasId]);
    expect(registry.canvases.find((canvas) => canvas.canvasId === duplicated.canvasId)?.name).toBe("Legacy duplicate");
    expect(duplicatedManifest.project.title).toBe("Legacy duplicate");
    await expect(readFile(join(duplicatedWorkspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"), "utf8")).resolves.toBe(
      await readFile(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"), "utf8")
    );
    await expect(readState(duplicatedWorkspace.stateFile)).resolves.toMatchObject({ currentRefs: [], blocks: {} });
    await expect(readdir(duplicatedWorkspace.resultsDir)).resolves.toEqual([]);
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

  it("reports task count read failures in canvas summaries", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Unreadable manifest canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writeFile(canvasWorkspace.manifestFile, "{", "utf8");

    const canvases = await listTaskCanvases(root);

    expect(canvases.find((item) => item.canvasId === canvas.canvasId)).toMatchObject({
      canvasId: canvas.canvasId,
      taskCount: 0,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "manifest_read_failed" }),
        expect.objectContaining({ code: "desktop_canvas_task_count_read_failed" })
      ])
    });
  });

  it("reports default canvas title fallback diagnostics when manifest title cannot be read", async () => {
    const { root, init } = await createTestWorkspace();
    await writeFile(init.workspace.manifestFile, "{", "utf8");

    const canvases = await listTaskCanvases(root);

    expect(canvases).toEqual([
      expect.objectContaining({
        canvasId: "default",
        name: "Test Plan",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "manifest_read_failed" }),
          expect.objectContaining({ code: "desktop_canvas_task_count_read_failed" })
        ])
      })
    ]);
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
    await rm(projectGraphPath(init.workspace));
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
    await selectTaskCanvas(root, secondCanvas.canvasId);

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

  it("does not fall back to the first formal canvas when active canvas stat fails with EACCES", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Active plan" });
    await selectTaskCanvas(root, secondCanvas.canvasId);
    const activeCanvasPath = join(init.workspace.workspaceRoot, "desktop", "active-canvas.json");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === activeCanvasPath) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(getProjectOverview(root)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not report a legacy canvas registry I/O failure as no active canvas", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const registryPath = join(init.workspace.workspaceRoot, "desktop", "canvases.json");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === registryPath) {
        throw nodeIoError("EIO");
      }
      return actualFs.stat(path, options);
    });

    await expect(getProjectOverview(root)).rejects.toMatchObject({ code: "EIO" });
  });

  it("updates formal project graph canvases instead of the legacy registry", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Test Plan" })],
      edges: [],
      crossTaskEdges: []
    });

    const created = await createTaskCanvas(root, { name: "Formal canvas" });
    let loaded = await loadProjectGraph(root);
    expect(loaded.source).toBe("project_graph");
    expect(loaded.manifest.canvases).toEqual([
      expect.objectContaining({ id: "default" }),
      expect.objectContaining({
        id: created.canvasId,
        title: "Formal canvas",
        packageDir: `canvases/${created.canvasId}/package`,
        stateFile: `canvases/${created.canvasId}/state.json`,
        resultsDir: `canvases/${created.canvasId}/results`
      })
    ]);
    await expect(resolveTaskCanvasWorkspace(root, created.canvasId)).resolves.toMatchObject({
      packageDir: join(init.workspace.workspaceRoot, "canvases", created.canvasId, "package")
    });

    await writeProjectGraph(init.workspace, {
      ...loaded.manifest,
      edges: [{ from: "default", to: created.canvasId, type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: created.canvasId, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    await expect(removeTaskCanvas(root, created.canvasId)).rejects.toThrow("referenced by project graph dependencies");
    loaded = await loadProjectGraph(root);
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", created.canvasId]);
    expect(loaded.manifest.edges).toHaveLength(1);
    expect(loaded.manifest.crossTaskEdges).toHaveLength(1);

    await writeProjectGraph(init.workspace, {
      ...loaded.manifest,
      edges: [],
      crossTaskEdges: []
    });

    const remaining = await removeTaskCanvas(root, created.canvasId);
    loaded = await loadProjectGraph(root);
    const quarantineEntries = await readdir(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"));

    expect(remaining.map((canvas) => canvas.canvasId)).toEqual(["default"]);
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default"]);
    expect(loaded.manifest.edges).toEqual([]);
    expect(loaded.manifest.crossTaskEdges).toEqual([]);
    await expect(access(join(init.workspace.workspaceRoot, "canvases", created.canvasId))).rejects.toThrow();
    expect(quarantineEntries).toHaveLength(1);
    await expect(access(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine", quarantineEntries[0], "package", "manifest.json"))).resolves.toBeUndefined();
  });

  it("resets formal default canvases by clearing stale package files without removing the canvas", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Root plan" })],
      edges: [],
      crossTaskEdges: []
    });
    const secondCanvas = await createTaskCanvas(root, { name: "Second plan" });
    const defaultWorkspace = await resolveTaskCanvasWorkspace(root, "default");
    const staleNodePrompt = join(defaultWorkspace.packageDir, "nodes", "T-STALE", "prompt.md");
    const staleBlockPrompt = join(defaultWorkspace.packageDir, "nodes", "T-STALE", "blocks", "B-STALE.prompt.md");
    await mkdir(join(defaultWorkspace.packageDir, "nodes", "T-STALE", "blocks"), { recursive: true });
    await writeFile(staleNodePrompt, "# Stale task prompt\n", "utf8");
    await writeFile(staleBlockPrompt, "# Stale block prompt\n", "utf8");

    const remaining = await removeTaskCanvas(root, "default");
    const loaded = await loadProjectGraph(root);
    const resetManifest = await readJsonFile<{ project: { title: string }; nodes: unknown[] }>(defaultWorkspace.manifestFile);

    expect(remaining.map((canvas) => canvas.canvasId)).toEqual(["default", secondCanvas.canvasId]);
    expect(remaining.find((canvas) => canvas.canvasId === "default")).toMatchObject({
      name: "Root plan",
      taskCount: 0,
      diagnostics: []
    });
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", secondCanvas.canvasId]);
    expect(resetManifest.project.title).toBe("Root plan");
    expect(resetManifest.nodes).toEqual([]);
    await expect(access(staleNodePrompt)).rejects.toThrow();
    await expect(access(staleBlockPrompt)).rejects.toThrow();
  });

  it("renames formal project graph canvases and their package manifest titles", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Root plan" })],
      edges: [],
      crossTaskEdges: []
    });
    const created = await createTaskCanvas(root, { name: "Original formal canvas" });

    const renamed = await renameTaskCanvas(root, created.canvasId, " Renamed formal canvas ");
    const loaded = await loadProjectGraph(root);
    const workspace = await resolveTaskCanvasWorkspace(root, created.canvasId);
    const manifest = await readJsonFile<{ project: { title: string } }>(workspace.manifestFile);

    expect(renamed).toMatchObject({ canvasId: created.canvasId, name: "Renamed formal canvas" });
    expect(loaded.manifest.canvases.find((canvas) => canvas.id === created.canvasId)?.title).toBe("Renamed formal canvas");
    expect(manifest.project.title).toBe("Renamed formal canvas");
  });

  it("renames legacy registry canvases and their package manifest titles", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const created = await createTaskCanvas(root, { name: "Original legacy canvas" });

    const renamed = await renameTaskCanvas(root, created.canvasId, "Renamed legacy canvas");
    const registry = await readJsonFile<{ canvases: Array<{ canvasId: string; name: string }> }>(join(init.workspace.workspaceRoot, "desktop", "canvases.json"));
    const workspace = await resolveTaskCanvasWorkspace(root, created.canvasId);
    const manifest = await readJsonFile<{ project: { title: string } }>(workspace.manifestFile);

    expect(renamed).toMatchObject({ canvasId: created.canvasId, name: "Renamed legacy canvas" });
    expect(registry.canvases.find((canvas) => canvas.canvasId === created.canvasId)?.name).toBe("Renamed legacy canvas");
    expect(manifest.project.title).toBe("Renamed legacy canvas");
  });

  it("rejects empty task canvas names", async () => {
    const { root } = await createTestWorkspace();

    await expect(renameTaskCanvas(root, "default", "   ")).rejects.toThrow("Task canvas name is required.");
  });

  it("restores formal canvas workspace on write failure", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Root plan" })],
      edges: [],
      crossTaskEdges: []
    });
    const created = await createTaskCanvas(root, { name: "Rollback" });
    const canvasRoot = join(init.workspace.workspaceRoot, "canvases", created.canvasId);
    await mkdir(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"), { recursive: true });

    try {
      await chmod(init.workspace.workspaceRoot, 0o555);
      await expect(removeTaskCanvas(root, created.canvasId)).rejects.toThrow();
    } finally {
      await chmod(init.workspace.workspaceRoot, 0o755);
    }

    const loaded = await loadProjectGraph(root);
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", created.canvasId]);
    await expect(access(join(canvasRoot, "package", "manifest.json"))).resolves.toBeUndefined();
    await expect(readdir(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"))).resolves.toEqual([]);
  });

  it("quarantines legacy canvas workspaces when removing non-default canvases", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const created = await createTaskCanvas(root, { name: "Legacy removable" });
    const canvasRoot = join(init.workspace.workspaceRoot, "canvases", created.canvasId);

    const remaining = await removeTaskCanvas(root, created.canvasId);
    const quarantineEntries = await readdir(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"));
    const registry = await readJsonFile<Record<string, unknown>>(join(init.workspace.workspaceRoot, "desktop", "canvases.json"));

    expect(remaining.map((canvas) => canvas.canvasId)).toEqual(["default"]);
    expect(registry).toMatchObject({ canvases: [expect.objectContaining({ canvasId: "default" })] });
    await expect(access(canvasRoot)).rejects.toThrow();
    expect(quarantineEntries).toHaveLength(1);
    await expect(access(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine", quarantineEntries[0], "package", "manifest.json"))).resolves.toBeUndefined();
  });

  it("resets legacy default canvases by clearing stale package files without removing the canvas", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const defaultWorkspace = await resolveTaskCanvasWorkspace(root, "default");
    const staleNodePrompt = join(defaultWorkspace.packageDir, "nodes", "T-STALE", "prompt.md");
    await mkdir(join(defaultWorkspace.packageDir, "nodes", "T-STALE"), { recursive: true });
    await writeFile(staleNodePrompt, "# Stale task prompt\n", "utf8");

    const remaining = await removeTaskCanvas(root, "default");
    const registry = await readJsonFile<{ canvases: Array<{ canvasId: string }> }>(join(init.workspace.workspaceRoot, "desktop", "canvases.json"));
    const resetManifest = await readJsonFile<{ nodes: unknown[] }>(defaultWorkspace.manifestFile);

    expect(remaining.map((canvas) => canvas.canvasId)).toEqual(["default"]);
    expect(remaining[0]).toMatchObject({
      name: "Test Plan",
      taskCount: 0,
      diagnostics: []
    });
    expect(registry.canvases.map((canvas) => canvas.canvasId)).toEqual(["default"]);
    expect(resetManifest.nodes).toEqual([]);
    await expect(access(staleNodePrompt)).rejects.toThrow();
  });

  it("restores legacy canvas workspace on write failure", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const created = await createTaskCanvas(root, { name: "Rollback" });
    const canvasRoot = join(init.workspace.workspaceRoot, "canvases", created.canvasId);
    const desktopRoot = join(init.workspace.workspaceRoot, "desktop");
    await mkdir(join(desktopRoot, "canvas-quarantine"), { recursive: true });

    try {
      await chmod(desktopRoot, 0o555);
      await expect(removeTaskCanvas(root, created.canvasId)).rejects.toThrow();
    } finally {
      await chmod(desktopRoot, 0o755);
    }

    const registry = await readJsonFile<{ canvases: Array<{ canvasId: string }> }>(join(desktopRoot, "canvases.json"));
    expect(registry.canvases.map((canvas) => canvas.canvasId)).toEqual(["default", created.canvasId]);
    await expect(access(join(canvasRoot, "package", "manifest.json"))).resolves.toBeUndefined();
    await expect(readdir(join(desktopRoot, "canvas-quarantine"))).resolves.toEqual([]);
  });

  it("rejects resetting a formal root canvas while project graph dependencies reference it", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Root plan" }),
        {
          ...canonicalProjectCanvasNode({ id: "downstream", title: "Downstream plan" })
        }
      ],
      edges: [{ from: "downstream", to: "default", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: "downstream", taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    await expect(removeTaskCanvas(root, "default")).rejects.toThrow("referenced by project graph dependencies");

    const loaded = await loadProjectGraph(root);
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", "downstream"]);
    expect(loaded.manifest.edges).toHaveLength(1);
    expect(loaded.manifest.crossTaskEdges).toHaveLength(1);
  });
});
