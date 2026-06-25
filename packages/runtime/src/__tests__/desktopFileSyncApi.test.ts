import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopPackageFileSnapshot,
  detectDesktopPackageFileChanges,
  getDirtyPromptRefs,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges
} from "../desktop/index.js";
import {
  undoDesktopPlanGraphCommand,
  updateTaskTitle
} from "../desktop/graphApi.js";
import { writeJsonFile } from "../json.js";
import {
  executePlanGraphCommand,
  undoPlanGraphCommand
} from "../plangraph/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

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

  it("refreshes changed package prompt paths incrementally from watcher paths", async () => {
    const { root, init } = await createTestWorkspace();
    await createDesktopPackageFileSnapshot(root);

    await writeFile(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"), "# external block prompt edit\n", "utf8");
    await expect(refreshPackageFileChanges(root, { changedPaths: ["package/nodes/T-001/blocks/B-001.prompt.md"] })).resolves.toMatchObject({
      ok: true,
      primed: false,
      fullRefresh: false,
      affectedTasks: ["T-001"],
      dirtyPromptRefs: ["T-001#B-001"],
      refreshedPromptCount: 1,
      refreshConcurrency: 4,
      diagnostics: []
    });

    await writeFile(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"), "# external task prompt edit\n", "utf8");
    await expect(refreshPackageFileChanges(root, { changedPaths: ["nodes/T-001/prompt.md"] })).resolves.toMatchObject({
      ok: true,
      primed: false,
      fullRefresh: false,
      affectedTasks: ["T-001"],
      dirtyPromptRefs: ["T-001"],
      refreshedPromptCount: 2,
      refreshConcurrency: 4,
      diagnostics: []
    });
  });

  it("falls back to full package refresh for manifest, unknown, and empty watcher paths", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const { root, init } = await createTestWorkspace(manifest);
    await createDesktopPackageFileSnapshot(root);
    const nextManifest = {
      ...manifest,
      edges: [...manifest.edges, { from: "T-002", to: "T-001", type: "depends_on" as const }]
    };

    await writeJsonFile(init.workspace.manifestFile, nextManifest);
    await expect(refreshPackageFileChanges(root, { changedPaths: ["package/manifest.json"] })).resolves.toMatchObject({
      ok: true,
      primed: false,
      affectedTasks: ["T-002"],
      diagnostics: [expect.objectContaining({ code: "package_change_manifest_requires_full_refresh" })]
    });

    await expect(refreshPackageFileChanges(root, { changedPaths: ["package/nodes/T-001"] })).resolves.toMatchObject({
      ok: true,
      primed: false,
      diagnostics: [expect.objectContaining({ code: "package_change_coarse_path_requires_full_refresh" })]
    });
    await expect(refreshPackageFileChanges(root, { changedPaths: [] })).resolves.toMatchObject({
      ok: true,
      primed: false,
      diagnostics: [expect.objectContaining({ code: "package_change_paths_empty" })]
    });
  });

  it("does not turn project prompt changes into dirty package prompt refs", async () => {
    const { root, init } = await createTestWorkspace();
    await createDesktopPackageFileSnapshot(root);

    await writeFile(init.workspace.projectPromptFile, "# Updated project prompt\n", "utf8");
    await expect(refreshPackageFileChanges(root, { changedPaths: ["policy/project-prompt.md"] })).resolves.toMatchObject({
      ok: true,
      primed: false,
      dirtyPromptRefs: [],
      diagnostics: [expect.objectContaining({ code: "package_change_non_package_prompt" })]
    });
    await expect(getDirtyPromptRefs(root)).resolves.toEqual([]);
  });

  it("does not clear PlanGraph command history for project prompt watcher paths", async () => {
    const { root, init } = await createTestWorkspace();
    await createDesktopPackageFileSnapshot(root);
    await expect(updateTaskTitle(root, "T-001", "Local command edit")).resolves.toMatchObject({ ok: true });
    await expect(refreshPackageFileChanges(root)).resolves.toMatchObject({ ok: true });

    await writeFile(init.workspace.projectPromptFile, "# Updated project prompt\n", "utf8");
    await expect(refreshPackageFileChanges(root, { changedPaths: ["policy/project-prompt.md"] })).resolves.toMatchObject({
      ok: true,
      dirtyPromptRefs: [],
      diagnostics: [expect.objectContaining({ code: "package_change_non_package_prompt" })]
    });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
  });

  it("does not clear PlanGraph command history for unknown watcher paths when package files did not change", async () => {
    const { root } = await createTestWorkspace();
    await createDesktopPackageFileSnapshot(root);
    await expect(updateTaskTitle(root, "T-001", "Local command edit")).resolves.toMatchObject({ ok: true });
    await expect(refreshPackageFileChanges(root)).resolves.toMatchObject({ ok: true });

    await expect(refreshPackageFileChanges(root, { changedPaths: ["package/results/report.md"] })).resolves.toMatchObject({
      ok: true,
      dirtyPromptRefs: [],
      diagnostics: [expect.objectContaining({ code: "package_change_unknown_path_requires_full_refresh" })]
    });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
  });

  it("protects dirty refs and diagnostics when a watched prompt file is deleted", async () => {
    const { root, init } = await createTestWorkspace();
    await createDesktopPackageFileSnapshot(root);
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"));

    await expect(refreshPackageFileChanges(root, { changedPaths: ["package/nodes/T-001/blocks/B-001.prompt.md"] })).resolves.toMatchObject({
      ok: false,
      primed: false,
      fullRefresh: true,
      dirtyPromptRefs: [],
      refreshedPromptCount: 0,
      refreshConcurrency: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "package_change_incremental_refresh_failed" }),
        expect.objectContaining({ code: "prompt_missing" })
      ])
    });
    await expect(getDirtyPromptRefs(root)).resolves.toEqual([]);
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

  it("clears PlanGraph command history after detecting external package file changes", async () => {
    const { root, init } = await createTestWorkspace();
    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateTaskFields",
          taskId: "T-001",
          fields: { title: "Local command edit" }
        }
      })
    ).resolves.toMatchObject({ ok: true });

    const snapshot = await createDesktopPackageFileSnapshot(root);
    await writeFile(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"), "# external prompt edit\n", "utf8");
    await expect(detectDesktopPackageFileChanges(root, snapshot.snapshotId)).resolves.toMatchObject({
      ok: true,
      fullRefresh: true,
      dirtyPromptRefs: ["T-001"]
    });

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });
    expect(undoResult.ok).toBe(false);
    expect(undoResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("history_empty");
  });

  it("keeps PlanGraph command history when refreshing package files after a local command save", async () => {
    const { root } = await createTestWorkspace();
    await createDesktopPackageFileSnapshot(root);
    await expect(updateTaskTitle(root, "T-001", "Local command edit")).resolves.toMatchObject({ ok: true });

    await expect(refreshPackageFileChanges(root)).resolves.toMatchObject({
      ok: true,
      primed: false
    });

    const undoResult = await undoDesktopPlanGraphCommand(root);
    expect(undoResult.ok).toBe(true);
  });
});
