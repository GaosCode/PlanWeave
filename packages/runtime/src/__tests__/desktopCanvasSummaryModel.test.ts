import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listTaskCanvases, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile)
  };
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

describe("desktop canvas summary model", () => {
  it("reads each canvas manifest once when listing many project graph canvas summaries", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readFile).mockImplementation((path, options) => actualFs.readFile(path, options));
    const { root, init } = await createTestWorkspace();
    const canvases = Array.from({ length: 20 }, (_, index) =>
      canonicalProjectCanvasNode({
        id: index === 0 ? "default" : `summary-${index}`,
        title: index === 0 ? "Test Plan" : `Summary ${index}`
      })
    );
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases,
      edges: [],
      crossTaskEdges: []
    });
    for (const canvas of canvases.slice(1)) {
      const workspace = await resolveTaskCanvasWorkspace(root, canvas.id);
      await writeJsonFile(workspace.manifestFile, basicManifest());
    }

    vi.mocked(readFile).mockClear();
    const summaries = await listTaskCanvases(root);
    const manifestReadPaths = vi
      .mocked(readFile)
      .mock.calls.map(([path]) => (typeof path === "string" ? path : null))
      .filter((path): path is string => path !== null && path.endsWith("/package/manifest.json"));

    expect(summaries).toHaveLength(20);
    expect(summaries.every((summary) => summary.taskCount === 1)).toBe(true);
    expect(manifestReadPaths).toHaveLength(20);
    expect(new Set(manifestReadPaths)).toHaveLength(20);
  });
});
