import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopPackageFileSnapshot,
  detectDesktopPackageFileChanges,
  getDirtyPromptRefs,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges
} from "../desktop/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop file sync API", () => {
  it("keeps package file snapshots inside runtime and returns serializable dirty prompt refs", async () => {
    const { root, init } = await createTestWorkspace();

    const snapshot = await createDesktopPackageFileSnapshot(root);
    expect(snapshot).toMatchObject({
      projectRoot: root,
      promptFileCount: 3
    });
    expect(snapshot.snapshotId).toMatch(/^PKG-SNAPSHOT-/);

    await expect(detectDesktopPackageFileChanges(root, snapshot.snapshotId)).resolves.toMatchObject({
      ok: true,
      primed: false,
      dirtyPromptRefs: []
    });
    await writeFile(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"), "# external edit\n", "utf8");

    await expect(detectDesktopPackageFileChanges(root, snapshot.snapshotId)).resolves.toMatchObject({
      ok: true,
      primed: false,
      fullRefresh: true,
      affectedTasks: ["T-001"],
      dirtyPromptRefs: ["T-001#B-001"]
    });
    await expect(getDirtyPromptRefs(root)).resolves.toEqual(["T-001#B-001"]);

    await expect(refreshChangedDesktopPackagePrompts(root, snapshot.snapshotId)).resolves.toMatchObject({
      ok: true,
      primed: false,
      fullRefresh: true,
      affectedTasks: ["T-001"],
      dirtyPromptRefs: ["T-001#B-001"]
    });
    await expect(refreshPackageFileChanges(root)).resolves.toMatchObject({
      ok: true,
      primed: false,
      dirtyPromptRefs: []
    });
  });
});
