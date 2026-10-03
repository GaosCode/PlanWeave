import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  executePlanGraphCommand,
  loadPlanGraphPackage,
  redoPlanGraphCommand,
  undoPlanGraphCommand
} from "../plangraph/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("PlanGraph dependency deletion history", () => {
  it.each([
    "complete",
    "external"
  ])("preserves versions and single-step history for multi-edge deletion: %s", async (scenario) => {
    const manifest = basicManifest({ includeSecondTask: true });
    for (const taskId of ["T-003", "T-004"])
      manifest.nodes.push({
        id: taskId,
        type: "task",
        title: taskId,
        prompt: `nodes/${taskId}/prompt.md`,
        acceptance: ["Done"],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Implement",
            prompt: `nodes/${taskId}/blocks/B-001.prompt.md`,
            depends_on: []
          }
        ]
      });
    const originalEdges: PlanPackageManifest["edges"] = ["T-002", "T-003", "T-004"].map((to) => ({
      from: "T-001",
      to,
      type: "depends_on"
    }));
    manifest.edges = originalEdges;
    const { root, init } = await createTestWorkspace(manifest);
    let version = (await loadPlanGraphPackage(root)).graph.graphVersion;
    const versions = [version];
    for (let index = 0; index < originalEdges.length; index += 1) {
      if (scenario === "external" && index === 1) {
        const external = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
        external.project.title = "External graph edit";
        await writeJsonFile(init.workspace.manifestFile, external);
        const before = await readFile(init.workspace.manifestFile, "utf8");
        const refused = await executePlanGraphCommand({
          projectRoot: root,
          command: {
            type: "removeTaskDependency",
            fromTaskId: originalEdges[index].from,
            toTaskId: originalEdges[index].to,
            baseGraphVersion: version
          }
        });
        expect(refused.ok).toBe(false);
        expect(refused.diagnostics.map((item) => item.code)).toContain("graph_version_conflict");
        expect(await readFile(init.workspace.manifestFile, "utf8")).toBe(before);
        const persisted = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
        expect(persisted.project.title).toBe("External graph edit");
        expect(persisted.edges).toEqual(originalEdges.slice(1));
        return;
      }
      const result = await executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "removeTaskDependency",
          fromTaskId: originalEdges[index].from,
          toTaskId: originalEdges[index].to,
          baseGraphVersion: version
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected a persisted dependency deletion");
      expect(result.graphVersion).not.toBe(version);
      const loaded = await loadPlanGraphPackage(root);
      expect(result.graphVersion).toBe(loaded.graph.graphVersion);
      expect((await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile)).edges).toEqual(
        originalEdges.slice(index + 1)
      );
      version = result.graphVersion;
      versions.push(version);
    }
    expect(new Set(versions).size).toBe(4);
    for (let count = 1; count <= originalEdges.length; count += 1) {
      const undone = await undoPlanGraphCommand({ projectRoot: root });
      expect(undone.ok, `undo step ${count}: ${JSON.stringify(undone.diagnostics)}`).toBe(true);
      expect(undone.graphVersion).toBe((await loadPlanGraphPackage(root)).graph.graphVersion);
      expect((await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile)).edges).toEqual(
        originalEdges.slice(-count)
      );
    }
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
    for (let count = 1; count <= originalEdges.length; count += 1) {
      const redone = await redoPlanGraphCommand({ projectRoot: root });
      expect(redone.ok).toBe(true);
      expect(redone.graphVersion).toBe((await loadPlanGraphPackage(root)).graph.graphVersion);
      expect((await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile)).edges).toEqual(
        originalEdges.slice(count)
      );
    }
    await expect(redoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });

  it.each([
    -1, 0.5, 2
  ])("rejects an invalid dependency insertion index %s without writing or recording history", async (insertIndex) => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const before = await readFile(init.workspace.manifestFile, "utf8");
    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: { type: "addTaskDependency", fromTaskId: "T-001", toTaskId: "T-002", insertIndex }
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("edge_insert_index_invalid");
    expect(await readFile(init.workspace.manifestFile, "utf8")).toBe(before);
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });
});
