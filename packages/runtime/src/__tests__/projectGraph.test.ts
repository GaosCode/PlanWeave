import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskCanvas } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import {
  canonicalCanvasWorkspacePaths,
  canonicalProjectCanvasNode,
  applyDefaultCanvasWorkspaceMigration,
  compileProjectGraph,
  detectDefaultCanvasWorkspaceMigration,
  loadProjectGraph,
  projectCanvasWorkspace,
  projectGraphPath,
  projectGraphSchema
} from "../projectGraph/index.js";
import { manifestSchema } from "../schema/manifest.js";
import { createEmptyState } from "../state.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function projectGraph() {
  return {
    version: "plan-project/v1" as const,
    canvases: [
      canonicalProjectCanvasNode({ id: "default", title: "Runtime" }),
      canonicalProjectCanvasNode({ id: "desktop", title: "Desktop" })
    ],
    edges: [],
    crossTaskEdges: []
  };
}

function codes(graph: Awaited<ReturnType<typeof compileProjectGraph>>): string[] {
  return graph.diagnostics.errors.map((error) => error.code);
}

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

function pathEndsWith(path: string | Buffer | URL, suffix: string): boolean {
  return String(path).split("\\").join("/").endsWith(suffix);
}

async function createTwoCanvasProject(manifest = projectGraph()) {
  const { root, init } = await createTestWorkspace();
  const desktopPackageDir = join(init.workspace.workspaceRoot, "canvases", "desktop", "package");
  const desktopManifest = basicManifest();
  await writeJsonFile(join(desktopPackageDir, "manifest.json"), desktopManifest);
  await writePromptFiles(desktopPackageDir, desktopManifest);
  await writeJsonFile(projectGraphPath(init.workspace), manifest);
  return loadProjectGraph(root);
}

async function writeLegacyRootDefaultCanvas(workspaceRoot: string, manifest: PlanPackageManifest = basicManifest()) {
  const packageDir = join(workspaceRoot, "package");
  await writeJsonFile(join(packageDir, "manifest.json"), manifest);
  await writePromptFiles(packageDir, manifest);
  await writeJsonFile(join(workspaceRoot, "state.json"), createEmptyState());
  await mkdir(join(workspaceRoot, "results"), { recursive: true });
}

describe("project graph schema and compiler", () => {
  it("builds canonical canvas workspace paths without filesystem access", () => {
    expect(canonicalCanvasWorkspacePaths("default")).toEqual({
      packageDir: "canvases/default/package",
      stateFile: "canvases/default/state.json",
      resultsDir: "canvases/default/results"
    });
    expect(canonicalProjectCanvasNode({ id: "canvas-123", title: "Canvas 123", description: "Test canvas" })).toEqual({
      id: "canvas-123",
      type: "canvas",
      title: "Canvas 123",
      description: "Test canvas",
      packageDir: "canvases/canvas-123/package",
      stateFile: "canvases/canvas-123/state.json",
      resultsDir: "canvases/canvas-123/results"
    });
  });

  it("accepts project-graph.json without changing single-canvas manifest nodes", () => {
    expect(() => projectGraphSchema.parse(projectGraph())).not.toThrow();

    const baseManifest = basicManifest();
    const manifestWithCanvasNode: unknown = {
      ...baseManifest,
      nodes: [
        ...baseManifest.nodes,
        {
          id: "canvas-node",
          type: "canvas",
          title: "Canvas",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results"
        }
      ]
    };

    expect(manifestSchema.safeParse(manifestWithCanvasNode).success).toBe(false);
  });

  it("detects duplicate canvas ids and edges pointing at missing canvases", async () => {
    const manifest = projectGraph();
    manifest.canvases.push({ ...manifest.canvases[0], title: "Duplicate default" });
    manifest.edges.push({ from: "desktop", to: "missing", type: "depends_on" });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph({ ...loaded, manifest });

    expect(codes(graph)).toEqual(expect.arrayContaining(["project_canvas_id_duplicate", "project_canvas_edge_to_missing"]));
  });

  it("detects missing tasks in cross-canvas task edges", async () => {
    const manifest = projectGraph();
    manifest.crossTaskEdges.push({
      from: { canvasId: "desktop", taskId: "T-DOES-NOT-EXIST" },
      to: { canvasId: "default", taskId: "T-001" },
      type: "depends_on"
    });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_cross_task_from_missing");
  });

  it("detects canvas dependency cycles", async () => {
    const manifest = projectGraph();
    manifest.edges.push({ from: "desktop", to: "default", type: "depends_on" });
    manifest.edges.push({ from: "default", to: "desktop", type: "depends_on" });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_canvas_depends_on_cycle");
    expect(graph.canvasReachable("desktop", "default")).toBe(true);
  });

  it("detects mixed canvas and cross-task cycles", async () => {
    const { root, init } = await createTestWorkspace();
    for (const canvasId of ["B", "C", "D"]) {
      const manifest = canvasId === "B" ? basicManifest({ includeSecondTask: true }) : basicManifest();
      const packageDir = join(init.workspace.workspaceRoot, "canvases", canvasId, "package");
      await writeJsonFile(join(packageDir, "manifest.json"), manifest);
      await writePromptFiles(packageDir, manifest);
    }
    await writeJsonFile(projectGraphPath(init.workspace), {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
        canonicalProjectCanvasNode({ id: "B", title: "B" }),
        canonicalProjectCanvasNode({ id: "C", title: "C" }),
        canonicalProjectCanvasNode({ id: "D", title: "D" })
      ],
      edges: [{ from: "C", to: "D", type: "depends_on" }],
      crossTaskEdges: [
        { from: { canvasId: "default", taskId: "T-001" }, to: { canvasId: "B", taskId: "T-001" }, type: "depends_on" },
        { from: { canvasId: "B", taskId: "T-002" }, to: { canvasId: "default", taskId: "T-001" }, type: "depends_on" },
        { from: { canvasId: "D", taskId: "T-001" }, to: { canvasId: "C", taskId: "T-001" }, type: "depends_on" }
      ]
    });

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_mixed_depends_on_cycle");
    expect(codes(graph)).not.toContain("project_task_depends_on_cycle");
    expect(codes(graph)).not.toContain("project_canvas_depends_on_cycle");
  });

  it("detects task cycles from same-canvas and cross-task edges", async () => {
    const manifest = projectGraph();
    const defaultManifest = basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] });
    manifest.crossTaskEdges.push(
      {
        from: { canvasId: "default", taskId: "T-002" },
        to: { canvasId: "desktop", taskId: "T-001" },
        type: "depends_on"
      },
      {
        from: { canvasId: "desktop", taskId: "T-001" },
        to: { canvasId: "default", taskId: "T-001" },
        type: "depends_on"
      }
    );

    const loaded = await createTwoCanvasProject(manifest);
    await writeJsonFile(loaded.workspace.manifestFile, defaultManifest);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_task_depends_on_cycle");
  });

  it("indexes cross-task dependencies with structured task refs", async () => {
    const manifest = projectGraph();
    manifest.crossTaskEdges.push({
      from: { canvasId: "desktop", taskId: "T-001" },
      to: { canvasId: "default", taskId: "T-001" },
      type: "depends_on"
    });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph(loaded);

    expect(graph.crossTaskDependencies({ canvasId: "desktop", taskId: "T-001" })).toEqual([{ canvasId: "default", taskId: "T-001" }]);
    expect(graph.taskDependencies({ canvasId: "desktop", taskId: "T-001" })).toEqual([{ canvasId: "default", taskId: "T-001" }]);
  });
});

describe("project graph loader", () => {
  it("reads formal project-graph.json and canvas manifests", async () => {
    const { root, init } = await createTestWorkspace();
    const graphManifest = projectGraph();
    graphManifest.canvases = [graphManifest.canvases[0]];
    await writeJsonFile(projectGraphPath(init.workspace), graphManifest);

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(loaded.source).toBe("project_graph");
    expect(loaded.diagnostics).toEqual([]);
    expect(graph.diagnostics).toEqual({ errors: [], warnings: [] });
    expect(graph.canvasIdsInOrder).toEqual(["default"]);
    expect(graph.taskRefsInProjectOrder).toEqual([{ canvasId: "default", taskId: "T-001" }]);
  });

  it("derives a legacy graph from desktop/canvases.json with a warning", async () => {
    const { root } = await createTestWorkspace();
    const loadedBeforeLegacy = await loadProjectGraph(root);
    await rm(projectGraphPath(loadedBeforeLegacy.workspace));
    const secondCanvas = await createTaskCanvas(root, { name: "Second canvas" });

    const loaded = await loadProjectGraph(root);

    expect(loaded.source).toBe("legacy_registry");
    expect(loaded.diagnostics.map((warning) => warning.code)).toContain("project_graph_missing_legacy_registry_used");
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", secondCanvas.canvasId]);
    expect(loaded.manifest.canvases[0]).toMatchObject({
      id: "default",
      packageDir: "canvases/default/package",
      stateFile: "canvases/default/state.json",
      resultsDir: "canvases/default/results"
    });
  });

  it("derives a default canvas graph when no formal graph or legacy registry exists", async () => {
    const { root } = await createTestWorkspace();
    const loadedBeforeLegacy = await loadProjectGraph(root);
    await rm(projectGraphPath(loadedBeforeLegacy.workspace));

    const loaded = await loadProjectGraph(root);

    expect(loaded.source).toBe("legacy_default_canvas");
    expect(loaded.diagnostics.map((warning) => warning.code)).toContain("project_graph_missing_default_canvas_used");
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default"]);
    expect(loaded.manifest.canvases[0]).toMatchObject({
      packageDir: "canvases/default/package",
      stateFile: "canvases/default/state.json",
      resultsDir: "canvases/default/results"
    });
  });

  it("detects a legacy root default canvas that can be migrated explicitly", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = basicManifest();
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await writeLegacyRootDefaultCanvas(init.workspace.workspaceRoot, manifest);

    const loaded = await loadProjectGraph(root);
    const migration = await detectDefaultCanvasWorkspaceMigration(init.workspace);

    expect(loaded.source).toBe("legacy_default_canvas");
    expect(loaded.manifest.canvases[0]).toMatchObject({
      id: "default",
      packageDir: "canvases/default/package",
      stateFile: "canvases/default/state.json",
      resultsDir: "canvases/default/results"
    });
    expect(migration).toMatchObject({
      action: "migrate",
      legacyFiles: expect.arrayContaining(["package/manifest.json", "state.json"]),
      canonicalFiles: []
    });
  });

  it("does not treat legacy default package stat failures as no migration data", async () => {
    const { init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await writeLegacyRootDefaultCanvas(init.workspace.workspaceRoot, basicManifest());
    const legacyPackageDir = join(init.workspace.workspaceRoot, "package");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === legacyPackageDir) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(detectDefaultCanvasWorkspaceMigration(init.workspace)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not treat legacy default state stat failures as missing state data", async () => {
    const { init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await writeLegacyRootDefaultCanvas(init.workspace.workspaceRoot, basicManifest());
    const legacyStateFile = join(init.workspace.workspaceRoot, "state.json");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === legacyStateFile) {
        throw nodeIoError("EIO");
      }
      return actualFs.stat(path, options);
    });

    await expect(detectDefaultCanvasWorkspaceMigration(init.workspace)).rejects.toMatchObject({ code: "EIO" });
  });

  it("does not treat project graph stat failures as missing during default canvas migration", async () => {
    const { init } = await createTestWorkspace();
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await writeLegacyRootDefaultCanvas(init.workspace.workspaceRoot, basicManifest());
    const path = projectGraphPath(init.workspace);
    vi.mocked(stat).mockImplementation((candidate, options) => {
      if (candidate === path) {
        throw nodeIoError("EPERM");
      }
      return actualFs.stat(candidate, options);
    });

    await expect(applyDefaultCanvasWorkspaceMigration(init.workspace)).rejects.toMatchObject({ code: "EPERM" });
  });

  it("explicitly migrates legacy root default canvas data and quarantines root files", async () => {
    const { init } = await createTestWorkspace();
    const manifest = basicManifest({ includeSecondTask: true });
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await writeLegacyRootDefaultCanvas(init.workspace.workspaceRoot, manifest);

    const result = await applyDefaultCanvasWorkspaceMigration(init.workspace);
    const graph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8"));

    expect(result.action).toBe("migrate");
    expect(result.legacyBackupPaths.packageDir).toBeTruthy();
    await expect(access(join(init.workspace.workspaceRoot, "canvases", "default", "package", "manifest.json"))).resolves.toBeUndefined();
    await expect(access(join(init.workspace.workspaceRoot, "package"))).rejects.toThrow();
    await expect(access(result.legacyBackupPaths.packageDir!)).resolves.toBeUndefined();
    expect(graph.canvases[0]).toMatchObject({
      id: "default",
      packageDir: "canvases/default/package",
      stateFile: "canvases/default/state.json",
      resultsDir: "canvases/default/results"
    });
  });

  it("preserves legacy registry canvases when migrating root default canvas data", async () => {
    const { init } = await createTestWorkspace();
    const manifest = basicManifest({ includeSecondTask: true });
    const secondManifest = basicManifest();
    const secondPackageDir = join(init.workspace.workspaceRoot, "canvases", "second", "package");
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await writeLegacyRootDefaultCanvas(init.workspace.workspaceRoot, manifest);
    await writeJsonFile(join(secondPackageDir, "manifest.json"), secondManifest);
    await writePromptFiles(secondPackageDir, secondManifest);
    await writeJsonFile(join(init.workspace.workspaceRoot, "canvases", "second", "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "canvases", "second", "results"), { recursive: true });
    await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), {
      version: "desktop-canvases/v1",
      canvases: [
        {
          canvasId: "default",
          name: "Legacy default",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        },
        {
          canvasId: "second",
          name: "Second",
          packageDir: "canvases/second/package",
          stateFile: "canvases/second/state.json",
          resultsDir: "canvases/second/results",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        }
      ]
    });

    await applyDefaultCanvasWorkspaceMigration(init.workspace);
    const graph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8"));

    expect(graph.canvases.map((canvas: { id: string }) => canvas.id)).toEqual(["default", "second"]);
    expect(graph.canvases[0]).toMatchObject({
      id: "default",
      packageDir: "canvases/default/package",
      stateFile: "canvases/default/state.json",
      resultsDir: "canvases/default/results"
    });
    expect(graph.canvases[1]).toMatchObject({
      id: "second",
      packageDir: "canvases/second/package",
      stateFile: "canvases/second/state.json",
      resultsDir: "canvases/second/results"
    });
  });

  it("does not write when legacy and canonical default canvas data conflict", async () => {
    const { init } = await createTestWorkspace();
    const beforeProjectGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    await writeLegacyRootDefaultCanvas(init.workspace.workspaceRoot, basicManifest({ includeSecondTask: true }));

    const migration = await detectDefaultCanvasWorkspaceMigration(init.workspace);

    expect(migration.action).toBe("conflict");
    await expect(applyDefaultCanvasWorkspaceMigration(init.workspace)).rejects.toThrow("default_canvas_legacy_root_conflict");
    await expect(readFile(projectGraphPath(init.workspace), "utf8")).resolves.toBe(beforeProjectGraph);
    await expect(access(join(init.workspace.workspaceRoot, "package", "manifest.json"))).resolves.toBeUndefined();
    await expect(access(join(init.workspace.workspaceRoot, "migration-quarantine"))).rejects.toThrow();
  });

  it("resolves legacy canvas workspaces and validates missing manifests as diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const registry = {
      version: "desktop-canvases/v1",
      canvases: [
        {
          canvasId: "broken",
          name: "Broken",
          packageDir: "canvases/broken/package",
          stateFile: "canvases/broken/state.json",
          resultsDir: "canvases/broken/results",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        }
      ]
    };
    await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), registry);

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(loaded.source).toBe("legacy_registry");
    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("project_canvas_manifest_read_failed");
  });

  it("can compile a formal two-canvas graph from disk", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = projectGraph();
    const desktopPackageDir = join(init.workspace.workspaceRoot, "canvases", "desktop", "package");
    const desktopManifest: PlanPackageManifest = basicManifest({ includeSecondTask: true });
    await writeJsonFile(join(desktopPackageDir, "manifest.json"), desktopManifest);
    await writePromptFiles(desktopPackageDir, desktopManifest);
    await writeJsonFile(projectGraphPath(init.workspace), manifest);

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(graph.diagnostics.errors).toEqual([]);
    expect(graph.taskRefsInProjectOrder).toEqual([
      { canvasId: "default", taskId: "T-001" },
      { canvasId: "desktop", taskId: "T-001" },
      { canvasId: "desktop", taskId: "T-002" }
    ]);
  });

  it("rejects invalid project-graph.json schema", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(projectGraphPath(init.workspace), { version: "plan-project/v1", canvases: [] });

    await expect(loadProjectGraph(root)).rejects.toThrow();
  });

  it("does not fall back to legacy graph when project-graph.json stat fails with EACCES", async () => {
    const { root } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (pathEndsWith(path, "project-graph.json")) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(loadProjectGraph(root)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not fall back to default graph when project-graph.json stat fails with EPERM", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), { force: true });
    vi.mocked(stat).mockImplementation((path, options) => {
      if (pathEndsWith(path, "project-graph.json")) {
        throw nodeIoError("EPERM");
      }
      return actualFs.stat(path, options);
    });

    await expect(loadProjectGraph(root)).rejects.toMatchObject({ code: "EPERM" });
  });
});

describe("project graph workspace resolution", () => {
  it("resolves the default canvas under canvases/default", async () => {
    const { init } = await createTestWorkspace();
    const canvas = canonicalProjectCanvasNode({ id: "default", title: "Default" });
    const workspace = projectCanvasWorkspace(init.workspace, canvas);

    expect(workspace.workspaceRoot).toBe(join(init.workspace.workspaceRoot, "canvases", "default"));
    expect(workspace.packageDir).toBe(join(init.workspace.workspaceRoot, "canvases", "default", "package"));
    expect(workspace.stateFile).toBe(join(init.workspace.workspaceRoot, "canvases", "default", "state.json"));
    expect(workspace.resultsDir).toBe(join(init.workspace.workspaceRoot, "canvases", "default", "results"));
  });
});
