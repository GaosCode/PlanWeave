import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskCanvas,
  getStatistics,
  resolveTaskCanvasWorkspace,
  searchProjectWithDiagnostics
} from "../desktop/index.js";
import {
  invalidateDesktopProjectProjection,
  readDesktopProjectProjectionContext,
  readDesktopProjectSearchIndexFromContext
} from "../desktop/graph/projectProjectionModel.js";
import { searchDesktopSearchIndex } from "../desktop/graph/searchIndexModel.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

const io = vi.hoisted(() => ({
  failure: null as string | null,
  pause: null as string | null,
  entered: null as (() => void) | null,
  release: null as Promise<void> | null
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === io.failure) throw new Error("injected body read failure");
      if (args[0] === io.pause) {
        io.entered?.();
        await io.release;
      }
      return actual.readFile(...args);
    })
  };
});
afterEach(() => {
  invalidateDesktopProjectProjection();
  vi.clearAllMocks();
  io.failure = io.pause = null;
  io.entered = null;
  io.release = null;
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function fixture() {
  const { root, init } = await createTestWorkspace();
  const canvases = [{ id: "default", workspace: init.workspace }];
  for (const name of ["Sibling B", "Sibling C"]) {
    const canvas = await createTaskCanvas(root, { name });
    const workspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writeJsonFile(workspace.manifestFile, basicManifest());
    await writePromptFiles(workspace.packageDir, basicManifest());
    canvases.push({ id: canvas.canvasId, workspace });
  }
  const bodies: string[][] = [];
  for (const [index, canvas] of canvases.entries()) {
    const prompt = join(canvas.workspace.packageDir, "nodes/T-001/prompt.md");
    const report = join(canvas.workspace.resultsDir, "T-001/blocks/B-001/runs/RUN-001/report.md");
    const review = join(
      canvas.workspace.resultsDir,
      "T-001/reviews/R-001/attempts/REV-001/review.md"
    );
    await fs.mkdir(join(canvas.workspace.resultsDir, "T-001/blocks/B-001/runs/RUN-001"), {
      recursive: true
    });
    await fs.mkdir(join(canvas.workspace.resultsDir, "T-001/reviews/R-001/attempts/REV-001"), {
      recursive: true
    });
    await fs.writeFile(prompt, `scope needle prompt ${index}\n`);
    await fs.writeFile(report, `scope needle run ${index}\n`);
    await fs.writeFile(review, `scope needle review ${index}\n`);
    bodies.push([
      prompt,
      join(canvas.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      join(canvas.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md"),
      report,
      review
    ]);
  }
  vi.mocked(fs.readFile).mockClear();
  return { root, canvases, bodies };
}
function bodyReads(paths: string[]) {
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
      kind: "run_record",
      ref: "T-001/blocks/B-001/runs/RUN-001/report.md"
    }),
    expect.objectContaining({
      canvasId,
      kind: "review_attempt",
      ref: "T-001/reviews/R-001/attempts/REV-001/review.md"
    })
  ];
}
const filters = { includeBodies: true, kinds: ["prompt", "run_record", "review_attempt"] as const };

describe("selected canvas search body read budget", () => {
  it("reads no bodies for summary search and only selected bodies on cold search; reuses them", async () => {
    const { root, canvases, bodies } = await fixture();
    await searchProjectWithDiagnostics(root, "scope needle", {
      canvasId: "default",
      includeBodies: false
    });
    expect(bodyReads(bodies.flat())).toEqual([]);
    const selected = await searchProjectWithDiagnostics(root, "scope needle", {
      ...filters,
      kinds: [...filters.kinds],
      canvasId: "default"
    });
    expect(selected.results).toEqual(expected("default"));
    expect(bodyReads(bodies[0])).toHaveLength(5);
    expect(bodyReads([...bodies[1], ...bodies[2]])).toEqual([]);
    vi.mocked(fs.readFile).mockClear();
    await searchProjectWithDiagnostics(root, "scope needle", { canvasId: "default" });
    expect(bodyReads(bodies.flat())).toEqual([]);
    await expect(getStatistics(root)).resolves.toMatchObject({ taskTotal: 3, blockTotal: 6 });
    expect(canvases).toHaveLength(3);
  });

  it.each([
    "selected-first",
    "all-first"
  ])("keeps complete global results across %s cache transitions", async (order) => {
    const { root, canvases, bodies } = await fixture();
    if (order === "selected-first") {
      await searchProjectWithDiagnostics(root, "scope needle", { canvasId: "default" });
      vi.mocked(fs.readFile).mockClear();
    }
    const global = await searchProjectWithDiagnostics(root, "scope needle");
    expect(global.results).toHaveLength(9);
    expect(global.results).toEqual(
      expect.arrayContaining([
        ...expected("default"),
        ...expected(canvases[1].id),
        ...expected(canvases[2].id)
      ])
    );
    expect(bodyReads(bodies[1])).toHaveLength(5);
    expect(bodyReads(bodies[2])).toHaveLength(5);
    vi.mocked(fs.readFile).mockClear();
    for (const canvasId of ["default", canvases[1].id]) {
      const selected = await searchProjectWithDiagnostics(root, "scope needle", { canvasId });
      expect(selected.results).toEqual(expected(canvasId));
    }
    expect(bodyReads(bodies.flat())).toEqual([]);
  });

  it("refreshes selected edits without rereading unchanged sibling bodies", async () => {
    const { root, canvases, bodies } = await fixture();
    await searchProjectWithDiagnostics(root, "scope needle");
    await fs.writeFile(bodies[0][0], "edited selected unique needle\n");
    vi.mocked(fs.readFile).mockClear();
    const edited = await searchProjectWithDiagnostics(root, "edited selected unique needle", {
      canvasId: "default"
    });
    expect(edited.results).toEqual([
      expect.objectContaining({ canvasId: "default", kind: "prompt", ref: "T-001" })
    ]);
    expect(bodyReads(bodies[0])).toContain(bodies[0][0]);
    expect(bodyReads([...bodies[1], ...bodies[2]])).toEqual([]);
    const global = await searchProjectWithDiagnostics(root, "scope needle");
    expect(global.results.filter((result) => result.canvasId === canvases[1].id)).toEqual(
      expected(canvases[1].id)
    );
    expect(bodyReads([...bodies[1], ...bodies[2]])).toEqual([]);
  });

  it("does not read unrelated failing bodies, but retains metadata diagnostics and global body failures", async () => {
    const { root, canvases, bodies } = await fixture();
    await fs.writeFile(
      join(canvases[2].workspace.resultsDir, "T-001/blocks/B-001/runs/RUN-001/metadata.json"),
      "{"
    );
    io.failure = bodies[1][3];
    const selected = await searchProjectWithDiagnostics(root, "scope needle", {
      canvasId: "default"
    });
    expect(selected.results).toEqual(expected("default"));
    expect(bodyReads([...bodies[1], ...bodies[2]])).toEqual([]);
    expect(selected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "desktop_result_metadata_read_failed" })
      ])
    );
    expect(
      selected.diagnostics.some(
        (diagnostic) => diagnostic.code === "desktop_result_file_read_failed"
      )
    ).toBe(false);
    const global = await searchProjectWithDiagnostics(root, "scope needle");
    expect(global.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_result_file_read_failed",
          message: expect.stringContaining("injected body read failure")
        })
      ])
    );
    await expect(
      searchProjectWithDiagnostics(root, "scope needle", { canvasId: "unknown" })
    ).rejects.toThrow("Task canvas 'unknown' does not exist.");
  });

  it("retains selected scope when an invalidated projection context is rebuilt", async () => {
    const { root, bodies } = await fixture();
    const context = await readDesktopProjectProjectionContext(root);
    invalidateDesktopProjectProjection(root);
    vi.mocked(fs.readFile).mockClear();
    const index = await readDesktopProjectSearchIndexFromContext(context, {
      includeBodies: true,
      canvasId: "default"
    });
    expect(searchDesktopSearchIndex(index, "scope needle", { canvasId: "default" })).toEqual(
      expected("default")
    );
    expect(bodyReads([...bodies[1], ...bodies[2]])).toEqual([]);
  });

  it("isolates interleaved selected hydration from a later invalidated cache", async () => {
    const { root, canvases, bodies } = await fixture();
    let release!: () => void;
    io.release = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      io.entered = resolve;
    });
    io.pause = bodies[0][3];
    const a = searchProjectWithDiagnostics(root, "scope needle", { canvasId: "default" });
    await entered;
    const b = await searchProjectWithDiagnostics(root, "scope needle", {
      canvasId: canvases[1].id
    });
    expect(b.results).toEqual(expected(canvases[1].id));
    invalidateDesktopProjectProjection(root);
    io.pause = null;
    release();
    expect((await a).results).toEqual(expected("default"));
    vi.mocked(fs.readFile).mockClear();
    const nextB = await searchProjectWithDiagnostics(root, "scope needle", {
      canvasId: canvases[1].id
    });
    expect(nextB.results).toEqual(expected(canvases[1].id));
    expect(bodyReads(bodies[0])).toEqual([]);
    expect(bodyReads(bodies[2])).toEqual([]);
  });
});
