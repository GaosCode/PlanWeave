import * as fsPromises from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopProjectProjectionCacheCapacityForTests } from "../desktop/graph/projectProjectionCache.js";
import {
  invalidateDesktopCanvasProjection,
  invalidateDesktopProjectProjection,
  invalidateDesktopProjectProjectionDerived,
  readDesktopProjectSearchIndex
} from "../desktop/graph/projectProjectionModel.js";
import {
  getResultsFingerprintFullScanCount,
  resetResultsFingerprintFullScanCount
} from "../desktop/graph/resultsFileIndex.js";
import { writeJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile)
  };
});

afterEach(() => {
  vi.clearAllMocks();
  invalidateDesktopProjectProjection();
  resetResultsFingerprintFullScanCount();
  delete process.env.PLANWEAVE_HOME;
});

function resultReadPaths(resultsDir: string): string[] {
  return vi
    .mocked(fsPromises.readFile)
    .mock.calls.map(([path]) => (typeof path === "string" ? path : null))
    .filter((path): path is string => path !== null && path.startsWith(resultsDir));
}

async function writeCachedRun(
  resultsDir: string,
  runId: string
): Promise<{
  metadataPath: string;
  reportPath: string;
}> {
  const runDir = join(resultsDir, "T-001", "blocks", "B-001", "runs", runId);
  const metadataPath = join(runDir, "metadata.json");
  const reportPath = join(runDir, "report.md");
  await fsPromises.mkdir(runDir, { recursive: true });
  await writeJsonFile(metadataPath, { runId, finishedAt: null });
  await writeFile(reportPath, `${runId} result body\n`, "utf8");
  return { metadataPath, reportPath };
}

async function expectNestedResultsCacheReleased(input: {
  projectRoot: string;
  resultsDir: string;
  metadataPath: string;
  reportPath: string;
  scansBeforeReread: number;
}): Promise<void> {
  vi.mocked(fsPromises.readFile).mockClear();
  await readDesktopProjectSearchIndex(input.projectRoot, { includeBodies: true });

  expect(getResultsFingerprintFullScanCount()).toBeGreaterThan(input.scansBeforeReread);
  expect(resultReadPaths(input.resultsDir)).toEqual(
    expect.arrayContaining([input.metadataPath, input.reportPath])
  );
}

describe("desktop project projection results ownership release", () => {
  it("releases nested caches after selective canvas invalidation followed by project deletion", async () => {
    const { root, init } = await createTestWorkspace();
    const run = await writeCachedRun(init.workspace.resultsDir, "RUN-SELECTIVE-DELETE");
    resetResultsFingerprintFullScanCount();
    await readDesktopProjectSearchIndex(root, { includeBodies: true });

    invalidateDesktopCanvasProjection(root, "default");
    invalidateDesktopProjectProjection(root);
    const scansBeforeReread = getResultsFingerprintFullScanCount();

    await expectNestedResultsCacheReleased({
      projectRoot: root,
      resultsDir: init.workspace.resultsDir,
      ...run,
      scansBeforeReread
    });
  });

  it("releases nested caches after derived invalidation followed by project deletion", async () => {
    const { root, init } = await createTestWorkspace();
    const run = await writeCachedRun(init.workspace.resultsDir, "RUN-DERIVED-DELETE");
    resetResultsFingerprintFullScanCount();
    await readDesktopProjectSearchIndex(root, { includeBodies: true });

    invalidateDesktopProjectProjectionDerived(root);
    invalidateDesktopProjectProjection(root);
    const scansBeforeReread = getResultsFingerprintFullScanCount();

    await expectNestedResultsCacheReleased({
      projectRoot: root,
      resultsDir: init.workspace.resultsDir,
      ...run,
      scansBeforeReread
    });
  });

  it("retains results ownership through selective invalidation until LRU eviction", async () => {
    const restoreCapacity = useDesktopProjectProjectionCacheCapacityForTests(2);
    try {
      const first = await createTestWorkspace();
      const second = await createTestWorkspace();
      const third = await createTestWorkspace();
      const run = await writeCachedRun(first.init.workspace.resultsDir, "RUN-SELECTIVE-EVICT");
      resetResultsFingerprintFullScanCount();

      process.env.PLANWEAVE_HOME = first.home;
      await readDesktopProjectSearchIndex(first.root, { includeBodies: true });
      invalidateDesktopCanvasProjection(first.root, "default");
      process.env.PLANWEAVE_HOME = second.home;
      await readDesktopProjectSearchIndex(second.root);
      process.env.PLANWEAVE_HOME = third.home;
      await readDesktopProjectSearchIndex(third.root);
      const scansBeforeReread = getResultsFingerprintFullScanCount();

      process.env.PLANWEAVE_HOME = first.home;
      await expectNestedResultsCacheReleased({
        projectRoot: first.root,
        resultsDir: first.init.workspace.resultsDir,
        ...run,
        scansBeforeReread
      });
    } finally {
      restoreCapacity();
    }
  });
});
