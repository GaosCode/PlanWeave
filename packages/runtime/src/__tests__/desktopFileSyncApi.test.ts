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

  it("keeps snapshot ids bounded per project while retaining the latest baseline snapshot", async () => {
    const { root, init } = await createTestWorkspace();
    const snapshots: Awaited<ReturnType<typeof createDesktopPackageFileSnapshot>>[] = [];

    for (let index = 0; index < 6; index += 1) {
      snapshots.push(await createDesktopPackageFileSnapshot(root));
    }

    await expect(detectDesktopPackageFileChanges(root, snapshots[0].snapshotId)).rejects.toThrow(
      `Package file snapshot '${snapshots[0].snapshotId}' has expired or does not exist.`
    );
    await expect(detectDesktopPackageFileChanges(root, snapshots[1].snapshotId)).resolves.toMatchObject({
      ok: true,
      primed: false,
      dirtyPromptRefs: []
    });

    await writeFile(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"), "# latest baseline edit\n", "utf8");
    await expect(detectDesktopPackageFileChanges(root)).resolves.toMatchObject({
      ok: true,
      primed: false,
      fullRefresh: true,
      affectedTasks: ["T-001"],
      dirtyPromptRefs: ["T-001"]
    });
  });

  it("does not consume snapshot id slots for refresh results that do not return a new snapshot id", async () => {
    const { root, init } = await createTestWorkspace();
    const snapshot = await createDesktopPackageFileSnapshot(root);

    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"), `# refresh edit ${index}\n`, "utf8");
      await expect(refreshPackageFileChanges(root)).resolves.toMatchObject({
        ok: true,
        primed: false
      });
    }

    await expect(detectDesktopPackageFileChanges(root, snapshot.snapshotId)).resolves.toMatchObject({
      ok: true,
      primed: false,
      fullRefresh: true,
      affectedTasks: ["T-001"],
      dirtyPromptRefs: ["T-001"]
    });
  });

  it("rejects snapshot ids from another project with a clear error", async () => {
    const first = await createTestWorkspace();
    const firstSnapshot = await createDesktopPackageFileSnapshot(first.root);
    const second = await createTestWorkspace();

    await expect(detectDesktopPackageFileChanges(second.root, firstSnapshot.snapshotId)).rejects.toThrow(
      `Package file snapshot '${firstSnapshot.snapshotId}' belongs to a different project.`
    );
  });

  it("returns the user-facing project root instead of the internal workspace key", async () => {
    const { init } = await createTestWorkspace();

    await expect(createDesktopPackageFileSnapshot(init.workspace)).resolves.toMatchObject({
      projectRoot: init.workspace.rootPath
    });
    await expect(createDesktopPackageFileSnapshot(init.workspace)).resolves.not.toMatchObject({
      projectRoot: init.workspace.workspaceRoot
    });
  });
});
