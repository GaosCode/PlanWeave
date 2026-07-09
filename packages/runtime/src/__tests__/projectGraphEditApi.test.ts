import { afterEach, describe, expect, it } from "vitest";
import {
  addCanvasDependency,
  addCrossTaskDependency,
  createTaskCanvas,
  loadProjectGraph,
  materializeProjectGraph,
  removeCanvasDependency,
  removeCrossTaskDependency,
  redoPlanGraphCommand,
  resolveTaskCanvasWorkspace,
  undoPlanGraphCommand
} from "../index.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

async function createFixtureCanvas(root: string) {
  const canvas = await createTaskCanvas(root, { name: "Second plan" });
  const workspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
  const manifest = basicManifest();
  await writeJsonFile(workspace.manifestFile, manifest);
  await writePromptFiles(workspace.packageDir, manifest);
  return canvas;
}

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("project graph edit API", () => {
  it("adds and removes canvas and cross-task dependencies", async () => {
    const { root } = await createTestWorkspace();
    await materializeProjectGraph(root);
    const second = await createFixtureCanvas(root);

    await expect(addCanvasDependency(root, second.canvasId, "default")).resolves.toMatchObject({
      ok: true
    });
    await expect(
      addCrossTaskDependency(
        root,
        { canvasId: second.canvasId, taskId: "T-001" },
        { canvasId: "default", taskId: "T-001" }
      )
    ).resolves.toMatchObject({ ok: true });

    let graph = (await loadProjectGraph(root)).manifest;
    expect(graph.edges).toEqual([{ from: second.canvasId, to: "default", type: "depends_on" }]);
    expect(graph.crossTaskEdges).toEqual([
      {
        from: { canvasId: second.canvasId, taskId: "T-001" },
        to: { canvasId: "default", taskId: "T-001" },
        type: "depends_on"
      }
    ]);

    await expect(removeCanvasDependency(root, second.canvasId, "default")).resolves.toMatchObject({
      ok: true
    });
    await expect(
      removeCrossTaskDependency(
        root,
        { canvasId: second.canvasId, taskId: "T-001" },
        { canvasId: "default", taskId: "T-001" }
      )
    ).resolves.toMatchObject({ ok: true });

    graph = (await loadProjectGraph(root)).manifest;
    expect(graph.edges).toEqual([]);
    expect(graph.crossTaskEdges).toEqual([]);
  });

  it("does not write invalid project graph dependency edits", async () => {
    const { root } = await createTestWorkspace();
    await materializeProjectGraph(root);
    const second = await createFixtureCanvas(root);
    await expect(addCanvasDependency(root, second.canvasId, "default")).resolves.toMatchObject({
      ok: true
    });

    const cyclic = await addCanvasDependency(root, "default", second.canvasId);
    expect(cyclic).toMatchObject({ ok: false });
    expect(cyclic.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_canvas_depends_on_cycle"
    );
    const graph = (await loadProjectGraph(root)).manifest;
    expect(graph.edges).toEqual([{ from: second.canvasId, to: "default", type: "depends_on" }]);
  });

  it("records project graph dependency edits as undoable PlanGraph history", async () => {
    const { root } = await createTestWorkspace();
    await materializeProjectGraph(root);
    const second = await createFixtureCanvas(root);

    await expect(addCanvasDependency(root, second.canvasId, "default")).resolves.toMatchObject({
      ok: true
    });
    await expect(
      addCrossTaskDependency(
        root,
        { canvasId: second.canvasId, taskId: "T-001" },
        { canvasId: "default", taskId: "T-001" }
      )
    ).resolves.toMatchObject({ ok: true });

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    let graph = (await loadProjectGraph(root)).manifest;
    expect(graph.edges).toEqual([{ from: second.canvasId, to: "default", type: "depends_on" }]);
    expect(graph.crossTaskEdges).toEqual([]);

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    graph = (await loadProjectGraph(root)).manifest;
    expect(graph.edges).toEqual([]);
    expect(graph.crossTaskEdges).toEqual([]);

    await expect(redoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    graph = (await loadProjectGraph(root)).manifest;
    expect(graph.edges).toEqual([{ from: second.canvasId, to: "default", type: "depends_on" }]);
    expect(graph.crossTaskEdges).toEqual([]);

    await expect(redoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    graph = (await loadProjectGraph(root)).manifest;
    expect(graph.crossTaskEdges).toEqual([
      {
        from: { canvasId: second.canvasId, taskId: "T-001" },
        to: { canvasId: "default", taskId: "T-001" },
        type: "depends_on"
      }
    ]);
  });
});
