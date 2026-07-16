import { access, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CanvasMapLayoutError,
  createTaskCanvas,
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  parseCanvasMapLayoutFile,
  reconcileCanvasMapLayoutWithProject,
  resetCanvasMapLayout,
  resolveTaskCanvasWorkspace,
  saveCanvasMapLayout
} from "../desktop/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(realpath).mockImplementation((path, options) => actualFs.realpath(path, options));
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

describe("desktop canvas graph API", () => {
  it("projects project-graph.json into a desktop canvas map view model", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Desktop plan" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest({ parallel: true, maxConcurrent: 3 });
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" }),
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Desktop plan",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        }
      ],
      edges: [{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: secondCanvas.canvasId, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.projectId).toBe(init.workspace.id);
    expect(graph.canvases.map((canvas) => canvas.canvasId)).toEqual([
      "default",
      secondCanvas.canvasId
    ]);
    expect(
      graph.canvases.map((canvas) => ({
        canvasId: canvas.canvasId,
        packageDir: canvas.packageDir,
        executionPolicy: canvas.executionPolicy
      }))
    ).toEqual([
      {
        canvasId: "default",
        packageDir: "canvases/default/package",
        executionPolicy: { parallelEnabled: false, maxConcurrent: 1 }
      },
      {
        canvasId: secondCanvas.canvasId,
        packageDir: `canvases/${secondCanvas.canvasId}/package`,
        executionPolicy: { parallelEnabled: true, maxConcurrent: 3 }
      }
    ]);
    expect(graph.edges).toEqual([
      { from: secondCanvas.canvasId, to: "default", type: "depends_on" }
    ]);
    expect(graph.crossTaskEdges).toEqual([
      {
        from: { canvasId: secondCanvas.canvasId, taskId: "T-001" },
        to: { canvasId: "default", taskId: "T-001" },
        type: "depends_on"
      }
    ]);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.health.severity).toBe("warning");
    expect(graph.health.blockedBlocks).toEqual([
      expect.objectContaining({
        blocked: expect.objectContaining({
          canvasId: secondCanvas.canvasId,
          taskId: "T-001",
          blockRef: "T-001#B-001",
          blockTitle: "Implement task"
        }),
        blockers: [
          expect.objectContaining({ kind: "canvas", canvasId: "default" }),
          expect.objectContaining({ kind: "task", canvasId: "default", taskId: "T-001" })
        ]
      })
    ]);
    expect(
      graph.health.canvases.find((canvas) => canvas.canvasId === secondCanvas.canvasId)
    ).toMatchObject({
      severity: "warning",
      blockerCount: 1
    });
    expect(
      graph.health.edges.find(
        (edge) => edge.from === secondCanvas.canvasId && edge.to === "default"
      )
    ).toMatchObject({
      severity: "warning",
      blockerCount: 1
    });
  });

  it("keeps health ok when a formal canvas graph has no blockers or diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" })],
      edges: [],
      crossTaskEdges: []
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.health).toEqual({
      severity: "ok",
      canvases: [{ canvasId: "default", severity: "ok", blockerCount: 0, diagnosticCount: 0 }],
      edges: [],
      blockedBlocks: [],
      diagnostics: []
    });
  });

  it("projects removed package fields as strict manifest errors", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    const block =
      task?.type === "task" ? task.blocks.find((item) => item.type === "implementation") : null;
    if (!block || block.type !== "implementation") {
      throw new Error("Expected an implementation block fixture.");
    }
    const { root, init } = await createTestWorkspace(manifest);
    block.parallel = { safe: false } as never;
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const graph = await getCanvasGraphViewModel(root);
    const canvas = graph.canvases.find((item) => item.canvasId === "default");
    const health = graph.health.canvases.find((item) => item.canvasId === "default");

    expect(canvas?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "manifest_schema",
        message: 'Unrecognized key: "safe"',
        severity: "error"
      })
    );
    expect(health?.severity).toBe("error");
    expect(health?.diagnosticCount).toBeGreaterThan(0);
  });

  it("refreshes the cached canvas graph when project graph changes externally", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Externally added canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" })],
      edges: [],
      crossTaskEdges: []
    });

    await expect(getCanvasGraphViewModel(root)).resolves.toMatchObject({
      canvases: [expect.objectContaining({ canvasId: "default" })]
    });

    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" }),
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Externally added canvas",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        }
      ],
      edges: [{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }],
      crossTaskEdges: []
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.canvases.map((canvas) => canvas.canvasId)).toEqual([
      "default",
      secondCanvas.canvasId
    ]);
    expect(graph.edges).toEqual([
      { from: secondCanvas.canvasId, to: "default", type: "depends_on" }
    ]);
  });

  it("surfaces broken project graph diagnostics in canvas health", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" })],
      edges: [{ from: "default", to: "missing-canvas", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: "default", taskId: "T-001" },
          to: { canvasId: "missing-canvas", taskId: "T-999" },
          type: "depends_on"
        }
      ]
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.health.severity).toBe("error");
    expect(graph.health.diagnostics).toEqual([
      expect.objectContaining({ code: "project_canvas_edge_to_missing" }),
      expect.objectContaining({ code: "project_cross_task_to_canvas_missing" })
    ]);
  });

  it("persists canvas map layout under desktop-owned state", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second canvas" });

    const initial = await getCanvasMapLayout(root);
    expect(initial.projectId).toBe(init.workspace.id);
    expect(initial.nodes.map((node) => node.canvasId)).toEqual(["default", secondCanvas.canvasId]);

    const saved = await saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [
        { canvasId: secondCanvas.canvasId, x: 500, y: 300 },
        { canvasId: "stale", x: 1, y: 1 }
      ],
      updatedAt: new Date(0).toISOString()
    });

    expect(saved.projectId).toBe(init.workspace.id);
    expect(saved.nodes).toEqual([
      { canvasId: secondCanvas.canvasId, x: 500, y: 300 },
      { canvasId: "default", x: 80, y: 80 }
    ]);
    await expect(getCanvasMapLayout(root)).resolves.toMatchObject({
      nodes: [
        { canvasId: secondCanvas.canvasId, x: 500, y: 300 },
        expect.objectContaining({ canvasId: "default", x: 80, y: 80 })
      ]
    });

    const reset = await resetCanvasMapLayout(root);
    expect(reset.nodes.map((node) => node.canvasId)).toEqual(["default", secondCanvas.canvasId]);
  });

  it("returns a default canvas map layout when the layout file is missing without creating it", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");

    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });
    const layout = await getCanvasMapLayout(root);
    expect(layout).toMatchObject({
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 80, y: 80 }]
    });
    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips a valid canvas map layout file without changing coordinates", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second canvas" });
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    const written = {
      version: "desktop-canvas-map-layout/v1" as const,
      projectId: init.workspace.id,
      nodes: [
        { canvasId: "default", x: 12.5, y: 34.25 },
        { canvasId: secondCanvas.canvasId, x: -10, y: 999 }
      ],
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    await writeJsonFile(layoutPath, written);

    await expect(getCanvasMapLayout(root)).resolves.toEqual(written);
    const raw = await readFile(layoutPath, "utf8");
    expect(JSON.parse(raw)).toEqual(written);
  });

  it("rejects invalid JSON and leaves the corrupt layout file untouched", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    const corrupt = "{ not-json";
    await mkdir(dirname(layoutPath), { recursive: true });
    await writeFile(layoutPath, corrupt, "utf8");

    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({
      name: "CanvasMapLayoutError",
      code: "canvas_map_layout_json",
      path: layoutPath
    });
    await expect(readFile(layoutPath, "utf8")).resolves.toBe(corrupt);
  });

  it("rejects wrong version, wrong projectId, duplicate canvas IDs, and non-finite coordinates", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");

    await writeJsonFile(layoutPath, {
      version: "desktop-canvas-map-layout/v0",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 1, y: 2 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    await expect(getCanvasMapLayout(root)).rejects.toBeInstanceOf(CanvasMapLayoutError);
    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({
      code: "canvas_map_layout_invalid",
      path: layoutPath
    });

    await writeJsonFile(layoutPath, {
      version: "desktop-canvas-map-layout/v1",
      projectId: "other-project",
      nodes: [{ canvasId: "default", x: 1, y: 2 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({
      code: "canvas_map_layout_project_mismatch",
      path: layoutPath
    });

    await writeJsonFile(layoutPath, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [
        { canvasId: "default", x: 1, y: 2 },
        { canvasId: "default", x: 3, y: 4 }
      ],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({
      code: "canvas_map_layout_invalid",
      path: layoutPath
    });

    await writeJsonFile(layoutPath, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: Number.NaN, y: 2 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({
      code: "canvas_map_layout_invalid",
      path: layoutPath
    });

    await writeJsonFile(layoutPath, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 1, y: Number.POSITIVE_INFINITY }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({
      code: "canvas_map_layout_invalid",
      path: layoutPath
    });
  });

  it("reconciles unknown, deleted, and newly added canvas IDs without rewriting disk on read", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second canvas" });
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    const onDisk = {
      version: "desktop-canvas-map-layout/v1" as const,
      projectId: init.workspace.id,
      nodes: [
        { canvasId: "default", x: 11, y: 22 },
        { canvasId: "removed-canvas", x: 1, y: 1 }
      ],
      updatedAt: "2026-07-02T00:00:00.000Z"
    };
    await writeJsonFile(layoutPath, onDisk);

    const layout = await getCanvasMapLayout(root);
    expect(layout.nodes).toEqual([
      { canvasId: "default", x: 11, y: 22 },
      { canvasId: secondCanvas.canvasId, x: 460, y: 80 }
    ]);
    await expect(readFile(layoutPath, "utf8")).resolves.toBe(`${JSON.stringify(onDisk, null, 2)}\n`);
  });

  it("rejects save input with non-finite coordinates, project mismatch, or non-ISO updatedAt without writing", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      saveCanvasMapLayout(root, {
        version: "desktop-canvas-map-layout/v1",
        projectId: init.workspace.id,
        nodes: [{ canvasId: "default", x: Number.NaN, y: 1 }],
        updatedAt: new Date(0).toISOString()
      })
    ).rejects.toMatchObject({
      code: "canvas_map_layout_invalid"
    });
    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      saveCanvasMapLayout(root, {
        version: "desktop-canvas-map-layout/v1",
        projectId: "wrong-project",
        nodes: [{ canvasId: "default", x: 42, y: 24 }],
        updatedAt: new Date(0).toISOString()
      })
    ).rejects.toMatchObject({
      code: "canvas_map_layout_project_mismatch"
    });
    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      saveCanvasMapLayout(root, {
        version: "desktop-canvas-map-layout/v1",
        projectId: init.workspace.id,
        nodes: [{ canvasId: "default", x: 42, y: 24 }],
        updatedAt: "not-an-iso-datetime"
      })
    ).rejects.toMatchObject({
      code: "canvas_map_layout_invalid"
    });
    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });

    const saved = await saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 42, y: 24 }],
      updatedAt: new Date(0).toISOString()
    });
    expect(saved.projectId).toBe(init.workspace.id);
    expect(saved.nodes).toEqual([{ canvasId: "default", x: 42, y: 24 }]);
    expect(saved.updatedAt).not.toBe(new Date(0).toISOString());
  });

  it("does not delete the layout file when reset fails before destructive work", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    const onDisk = {
      version: "desktop-canvas-map-layout/v1" as const,
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 111, y: 222 }],
      updatedAt: "2026-07-05T00:00:00.000Z"
    };
    await writeJsonFile(layoutPath, onDisk);

    const projection = await import("../desktop/graph/projectProjectionModel.js");
    const spy = vi
      .spyOn(projection, "readDesktopProjectProjection")
      .mockRejectedValueOnce(new Error("projection unavailable"));

    await expect(resetCanvasMapLayout(root)).rejects.toThrow("projection unavailable");
    await expect(readFile(layoutPath, "utf8")).resolves.toBe(`${JSON.stringify(onDisk, null, 2)}\n`);
    spy.mockRestore();
  });

  it("serializes concurrent saves so the last mutation wins on disk", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");

    const first = saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 10, y: 10 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const second = saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 20, y: 20 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });

    const [firstSaved, secondSaved] = await Promise.all([first, second]);
    expect(firstSaved.nodes).toEqual([{ canvasId: "default", x: 10, y: 10 }]);
    expect(secondSaved.nodes).toEqual([{ canvasId: "default", x: 20, y: 20 }]);

    const raw = JSON.parse(await readFile(layoutPath, "utf8")) as {
      nodes: Array<{ canvasId: string; x: number; y: number }>;
    };
    expect(raw.nodes).toEqual([{ canvasId: "default", x: 20, y: 20 }]);
  });

  it("uses one FIFO for symlink aliases and preserves API invocation order", async () => {
    const { home, root, init } = await createTestWorkspace();
    const alias = join(home, "project-root-alias");
    await symlink(root, alias, "dir");
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    let releaseFirstResolve!: () => void;
    const firstResolveGate = new Promise<void>((resolveGate) => {
      releaseFirstResolve = resolveGate;
    });
    let firstRootResolve = true;
    vi.mocked(realpath).mockImplementation(async (path, options) => {
      if (path === root && firstRootResolve) {
        firstRootResolve = false;
        await firstResolveGate;
      }
      return actualFs.realpath(path, options);
    });

    const first = saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 10, y: 10 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const second = saveCanvasMapLayout(alias, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 20, y: 20 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    releaseFirstResolve();
    await Promise.all([first, second]);

    await expect(readJsonFile<{ nodes: Array<{ x: number; y: number }> }>(layoutPath)).resolves.toMatchObject({
      nodes: [{ x: 20, y: 20 }]
    });
  });

  it("serializes save then reset so an earlier save cannot repopulate the layout file", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");

    const savePromise = saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 55, y: 66 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const resetPromise = resetCanvasMapLayout(root);
    await Promise.all([savePromise, resetPromise]);

    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(getCanvasMapLayout(root)).resolves.toMatchObject({
      nodes: [{ canvasId: "default", x: 80, y: 80 }]
    });
  });

  it("serializes concurrent get with save so a late get cannot observe a torn intermediate state", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    await saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 1, y: 1 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });

    const getPromise = getCanvasMapLayout(root);
    const savePromise = saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ canvasId: "default", x: 77, y: 88 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const [loaded, saved] = await Promise.all([getPromise, savePromise]);
    expect(loaded.nodes).toEqual([{ canvasId: "default", x: 1, y: 1 }]);
    expect(saved.nodes).toEqual([{ canvasId: "default", x: 77, y: 88 }]);
    const raw = JSON.parse(await readFile(layoutPath, "utf8")) as {
      nodes: Array<{ canvasId: string; x: number; y: number }>;
    };
    expect(raw.nodes).toEqual([{ canvasId: "default", x: 77, y: 88 }]);
  });

  it("keeps parse and reconcile responsibilities separate", () => {
    const parsed = parseCanvasMapLayoutFile(
      {
        version: "desktop-canvas-map-layout/v1",
        projectId: "proj",
        nodes: [
          { canvasId: "a", x: 1, y: 2 },
          { canvasId: "gone", x: 3, y: 4 }
        ],
        updatedAt: "2026-07-03T00:00:00.000Z"
      },
      "/tmp/canvas-map-layout.json"
    );
    expect(parsed.nodes).toHaveLength(2);

    const reconciled = reconcileCanvasMapLayoutWithProject(parsed, "proj", ["a", "b"]);
    expect(reconciled.nodes).toEqual([
      { canvasId: "a", x: 1, y: 2 },
      { canvasId: "b", x: 460, y: 80 }
    ]);
  });

  it("does not fall back to the default canvas map layout when layout stat fails with EACCES", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === layoutPath) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({ code: "EACCES" });
  });
});
