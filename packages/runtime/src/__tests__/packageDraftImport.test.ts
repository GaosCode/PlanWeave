import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPackageDraftImport,
  previewPackageDraftImport,
  validatePackageDraft
} from "../package/packageDraftImport.js";
import { validateGraphQuality } from "../graph/validateGraphQuality.js";
import { validatePackage } from "../validatePackage.js";
import { writeJsonFile } from "../json.js";
import { projectGraphPath } from "../projectGraph/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

async function createDraft(manifest: PlanPackageManifest): Promise<string> {
  const draftRoot = await mkdtemp(join(tmpdir(), "planweave-package-draft-"));
  await writeJsonFile(join(draftRoot, "manifest.json"), manifest);
  await writePromptFiles(draftRoot, manifest);
  return draftRoot;
}

async function readManifestTitle(packageDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8")) as PlanPackageManifest;
  return manifest.project.title;
}

async function createProjectDraft(options: { canvasIds?: string[]; extraUnreadableFile?: boolean } = {}): Promise<string> {
  const draftRoot = await mkdtemp(join(tmpdir(), "planweave-project-draft-"));
  const canvasIds = options.canvasIds ?? ["default"];
  for (const canvasId of canvasIds) {
    const packageDir = join(draftRoot, "canvases", canvasId, "package");
    await mkdir(packageDir, { recursive: true });
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    if (options.extraUnreadableFile && canvasId === canvasIds[0]) {
      const unreadable = join(packageDir, "unreadable.txt");
      await writeFile(unreadable, "cannot copy\n", "utf8");
      await chmod(unreadable, 0o000);
    }
  }
  await writeJsonFile(join(draftRoot, "project-graph.json"), {
    version: "plan-project/v1",
    canvases: canvasIds.map((canvasId) => ({
        id: canvasId,
        type: "canvas",
        title: `Draft ${canvasId}`,
        packageDir: `canvases/${canvasId}/package`,
        stateFile: `canvases/${canvasId}/state.json`,
        resultsDir: `canvases/${canvasId}/results`
      })),
    edges: [],
    crossTaskEdges: []
  });
  return draftRoot;
}

describe("package draft import", () => {
  it("validates package-shaped draft roots and includes graph quality errors", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    const draftRoot = await createDraft(manifest);

    const result = await validatePackageDraft({ draftRoot });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("single-canvas");
    expect(result.validation.errors.map((issue) => issue.code)).toContain("edge_to_missing");
    expect(result.canvases[0]?.graphQuality?.ok).toBe(false);
    expect(result.canvases[0]?.graphQuality?.diagnostics.map((diagnostic) => diagnostic.code)).toContain("edge_to_missing");
  });

  it("previews imports without writing target files", async () => {
    const { root, init } = await createTestWorkspace();
    const draftManifest = {
      ...basicManifest(),
      project: { title: "Draft Plan", description: "Imported draft" }
    };
    const draftRoot = await createDraft(draftManifest);

    const preview = await previewPackageDraftImport({ draftRoot, projectRoot: root });

    expect(preview.ok).toBe(true);
    expect(preview.target.canvasId).toBe("default");
    expect(preview.effects).toEqual(
      expect.arrayContaining([
        { type: "replace_package", path: "package" },
        { type: "reset_state", path: "state.json" },
        { type: "reset_results", path: "results" }
      ])
    );
    expect(preview.fileDiffs.map((diff) => diff.path)).toContain("package/manifest.json");
    expect(preview.summary.changed).toBeGreaterThan(0);
    expect(await readManifestTitle(init.workspace.packageDir)).toBe("Test Plan");
  });

  it("applies imports and leaves the target package valid with passing graph quality", async () => {
    const { root, init } = await createTestWorkspace();
    const draftManifest = {
      ...basicManifest(),
      project: { title: "Draft Plan", description: "Imported draft" }
    };
    const draftRoot = await createDraft(draftManifest);

    const applied = await applyPackageDraftImport({ draftRoot, projectRoot: root });
    const validation = await validatePackage({ projectRoot: root });
    const quality = await validateGraphQuality({ projectRoot: root });

    expect(applied).toMatchObject({ ok: true, applied: true, target: { canvasId: "default" } });
    expect(await readManifestTitle(init.workspace.packageDir)).toBe("Draft Plan");
    expect(validation.ok).toBe(true);
    expect(quality.ok).toBe(true);
  });

  it("does not write target files when validation fails before apply", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    const draftRoot = await createDraft(manifest);

    const applied = await applyPackageDraftImport({ draftRoot, projectRoot: root });

    expect(applied.applied).toBe(false);
    expect(applied.ok).toBe(false);
    expect(await readManifestTitle(init.workspace.packageDir)).toBe("Test Plan");
  });

  it("rolls back project graph files when apply fails after partial replacement", async () => {
    const { root, init } = await createTestWorkspace();
    const draftRoot = await createProjectDraft({ extraUnreadableFile: true });

    await expect(applyPackageDraftImport({ draftRoot, projectRoot: root })).rejects.toThrow();

    const projectGraph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8")) as {
      canvases: Array<{ title: string }>;
    };
    expect(projectGraph.canvases[0]?.title).toBe("Test Plan");
  });

  it("rolls back after project graph replacement when a later canvas cannot be written", async () => {
    const { root, init } = await createTestWorkspace();
    const draftRoot = await createProjectDraft({ canvasIds: ["default", "blocked"] });
    const blockerParent = join(init.workspace.workspaceRoot, "canvases");
    await mkdir(blockerParent, { recursive: true });
    await writeFile(join(blockerParent, "blocked"), "not a directory\n", "utf8");

    await expect(applyPackageDraftImport({ draftRoot, projectRoot: root })).rejects.toThrow();

    const projectGraph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8")) as {
      canvases: Array<{ id: string; title: string }>;
    };
    expect(projectGraph.canvases.map((canvas) => canvas.id)).toEqual(["default"]);
    expect(projectGraph.canvases[0]?.title).toBe("Test Plan");
  });

  it("validates project-shaped draft roots", async () => {
    const draftRoot = await createProjectDraft();
    await writeFile(join(draftRoot, "README.md"), "# Draft\n", "utf8");

    const result = await validatePackageDraft({ draftRoot });

    expect(result).toMatchObject({
      ok: true,
      mode: "project",
      canvases: [{ canvasId: "default", validation: { ok: true }, graphQuality: { ok: true } }]
    });
  });

  it("previews and applies project-shaped imports without stale workspace diff drift", async () => {
    const { root, init } = await createTestWorkspace();
    const stalePackageDir = join(init.workspace.workspaceRoot, "canvases", "stale", "package");
    const staleStateFile = join(init.workspace.workspaceRoot, "canvases", "stale", "state.json");
    const staleResultsDir = join(init.workspace.workspaceRoot, "canvases", "stale", "results");
    await mkdir(stalePackageDir, { recursive: true });
    await writeJsonFile(join(stalePackageDir, "manifest.json"), basicManifest());
    await writePromptFiles(stalePackageDir, basicManifest());
    await writeJsonFile(staleStateFile, { currentRefs: ["STALE#B-001"] });
    await mkdir(staleResultsDir, { recursive: true });
    await writeFile(join(staleResultsDir, "old.txt"), "stale result\n", "utf8");
    await writeJsonFile(projectGraphPath(init.workspace), {
      version: "plan-project/v1",
      canvases: [
        {
          id: "default",
          type: "canvas",
          title: "Default",
          packageDir: "canvases/default/package",
          stateFile: "canvases/default/state.json",
          resultsDir: "canvases/default/results"
        },
        {
          id: "stale",
          type: "canvas",
          title: "Stale",
          packageDir: "canvases/stale/package",
          stateFile: "canvases/stale/state.json",
          resultsDir: "canvases/stale/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });
    const draftRoot = await createProjectDraft();

    const preview = await previewPackageDraftImport({ draftRoot, projectRoot: root });
    const applied = await applyPackageDraftImport({ draftRoot, projectRoot: root });

    expect(preview.fileDiffs.map((diff) => diff.path)).not.toContain("project.json");
    expect(preview.fileDiffs).toContainEqual({ path: "canvases/stale/package/manifest.json", type: "removed" });
    expect(preview.fileDiffs).toContainEqual({ path: "canvases/stale/state.json", type: "removed" });
    expect(preview.fileDiffs).toContainEqual({ path: "canvases/stale/results/old.txt", type: "removed" });
    expect(preview.effects).toContainEqual({ type: "remove_canvas", path: "stale" });
    expect(applied.applied).toBe(true);
    await expect(access(stalePackageDir)).rejects.toThrow();
    await expect(access(staleStateFile)).rejects.toThrow();
    await expect(access(staleResultsDir)).rejects.toThrow();
  });
});
