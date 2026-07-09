import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasWorkspace } from "../projectGraph/createCanvasWorkspace.js";
import { readJsonFile } from "../json.js";
import { projectGraphPath } from "../projectGraph/index.js";
import {
  readActiveTaskCanvasSelection,
  writeActiveTaskCanvasSelection
} from "../desktop/canvasSelectionStore.js";
import { validatePackage } from "../validatePackage.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hashSlug(title: string): string {
  return `canvas-${createHash("sha256").update(title).digest("hex").slice(0, 8)}`;
}

describe("createCanvasWorkspace", () => {
  it("generates CLI-safe slugs and appends numeric suffixes for conflicts", async () => {
    const { root } = await createTestWorkspace();

    const first = await createCanvasWorkspace({ cwd: root, title: "Optimization Plan!" });
    const second = await createCanvasWorkspace({ cwd: root, title: "Optimization Plan!" });

    expect(first.canvasId).toBe("optimization-plan");
    expect(second.canvasId).toBe("optimization-plan-2");
    expect(first.canvasValidationArgs).toEqual([
      "validate",
      "--canvas",
      "optimization-plan",
      "--json"
    ]);
    expect(first.projectValidationArgs).toEqual(["validate", "--json"]);
    expect(second.qualityArgs).toEqual([
      "graph",
      "quality",
      "--canvas",
      "optimization-plan-2",
      "--json"
    ]);
    expect(first).not.toHaveProperty("projectPromptPath");
    expect(first).not.toHaveProperty("validationCommand");
    expect(first).not.toHaveProperty("qualityCommand");
  });

  it("uses a stable hash fallback when title has no ASCII slug", async () => {
    const { root } = await createTestWorkspace();
    const title = "五项优化计划";

    const result = await createCanvasWorkspace({ cwd: root, title });

    expect(result.canvasId).toBe(hashSlug(title));
  });

  it("accepts explicit CLI-safe ids and still avoids conflicts", async () => {
    const { root } = await createTestWorkspace();

    const first = await createCanvasWorkspace({
      cwd: root,
      id: "release_2026.07",
      title: "Release Plan"
    });
    const second = await createCanvasWorkspace({
      cwd: root,
      id: "release_2026.07",
      title: "Release Plan Again"
    });

    expect(first.canvasId).toBe("release_2026.07");
    expect(second.canvasId).toBe("release_2026.07-2");
  });

  it("rejects empty titles and invalid explicit ids", async () => {
    const { root } = await createTestWorkspace();

    await expect(createCanvasWorkspace({ cwd: root, title: "   " })).rejects.toThrow(
      "Canvas title must not be empty."
    );
    await expect(createCanvasWorkspace({ cwd: root, id: "-bad", title: "Bad Id" })).rejects.toThrow(
      "Canvas id must be CLI-safe"
    );
  });

  it("dry-runs without creating directories, project graph entries, state, or active selection", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const activePath = join(init.workspace.workspaceRoot, "desktop", "active-canvas.json");

    const result = await createCanvasWorkspace({
      cwd: root,
      title: "Dry Run Plan",
      dryRun: true,
      activate: true
    });

    expect(result).toMatchObject({
      canvasId: "dry-run-plan",
      created: false,
      activated: false
    });
    expect(result.canvasRoot).toBe(join(init.workspace.workspaceRoot, "canvases", "dry-run-plan"));
    expect(await pathExists(result.canvasRoot)).toBe(false);
    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    expect(await pathExists(activePath)).toBe(false);
  });

  it("creates the current canonical canvas file structure and project graph entry", async () => {
    const { root, init } = await createTestWorkspace();

    const result = await createCanvasWorkspace({ cwd: root, title: "Runtime Canvas" });
    const manifest = await readJsonFile<Record<string, unknown>>(result.manifestPath);
    const state = await readJsonFile<Record<string, unknown>>(result.statePath);
    const projectGraph = await readJsonFile<{
      canvases: Array<{ id: string; packageDir: string; stateFile: string; resultsDir: string }>;
    }>(projectGraphPath(init.workspace));

    expect(result).toMatchObject({
      canvasId: "runtime-canvas",
      created: true,
      activated: false,
      packageDir: join(init.workspace.workspaceRoot, "canvases", "runtime-canvas", "package"),
      manifestPath: join(
        init.workspace.workspaceRoot,
        "canvases",
        "runtime-canvas",
        "package",
        "manifest.json"
      ),
      taskPromptsDir: join(
        init.workspace.workspaceRoot,
        "canvases",
        "runtime-canvas",
        "package",
        "nodes"
      ),
      blockPromptsDir: join(
        init.workspace.workspaceRoot,
        "canvases",
        "runtime-canvas",
        "package",
        "nodes"
      )
    });
    await expect(access(join(result.packageDir, "nodes"))).resolves.toBeUndefined();
    await expect(access(join(result.packageDir, "prompts"))).rejects.toThrow();
    await expect(access(result.resultsDir)).resolves.toBeUndefined();
    expect(manifest).toMatchObject({
      version: "plan-package/v1",
      project: { title: "Runtime Canvas" },
      nodes: [],
      edges: []
    });
    expect(state).toEqual({
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });
    expect(projectGraph.canvases).toContainEqual({
      id: "runtime-canvas",
      type: "canvas",
      title: "Runtime Canvas",
      packageDir: "canvases/runtime-canvas/package",
      stateFile: "canvases/runtime-canvas/state.json",
      resultsDir: "canvases/runtime-canvas/results"
    });
  });

  it("does not change the active canvas unless activation is requested", async () => {
    const { root } = await createTestWorkspace();
    await writeActiveTaskCanvasSelection(root, "default");

    await createCanvasWorkspace({ cwd: root, title: "Inactive Canvas" });

    await expect(readActiveTaskCanvasSelection(root)).resolves.toEqual({
      activeCanvasId: "default"
    });
  });

  it("updates the active canvas when activation is requested", async () => {
    const { root } = await createTestWorkspace();
    await writeActiveTaskCanvasSelection(root, "default");

    const result = await createCanvasWorkspace({
      cwd: root,
      title: "Active Canvas",
      activate: true
    });

    expect(result.activated).toBe(true);
    await expect(readActiveTaskCanvasSelection(root)).resolves.toEqual({
      activeCanvasId: "active-canvas"
    });
  });

  it("does not rewrite existing canvas manifests", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await readFile(init.workspace.manifestFile, "utf8");

    await createCanvasWorkspace({ cwd: root, title: "Separate Canvas" });

    expect(await readFile(init.workspace.manifestFile, "utf8")).toBe(before);
  });

  it("creates a canvas that passes current project validation", async () => {
    const { root } = await createTestWorkspace();

    await createCanvasWorkspace({ cwd: root, title: "Validation Canvas" });

    await expect(validatePackage({ projectRoot: root })).resolves.toMatchObject({ ok: true });
  });
});
