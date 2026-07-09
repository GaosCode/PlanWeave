import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace, searchProjectWithDiagnostics } from "../desktop/index.js";
import { createDesktopPackageFileSnapshot, refreshPackageFileChanges } from "../desktop/fileSyncApi.js";
import {
  invalidateDesktopProjectProjection,
  peekDesktopCanvasProjectionCacheEntryForTests,
  readDesktopProjectSearchIndex
} from "../desktop/graph/projectProjectionModel.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  invalidateDesktopProjectProjection();
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop projection selective invalidation", () => {
  it("prompt-only refresh rebuilds only the owning canvas and serves updated prompt content", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Sibling canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    const secondTask = secondManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (secondTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    secondTask.title = "Sibling canvas task";
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);

    await createDesktopPackageFileSnapshot(init.workspace);
    await createDesktopPackageFileSnapshot(secondWorkspace);
    await readDesktopProjectSearchIndex(root);

    const siblingBefore = peekDesktopCanvasProjectionCacheEntryForTests(root, secondCanvas.canvasId);
    const defaultBefore = peekDesktopCanvasProjectionCacheEntryForTests(root, "default");
    expect(siblingBefore).toBeDefined();
    expect(defaultBefore).toBeDefined();

    const promptNeedle = "selective invalidation prompt needle";
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      `# Edited block prompt\n\n${promptNeedle}\n`,
      "utf8"
    );

    await expect(
      refreshPackageFileChanges(init.workspace, {
        changedPaths: ["package/nodes/T-001/blocks/B-001.prompt.md"]
      })
    ).resolves.toMatchObject({
      ok: true,
      primed: false,
      fullRefresh: false,
      dirtyPromptRefs: ["T-001#B-001"]
    });

    const siblingAfter = peekDesktopCanvasProjectionCacheEntryForTests(root, secondCanvas.canvasId);
    const defaultAfter = peekDesktopCanvasProjectionCacheEntryForTests(root, "default");
    expect(siblingAfter).toBe(siblingBefore);
    expect(defaultAfter).toBeUndefined();
    expect(defaultBefore).toBeDefined();

    const search = await searchProjectWithDiagnostics(root, promptNeedle, { kinds: ["prompt"], includeBodies: true });
    expect(search.results).toEqual([
      expect.objectContaining({ canvasId: "default", ref: "T-001#B-001", targetRef: "T-001#B-001" })
    ]);
  });

  it("manifest change still fully invalidates every canvas projection entry", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Sibling canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);

    await createDesktopPackageFileSnapshot(init.workspace);
    await createDesktopPackageFileSnapshot(secondWorkspace);
    await readDesktopProjectSearchIndex(root);

    const siblingBefore = peekDesktopCanvasProjectionCacheEntryForTests(root, secondCanvas.canvasId);
    const defaultBefore = peekDesktopCanvasProjectionCacheEntryForTests(root, "default");
    expect(siblingBefore).toBeDefined();
    expect(defaultBefore).toBeDefined();

    const nextManifest = basicManifest({ includeSecondTask: true });
    await writeJsonFile(init.workspace.manifestFile, nextManifest);
    await writePromptFiles(init.workspace.packageDir, nextManifest);

    await expect(
      refreshPackageFileChanges(init.workspace, { changedPaths: ["package/manifest.json"] })
    ).resolves.toMatchObject({
      ok: true,
      primed: false,
      refreshStats: expect.objectContaining({ mode: "full" })
    });

    expect(peekDesktopCanvasProjectionCacheEntryForTests(root, secondCanvas.canvasId)).toBeUndefined();
    expect(peekDesktopCanvasProjectionCacheEntryForTests(root, "default")).toBeUndefined();

    await readDesktopProjectSearchIndex(root);
    const siblingAfter = peekDesktopCanvasProjectionCacheEntryForTests(root, secondCanvas.canvasId);
    const defaultAfter = peekDesktopCanvasProjectionCacheEntryForTests(root, "default");
    expect(siblingAfter).toBeDefined();
    expect(defaultAfter).toBeDefined();
    expect(siblingAfter).not.toBe(siblingBefore);
    expect(defaultAfter).not.toBe(defaultBefore);
  });
});
