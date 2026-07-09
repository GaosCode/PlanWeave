import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  bulkAddTaskDependencies,
  bulkSetBlockDependencies,
  bulkSetTaskDependencies,
  setTaskDependencies
} from "../graph/dependencyEdit.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

async function readManifest(path: string): Promise<PlanPackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PlanPackageManifest;
}

describe("dependency edit runtime helpers", () => {
  it("sets and clears one task dependency list", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges = [{ from: "T-001", to: "T-002", type: "depends_on" }];
    const { root, init } = await createTestWorkspace(manifest);

    const result = await setTaskDependencies({ projectRoot: root, taskId: "T-001", dependsOn: [] });
    const written = await readManifest(init.workspace.manifestFile);

    expect(result.ok).toBe(true);
    expect(written.edges).toEqual([]);
  });

  it("adds task dependencies in one mutation and leaves existing edges intact", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const { root, init } = await createTestWorkspace(manifest);

    const result = await bulkAddTaskDependencies({
      projectRoot: root,
      edges: [{ dependentTaskId: "T-001", dependsOnTaskId: "T-002" }]
    });
    const written = await readManifest(init.workspace.manifestFile);

    expect(result.ok).toBe(true);
    expect(written.edges).toEqual([{ from: "T-001", to: "T-002", type: "depends_on" }]);
  });

  it("does not write task dependency edits when any input is invalid", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const { root, init } = await createTestWorkspace(manifest);

    const result = await bulkAddTaskDependencies({
      projectRoot: root,
      edges: [
        { dependentTaskId: "T-001", dependsOnTaskId: "T-002" },
        { dependentTaskId: "T-001", dependsOnTaskId: "MISSING" }
      ]
    });
    const written = await readManifest(init.workspace.manifestFile);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("task_missing");
    expect(written.edges).toEqual([]);
  });

  it("rejects duplicate task updates instead of merging ambiguous dependency lists", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const { root, init } = await createTestWorkspace(manifest);

    const result = await bulkSetTaskDependencies({
      projectRoot: root,
      updates: [
        { taskId: "T-001", dependsOn: ["T-002"] },
        { taskId: "T-001", dependsOn: [] }
      ]
    });
    const written = await readManifest(init.workspace.manifestFile);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "duplicate_dependency_update"
    );
    expect(written.edges).toEqual([]);
  });

  it("sets block dependencies in one mutation and rejects duplicate block updates", async () => {
    const manifest = basicManifest();
    const { root, init } = await createTestWorkspace(manifest);

    const clearResult = await bulkSetBlockDependencies({
      projectRoot: root,
      updates: [{ blockRef: "T-001#R-001", dependsOn: [] }]
    });
    const cleared = await readManifest(init.workspace.manifestFile);

    expect(clearResult.ok).toBe(true);
    expect(cleared.nodes[0]?.blocks.find((block) => block.id === "R-001")?.depends_on).toEqual([]);

    const duplicateResult = await bulkSetBlockDependencies({
      projectRoot: root,
      updates: [
        { blockRef: "T-001#R-001", dependsOn: ["B-001"] },
        { blockRef: "T-001#R-001", dependsOn: [] }
      ]
    });
    const afterDuplicate = await readManifest(init.workspace.manifestFile);

    expect(duplicateResult.ok).toBe(false);
    expect(duplicateResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "duplicate_dependency_update"
    );
    expect(
      afterDuplicate.nodes[0]?.blocks.find((block) => block.id === "R-001")?.depends_on
    ).toEqual([]);
  });
});
