import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCanvasStore } from "../desktop/projectCanvasStore.js";
import { writeJsonFile } from "../json.js";
import { createCanvasWorkspace } from "../projectGraph/createCanvasWorkspace.js";
import {
  createProjectCanvas,
  duplicateProjectCanvas,
  type ProjectCanvasMutationPorts
} from "../projectGraph/projectCanvasMutation.js";
import { loadProjectGraph, projectGraphPath, writeProjectGraph } from "../projectGraph/index.js";
import { listCanvasWorkspaceAnomalies } from "../projectGraph/canvasWorkspaceRecovery.js";
import { projectCanvasWorkspace } from "../projectGraph/projectGraphWorkspace.js";
import { projectGraphManifestSchema } from "../projectGraph/schema.js";
import type { ProjectGraphManifest } from "../projectGraph/types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function failingPort(message: string): () => Promise<never> {
  return async () => {
    throw new Error(message);
  };
}

/** Workspace with package init but no project-graph.json (legacy/default source lane). */
async function createWorkspaceWithoutProjectGraph() {
  const ctx = await createTestWorkspace();
  await rm(projectGraphPath(ctx.init.workspace), { force: true });
  expect(await pathExists(projectGraphPath(ctx.init.workspace))).toBe(false);
  return ctx;
}

async function listDirNames(path: string): Promise<string[]> {
  if (!(await pathExists(path))) {
    return [];
  }
  return readdir(path);
}

function canvasIdsFromGraph(manifest: ProjectGraphManifest): string[] {
  return manifest.canvases.map((canvas) => canvas.id).sort();
}

describe("project canvas mutation coordinator", () => {
  it("lets two independent stores create concurrently without graph lost updates", async () => {
    const { root, init } = await createTestWorkspace();
    const storeA = await createProjectCanvasStore(root);
    const storeB = await createProjectCanvasStore(root);

    const [createdA, createdB] = await Promise.all([
      storeA.create({ name: "Store A Canvas" }),
      storeB.create({ name: "Store B Canvas" })
    ]);

    expect(createdA.canvasId).not.toBe(createdB.canvasId);
    const loaded = await loadProjectGraph(root);
    const ids = loaded.manifest.canvases.map((canvas) => canvas.id).sort();
    expect(ids).toEqual(["default", createdA.canvasId, createdB.canvasId].sort());
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", createdA.canvasId))
    ).toBe(true);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", createdB.canvasId))
    ).toBe(true);
  });

  it("serializes CLI create and Desktop create so both graph nodes survive", async () => {
    const { root, init } = await createTestWorkspace();
    const store = await createProjectCanvasStore(root);

    const [cliResult, desktopResult] = await Promise.all([
      createCanvasWorkspace({ cwd: root, title: "CLI Concurrent Canvas" }),
      store.create({ name: "Desktop Concurrent Canvas" })
    ]);

    expect(cliResult.canvasId).toBe("cli-concurrent-canvas");
    expect(desktopResult.canvasId).not.toBe(cliResult.canvasId);

    const loaded = await loadProjectGraph(root);
    const ids = new Set(loaded.manifest.canvases.map((canvas) => canvas.id));
    expect(ids.has(cliResult.canvasId)).toBe(true);
    expect(ids.has(desktopResult.canvasId)).toBe(true);
    expect(ids.has("default")).toBe(true);

    for (const id of [cliResult.canvasId, desktopResult.canvasId]) {
      expect(await pathExists(join(init.workspace.workspaceRoot, "canvases", id))).toBe(true);
    }
  });

  it("duplicates the same source concurrently into distinct targets without mutating the source", async () => {
    const { root, init } = await createTestWorkspace();
    const storeA = await createProjectCanvasStore(root);
    const storeB = await createProjectCanvasStore(root);
    const sourceBefore = await readFile(init.workspace.manifestFile, "utf8");

    const [dupA, dupB] = await Promise.all([
      storeA.duplicate("default", { name: "Dup A" }),
      storeB.duplicate("default", { name: "Dup B" })
    ]);

    expect(dupA.canvasId).not.toBe(dupB.canvasId);
    expect(await readFile(init.workspace.manifestFile, "utf8")).toBe(sourceBefore);

    const loaded = await loadProjectGraph(root);
    const ids = new Set(loaded.manifest.canvases.map((canvas) => canvas.id));
    expect(ids.has("default")).toBe(true);
    expect(ids.has(dupA.canvasId)).toBe(true);
    expect(ids.has(dupB.canvasId)).toBe(true);
    expect(loaded.manifest.canvases.find((canvas) => canvas.id === "default")?.title).toBe(
      "Test Plan"
    );
  });

  it("rolls back the final canvas directory when project graph write fails after commit", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const ports: ProjectCanvasMutationPorts = {
      writeGraph: failingPort("simulated graph write failure")
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Graph Fail Canvas",
        ports
      })
    ).rejects.toThrow("simulated graph write failure");

    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "graph-fail-canvas"))
    ).toBe(false);

    const stagingRoot = join(init.workspace.workspaceRoot, "desktop", "canvas-staging");
    if (await pathExists(stagingRoot)) {
      expect(await readdir(stagingRoot)).toEqual([]);
    }
  });

  it("quarantines the final directory when graph write fails and remove also fails", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const ports: ProjectCanvasMutationPorts = {
      writeGraph: failingPort("graph write boom"),
      removeFinal: failingPort("remove final boom")
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Quarantine Fail Canvas",
        ports
      })
    ).rejects.toThrow(/project graph write failed[\s\S]*quarantine/);

    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "quarantine-fail-canvas"))
    ).toBe(false);

    const quarantineRoot = join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine");
    const quarantineEntries = await readdir(quarantineRoot);
    expect(quarantineEntries.length).toBeGreaterThanOrEqual(1);
    expect(quarantineEntries.some((name) => name.startsWith("quarantine-fail-canvas"))).toBe(true);
  });

  it("cleans staging and leaves no final canvas when commit rename fails", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const ports: ProjectCanvasMutationPorts = {
      commit: failingPort("commit rename boom")
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Commit Fail Canvas",
        ports
      })
    ).rejects.toThrow("commit rename boom");

    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "commit-fail-canvas"))
    ).toBe(false);

    const stagingRoot = join(init.workspace.workspaceRoot, "desktop", "canvas-staging");
    if (await pathExists(stagingRoot)) {
      expect(await readdir(stagingRoot)).toEqual([]);
    }
  });

  it("preserves staging evidence when content write and staging cleanup both fail", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    let stagingPath: string | null = null;
    const ports: ProjectCanvasMutationPorts = {
      writeEmpty: failingPort("empty workspace write boom"),
      removeStaging: async (projectWorkspace, path) => {
        stagingPath = path;
        throw new Error("staging cleanup boom");
      }
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Staging Cleanup Fail",
        ports
      })
    ).rejects.toThrow(/staging cleanup failed/);

    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    expect(stagingPath).not.toBeNull();
    expect(await pathExists(stagingPath!)).toBe(true);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "staging-cleanup-fail"))
    ).toBe(false);
  });

  it("does not overwrite an existing stale staging directory on the next mutation", async () => {
    const { root, init } = await createTestWorkspace();
    const stagingParent = join(init.workspace.workspaceRoot, "desktop", "canvas-staging");
    await mkdir(stagingParent, { recursive: true });
    const staleStaging = join(stagingParent, "stale-marker-00000000-deadbeef");
    await mkdir(staleStaging, { recursive: true });
    await writeFile(join(staleStaging, "marker.txt"), "stale", "utf8");

    const created = await createProjectCanvas({
      projectRoot: root,
      title: "After Stale Staging"
    });

    expect(created.created).toBe(true);
    expect(await pathExists(staleStaging)).toBe(true);
    expect(await readFile(join(staleStaging, "marker.txt"), "utf8")).toBe("stale");

    const loaded = await loadProjectGraph(root);
    expect(loaded.manifest.canvases.some((canvas) => canvas.id === created.canvas.id)).toBe(true);

    const anomalies = await listCanvasWorkspaceAnomalies(
      init.workspace,
      loaded.manifest.canvases.map((canvas) => projectCanvasWorkspace(loaded.workspace, canvas)),
      { staleThresholdMs: 0, nowMs: Date.now() + 1 }
    );
    expect(anomalies.stagingDirectories.some((entry) => entry.path === staleStaging)).toBe(true);
  });

  it("keeps source canvas unchanged when duplicate content copy fails", async () => {
    const { root, init } = await createTestWorkspace();
    const sourceBefore = await readFile(init.workspace.manifestFile, "utf8");
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const ports: ProjectCanvasMutationPorts = {
      populateDuplicate: failingPort("duplicate copy boom")
    };

    await expect(
      duplicateProjectCanvas({
        projectRoot: root,
        sourceCanvasId: "default",
        name: "Broken Dup",
        ports
      })
    ).rejects.toThrow("duplicate copy boom");

    expect(await readFile(init.workspace.manifestFile, "utf8")).toBe(sourceBefore);
    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);

    const canvasesDir = join(init.workspace.workspaceRoot, "canvases");
    if (await pathExists(canvasesDir)) {
      const children = await readdir(canvasesDir);
      // default lives at workspace root package; only non-default canvases under canvases/
      expect(children.every((name) => !name.startsWith("canvas-"))).toBe(true);
    }
  });

  it("refuses to trust a stale store snapshot for id allocation across sequential reloads", async () => {
    const { root } = await createTestWorkspace();
    const store = await createProjectCanvasStore(root);

    // External mutation after store construction (simulates another process).
    await createCanvasWorkspace({ cwd: root, title: "External Canvas" });

    const created = await store.create({ name: "Store After External" });
    const loaded = await loadProjectGraph(root);
    const ids = loaded.manifest.canvases.map((canvas) => canvas.id);
    expect(ids).toContain("external-canvas");
    expect(ids).toContain(created.canvasId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("records create lock operation names that include the requested base id", async () => {
    const { root, init } = await createTestWorkspace();
    const operations: string[] = [];
    const ports: ProjectCanvasMutationPorts = {
      withLock: async (workspaceRoot, operation, fn) => {
        operations.push(operation);
        expect(workspaceRoot).toBe(init.workspace.workspaceRoot);
        // Still take the real lock so concurrent tests stay valid if run later.
        const { withProjectMutationLock } = await import("../fs/withProjectMutationLock.js");
        return withProjectMutationLock(workspaceRoot, fn, { operation });
      }
    };

    await createProjectCanvas({
      projectRoot: root,
      title: "Lock Label",
      requestedId: "lock-label-canvas",
      ports
    });

    expect(operations).toEqual(["create-canvas:lock-label-canvas"]);
  });

  it("leaves graph and final untouched when stage creation fails", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const ports: ProjectCanvasMutationPorts = {
      stage: failingPort("stage create boom")
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Stage Fail Canvas",
        ports
      })
    ).rejects.toThrow("stage create boom");

    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "stage-fail-canvas"))
    ).toBe(false);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-staging"))
    ).toEqual([]);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"))
    ).toEqual([]);
  });

  it("keeps old graph when graph temp write fails after final commit", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const graphDir = dirname(projectGraphPath(init.workspace));
    const ports: ProjectCanvasMutationPorts = {
      writeGraph: async () => {
        throw new Error("graph temp write boom");
      }
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Graph Temp Fail",
        ports
      })
    ).rejects.toThrow("graph temp write boom");

    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "graph-temp-fail"))
    ).toBe(false);
    const leftoverTemps = (await readdir(graphDir)).filter(
      (name) => name.startsWith(".project-graph.json") && name.endsWith(".tmp")
    );
    expect(leftoverTemps).toEqual([]);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-staging"))
    ).toEqual([]);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"))
    ).toEqual([]);
  });

  it("keeps old graph and removes final when graph final rename fails after temp write", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const graphPath = projectGraphPath(init.workspace);
    const graphDir = dirname(graphPath);
    let observedTempPath: string | undefined;
    const ports: ProjectCanvasMutationPorts = {
      writeGraph: async (_workspace, manifest) => {
        // Production writeJsonFile path: temp is written, rename fails, temp is force-removed.
        const parsed = projectGraphManifestSchema.parse(manifest) as ProjectGraphManifest;
        await writeJsonFile(graphPath, parsed, {
          rename: async (temporaryPath) => {
            observedTempPath = temporaryPath;
            expect(await pathExists(temporaryPath)).toBe(true);
            throw new Error("graph final rename boom");
          }
        });
        return parsed;
      }
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Graph Rename Fail",
        ports
      })
    ).rejects.toThrow("graph final rename boom");

    expect(await readFile(graphPath, "utf8")).toBe(beforeGraph);
    expect(observedTempPath).toBeDefined();
    // Production contract: rename failure cleans temporaryPath before rethrowing.
    expect(await pathExists(observedTempPath!)).toBe(false);
    const leftoverTemps = (await readdir(graphDir)).filter(
      (name) => name.startsWith(".project-graph.json") && name.endsWith(".tmp")
    );
    expect(leftoverTemps).toEqual([]);
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "graph-rename-fail"))
    ).toBe(false);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-staging"))
    ).toEqual([]);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"))
    ).toEqual([]);
  });

  it("surfaces primary graph error and dual compensation failures when remove and quarantine both fail", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    const finalRoot = join(init.workspace.workspaceRoot, "canvases", "dual-comp-fail");
    const ports: ProjectCanvasMutationPorts = {
      writeGraph: failingPort("graph write dual boom"),
      removeFinal: failingPort("remove final dual boom"),
      quarantine: failingPort("quarantine dual boom")
    };

    let caught: unknown;
    try {
      await createProjectCanvas({
        projectRoot: root,
        title: "Dual Comp Fail",
        ports
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/project graph write failed/);
    expect(message).toMatch(/graph write dual boom/);
    expect(message).toMatch(/final directory remove failed/);
    expect(message).toMatch(/remove final dual boom/);
    expect(message).toMatch(/quarantine failed/);
    expect(message).toMatch(/quarantine dual boom/);
    expect(message).toMatch(/Manual recovery required/);

    expect(await readFile(projectGraphPath(init.workspace), "utf8")).toBe(beforeGraph);
    // Final directory remains as an orphan when both compensation paths fail.
    expect(await pathExists(finalRoot)).toBe(true);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"))
    ).toEqual([]);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-staging"))
    ).toEqual([]);
  });

  it("keeps durable graph and final canvas when post-success step fails after graph write", async () => {
    const { root, init } = await createTestWorkspace();
    const beforeGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    let graphWritten = false;
    const ports: ProjectCanvasMutationPorts = {
      writeGraph: async (workspace, manifest) => {
        const next = await writeProjectGraph(workspace, manifest);
        graphWritten = true;
        return next;
      },
      activateCanvas: async () => {
        expect(graphWritten).toBe(true);
        throw new Error("post-success cleanup boom");
      }
    };

    await expect(
      createProjectCanvas({
        projectRoot: root,
        title: "Post Success Cleanup",
        activate: true,
        ports
      })
    ).rejects.toThrow("post-success cleanup boom");

    const afterGraph = await readFile(projectGraphPath(init.workspace), "utf8");
    expect(afterGraph).not.toBe(beforeGraph);
    const loaded = await loadProjectGraph(root);
    expect(loaded.manifest.canvases.some((canvas) => canvas.id === "post-success-cleanup")).toBe(
      true
    );
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "post-success-cleanup"))
    ).toBe(true);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-staging"))
    ).toEqual([]);
    expect(
      await listDirNames(join(init.workspace.workspaceRoot, "desktop", "canvas-quarantine"))
    ).toEqual([]);
  });
});

describe("project mutation without pre-existing project-graph.json", () => {
  it("serializes two independent stores create when project-graph is missing (no lost update, no orphans)", async () => {
    const { root, init } = await createWorkspaceWithoutProjectGraph();
    const storeA = await createProjectCanvasStore(root);
    const storeB = await createProjectCanvasStore(root);

    const [createdA, createdB] = await Promise.all([
      storeA.create({ name: "Legacy Store A" }),
      storeB.create({ name: "Legacy Store B" })
    ]);

    expect(createdA.canvasId).not.toBe(createdB.canvasId);

    const successIds = [createdA.canvasId, createdB.canvasId, "default"].sort();
    const loaded = await loadProjectGraph(root);
    expect(loaded.source).toBe("project_graph");
    expect(canvasIdsFromGraph(loaded.manifest)).toEqual(successIds);

    const canvasesDir = join(init.workspace.workspaceRoot, "canvases");
    const finalDirs = new Set(await listDirNames(canvasesDir));
    // Both successful creates must have final dirs; no extra orphan canvas-* dirs.
    expect(finalDirs.has(createdA.canvasId)).toBe(true);
    expect(finalDirs.has(createdB.canvasId)).toBe(true);
    const orphanCandidates = [...finalDirs].filter(
      (name) => name !== "default" && name !== createdA.canvasId && name !== createdB.canvasId
    );
    expect(orphanCandidates).toEqual([]);

    const listed = await storeA.list();
    const listedIds = listed.map((canvas) => canvas.canvasId).sort();
    expect(listedIds).toEqual(successIds);

    // Authoritative graph is project-graph.json; registry must not be a divergent sole source.
    expect(await pathExists(projectGraphPath(init.workspace))).toBe(true);
  });

  it("serializes CLI create with a pre-constructed legacy Desktop store without split-brain", async () => {
    const { root, init } = await createWorkspaceWithoutProjectGraph();
    // Construct store while source is still legacy/default (no project-graph.json).
    const desktopStore = await createProjectCanvasStore(root);
    const beforeSource = (await loadProjectGraph(root)).source;
    expect(beforeSource).not.toBe("project_graph");

    const [cliResult, desktopResult] = await Promise.all([
      createCanvasWorkspace({ cwd: root, title: "CLI No Graph Canvas" }),
      desktopStore.create({ name: "Desktop No Graph Canvas" })
    ]);

    expect(cliResult.canvasId).toBe("cli-no-graph-canvas");
    expect(desktopResult.canvasId).not.toBe(cliResult.canvasId);

    const successIds = ["default", cliResult.canvasId, desktopResult.canvasId].sort();
    const loaded = await loadProjectGraph(root);
    expect(loaded.source).toBe("project_graph");
    expect(canvasIdsFromGraph(loaded.manifest)).toEqual(successIds);

    const finalDirs = new Set(await listDirNames(join(init.workspace.workspaceRoot, "canvases")));
    expect(finalDirs.has(cliResult.canvasId)).toBe(true);
    expect(finalDirs.has(desktopResult.canvasId)).toBe(true);
    const orphanCandidates = [...finalDirs].filter(
      (name) => name !== "default" && name !== cliResult.canvasId && name !== desktopResult.canvasId
    );
    expect(orphanCandidates).toEqual([]);

    const listed = await desktopStore.list();
    const listedIds = listed.map((canvas) => canvas.canvasId).sort();
    expect(listedIds).toEqual(successIds);

    for (const id of [cliResult.canvasId, desktopResult.canvasId]) {
      expect(await pathExists(join(init.workspace.workspaceRoot, "canvases", id))).toBe(true);
    }
  });
});

describe("project mutation lock integration with real temp dirs", () => {
  it("two createProjectCanvas calls on distinct titles both persist under real FS", async () => {
    const { root, init } = await createTestWorkspace();

    const [first, second] = await Promise.all([
      createProjectCanvas({ projectRoot: root, title: "Alpha Real" }),
      createProjectCanvas({ projectRoot: root, title: "Beta Real" })
    ]);

    const graph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8")) as {
      canvases: Array<{ id: string; title: string }>;
    };
    const titles = graph.canvases.map((canvas) => canvas.title).sort();
    expect(titles).toEqual(["Alpha Real", "Beta Real", "Test Plan"].sort());
    expect(first.canvas.id).not.toBe(second.canvas.id);
    expect(await pathExists(first.canvasWorkspace.workspaceRoot)).toBe(true);
    expect(await pathExists(second.canvasWorkspace.workspaceRoot)).toBe(true);
  });

  it("two child processes creating canvases both appear in project-graph.json", async () => {
    const { root, init } = await createTestWorkspace();
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
    const mutationModule = join(runtimeRoot, "src/projectGraph/projectCanvasMutation.ts");

    const runChild = (title: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "-e",
            `import { createProjectCanvas } from ${JSON.stringify(mutationModule)};
             const result = await createProjectCanvas({
               projectRoot: process.env.PLANWEAVE_PROJECT_ROOT,
               title: process.env.PLANWEAVE_CANVAS_TITLE
             });
             console.log(JSON.stringify({ canvasId: result.canvas.id, title: result.title }));`
          ],
          {
            env: {
              ...process.env,
              PLANWEAVE_HOME: process.env.PLANWEAVE_HOME,
              PLANWEAVE_PROJECT_ROOT: root,
              PLANWEAVE_CANVAS_TITLE: title
            },
            cwd: runtimeRoot
          }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    const [childA, childB] = await Promise.all([
      runChild("Process A Canvas"),
      runChild("Process B Canvas")
    ]);

    expect(childA.code, childA.stderr).toBe(0);
    expect(childB.code, childB.stderr).toBe(0);
    const parsedA = JSON.parse(childA.stdout.trim()) as { canvasId: string; title: string };
    const parsedB = JSON.parse(childB.stdout.trim()) as { canvasId: string; title: string };
    expect(parsedA.canvasId).not.toBe(parsedB.canvasId);

    const graph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8")) as {
      canvases: Array<{ id: string; title: string }>;
    };
    const ids = new Set(graph.canvases.map((canvas) => canvas.id));
    expect(ids.has(parsedA.canvasId)).toBe(true);
    expect(ids.has(parsedB.canvasId)).toBe(true);
    expect(ids.has("default")).toBe(true);
    expect(await pathExists(join(init.workspace.workspaceRoot, "canvases", parsedA.canvasId))).toBe(
      true
    );
    expect(await pathExists(join(init.workspace.workspaceRoot, "canvases", parsedB.canvasId))).toBe(
      true
    );
  });
});
