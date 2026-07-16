import { join } from "node:path";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTaskCanvas,
  listTaskCanvases,
  resolveTaskCanvasWorkspace
} from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { projectGraphManifestSchema } from "../projectGraph/schema.js";
import {
  canonicalProjectCanvasNode,
  loadProjectGraph,
  projectGraphPath,
  writeProjectGraph
} from "../projectGraph/index.js";
import { materializeProjectGraph } from "../projectGraph/materializeProjectGraph.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";
import { createEmptyState } from "../state.js";

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

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

describe("project graph schema", () => {
  it("parses the project-level canvas graph contract", () => {
    expect(
      projectGraphManifestSchema.parse({
        version: "plan-project/v1",
        canvases: [canonicalProjectCanvasNode({ id: "default", title: "Default plan" })],
        edges: [],
        crossTaskEdges: []
      })
    ).toMatchObject({ version: "plan-project/v1" });
  });

  it("requires CLI-safe canvas ids", () => {
    expect(() =>
      projectGraphManifestSchema.parse({
        version: "plan-project/v1",
        canvases: [
          {
            id: "desktop canvas; rm -rf",
            type: "canvas",
            title: "Unsafe canvas id",
            packageDir: "desktop/package",
            stateFile: "desktop/state.json",
            resultsDir: "desktop/results"
          }
        ],
        edges: [],
        crossTaskEdges: []
      })
    ).toThrow();
  });

  it("derives a legacy project graph when project-graph.json is missing", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    await mkdir(join(init.workspace.workspaceRoot, "desktop"), { recursive: true });
    await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), {
      version: "desktop-canvases/v1",
      canvases: [
        {
          canvasId: "default",
          name: "Test Plan",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results",
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z"
        },
        {
          canvasId: "second",
          name: "Second plan",
          packageDir: "canvases/second/package",
          stateFile: "canvases/second/state.json",
          resultsDir: "canvases/second/results",
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z"
        }
      ]
    });

    const loaded = await loadProjectGraph(root);

    expect(loaded.source).toBe("legacy_registry");
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({ code: "project_graph_missing_legacy_registry_used" })
    ]);
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", "second"]);
  });

  it("loads a formal project graph when present", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Formal default" })],
      edges: [],
      crossTaskEdges: []
    });

    const loaded = await loadProjectGraph(root);

    expect(projectGraphPath(init.workspace)).toBe(
      join(init.workspace.workspaceRoot, "project-graph.json")
    );
    expect(loaded.source).toBe("project_graph");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.manifest.canvases[0]?.title).toBe("Formal default");
  });

  it("materializes the current fallback graph as formal project-graph.json", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));

    const result = await materializeProjectGraph(root);
    const loaded = await loadProjectGraph(root);

    expect(result).toEqual({
      path: projectGraphPath(init.workspace),
      created: true,
      source: "legacy_default_canvas",
      canvasCount: 1
    });
    expect(loaded.source).toBe("project_graph");
    expect(loaded.manifest.canvases).toEqual([
      expect.objectContaining({
        id: "default",
        packageDir: "canvases/default/package",
        stateFile: "canvases/default/state.json",
        resultsDir: "canvases/default/results"
      })
    ]);
  });

  it("refuses to materialize a formal graph while legacy root default data needs migration", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    const packageDir = join(init.workspace.workspaceRoot, "package");
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeJsonFile(join(init.workspace.workspaceRoot, "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "results"), { recursive: true });

    await expect(materializeProjectGraph(root)).rejects.toThrow("project-graph migrate");
    await expect(access(projectGraphPath(init.workspace))).rejects.toThrow();
  });

  it("rejects materializing a project graph before workspace init", async () => {
    process.env.PLANWEAVE_HOME = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));

    await expect(materializeProjectGraph(root)).rejects.toThrow(
      "planweave init --project-graph --json"
    );
  });

  it("does not report project metadata stat failures as uninitialized when materializing a project graph", async () => {
    const { root, init } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === init.workspace.projectFile) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(materializeProjectGraph(root)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not report project metadata I/O failures as uninitialized when materializing a project graph", async () => {
    const { root, init } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === init.workspace.projectFile) {
        throw nodeIoError("EIO");
      }
      return actualFs.stat(path, options);
    });

    await expect(materializeProjectGraph(root)).rejects.toMatchObject({ code: "EIO" });
  });

  it("can reference a second canvas package from project-graph.json", async () => {
    const { root, init } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Explicit second" });
    const workspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    const manifest = basicManifest();
    await writeJsonFile(workspace.manifestFile, manifest);
    await writePromptFiles(workspace.packageDir, manifest);

    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
        {
          id: canvas.canvasId,
          type: "canvas",
          title: "Explicit second",
          packageDir: `canvases/${canvas.canvasId}/package`,
          stateFile: `canvases/${canvas.canvasId}/state.json`,
          resultsDir: `canvases/${canvas.canvasId}/results`
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    await expect(loadProjectGraph(root)).resolves.toMatchObject({
      source: "project_graph",
      manifest: {
        canvases: expect.arrayContaining([expect.objectContaining({ id: canvas.canvasId })])
      }
    });
  });

  it("resolves formal project graph canvases outside the legacy registry", async () => {
    const { root, init } = await createTestWorkspace();
    const packageDir = join(init.workspace.workspaceRoot, "manual-canvas", "package");
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "manual-canvas",
          type: "canvas",
          title: "Manual formal canvas",
          packageDir: "manual-canvas/package",
          stateFile: "manual-canvas/state.json",
          resultsDir: "manual-canvas/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    const workspace = await resolveTaskCanvasWorkspace(root, "manual-canvas");
    const canvases = await listTaskCanvases(root);

    expect(workspace.packageDir).toBe(packageDir);
    expect(canvases).toEqual([
      expect.objectContaining({
        canvasId: "manual-canvas",
        name: "Manual formal canvas",
        taskCount: 1
      })
    ]);
  });
});
