import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBlockRunIndexView,
  recordBlockRunArtifactInIndex,
  recordBlockRunInIndex,
  removeBlockRunFromIndex
} from "../autoRun/blockRunIndex.js";
import {
  blockRunIndexPageObjectId,
  blockRunIndexV5ManifestSchema,
  blockRunIndexV5PointerSchema
} from "../autoRun/blockRunIndexSchema.js";
import { prepareBlockRun } from "../autoRun/executorShared.js";
import { readJsonFile } from "../json.js";
import {
  claimNext,
  markBlockDiverged,
  resolveBlockDivergence,
  submitBlockResult
} from "../taskManager/index.js";
import { createTestWorkspace, writeReport } from "./promptTestHelpers.js";
import { snapshotDirectory } from "./support/snapshotDirectory.js";

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

  it.each([
    "manifest",
    "root node",
    "page object",
    "legacy report"
  ])("rejects an escaping RUN index %s with zero submission side effects", async (source) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    const { resultsDir, stateFile } = init.workspace;
    const runRoot = join(resultsDir, "T-001", "blocks", "B-001", "runs");
    const indexRoot = join(runRoot, ".planweave-task-workspace-run-index");
    const options = {
      projectRoot: root,
      ref,
      reportPath: await writeReport(root, "first-indexed-report.md", "first report\n")
    };
    await claimNext({ projectRoot: root });
    expect((await submitBlockResult(options)).runId).toBe("RUN-001");
    await markBlockDiverged({ projectRoot: root, ref, reason: "new execution" });
    await resolveBlockDivergence({ projectRoot: root, ref, reason: "retry work" });
    await claimNext({ projectRoot: root, scope: { kind: "block", blockRef: ref } });
    const reportPath = await writeReport(root, "second-indexed-report.md", "second report\n");
    const outside = `${resultsDir}-outside`;
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "outside results");

    let escapedPath: string;
    if (source === "legacy report") {
      await rename(indexRoot, join(root, "saved-run-index"));
      escapedPath = join(runRoot, "RUN-001", "report.md");
    } else {
      const pointer = await readJsonFile<{ currentGeneration: string }>(
        join(indexRoot, "current.json")
      );
      const manifestPath = join(
        indexRoot,
        "generations",
        pointer.currentGeneration,
        "manifest.json"
      );
      const manifest = await readJsonFile<{ rootNodeId: string }>(manifestPath);
      const pages = await readdir(join(indexRoot, "objects"));
      expect(pages).toHaveLength(1);
      escapedPath =
        source === "manifest"
          ? manifestPath
          : source === "root node"
            ? join(indexRoot, "nodes", `${manifest.rootNodeId}.json`)
            : join(indexRoot, "objects", pages[0]!);
    }
    const external = join(outside, "redirect");
    await rename(escapedPath, external);
    await symlink(external, escapedPath, "file");
    const beforeState = await readFile(stateFile);
    const beforeResults = await snapshotDirectory(resultsDir);
    const beforeOutside = await snapshotDirectory(outside);

    await expect(submitBlockResult({ ...options, reportPath })).rejects.toMatchObject({
      code: "results_path_outside",
      message: expect.stringContaining(escapedPath)
    });
    expect(await readFile(stateFile)).toEqual(beforeState);
    expect(await snapshotDirectory(outside)).toEqual(beforeOutside);
    expect(await snapshotDirectory(resultsDir)).toEqual(beforeResults);

    await unlink(escapedPath);
    await rename(external, escapedPath);
    const replayOptions = { ...options, reportPath };
    const second = await submitBlockResult(replayOptions);
    expect(second).toEqual({ ref, runId: "RUN-002", status: "completed" });
    await expect(submitBlockResult(replayOptions)).resolves.toEqual(second);
    const index = await readBlockRunIndexView(runRoot, { limit: 2 });
    expect(index.entries.map((entry) => [entry.runId, entry.retryIndex])).toEqual([
      ["RUN-002", 2],
      ["RUN-001", 1]
    ]);
  });

  it.each([
    "planned page object",
    "queued retirement"
  ])("rejects an escaping %s before writing a prepared submission", async (source) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    const { resultsDir, stateFile } = init.workspace;
    const runRoot = join(resultsDir, "T-001", "blocks", "B-001", "runs");
    const indexRoot = join(runRoot, ".planweave-task-workspace-run-index");
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref,
      reportPath: await writeReport(root, "first.md")
    });
    await markBlockDiverged({ projectRoot: root, ref, reason: "new execution" });
    await resolveBlockDivergence({ projectRoot: root, ref, reason: "retry work" });
    const claim = await claimNext({ projectRoot: root, scope: { kind: "block", blockRef: ref } });
    if (claim.kind !== "block") throw new Error("Expected block claim");
    const second = await prepareBlockRun({
      projectRoot: root,
      claim,
      executorName: "manual",
      adapter: "manual",
      profile: { adapter: "manual" },
      prompt: "Publish the second result"
    });
    expect(second.runId).toBe("RUN-002");
    const outside = `${resultsDir}-outside`;
    await mkdir(outside);
    const external = await writeReport(outside, "sentinel", "outside Results");
    let escapedPath: string;
    if (source === "queued retirement") {
      const { currentGeneration } = await readJsonFile<{ currentGeneration: string }>(
        join(indexRoot, "current.json")
      );
      escapedPath = join(indexRoot, "generations", currentGeneration, "retirement.json");
      await rename(escapedPath, join(outside, "saved-retirement"));
    } else {
      const { entries } = await readBlockRunIndexView(runRoot, { limit: 2 });
      const resultingPage = entries.reverse().map((entry) => ({ ...entry, hasArtifact: true }));
      escapedPath = join(indexRoot, "objects", `${blockRunIndexPageObjectId(resultingPage)}.json`);
    }
    await symlink(external, escapedPath, "file");
    const beforeState = await readFile(stateFile);
    const beforeResults = await snapshotDirectory(resultsDir);
    const beforeOutside = await snapshotDirectory(outside);
    const options = {
      projectRoot: root,
      ref,
      runId: second.runId,
      reportPath: await writeReport(root, "prepared.md", "prepared result")
    };

    await expect(submitBlockResult(options)).rejects.toMatchObject({
      code: "results_path_outside",
      message: expect.stringContaining(escapedPath)
    });
    expect(await readFile(stateFile)).toEqual(beforeState);
    expect(await snapshotDirectory(resultsDir)).toEqual(beforeResults);
    expect(await snapshotDirectory(outside)).toEqual(beforeOutside);

    await unlink(escapedPath);
    if (source === "queued retirement") {
      await rename(join(outside, "saved-retirement"), escapedPath);
    }
    const result = await submitBlockResult(options);
    expect(result.runId).toBe(second.runId);
    await expect(submitBlockResult(options)).resolves.toEqual(result);
  });

  it.each([
    {
      operation: "record run",
      mutate: recordBlockRunInIndex,
      runId: "NUL.txt",
      existingRoot: false
    },
    {
      operation: "record artifact",
      mutate: recordBlockRunArtifactInIndex,
      runId: "NUL.txt",
      existingRoot: true
    },
    {
      operation: "remove run",
      mutate: removeBlockRunFromIndex,
      runId: "NUL.txt",
      existingRoot: true
    },
    {
      operation: "record a hidden directory as a run",
      mutate: recordBlockRunInIndex,
      runId: ".planweave-task-workspace-run-index",
      existingRoot: false
    }
  ])("rejects an unsafe ID before attempting to $operation", async ({
    mutate,
    runId,
    existingRoot
  }) => {
    const { init } = await createTestWorkspace();
    const { resultsDir } = init.workspace;
    const runRoot = join(resultsDir, "T-001", "blocks", "B-001", "runs");
    if (existingRoot) await mkdir(runRoot, { recursive: true });
    const before = await snapshotDirectory(resultsDir);

    await expect(mutate(runRoot, runId)).rejects.toMatchObject({
      code: "results_path_outside",
      message: expect.stringContaining(runId)
    });
    expect(await snapshotDirectory(resultsDir)).toEqual(before);
  });
});
