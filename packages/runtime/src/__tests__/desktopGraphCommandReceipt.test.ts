import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGraphViewModel, removeDependencyEdge } from "../desktop/index.js";
import { readJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { undoPlanGraphCommand } from "../plangraph/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("Desktop graph command receipts", () => {
  it("preserves a committed deletion receipt when Desktop layout persistence fails", async () => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] })
    );
    const { workspace } = await loadPackage(root);
    await mkdir(join(workspace.workspaceRoot, "desktop/layout.json"), { recursive: true });
    const beforeVersion = (await getGraphViewModel(root)).graphVersion;
    const result = await removeDependencyEdge(root, "T-001", "T-002", beforeVersion, {
      version: "desktop-layout/v1",
      projectId: init.workspace.id,
      nodes: [],
      updatedAt: new Date(0).toISOString()
    });
    expect(result.ok).toBe(false);
    expect(result.committed?.graphVersion).toBe((await getGraphViewModel(root)).graphVersion);
    expect(result.committed?.graphVersion).not.toBe(beforeVersion);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "desktop_post_commit_failed",
        message: expect.stringContaining("EISDIR")
      })
    ]);
    expect((await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile)).edges).toEqual(
      []
    );
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    expect((await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile)).edges).toEqual([
      { from: "T-001", to: "T-002", type: "depends_on" }
    ]);
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });
});
