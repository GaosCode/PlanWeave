import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimNext,
  loadProjectGraph,
  readProjectPaths,
  renameProject,
  resolveTaskCanvasWorkspace,
  submitBlockResult
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeGateway } from "../toolRuntime.js";
import { handlePlanweaveTool } from "../tools.js";
import { readJson } from "./toolTestHelpers.js";

vi.mock("@planweave-ai/runtime", () => import("../../../runtime/src/index.js"));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function createLegacyStatusFixture(canonical: "missing" | "conflicting", completed = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planweave-legacy-status-")));
  vi.stubEnv("PLANWEAVE_HOME", home);
  const project = await runtimeGateway.initProject("Legacy status");
  await runtimeGateway.createTask(project.projectId, "default", {
    title: "Legacy work",
    promptMarkdown: "Implement the legacy task."
  });
  const legacy = await resolveTaskCanvasWorkspace(project.workspaceRoot, "default");
  await expect(claimNext({ projectRoot: legacy })).resolves.toMatchObject({
    kind: "block",
    ref: "T-LEGACY-WORK#B-001"
  });
  let expected = await runtimeGateway.getStatus(project.projectId, "default");
  expect(expected).toMatchObject({
    canvasId: "default",
    taskTotal: 1,
    blockTotal: 2,
    tasks: [{ taskId: "T-LEGACY-WORK", status: "in_progress" }],
    currentRefs: ["T-LEGACY-WORK#B-001"]
  });

  const report = "Legacy implementation history.\n";
  if (completed) {
    const reportPath = join(home, "implementation.md");
    await writeFile(reportPath, report);
    await submitBlockResult({
      projectRoot: legacy,
      ref: "T-LEGACY-WORK#B-001",
      reportPath
    });
    expected = await runtimeGateway.getStatus(project.projectId, "default");
    expect(expected).toMatchObject({
      tasks: [{ taskId: "T-LEGACY-WORK", status: "in_progress" }],
      currentRefs: [],
      blocks: [
        expect.objectContaining({ ref: "T-LEGACY-WORK#B-001", status: "completed" }),
        expect.objectContaining({ ref: "T-LEGACY-WORK#R-001", status: "ready" })
      ]
    });
  }

  const residue = await runtimeGateway.createCanvas(project.projectId, "Canonical residue");
  await runtimeGateway.createTask(project.projectId, residue.canvasId, {
    title: "Residue work",
    promptMarkdown: "Implement the residue task."
  });
  const residueWorkspace = await resolveTaskCanvasWorkspace(
    project.workspaceRoot,
    residue.canvasId
  );
  const residueStatus = await runtimeGateway.getStatus(project.projectId, residue.canvasId);
  expect(residueStatus).toMatchObject({
    tasks: [{ taskId: "T-RESIDUE-WORK", status: "ready" }],
    currentRefs: []
  });

  await writeFile(join(residueWorkspace.resultsDir, "residue-history.txt"), "Residue history");

  await rename(legacy.packageDir, join(project.workspaceRoot, "package"));
  await rename(legacy.stateFile, join(project.workspaceRoot, "state.json"));
  await rename(legacy.resultsDir, join(project.workspaceRoot, "results"));
  if (canonical === "conflicting") {
    await cp(residueWorkspace.packageDir, legacy.packageDir, { recursive: true });
    await cp(residueWorkspace.stateFile, legacy.stateFile);
    await cp(residueWorkspace.resultsDir, legacy.resultsDir, { recursive: true });
  }
  await writeFile(
    join(project.workspaceRoot, "desktop", "canvases.json"),
    JSON.stringify({
      version: "desktop-canvases/v1",
      activeCanvasId: "default",
      canvases: [
        {
          canvasId: "default",
          name: "Legacy status",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const graphPath = join(project.workspaceRoot, "project-graph.json");
  await rm(graphPath);
  const unrelated = join(home, "projects", "broken-legacy-status-neighbor");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "project.json"), "{");
  const registryBefore = await readFile(
    join(project.workspaceRoot, "desktop", "canvases.json"),
    "utf8"
  );

  return { home, project, expected, graphPath, registryBefore, report };
}

describe("legacy root default canvas status", () => {
  it.each([
    { canvasId: undefined, canonical: "missing" },
    { canvasId: null, canonical: "missing" },
    { canvasId: "default", canonical: "missing" },
    { canvasId: undefined, canonical: "conflicting" },
    { canvasId: null, canonical: "conflicting" },
    { canvasId: "default", canonical: "conflicting" }
  ] as const)("reads the registered legacy data for $canvasId with $canonical canonical storage", async ({
    canvasId,
    canonical
  }) => {
    const { home, project, expected, graphPath, registryBefore } =
      await createLegacyStatusFixture(canonical);

    const args =
      canvasId === undefined
        ? { projectId: project.projectId }
        : { projectId: project.projectId, canvasId };
    const result = readJson(await handlePlanweaveTool("get_status", args, runtimeGateway));
    expect(result).toEqual(expected);
    expect(await runtimeGateway.getStatus(project.projectId, canvasId)).toEqual(expected);
    const workspace = await resolveTaskCanvasWorkspace(project.workspaceRoot, canvasId);
    expect(workspace).toMatchObject({
      packageDir: join(project.workspaceRoot, "package"),
      stateFile: join(project.workspaceRoot, "state.json"),
      resultsDir: join(project.workspaceRoot, "results")
    });
    expect(JSON.stringify(result)).not.toContain(home);
    await expect(access(graphPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(project.workspaceRoot, "desktop", "canvases.json"), "utf8")).toBe(
      registryBefore
    );
  });

  it.each([
    "missing",
    "conflicting"
  ] as const)("keeps legacy ready queues, paths, and history through managed rename with %s canonical storage", async (canonical) => {
    const { project, expected, graphPath, report } = await createLegacyStatusFixture(
      canonical,
      true
    );
    const expectedReady = {
      readyBlocks: [expect.objectContaining({ canvasId: "default", ref: "T-LEGACY-WORK#R-001" })]
    };
    for (const args of [
      { projectId: project.projectId },
      { projectId: project.projectId, canvasId: "default" }
    ]) {
      expect
        .soft(readJson(await handlePlanweaveTool("list_ready_blocks", args, runtimeGateway)))
        .toEqual(expectedReady);
    }
    const paths = await readProjectPaths(project.workspaceRoot);
    const storage = {
      packageDir: join(project.workspaceRoot, "package"),
      statePath: join(project.workspaceRoot, "state.json"),
      resultsDir: join(project.workspaceRoot, "results")
    };
    expect.soft(paths).toMatchObject(storage);
    expect
      .soft(paths.canvases)
      .toEqual([expect.objectContaining({ canvasId: "default", ...storage })]);
    await expect(access(graphPath)).rejects.toMatchObject({ code: "ENOENT" });

    const canonicalManifest = join("canvases", "default", "package", "manifest.json");
    const residueBefore =
      canonical === "conflicting"
        ? await readFile(join(project.workspaceRoot, canonicalManifest), "utf8")
        : null;
    const renamed = await renameProject(project.projectId, "Legacy renamed");
    expect
      .soft(renamed.taskCanvases)
      .toEqual([
        expect.objectContaining({ canvasId: "default", name: "Legacy renamed", taskCount: 1 })
      ]);
    const graph = await loadProjectGraph(renamed.workspaceRoot);
    expect.soft(graph.source).toBe("project_graph");
    expect.soft(graph.manifest.canvases).toEqual([
      expect.objectContaining({
        id: "default",
        title: "Legacy renamed",
        packageDir: "package",
        stateFile: "state.json",
        resultsDir: "results"
      })
    ]);
    expect
      .soft(
        readJson(
          await handlePlanweaveTool("get_status", { projectId: renamed.projectId }, runtimeGateway)
        )
      )
      .toEqual({ ...expected, projectId: renamed.projectId });
    expect
      .soft(
        readJson(
          await handlePlanweaveTool(
            "list_ready_blocks",
            { projectId: renamed.projectId },
            runtimeGateway
          )
        )
      )
      .toEqual(expectedReady);
    const moved = await resolveTaskCanvasWorkspace(renamed.workspaceRoot, "default");
    expect.soft(moved).toMatchObject({
      packageDir: join(renamed.workspaceRoot, "package"),
      stateFile: join(renamed.workspaceRoot, "state.json"),
      resultsDir: join(renamed.workspaceRoot, "results")
    });
    expect(
      JSON.parse(await readFile(join(moved.packageDir, "manifest.json"), "utf8"))
    ).toMatchObject({ project: { title: "Legacy renamed" } });
    expect
      .soft(
        await readFile(
          join(
            renamed.workspaceRoot,
            "results",
            "T-LEGACY-WORK",
            "blocks",
            "B-001",
            "runs",
            "RUN-001",
            "report.md"
          ),
          "utf8"
        )
      )
      .toBe(report);
    if (residueBefore !== null) {
      expect
        .soft(await readFile(join(renamed.workspaceRoot, canonicalManifest), "utf8"))
        .toBe(residueBefore);
      expect
        .soft(
          await readFile(
            join(renamed.workspaceRoot, "canvases", "default", "results", "residue-history.txt"),
            "utf8"
          )
        )
        .toBe("Residue history");
    } else {
      await expect(access(join(renamed.workspaceRoot, canonicalManifest))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
    const detail = await runtimeGateway.getBlockDetail(
      renamed.projectId,
      "T-LEGACY-WORK#B-001",
      "default"
    );
    expect(detail).toMatchObject({ status: "completed", latestRunId: "RUN-001" });
    const reviewPrompt = await runtimeGateway.getPrompt(
      renamed.projectId,
      "default",
      "T-LEGACY-WORK#R-001"
    );
    expect(reviewPrompt.markdown).toContain(report.trim());
  });
});
