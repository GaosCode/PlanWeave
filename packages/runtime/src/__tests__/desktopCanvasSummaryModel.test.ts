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
  it("does not report shared-resource coordination hints as diagnostics", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task");
    const block =
      task?.type === "task" ? task.blocks.find((item) => item.type === "implementation") : null;
    if (!block || block.type !== "implementation") {
      throw new Error("Expected an implementation block fixture.");
    }
    block.parallel = { sharedResources: ["shared"] };
    const { root } = await createTestWorkspace(manifest);

    const summaries = await listTaskCanvases(root);
    expect(summaries[0]?.diagnostics).toEqual([]);
  });

  it("marks manifest schema diagnostics as errors", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(init.workspace.manifestFile, {
      version: "plan-package/v1",
      project: { title: "Broken", description: "Broken manifest" },
      execution: { parallel: { enabled: false, maxConcurrent: 1 } },
      review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
      nodes: "not-an-array",
      edges: []
    });

    const summaries = await listTaskCanvases(root);

    expect(summaries[0]?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "manifest_schema", severity: "error" })
    );
  });

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
