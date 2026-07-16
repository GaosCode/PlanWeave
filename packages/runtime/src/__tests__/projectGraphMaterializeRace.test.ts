import type { PathLike } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic rename barrier for the first project-graph.json atomic rename.
 * Reproduces the public-materialize vs create lost-update window when materialize
 * is not serialized under the project mutation lock.
 */
const renameBarrier = vi.hoisted(() => {
  const state = {
    enabled: false,
    targetBaseName: "project-graph.json",
    armed: false,
    hitCount: 0,
    release: null as null | (() => void),
    wait: null as null | Promise<void>,
    reached: null as null | Promise<void>,
    markReached: null as null | (() => void)
  };

  function arm() {
    state.enabled = true;
    state.armed = true;
    state.hitCount = 0;
    state.wait = new Promise<void>((resolve) => {
      state.release = resolve;
    });
    state.reached = new Promise<void>((resolve) => {
      state.markReached = resolve;
    });
  }

  function disarm() {
    state.enabled = false;
    state.armed = false;
    state.release?.();
    state.release = null;
    state.wait = null;
    state.reached = null;
    state.markReached = null;
  }

  return { state, arm, disarm };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: PathLike, newPath: PathLike) => {
      const target = newPath.toString();
      if (
        renameBarrier.state.enabled &&
        renameBarrier.state.armed &&
        basename(target) === renameBarrier.state.targetBaseName
      ) {
        renameBarrier.state.armed = false;
        renameBarrier.state.hitCount += 1;
        renameBarrier.state.markReached?.();
        await renameBarrier.state.wait;
      }
      return actual.rename(oldPath, newPath);
    }
  };
});

import { createProjectCanvas } from "../projectGraph/projectCanvasMutation.js";
import {
  loadProjectGraph,
  materializeProjectGraph,
  projectGraphPath
} from "../projectGraph/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  renameBarrier.disarm();
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirNames(path: string): Promise<string[]> {
  if (!(await pathExists(path))) {
    return [];
  }
  return readdir(path);
}

async function createWorkspaceWithoutProjectGraph() {
  const ctx = await createTestWorkspace();
  await rm(projectGraphPath(ctx.init.workspace), { force: true });
  expect(await pathExists(projectGraphPath(ctx.init.workspace))).toBe(false);
  return ctx;
}

describe("public materialize vs create rename-barrier race", () => {
  it("keeps concurrent create node when public materialize is paused at graph rename", async () => {
    const { root, init } = await createWorkspaceWithoutProjectGraph();
    const graphPath = projectGraphPath(init.workspace);
    const canvasesDir = join(init.workspace.workspaceRoot, "canvases");

    renameBarrier.arm();
    const materializePromise = materializeProjectGraph(root);

    await renameBarrier.state.reached;
    expect(renameBarrier.state.hitCount).toBe(1);
    // Materialize holds the project mutation lock across load+rename, so create
    // must not commit until the paused materialize finishes.
    expect(await pathExists(graphPath)).toBe(false);

    const createPromise = createProjectCanvas({
      projectRoot: root,
      title: "Concurrent Create"
    });

    // Allow materialize to finish its first write, then create proceeds under lock.
    renameBarrier.state.release?.();
    const [materialized, created] = await Promise.all([materializePromise, createPromise]);

    expect(materialized.created).toBe(true);
    expect(created.canvas.id).toBe("concurrent-create");
    expect(created.persisted).toBe(true);

    const loaded = await loadProjectGraph(root);
    expect(loaded.source).toBe("project_graph");
    const ids = loaded.manifest.canvases.map((canvas) => canvas.id).sort();
    expect(ids).toEqual(["concurrent-create", "default"].sort());

    const finalDirs = new Set(await listDirNames(canvasesDir));
    expect(finalDirs.has("default")).toBe(true);
    expect(finalDirs.has("concurrent-create")).toBe(true);
    const orphanCandidates = [...finalDirs].filter(
      (name) => name !== "default" && name !== "concurrent-create"
    );
    expect(orphanCandidates).toEqual([]);
  });

  it("lets create complete first when it acquires the lock before materialize rename", async () => {
    const { root, init } = await createWorkspaceWithoutProjectGraph();

    // No barrier: concurrent public materialize + create must remain consistent.
    const [materialized, created] = await Promise.all([
      materializeProjectGraph(root),
      createProjectCanvas({ projectRoot: root, title: "Concurrent Create" })
    ]);

    expect(created.canvas.id).toBe("concurrent-create");
    // One of the two may be the first writer; both must leave create's node durable.
    void materialized;
    const loaded = await loadProjectGraph(root);
    const ids = loaded.manifest.canvases.map((canvas) => canvas.id).sort();
    expect(ids).toEqual(["concurrent-create", "default"].sort());
    expect(
      await pathExists(join(init.workspace.workspaceRoot, "canvases", "concurrent-create"))
    ).toBe(true);
  });
});
