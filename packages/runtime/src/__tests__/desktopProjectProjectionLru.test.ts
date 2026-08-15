import * as fsPromises from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import {
  DesktopProjectProjectionLru,
  projectionContextCache,
  useDesktopProjectProjectionCacheCapacityForTests
} from "../desktop/graph/projectProjectionCache.js";
import {
  buildDesktopProjectStatisticsProjectionFromProjection,
  invalidateDesktopCanvasProjection,
  invalidateDesktopProjectProjection,
  peekDesktopCanvasProjectionCacheEntryForTests,
  readDesktopProjectProjectionContext,
  readDesktopProjectSearchIndex,
  readDesktopProjectSearchIndexFromContext
} from "../desktop/graph/projectProjectionModel.js";
import {
  getResultsFingerprintFullScanCount,
  hydrateResultsFileIndexBodies,
  resetResultsFingerprintFullScanCount
} from "../desktop/graph/resultsFileIndex.js";
import { searchDesktopSearchIndex } from "../desktop/graph/searchIndexModel.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
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

describe("desktop project projection LRU", () => {
  it("enforces its capacity boundary without evicting an entry at the limit", () => {
    const released: string[] = [];
    const cache = new DesktopProjectProjectionLru<string>(2, (value) => released.push(value));

    cache.set("first", "first value");
    cache.set("second", "second value");

    expect(released).toEqual([]);
    expect(cache.peek("first")).toBe("first value");
    expect(cache.peek("second")).toBe("second value");

    cache.set("third", "third value");

    expect(released).toEqual(["first value"]);
    expect(cache.peek("first")).toBeUndefined();
    expect(cache.peek("second")).toBe("second value");
    expect(cache.peek("third")).toBe("third value");
  });

  it("promotes cache hits ahead of eviction", () => {
    const hitReleases: string[] = [];
    const hitCache = new DesktopProjectProjectionLru<string>(2, (value) => hitReleases.push(value));
    hitCache.set("first", "first value");
    hitCache.set("second", "second value");

    expect(hitCache.get("first")).toBe("first value");
    hitCache.set("third", "third value");

    expect(hitReleases).toEqual(["second value"]);
  });

  it("touches a same-object update without releasing it", () => {
    const first = { value: "first" };
    const second = { value: "second" };
    const third = { value: "third" };
    const released: Array<{ value: string }> = [];
    const cache = new DesktopProjectProjectionLru(2, (value) => released.push(value));

    cache.set("first", first);
    cache.set("second", second);
    cache.set("first", first);
    cache.set("third", third);

    expect(released).toEqual([second]);
    expect(cache.get("first")).toBe(first);
  });

  it("releases a different value when replacing an existing key and promotes the replacement", () => {
    const first = { value: "first" };
    const replacement = { value: "replacement" };
    const second = { value: "second" };
    const third = { value: "third" };
    const released: Array<{ value: string }> = [];
    const cache = new DesktopProjectProjectionLru(2, (value) => released.push(value));

    cache.set("first", first);
    cache.set("second", second);
    cache.set("first", replacement);

    expect(released).toEqual([first]);

    cache.set("third", third);

    expect(released).toEqual([first, second]);
    expect(cache.get("first")).toBe(replacement);
  });

  it("releases every retained entry when the cache is cleared", () => {
    const released: string[] = [];
    const cache = new DesktopProjectProjectionLru<string>(2, (value) => released.push(value));
    cache.set("first", "first value");
    cache.set("second", "second value");

    cache.clear();

    expect(released).toEqual(["first value", "second value"]);
    expect(cache.peek("first")).toBeUndefined();
    expect(cache.peek("second")).toBeUndefined();
  });

  it("releases replaced project container references without clearing a reused canvas entry", async () => {
    const { root } = await createTestWorkspace();
    const oldContext = await readDesktopProjectProjectionContext(root);
    const oldCached = projectionContextCache.get(oldContext);
    if (!oldCached) {
      throw new Error("Expected the first projection context to own a cache entry.");
    }
    await readDesktopProjectSearchIndexFromContext(oldContext, { includeBodies: true });
    oldCached.statisticsProjection = await buildDesktopProjectStatisticsProjectionFromProjection(
      oldContext.projection,
      root
    );
    const reusedCanvas = oldCached.canvases.get("default");
    expect(reusedCanvas).toBeDefined();
    expect(oldCached.searchIndex).not.toBeNull();
    expect(oldCached.bodySearchIndex).not.toBeNull();
    expect(oldCached.statisticsProjection).not.toBeNull();

    await readDesktopProjectProjectionContext(root);

    expect(peekDesktopCanvasProjectionCacheEntryForTests(root, "default")).toBe(reusedCanvas);
    expect(oldCached.canvases.size).toBe(0);
    expect(oldCached.searchIndex).toBeNull();
    expect(oldCached.bodySearchIndex).toBeNull();
    expect(oldCached.statisticsProjection).toBeNull();
  });

  it("preserves retained results directories and clears only an unowned old canvas cache", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Removed from replacement" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const defaultRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-RETAINED-RESULTS"
    );
    const secondRunDir = join(
      secondWorkspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-RELEASED-RESULTS"
    );
    const defaultReportPath = join(defaultRunDir, "report.md");
    const secondReportPath = join(secondRunDir, "report.md");
    await fsPromises.mkdir(defaultRunDir, { recursive: true });
    await fsPromises.mkdir(secondRunDir, { recursive: true });
    await writeFile(defaultReportPath, "retained replacement result body\n", "utf8");
    await writeFile(secondReportPath, "released replacement result body\n", "utf8");

    const oldContext = await readDesktopProjectProjectionContext(root);
    await readDesktopProjectSearchIndexFromContext(oldContext, { includeBodies: true });
    const oldDefaultIndex = oldContext.projection.resultsByCanvas.get("default");
    const oldSecondIndex = oldContext.projection.resultsByCanvas.get(secondCanvas.canvasId);
    if (!oldDefaultIndex || !oldSecondIndex) {
      throw new Error("Expected both canvas results indexes in the old projection.");
    }

    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Test Plan" })],
      edges: [],
      crossTaskEdges: []
    });
    await readDesktopProjectProjectionContext(root);

    vi.mocked(fsPromises.readFile).mockClear();
    await hydrateResultsFileIndexBodies(oldDefaultIndex);
    await hydrateResultsFileIndexBodies(oldSecondIndex);

    expect(resultReadPaths(init.workspace.resultsDir)).not.toContain(defaultReportPath);
    expect(resultReadPaths(secondWorkspace.resultsDir)).toContain(secondReportPath);
  });

  it("keeps a reused results cache after replacement and selective canvas invalidation", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-REUSED-ENTRY"
    );
    const reportPath = join(runDir, "report.md");
    await fsPromises.mkdir(runDir, { recursive: true });
    await writeFile(reportPath, "reused entry result body\n", "utf8");

    await readDesktopProjectSearchIndex(root, { includeBodies: true });
    const reusedEntry = peekDesktopCanvasProjectionCacheEntryForTests(root, "default");
    await readDesktopProjectProjectionContext(root);
    expect(peekDesktopCanvasProjectionCacheEntryForTests(root, "default")).toBe(reusedEntry);

    invalidateDesktopCanvasProjection(root, "default");
    vi.mocked(fsPromises.readFile).mockClear();
    await readDesktopProjectSearchIndex(root, { includeBodies: true });

    expect(resultReadPaths(init.workspace.resultsDir)).not.toContain(reportPath);
  });

  it("evicts the least recently used project and clears its cached result metadata and bodies", async () => {
    const restoreCapacity = useDesktopProjectProjectionCacheCapacityForTests(2);
    try {
      const first = await createTestWorkspace();
      const second = await createTestWorkspace();
      const third = await createTestWorkspace();
      const runDir = join(
        first.init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-PROJECT-EVICT"
      );
      const reportPath = join(runDir, "report.md");
      const metadataPath = join(runDir, "metadata.json");
      await fsPromises.mkdir(runDir, { recursive: true });
      await writeFile(reportPath, "project eviction result body needle\n", "utf8");
      await writeJsonFile(metadataPath, {
        runId: "RUN-PROJECT-EVICT",
        finishedAt: null
      });

      resetResultsFingerprintFullScanCount();
      process.env.PLANWEAVE_HOME = first.home;
      await readDesktopProjectSearchIndex(first.root, { includeBodies: true });
      process.env.PLANWEAVE_HOME = second.home;
      await readDesktopProjectSearchIndex(second.root);
      process.env.PLANWEAVE_HOME = third.home;
      await readDesktopProjectSearchIndex(third.root);
      const scansBeforeReread = getResultsFingerprintFullScanCount();

      vi.mocked(fsPromises.readFile).mockClear();
      process.env.PLANWEAVE_HOME = first.home;
      await readDesktopProjectSearchIndex(first.root, { includeBodies: true });

      expect(getResultsFingerprintFullScanCount()).toBeGreaterThan(scansBeforeReread);
      expect(resultReadPaths(first.init.workspace.resultsDir)).toEqual(
        expect.arrayContaining([metadataPath, reportPath])
      );
    } finally {
      restoreCapacity();
    }
  });

  it("rebuilds an evicted projection context instead of binding it to a newer cache entry", async () => {
    const restoreCapacity = useDesktopProjectProjectionCacheCapacityForTests(1);
    try {
      const first = await createTestWorkspace();
      const second = await createTestWorkspace();
      const runDir = join(
        first.init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-EVICTED-CONTEXT"
      );
      const reportPath = join(runDir, "report.md");
      await fsPromises.mkdir(runDir, { recursive: true });
      await writeFile(reportPath, "evicted context result body needle\n", "utf8");

      process.env.PLANWEAVE_HOME = first.home;
      const oldContext = await readDesktopProjectProjectionContext(first.root);
      process.env.PLANWEAVE_HOME = second.home;
      await readDesktopProjectSearchIndex(second.root);
      vi.mocked(fsPromises.readFile).mockClear();
      process.env.PLANWEAVE_HOME = first.home;

      const rebuilt = await readDesktopProjectSearchIndexFromContext(oldContext, {
        includeBodies: true
      });

      expect(resultReadPaths(first.init.workspace.resultsDir)).toContain(reportPath);
      expect(
        searchDesktopSearchIndex(rebuilt, "evicted context result body needle", {
          kinds: ["run_record"]
        })
      ).toEqual([
        expect.objectContaining({
          canvasId: "default",
          ref: "T-001/blocks/B-001/runs/RUN-EVICTED-CONTEXT/report.md"
        })
      ]);
    } finally {
      restoreCapacity();
    }
  });

  it("releases nested result bodies for every project during a full cache clear", async () => {
    const first = await createTestWorkspace();
    const second = await createTestWorkspace();
    const firstRunDir = join(
      first.init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-FULL-CLEAR-FIRST"
    );
    const secondRunDir = join(
      second.init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-FULL-CLEAR-SECOND"
    );
    const firstReportPath = join(firstRunDir, "report.md");
    const secondReportPath = join(secondRunDir, "report.md");
    await fsPromises.mkdir(firstRunDir, { recursive: true });
    await fsPromises.mkdir(secondRunDir, { recursive: true });
    await writeFile(firstReportPath, "full clear first body needle\n", "utf8");
    await writeFile(secondReportPath, "full clear second body needle\n", "utf8");

    process.env.PLANWEAVE_HOME = first.home;
    await readDesktopProjectSearchIndex(first.root, { includeBodies: true });
    process.env.PLANWEAVE_HOME = second.home;
    await readDesktopProjectSearchIndex(second.root, { includeBodies: true });
    vi.mocked(fsPromises.readFile).mockClear();
    invalidateDesktopProjectProjection();
    process.env.PLANWEAVE_HOME = first.home;
    await readDesktopProjectSearchIndex(first.root, { includeBodies: true });
    process.env.PLANWEAVE_HOME = second.home;
    await readDesktopProjectSearchIndex(second.root, { includeBodies: true });

    expect(resultReadPaths(first.init.workspace.resultsDir)).toContain(firstReportPath);
    expect(resultReadPaths(second.init.workspace.resultsDir)).toContain(secondReportPath);
  });
});
