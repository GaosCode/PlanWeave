import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import {
  canonicalProjectCanvasNode,
  projectGraphPath,
  writeProjectGraph
} from "../projectGraph/index.js";
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
          path: expect.stringContaining(
            `canvases/${canvas.canvasId}/package/nodes/T-001/blocks/B-001.prompt.md`
          )
        })
      ])
    );
  });

  it("validates only the requested canvas workspace when one is provided", async () => {
    const { root } = await createTestWorkspace();
    const targetCanvas = await createTaskCanvas(root, { name: "Target canvas" });
    const brokenCanvas = await createTaskCanvas(root, { name: "Broken canvas" });
    const targetWorkspace = await resolveTaskCanvasWorkspace(root, targetCanvas.canvasId);
    const brokenWorkspace = await resolveTaskCanvasWorkspace(root, brokenCanvas.canvasId);
    const targetManifest = basicManifest();
    await writeJsonFile(targetWorkspace.manifestFile, targetManifest);
    await writePromptFiles(targetWorkspace.packageDir, targetManifest);
    await writeJsonFile(brokenWorkspace.manifestFile, {
      version: "plan-package/v1",
      nodes: "invalid"
    });

    const report = await validatePackage({ projectRoot: targetWorkspace });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("reports diagnostics from the requested canvas workspace", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Missing prompt canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writeJsonFile(canvasWorkspace.manifestFile, basicManifest());

    const report = await validatePackage({ projectRoot: canvasWorkspace });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_missing",
          path: expect.stringContaining(`canvases/${canvas.canvasId}/package/nodes/T-001/prompt.md`)
        })
      ])
    );
  });

  it("reports missing manifests from the requested canvas workspace", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Missing manifest canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await rm(canvasWorkspace.manifestFile);

    const report = await validatePackage({ projectRoot: canvasWorkspace });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: "manifest_missing",
        path: `canvases/${canvas.canvasId}/package/manifest.json`
      })
    ]);
  });

  it("reports independent canvas failures and leaves historical package and execution files intact", async () => {
    const { root, init } = await createTestWorkspace();
    const missing = canonicalProjectCanvasNode({ id: "missing-prompt", title: "Missing prompt" });
    const valid = canonicalProjectCanvasNode({ id: "valid", title: "Valid" });
    const missingPackageDir = join(init.workspace.workspaceRoot, missing.packageDir);
    const validPackageDir = join(init.workspace.workspaceRoot, valid.packageDir);
    const historical = basicManifest();
    historical.nodes[0].id = "T-001#old";
    await writeJsonFile(init.workspace.manifestFile, historical);
    const missingManifest = basicManifest();
    await writePromptFiles(missingPackageDir, missingManifest);
    missingManifest.nodes[0].prompt = "prompts/missing.md";
    await writeJsonFile(join(missingPackageDir, "manifest.json"), missingManifest);
    const validManifest = basicManifest();
    await writeJsonFile(join(validPackageDir, "manifest.json"), validManifest);
    await writePromptFiles(validPackageDir, validManifest);
    await writeFile(join(validPackageDir, "nodes", "stale.md"), "Unreferenced prompt\n");
    const resultFile = join(init.workspace.resultsDir, "T-001", "report.md");
    await mkdir(join(init.workspace.resultsDir, "T-001"), { recursive: true });
    await writeFile(resultFile, "Historical result\n");
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Historical" }),
        missing,
        valid
      ],
      edges: [],
      crossTaskEdges: []
    });
    const files = [init.workspace.manifestFile, init.workspace.stateFile, resultFile];
    const bytes = await Promise.all(files.map((file) => readFile(file)));

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest_schema",
          path: "canvases/default/package/manifest.json:nodes.0.id"
        }),
        expect.objectContaining({
          code: "prompt_missing",
          path: "canvases/missing-prompt/package/prompts/missing.md"
        })
      ])
    );
    expect(report.errors.filter((error) => error.path?.startsWith("project-graph.json"))).toEqual(
      []
    );
    expect(report.warnings).toContainEqual(
      expect.objectContaining({
        code: "stale_prompt_reference",
        path: "canvases/valid/package/nodes/stale.md"
      })
    );
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(bytes);
  });

  it("continues validation after a canvas workspace path fails containment", async () => {
    const { root, init } = await createTestWorkspace();
    const broken = {
      ...canonicalProjectCanvasNode({ id: "outside", title: "Outside" }),
      stateFile: "../state.json"
    };
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [broken, canonicalProjectCanvasNode({ id: "default", title: "Default" })],
      edges: [],
      crossTaskEdges: []
    });
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"));

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "project_canvas_workspace_invalid",
          message: expect.stringMatching(/outside.*state\.json/),
          path: "project-graph.json:canvases.0"
        }),
        expect.objectContaining({
          code: "prompt_missing",
          path: "canvases/default/package/nodes/T-001/prompt.md"
        })
      ])
    );
    expect(report.errors.map((error) => error.code)).not.toContain("project_graph_read_failed");
  });

  it.each([
    ["{ invalid json", "project_graph_read_failed", "project-graph.json"],
    [
      '{"version":"plan-project/v1","canvases":[]}',
      "project_graph_schema",
      "project-graph.json:canvases"
    ]
  ])("attributes project graph failures to the graph file (%s)", async (content, code, path) => {
    const { root, init } = await createTestWorkspace();
    await writeFile(projectGraphPath(init.workspace), content);

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.objectContaining({ code, path })]);
  });

  it("locates a failed manifest on the correct canvas when two canvases share an ID", async () => {
    const { root, init } = await createTestWorkspace();
    const first = canonicalProjectCanvasNode({ id: "first", title: "Broken package" });
    const second = canonicalProjectCanvasNode({ id: "second", title: "Healthy package" });
    const firstPackageDir = join(init.workspace.workspaceRoot, first.packageDir);
    await mkdir(firstPackageDir, { recursive: true });
    await writeFile(join(firstPackageDir, "manifest.json"), "{ invalid json");
    await cp(init.workspace.packageDir, join(init.workspace.workspaceRoot, second.packageDir), {
      recursive: true
    });
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        { ...first, id: "dup" },
        { ...second, id: "dup" }
      ],
      edges: [],
      crossTaskEdges: []
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.filter((error) => error.code === "project_canvas_id_duplicate")).toEqual([
      expect.objectContaining({ path: "project-graph.json:canvases" })
    ]);
    expect(report.errors).toContainEqual(
      expect.objectContaining({
        code: "manifest_read_failed",
        path: `${first.packageDir}/manifest.json`
      })
    );
    expect(
      report.errors.every((error) => error.path !== `${second.packageDir}/manifest.json`)
    ).toBe(true);
  });

  it.each([
    ["canvases/default/package/manifest.json", "manifest_read_failed", "{ invalid json"],
    ["desktop/canvases.json", "project_graph_read_failed", "{ invalid json"],
    [
      "desktop/canvases.json",
      "project_graph_read_failed",
      '{"version":"unsupported","canvases":[]}'
    ],
    [
      "desktop/canvases.json",
      "project_graph_read_failed",
      '{"version":"desktop-canvases/v1","canvases":[{}]}'
    ]
  ])("attributes legacy fallback failures to %s (%s from %s)", async (path, code, contents) => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const source = join(init.workspace.workspaceRoot, path);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, contents);

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.objectContaining({ code, path })]);
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
    expect(
      report.warnings.filter(
        (warning) => warning.code === "project_graph_missing_default_canvas_used"
      )
    ).toHaveLength(1);
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
    await writeFile(
      join(init.workspace.workspaceRoot, "package", "manifest.json"),
      "{ invalid json",
      "utf8"
    );
    await writeJsonFile(join(init.workspace.workspaceRoot, "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "results"), { recursive: true });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual([
      "default_canvas_canonical_missing_legacy_root_present"
    ]);
    expect(report.errors.map((error) => error.code)).not.toContain(
      "project_canvas_manifest_read_failed"
    );
    expect(report.errors.map((error) => error.code)).not.toContain("workspace_missing");
    expect(
      report.errors
        .map((error) => error.code)
        .filter((code) => code.startsWith("project_cross_task_"))
    ).toEqual([]);
  });

  it("reports mixed conflicting default canvas layouts as an error", async () => {
    const { root, init } = await createTestWorkspace();
    const legacyManifest = basicManifest({ includeSecondTask: true });
    await writeJsonFile(
      join(init.workspace.workspaceRoot, "package", "manifest.json"),
      legacyManifest
    );
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
    await cp(init.workspace.packageDir, join(init.workspace.workspaceRoot, "package"), {
      recursive: true
    });
    await cp(init.workspace.stateFile, join(init.workspace.workspaceRoot, "state.json"));
    await cp(init.workspace.resultsDir, join(init.workspace.workspaceRoot, "results"), {
      recursive: true
    });

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
    await writeJsonFile(init.workspace.manifestFile, {
      version: "plan-package/v1",
      nodes: "invalid"
    });
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
    await mkdir(join(init.workspace.resultsDir, "run-sessions", "SESSION-0001"), {
      recursive: true
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.warnings.filter((warning) => warning.code === "orphan_result")).toEqual([]);
  });
});
