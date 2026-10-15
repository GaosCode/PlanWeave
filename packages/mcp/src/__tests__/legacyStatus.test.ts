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
import { claimNext, resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeGateway } from "../toolRuntime.js";
import { handlePlanweaveTool } from "../tools.js";
import { readJson } from "./toolTestHelpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    const home = await realpath(await mkdtemp(join(tmpdir(), "planweave-legacy-status-")));
    vi.stubEnv("PLANWEAVE_HOME", home);
    const project = await runtimeGateway.initProject("Legacy status");
    await runtimeGateway.createTask(project.projectId, "default", { title: "Legacy work" });
    const legacy = await resolveTaskCanvasWorkspace(project.workspaceRoot, "default");
    await expect(claimNext({ projectRoot: legacy })).resolves.toMatchObject({
      kind: "block",
      ref: "T-LEGACY-WORK#B-001"
    });
    const expected = await runtimeGateway.getStatus(project.projectId, "default");
    expect(expected).toMatchObject({
      canvasId: "default",
      taskTotal: 1,
      blockTotal: 2,
      tasks: [{ taskId: "T-LEGACY-WORK", status: "in_progress" }],
      currentRefs: ["T-LEGACY-WORK#B-001"]
    });

    const residue = await runtimeGateway.createCanvas(project.projectId, "Canonical residue");
    await runtimeGateway.createTask(project.projectId, residue.canvasId, { title: "Residue work" });
    const residueWorkspace = await resolveTaskCanvasWorkspace(
      project.workspaceRoot,
      residue.canvasId
    );
    const residueStatus = await runtimeGateway.getStatus(project.projectId, residue.canvasId);
    expect(residueStatus).toMatchObject({
      tasks: [{ taskId: "T-RESIDUE-WORK", status: "ready" }],
      currentRefs: []
    });

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
});
