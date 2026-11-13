import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopPackageFileSnapshot,
  detectDesktopPackageFileChanges,
  getGraphViewModel,
  redoDesktopPlanGraphCommand,
  refreshPackageFileChanges,
  removeBlock,
  undoDesktopPlanGraphCommand,
  updateTaskTitle
} from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function position(root: string) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const undo = await store.log.latestUndoable();
  const redo = await store.log.latestRedoable();
  return { cursor: undo?.id ?? null, redo: redo?.id ?? null, canUndo: !!undo, canRedo: !!redo };
}

async function setup(link: boolean, earlier: boolean) {
  const f = await createTestWorkspace();
  const path = join(f.init.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md");
  const target = join(f.init.workspace.packageDir, "target.md");
  if (link) {
    await writeFile(target, "# Saved review\r\n中文\r\n");
    await rm(path);
    await symlink("../../../target.md", path);
  }
  await createDesktopPackageFileSnapshot(f.root);
  await refreshPackageFileChanges(f.root);
  if (earlier) expect((await updateTaskTitle(f.root, "T-001", "Earlier local edit")).ok).toBe(true);
  return { ...f, path, target };
}

describe("file sync preserves the current undo and redo position", () => {
  it.each(
    [false, true].flatMap((link) =>
      [false, true].flatMap((earlier) =>
        ["detect", "refresh"].map((mode) => ({ link, earlier, mode }))
      )
    )
  )("keeps two cycles with link=$link earlier=$earlier through $mode", async ({
    link,
    earlier,
    mode
  }) => {
    const f = await setup(link, earlier);
    const before = await readFile(f.path);
    const initial = await position(f.root);
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    expect((await removeBlock(f.root, "T-001#R-001")).ok).toBe(true);
    const after = await position(f.root);
    const manifestAfter = await readFile(f.init.workspace.manifestFile);
    const versionAfter = (await getGraphViewModel(f.root)).graphVersion;
    for (let cycle = 0; cycle < 2; cycle++) {
      const snapshot = await createDesktopPackageFileSnapshot(f.root);
      expect((await undoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
      const manifestBefore = await readFile(f.init.workspace.manifestFile);
      const expected = {
        cursor: initial.cursor,
        redo: after.cursor,
        canUndo: earlier,
        canRedo: true
      };
      expect(await position(f.root)).toEqual(expected);
      const synced =
        mode === "detect"
          ? await detectDesktopPackageFileChanges(f.root, snapshot.snapshotId)
          : await refreshPackageFileChanges(f.root, {
              changedPaths: ["manifest.json", "nodes/T-001/blocks/R-001.prompt.md"]
            });
      expect(synced).toMatchObject({ ok: true, primed: false });
      expect(await position(f.root)).toEqual(expected);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
      await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestBefore);
      await expect(readFile(f.path)).resolves.toEqual(before);
      if (link) {
        expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
        expect(await readlink(f.path)).toBe("../../../target.md");
        await expect(readFile(f.target)).resolves.toEqual(before);
      }
      await createDesktopPackageFileSnapshot(f.root);
      expect((await redoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
      const redetected =
        mode === "detect"
          ? await detectDesktopPackageFileChanges(f.root)
          : await refreshPackageFileChanges(f.root, { changedPaths: ["manifest.json"] });
      expect(redetected.ok).toBe(true);
      expect(await position(f.root)).toEqual(after);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
      await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestAfter);
      await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("retains the history cursor on a same-content shared notification and clears it after an external edit", async () => {
    const manifest = basicManifest();
    const f = await createTestWorkspace(manifest);
    const shared = "shared/source.md";
    const path = join(f.init.workspace.packageDir, shared);
    await mkdir(join(f.init.workspace.packageDir, "shared"));
    await writeFile(path, "Shared history baseline");
    manifest.nodes[0].prompt = shared;
    await writeJsonFile(f.init.workspace.manifestFile, manifest);
    expect((await updateTaskTitle(f.root, "T-001", "Earlier local edit")).ok).toBe(true);
    await createDesktopPackageFileSnapshot(f.root);
    const earlier = await position(f.root);

    await writeFile(path, "Shared history baseline");
    await expect(
      refreshPackageFileChanges(f.root, { changedPaths: [shared] })
    ).resolves.toMatchObject({
      ok: true,
      dirtyPromptRefs: [],
      refreshedPromptCount: 0
    });
    expect(await position(f.root)).toEqual(earlier);

    await writeFile(path, "Shared external edit");
    await expect(
      refreshPackageFileChanges(f.root, { changedPaths: ["package/shared"] })
    ).resolves.toMatchObject({
      ok: true,
      dirtyPromptRefs: ["T-001"]
    });
    expect(await position(f.root)).toEqual({
      cursor: null,
      redo: null,
      canUndo: false,
      canRedo: false
    });
  });

  it.each([
    false,
    true
  ])("invalidates redo after an actual external edit (earlier=%s)", async (earlier) => {
    const f = await setup(false, earlier);
    expect((await removeBlock(f.root, "T-001#R-001")).ok).toBe(true);
    const snapshot = await createDesktopPackageFileSnapshot(f.root);
    expect((await undoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
    const external = "# External prompt mutation\r\n";
    await writeFile(f.path, external);
    expect((await detectDesktopPackageFileChanges(f.root, snapshot.snapshotId)).ok).toBe(true);
    expect(await position(f.root)).toEqual({
      cursor: null,
      redo: null,
      canUndo: false,
      canRedo: false
    });
    await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
    await expect(readFile(f.path, "utf8")).resolves.toBe(external);
  });
});
