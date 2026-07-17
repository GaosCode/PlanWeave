import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockRunIndexV5ManifestSchema,
  blockRunIndexV5PointerSchema
} from "../autoRun/blockRunIndexSchema.js";
import { readJsonFile } from "../json.js";
import { claimNext, submitBlockResult } from "../taskManager/index.js";
import { createTestWorkspace, writeReport } from "./promptTestHelpers.js";

describe("block submission run index", () => {
  it("publishes one v5 generation containing the run and its artifact", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });

    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "report.md")
    });

    const indexRoot = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      ".planweave-task-workspace-run-index"
    );
    const pointer = blockRunIndexV5PointerSchema.parse(
      await readJsonFile(join(indexRoot, "current.json"))
    );
    const manifest = blockRunIndexV5ManifestSchema.parse(
      await readJsonFile(join(indexRoot, "generations", pointer.currentGeneration, "manifest.json"))
    );

    expect(pointer.previousGeneration).toBeNull();
    expect(manifest.latestArtifact?.runId).toBe("RUN-001");
    expect(await readdir(join(indexRoot, "generations"))).toEqual([pointer.currentGeneration]);
  });
});
