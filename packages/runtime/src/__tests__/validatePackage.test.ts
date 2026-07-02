import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, projectGraphPath, writeProjectGraph } from "../projectGraph/index.js";
import { createEmptyState } from "../state.js";
import { validatePackage } from "../validatePackage.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(readdir).mockImplementation((path, options) => actualFs.readdir(path, options));
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

describe("validatePackage", () => {
  it("accepts a complete v1 block-level package", async () => {
    const { root } = await createTestWorkspace();

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("rejects legacy global_prompt and missing block prompt files", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = { ...basicManifest(), global_prompt: "global-prompt.md" };
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("manifest_schema");
  });

  it("warns about stale prompt files instead of treating them as active contract", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-001.prompt.md"));

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("prompt_missing");
  });

  it("validates prompt references inside desktop task canvas packages", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Canvas missing prompts" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writeJsonFile(canvasWorkspace.manifestFile, basicManifest());

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_missing",
          path: expect.stringContaining(`canvases/${canvas.canvasId}/package/nodes/T-001/prompt.md`)
        }),
        expect.objectContaining({
          code: "prompt_missing",
          path: expect.stringContaining(`canvases/${canvas.canvasId}/package/nodes/T-001/blocks/B-001.prompt.md`)
        })
      ])
    );
  });

  it("reports workspace stat failures as workspace_read_failed instead of workspace_missing", async () => {
    const { root, init } = await createTestWorkspace();
    const workspaceRoot = join(init.workspace.workspaceRoot, "canvases", "default");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === workspaceRoot) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "workspace_read_failed",
          path: "canvases/default"
        })
      ])
    );
    expect(report.errors.map((error) => error.code)).not.toContain("workspace_missing");
  });

  it("reports manifest stat failures as manifest_read_failed instead of manifest_missing", async () => {
    const { root, init } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === init.workspace.manifestFile) {
        throw nodeIoError("EIO");
      }
      return actualFs.stat(path, options);
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest_read_failed",
          path: "canvases/default/package/manifest.json"
        })
      ])
    );
    expect(report.errors.map((error) => error.code)).not.toContain("manifest_missing");
  });

  it("reports runtime state stat failures as state_read_failed", async () => {
    const { root, init } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === init.workspace.stateFile) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "state_read_failed",
          path: "canvases/default/state.json"
        })
      ])
    );
  });

  it("reports result directory read failures as results_read_failed", async () => {
    const { root, init } = await createTestWorkspace();
    let resultsDirReads = 0;
    vi.mocked(readdir).mockImplementation((path, options) => {
      if (path === init.workspace.resultsDir) {
        resultsDirReads += 1;
        if (resultsDirReads > 1) {
          throw nodeIoError("EIO");
        }
      }
      return actualFs.readdir(path, options);
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "results_read_failed",
          path: "canvases/default/results"
        })
      ])
    );
  });

  it("reports task canvas layout schema diagnostics with the canvas layout path", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Legacy layout canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    const manifest = basicManifest();
    await writeJsonFile(canvasWorkspace.manifestFile, manifest);
    await writePromptFiles(canvasWorkspace.packageDir, manifest);
    await writeJsonFile(join(canvasWorkspace.workspaceRoot, "desktop", "layout.json"), {
      version: 1,
      nodes: {
        "T-001": {
          position: { x: 120, y: 240 }
        }
      }
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "legacy_layout_schema",
          path: expect.stringContaining(`canvases/${canvas.canvasId}/desktop/layout.json:nodes`)
        })
      ])
    );
  });

  it("reports formal project graph dependency diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Default" })],
      edges: [{ from: "default", to: "missing-canvas", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: "default", taskId: "T-MISSING" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "project_canvas_edge_to_missing",
          path: "project-graph.json:edges"
        }),
        expect.objectContaining({
          code: "project_cross_task_from_missing",
          path: "project-graph.json:crossTaskEdges"
        })
      ])
    );
  });

  it("warns for legacy root-only default canvas layout while validating the legacy package", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = basicManifest();
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await writeJsonFile(join(init.workspace.workspaceRoot, "package", "manifest.json"), manifest);
    await writePromptFiles(join(init.workspace.workspaceRoot, "package"), manifest);
    await writeJsonFile(join(init.workspace.workspaceRoot, "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "results"), { recursive: true });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "default_canvas_legacy_root_layout"
        })
      ])
    );
    expect(report.warnings.filter((warning) => warning.code === "project_graph_missing_default_canvas_used")).toHaveLength(1);
  });

  it("reports canonical default missing with legacy root data without canonical validation noise", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    await mkdir(join(init.workspace.workspaceRoot, "package"), { recursive: true });
    await writeJsonFile(projectGraphPath(init.workspace), {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Default" })],
      edges: [],
      crossTaskEdges: [
        {
          from: { canvasId: "default", taskId: "T-MISSING" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });
    await writeFile(join(init.workspace.workspaceRoot, "package", "manifest.json"), "{ invalid json", "utf8");
    await writeJsonFile(join(init.workspace.workspaceRoot, "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "results"), { recursive: true });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(["default_canvas_canonical_missing_legacy_root_present"]);
    expect(report.errors.map((error) => error.code)).not.toContain("project_canvas_manifest_read_failed");
    expect(report.errors.map((error) => error.code)).not.toContain("workspace_missing");
    expect(report.errors.map((error) => error.code).filter((code) => code.startsWith("project_cross_task_"))).toEqual([]);
  });

  it("reports mixed conflicting default canvas layouts as an error", async () => {
    const { root, init } = await createTestWorkspace();
    const legacyManifest = basicManifest({ includeSecondTask: true });
    await writeJsonFile(join(init.workspace.workspaceRoot, "package", "manifest.json"), legacyManifest);
    await writePromptFiles(join(init.workspace.workspaceRoot, "package"), legacyManifest);
    await writeJsonFile(join(init.workspace.workspaceRoot, "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "results"), { recursive: true });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "default_canvas_legacy_root_conflict"
        })
      ])
    );
  });

  it("accepts mixed identical default canvas layouts with a warning", async () => {
    const { root, init } = await createTestWorkspace();
    await cp(init.workspace.packageDir, join(init.workspace.workspaceRoot, "package"), { recursive: true });
    await cp(init.workspace.stateFile, join(init.workspace.workspaceRoot, "state.json"));
    await cp(init.workspace.resultsDir, join(init.workspace.workspaceRoot, "results"), { recursive: true });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "default_canvas_legacy_root_redundant"
        })
      ])
    );
  });

  it("validates only canvases referenced by a formal project graph", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(init.workspace.manifestFile, { version: "plan-package/v1", nodes: "invalid" });
    const packageDir = join(init.workspace.workspaceRoot, "manual-only", "package");
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "manual-only",
          type: "canvas",
          title: "Manual only",
          packageDir: "manual-only/package",
          stateFile: "manual-only/state.json",
          resultsDir: "manual-only/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("does not report runtime result directories as orphan task results", async () => {
    const { root, init } = await createTestWorkspace();
    await mkdir(join(init.workspace.resultsDir, "auto-runs", "RUN-001"), { recursive: true });
    await mkdir(join(init.workspace.resultsDir, "feedback-runs", "RUN-001"), { recursive: true });
    await mkdir(join(init.workspace.resultsDir, "run-sessions", "SESSION-0001"), { recursive: true });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.warnings.filter((warning) => warning.code === "orphan_result")).toEqual([]);
  });
});
