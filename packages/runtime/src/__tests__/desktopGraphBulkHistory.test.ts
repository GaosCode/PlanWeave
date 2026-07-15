import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  bulkUpdateBlocks,
  bulkUpdateParallelPolicy,
  redoDesktopPlanGraphCommand,
  undoDesktopPlanGraphCommand
} from "../desktop/index.js";
import { readJsonFile } from "../json.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import type { ManifestImplementationBlock, PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function implementationBlock(
  manifest: PlanPackageManifest,
  taskId: string
): ManifestImplementationBlock {
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  const block = task?.blocks.find((candidate) => candidate.id === "B-001");
  if (block?.type !== "implementation") {
    throw new Error(`Implementation block '${taskId}#B-001' is missing.`);
  }
  return block;
}

describe("desktop graph bulk command history", () => {
  it("undoes and redoes all bulk block updates as one history entry", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(
      bulkUpdateBlocks(root, [
        {
          blockRef: "T-001#B-001",
          fields: { sharedResources: ["api", "api"] }
        },
        {
          blockRef: "T-002#B-001",
          fields: { sharedResources: ["runtime"] }
        }
      ])
    ).resolves.toMatchObject({ ok: true });

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(implementationBlock(manifest, "T-001").parallel).toEqual({
      sharedResources: ["api"]
    });
    expect(implementationBlock(manifest, "T-002").parallel).toEqual({
      sharedResources: ["runtime"]
    });

    const reopenedStore = await createSqlitePlanGraphStore({ projectRoot: root });
    await expect(reopenedStore.log.latestUndoable()).resolves.toMatchObject({
      command: { type: "bulkUpdateBlocks" },
      inverse: { type: "bulkUpdateBlocks" }
    });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(implementationBlock(manifest, "T-001")).not.toHaveProperty("parallel");
    expect(implementationBlock(manifest, "T-002")).not.toHaveProperty("parallel");
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });

    await expect(redoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(implementationBlock(manifest, "T-001").parallel).toEqual({
      sharedResources: ["api"]
    });
    expect(implementationBlock(manifest, "T-002").parallel).toEqual({
      sharedResources: ["runtime"]
    });
  });

  it("undoes and redoes canvas and block parallel policy as one history entry", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(
      bulkUpdateParallelPolicy(root, {
        canvasPolicy: {
          defaultExecutor: "codex-auto",
          parallelEnabled: true,
          maxConcurrent: 3
        },
        blocks: [
          { blockRef: "T-001#B-001", input: { sharedResources: ["api", "api"] } },
          { blockRef: "T-002#B-001", input: { sharedResources: ["runtime"] } }
        ]
      })
    ).resolves.toMatchObject({ ok: true });

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.execution).toEqual({
      defaultExecutor: "codex-auto",
      parallel: { enabled: true, maxConcurrent: 3 }
    });
    expect(implementationBlock(manifest, "T-001").parallel).toEqual({
      sharedResources: ["api"]
    });
    expect(implementationBlock(manifest, "T-002").parallel).toEqual({
      sharedResources: ["runtime"]
    });

    const reopenedStore = await createSqlitePlanGraphStore({ projectRoot: root });
    await expect(reopenedStore.log.latestUndoable()).resolves.toMatchObject({
      command: { type: "bulkUpdateParallelPolicy" },
      inverse: { type: "bulkUpdateParallelPolicy" }
    });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.execution).toEqual({
      parallel: { enabled: false, maxConcurrent: 1 }
    });
    expect(implementationBlock(manifest, "T-001")).not.toHaveProperty("parallel");
    expect(implementationBlock(manifest, "T-002")).not.toHaveProperty("parallel");
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });

    await expect(redoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.execution).toEqual({
      defaultExecutor: "codex-auto",
      parallel: { enabled: true, maxConcurrent: 3 }
    });
    expect(implementationBlock(manifest, "T-001").parallel).toEqual({
      sharedResources: ["api"]
    });
    expect(implementationBlock(manifest, "T-002").parallel).toEqual({
      sharedResources: ["runtime"]
    });
  });

  it("leaves no partial write or history when a later bulk block update is invalid", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(
      bulkUpdateBlocks(root, [
        {
          blockRef: "T-001#B-001",
          fields: { sharedResources: ["api"] }
        },
        {
          blockRef: "T-002#MISSING",
          fields: { sharedResources: ["runtime"] }
        }
      ])
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "block_missing" })]
    });

    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(implementationBlock(manifest, "T-001")).not.toHaveProperty("parallel");
    expect(implementationBlock(manifest, "T-002")).not.toHaveProperty("parallel");
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });

  it("returns structured diagnostics when a bulk block command fails graph validation", async () => {
    const { root, init } = await createTestWorkspace();
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");

    await expect(
      bulkUpdateBlocks(root, [
        {
          blockRef: "T-001#B-001",
          fields: { dependsOn: ["MISSING"], sharedResources: ["api"] }
        }
      ])
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "block_dependency_missing" })]
    });

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });
});
