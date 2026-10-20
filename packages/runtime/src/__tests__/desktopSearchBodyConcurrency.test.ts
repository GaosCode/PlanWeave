import * as fs from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskCanvas,
  resolveTaskCanvasWorkspace,
  searchProjectWithDiagnostics
} from "../desktop/index.js";
import {
  invalidateDesktopCanvasProjection,
  invalidateDesktopProjectProjection,
  readDesktopProjectProjectionContext
} from "../desktop/graph/projectProjectionModel.js";
import {
  projectionContextCache,
  useDesktopProjectProjectionCacheCapacityForTests
} from "../desktop/graph/projectProjectionCache.js";
import {
  clearResultsFileIndexCache,
  hydrateResultsFileIndexBodies
} from "../desktop/graph/resultsFileIndex.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

const io = vi.hoisted(() => ({
  pause: null as string | null,
  entered: null as (() => void) | null,
  release: null as Promise<void> | null,
  failures: new Set<string>(),
  rejectHydration: false
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      const result = actual.readFile(...args);
      // Start the real read before pausing so a late generation retains its old bytes.
      if (args[0] === io.pause) {
        io.entered?.();
        await io.release;
      }
      if (typeof args[0] === "string" && io.failures.has(args[0])) {
        await result;
        throw new Error("injected body read failure");
      }
      return result;
    })
  };
});
vi.mock("../desktop/graph/resultsFileIndex.js", async (original) => {
  const actual = await original<typeof import("../desktop/graph/resultsFileIndex.js")>();
  return {
    ...actual,
    hydrateResultsFileIndexBodies: async (
      ...args: Parameters<typeof actual.hydrateResultsFileIndexBodies>
    ) => {
      const result = await actual.hydrateResultsFileIndexBodies(...args);
      if (io.rejectHydration) throw new Error("injected hydration rejection");
      return result;
    }
  };
});
const ownedDirectories: string[] = [];
afterEach(async () => {
  invalidateDesktopProjectProjection();
  vi.clearAllMocks();
  io.pause = io.entered = io.release = null;
  io.failures.clear();
  io.rejectHydration = false;
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  delete process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS;
  for (const path of ownedDirectories.splice(0))
    await fs.rm(path, { recursive: true, force: true });
});
async function fixture(home?: string) {
  const workspace = await createTestWorkspace(basicManifest(), { planweaveHome: home });
  ownedDirectories.push(workspace.root);
  if (!home) ownedDirectories.push(workspace.home);
  const canvases = [{ id: "default", workspace: workspace.init.workspace }];
  const sibling = await createTaskCanvas(workspace.root, { name: "Sibling" });
  const siblingWorkspace = await resolveTaskCanvasWorkspace(workspace.root, sibling.canvasId);
  await writeJsonFile(siblingWorkspace.manifestFile, basicManifest());
  await writePromptFiles(siblingWorkspace.packageDir, basicManifest());
  canvases.push({ id: sibling.canvasId, workspace: siblingWorkspace });
  const bodies: string[][] = [];
  for (const canvas of canvases) {
    const report = join(canvas.workspace.resultsDir, "T-001/blocks/B-001/runs/RUN-001/report.md");
    const review = join(
      canvas.workspace.resultsDir,
      "T-001/reviews/R-001/attempts/REV-001/review.md"
    );
    await fs.mkdir(join(report, ".."), { recursive: true });
    await fs.mkdir(join(review, ".."), { recursive: true });
    await fs.writeFile(report, "concurrent needle report\n");
    await fs.writeFile(review, "concurrent needle review\n");
    const prompt = join(canvas.workspace.packageDir, "nodes/T-001/prompt.md");
    await fs.writeFile(prompt, "concurrent needle prompt\n");
    bodies.push([
      prompt,
      join(canvas.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      join(canvas.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md"),
      report,
      review
    ]);
  }
  // Cold body index, existing shared projection entry.
  await searchProjectWithDiagnostics(workspace.root, "needle", { includeBodies: false });
  vi.mocked(fs.readFile).mockClear();
  return { ...workspace, canvases, bodies };
}
function reads(paths: string[]) {
  return vi
    .mocked(fs.readFile)
    .mock.calls.map(([path]) => path)
    .filter((path) => typeof path === "string" && paths.includes(path));
}
function expected(canvasId: string) {
  return [
    expect.objectContaining({ canvasId, kind: "prompt", ref: "T-001" }),
    expect.objectContaining({
      canvasId,
      kind: "review_attempt",
      ref: "T-001/reviews/R-001/attempts/REV-001/review.md"
    }),
    expect.objectContaining({
      canvasId,
      kind: "run_record",
      ref: "T-001/blocks/B-001/runs/RUN-001/report.md"
    })
  ];
}
function pause(path: string) {
  let release!: () => void;
  io.pause = path;
  io.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    io.entered = resolve;
  });
  return {
    entered,
    release: () => {
      io.pause = null;
      release();
    }
  };
}
async function startSearch(root: string, canvasId?: string) {
  // Observe publication only to order the second caller; assertions use public search results and real reads.
  const original = projectionContextCache.set;
  let published!: () => void;
  const publication = new Promise<void>((resolve) => {
    published = resolve;
  });
  projectionContextCache.set = (key, value) => {
    original.call(projectionContextCache, key, value);
    published();
    return projectionContextCache;
  };
  const result = searchProjectWithDiagnostics(root, "concurrent needle", { canvasId });
  try {
    await publication;
    await setImmediate();
  } finally {
    projectionContextCache.set = original;
  }
  return { result };
}

describe("concurrent search body entry lifecycle", () => {
  it("shares one selected body batch while summary and other canvases remain independent", async () => {
    const f = await fixture();
    process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS = "0";
    const gate = pause(f.bodies[0][3]);
    const first = searchProjectWithDiagnostics(f.root, "concurrent needle", {
      canvasId: "default"
    });
    await gate.entered;
    try {
      const second = await startSearch(f.root, "default");
      const summary = await searchProjectWithDiagnostics(f.root, "concurrent needle", {
        includeBodies: false
      });
      expect(summary.results).toEqual([]);
      expect(reads(f.bodies[0].slice(3))).toHaveLength(2);
      expect(reads(f.bodies[1])).toEqual([]);
      const sibling = await searchProjectWithDiagnostics(f.root, "concurrent needle", {
        canvasId: f.canvases[1].id
      });
      expect(sibling.results).toEqual(expected(f.canvases[1].id));
      gate.release();
      const results = await Promise.all([first, second.result]);
      expect(results[0].results).toEqual(results[1].results);
      const bodyDiagnostics = results.map((result) =>
        result.diagnostics.filter(
          (diagnostic) =>
            diagnostic.path === "default" &&
            (diagnostic.message.includes("search result body index hydration") ||
              diagnostic.message.includes("body search index construction"))
        )
      );
      expect(bodyDiagnostics[0]).toHaveLength(2);
      expect(bodyDiagnostics[0]).toEqual(bodyDiagnostics[1]);
      expect(results[0].results).toEqual(expected("default"));
      expect(reads(f.bodies[0])).toHaveLength(5);
      expect(reads(f.bodies[1])).toHaveLength(5);
    } finally {
      gate.release();
      await first;
    }
  });

  it("shares selected and all-canvas work without sharing across projects", async () => {
    const f = await fixture();
    const other = await fixture(f.home);
    const gate = pause(f.bodies[0][3]);
    const selected = searchProjectWithDiagnostics(f.root, "concurrent needle", {
      canvasId: "default"
    });
    await gate.entered;
    try {
      const all = await startSearch(f.root);
      const independent = await searchProjectWithDiagnostics(other.root, "concurrent needle", {
        canvasId: "default"
      });
      expect(independent.results).toEqual(expected("default"));
      gate.release();
      expect((await selected).results).toEqual(expected("default"));
      expect((await all.result).results).toEqual([
        expected("default")[0],
        expected(f.canvases[1].id)[0],
        ...expected("default").slice(1),
        ...expected(f.canvases[1].id).slice(1)
      ]);
      expect(reads(f.bodies[0])).toHaveLength(5);
      expect(reads(other.bodies[0])).toHaveLength(5);
      expect(reads(other.bodies[1])).toEqual([]);
    } finally {
      gate.release();
      await selected;
    }
  });

  it.each([
    { failure: "all", scope: "selected" },
    { failure: "partial", scope: "selected" },
    { failure: "all", scope: "project" },
    { failure: "partial", scope: "project" }
  ])("delivers consistent $failure read failures for $scope and retries without invalidation", async ({
    failure,
    scope
  }) => {
    const f = await fixture();
    const canvasId = scope === "selected" ? "default" : undefined;
    const gate = pause(f.bodies[0][3]);
    io.failures.add(f.bodies[0][3]);
    if (failure === "all") io.failures.add(f.bodies[0][4]);
    const first = searchProjectWithDiagnostics(f.root, "concurrent needle", { canvasId });
    await gate.entered;
    try {
      const second = await startSearch(f.root, canvasId);
      gate.release();
      const results = await Promise.all([first, second.result]);
      expect(results[0]).toEqual(results[1]);
      const own = expected("default").slice(0, failure === "all" ? 1 : 2);
      const sibling = expected(f.canvases[1].id);
      expect(results[0].results).toEqual(
        scope === "selected" ? own : [own[0], sibling[0], ...own.slice(1), ...sibling.slice(1)]
      );
      expect(
        results[0].diagnostics.filter((d) => d.code === "desktop_result_file_read_failed")
      ).toHaveLength(failure === "all" ? 2 : 1);
      // Repair the read fault without changing fingerprints, so recovery must retry the same entry.
      io.failures.clear();
      vi.mocked(fs.readFile).mockClear();
      const recovered = await searchProjectWithDiagnostics(f.root, "concurrent needle", {
        canvasId
      });
      expect(recovered.results).toEqual(
        scope === "selected"
          ? expected("default")
          : [
              expected("default")[0],
              sibling[0],
              ...expected("default").slice(1),
              ...sibling.slice(1)
            ]
      );
      expect(
        recovered.diagnostics.filter((d) => d.code === "desktop_result_file_read_failed")
      ).toEqual([]);
      expect(reads([f.bodies[0][3]])).toHaveLength(1);
    } finally {
      gate.release();
      await first;
    }
  });

  it("clears a rejected pending build for every waiter and allows the next request", async () => {
    const f = await fixture();
    const gate = pause(f.bodies[0][3]);
    io.rejectHydration = true;
    const first = searchProjectWithDiagnostics(f.root, "concurrent needle", {
      canvasId: "default"
    });
    const firstOutcome = Promise.allSettled([first]);
    await gate.entered;
    try {
      const second = await startSearch(f.root, "default");
      const secondOutcome = Promise.allSettled([second.result]);
      gate.release();
      for (const outcome of [...(await firstOutcome), ...(await secondOutcome)]) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({ message: "injected hydration rejection" })
        });
      }
      io.rejectHydration = false;
      expect(
        (await searchProjectWithDiagnostics(f.root, "concurrent needle", { canvasId: "default" }))
          .results
      ).toEqual(expected("default"));
      expect(reads(f.bodies[0].slice(3))).toHaveLength(2);
    } finally {
      gate.release();
      await firstOutcome;
    }
  });

  it("keeps the newer generation after an old read completes late", async () => {
    const f = await fixture();
    const gate = pause(f.bodies[0][3]);
    const old = searchProjectWithDiagnostics(f.root, "concurrent needle", { canvasId: "default" });
    await gate.entered;
    try {
      await fs.writeFile(f.bodies[0][0], "new generation needle prompt\n");
      await fs.writeFile(f.bodies[0][3], "new generation needle report\n");
      invalidateDesktopCanvasProjection(f.root, "default");
      io.pause = null;
      const fresh = await searchProjectWithDiagnostics(f.root, "new generation needle", {
        canvasId: "default"
      });
      expect(fresh.results).toEqual([expected("default")[0], expected("default")[2]]);
      gate.release();
      expect((await old).results).toEqual(expected("default").slice(1));
      vi.mocked(fs.readFile).mockClear();
      const retained = await searchProjectWithDiagnostics(f.root, "new generation needle", {
        canvasId: "default"
      });
      expect(retained).toEqual(fresh);
      expect(reads(f.bodies[0])).toEqual([]);
      // Drop only derived indexes to inspect whether the lower result cache kept B's bodies.
      invalidateDesktopCanvasProjection(f.root, "default");
      await searchProjectWithDiagnostics(f.root, "new generation needle", { canvasId: "default" });
      expect(reads(f.bodies[0].slice(3))).toEqual([]);
    } finally {
      gate.release();
      await old;
    }
  });

  it.each([
    "clear",
    "lru",
    "remove sibling",
    "replacement owner"
  ])("keeps late sibling hydration read-only after %s", async (retirement) => {
    const restore = useDesktopProjectProjectionCacheCapacityForTests(1);
    const f = await fixture();
    const other = retirement === "lru" ? await fixture(f.home) : null;
    const context = await readDesktopProjectProjectionContext(f.root);
    const siblingId = f.canvases[1].id;
    const siblingEntry = projectionContextCache.get(context)?.canvases.get(siblingId);
    if (!siblingEntry) throw new Error("Expected sibling cache entry");
    const gate = pause(f.bodies[0][3]);
    const old = searchProjectWithDiagnostics(f.root, "concurrent needle");
    await gate.entered;
    try {
      expect(reads(f.bodies[1].slice(3))).toEqual([]);
      expect(siblingEntry.bodySearchIndexBuild).toBeNull();
      if (retirement === "remove sibling") {
        await writeProjectGraph(f.init.workspace, {
          version: "plan-project/v1",
          canvases: [canonicalProjectCanvasNode({ id: "default", title: "Test Plan" })],
          edges: [],
          crossTaskEdges: []
        });
        await searchProjectWithDiagnostics(f.root, "needle", { includeBodies: false });
      } else if (other) {
        await searchProjectWithDiagnostics(other.root, "needle", { includeBodies: false });
      } else {
        invalidateDesktopProjectProjection();
        if (retirement === "replacement owner") {
          await searchProjectWithDiagnostics(f.root, "needle", { includeBodies: false });
        }
      }
      expect(siblingEntry.retired).toBe(true);
      gate.release();
      expect((await old).results).toEqual([
        expected("default")[0],
        expected(siblingId)[0],
        ...expected("default").slice(1),
        ...expected(siblingId).slice(1)
      ]);
      expect(siblingEntry.bodySearchIndex).toBeNull();
      expect(siblingEntry.bodySearchIndexBuild).toBeNull();
      expect(reads(f.bodies[1].slice(3))).toHaveLength(2);
      vi.mocked(fs.readFile).mockClear();
      await hydrateResultsFileIndexBodies(siblingEntry.resultsIndex);
      expect(reads(f.bodies[1].slice(3))).toHaveLength(2);
    } finally {
      gate.release();
      await old;
      restore();
    }
  });

  it.each([
    "clear",
    "clear with evicted results cache",
    "remove",
    "lru"
  ])("does not restore body caches after %s retires pending work", async (retirement) => {
    const restore = useDesktopProjectProjectionCacheCapacityForTests(1);
    const f = await fixture();
    const other = retirement === "lru" ? await fixture(f.home) : null;
    await readDesktopProjectProjectionContext(f.root);
    const context = await readDesktopProjectProjectionContext(f.root);
    const entry = projectionContextCache.get(context)?.canvases.get("default");
    if (!entry) throw new Error("Expected default cache entry");
    if (retirement === "clear with evicted results cache") {
      clearResultsFileIndexCache({ resultsDir: f.init.workspace.resultsDir });
    }
    const gate = pause(f.bodies[0][3]);
    const old = searchProjectWithDiagnostics(f.root, "concurrent needle", { canvasId: "default" });
    await gate.entered;
    expect(entry.bodySearchIndexBuild).not.toBeNull();
    try {
      if (retirement.startsWith("clear")) invalidateDesktopProjectProjection();
      if (retirement === "remove") {
        await writeProjectGraph(f.init.workspace, {
          version: "plan-project/v1",
          canvases: [canonicalProjectCanvasNode({ id: f.canvases[1].id, title: "Sibling" })],
          edges: [],
          crossTaskEdges: []
        });
        await searchProjectWithDiagnostics(f.root, "needle", { includeBodies: false });
      }
      if (other) await searchProjectWithDiagnostics(other.root, "needle", { includeBodies: false });
      expect(entry.bodySearchIndexBuild).toBeNull();
      gate.release();
      expect((await old).results).toEqual(expected("default"));
      expect(entry.bodySearchIndex).toBeNull();
      expect(entry.bodySearchIndexBuild).toBeNull();
      vi.mocked(fs.readFile).mockClear();
      await hydrateResultsFileIndexBodies(entry.resultsIndex);
      expect(reads(f.bodies[0].slice(3))).toHaveLength(2);
    } finally {
      gate.release();
      await old;
      restore();
    }
  });
});
