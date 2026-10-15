import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectTaskCanvas } from "../desktop/canvasSelectionApi.js";
import {
  readActiveTaskCanvasSelectionForWorkspace,
  writeActiveTaskCanvasSelectionForWorkspace
} from "../desktop/canvasSelectionStore.js";
import { defaultDesktopLayout, saveDesktopLayoutDirect } from "../desktop/layoutStore.js";
import { removeProject } from "../desktop/projectApi.js";
import * as projectLocks from "../fs/withProjectMutationLock.js";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import * as projects from "../project.js";
import { createProjectCanvas } from "../projectGraph/projectCanvasMutation.js";

const originalHome = process.env.PLANWEAVE_HOME;
let temporaryRoot: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  );
}

describe("canvas selection project-instance admission", () => {
  it.each([
    "external",
    "managed-delayed-resolution"
  ] as const)("rejects every old queued selection after same-name project replacement: %s", async (kind) => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "pw-selection-instance-"));
    process.env.PLANWEAVE_HOME = join(temporaryRoot, "home");
    const source = join(temporaryRoot, "source");
    await mkdir(source);
    const initialize = () =>
      kind === "external"
        ? initWorkspace({ projectRoot: source, projectGraph: true })
        : initManagedWorkspace({ name: "Same Name", projectGraph: true });
    const previous = await initialize();
    const root = previous.workspace.rootPath;
    const entered = deferred(),
      replace = deferred(),
      replaced = deferred(),
      release = deferred();
    const lockRequested = deferred(),
      resumeResolution = deferred();
    const lock = projectLocks.withProjectMutationLock;
    const holder = lock(previous.workspace.workspaceRoot, async () => {
      entered.resolve();
      await replace.promise;
      await removeProject(previous.project.id);
      const fresh = await initialize();
      expect(fresh.project.id).toBe(previous.project.id);
      const other = await createProjectCanvas({
        projectRoot: fresh.workspace,
        title: "New instance canvas"
      });
      await writeActiveTaskCanvasSelectionForWorkspace(fresh.workspace, other.canvas.id);
      await saveDesktopLayoutDirect(fresh.workspace, defaultDesktopLayout(fresh.project.id));
      const store = await createSqlitePlanGraphStore({ projectRoot: fresh.workspace });
      const activePath = join(fresh.workspace.workspaceRoot, "desktop", "active-canvas.json");
      const layoutPath = join(fresh.workspace.workspaceRoot, "desktop", "layout.json");
      const activeBefore = await readFile(activePath);
      const layoutBefore = await readFile(layoutPath);
      const historyBefore = await store.log.latestUndoable();
      replaced.resolve();
      await release.promise;
      return {
        fresh,
        other,
        store,
        activePath,
        layoutPath,
        activeBefore,
        layoutBefore,
        historyBefore
      };
    });
    const watchedHolder = outcome(holder);
    await entered.promise;
    vi.spyOn(projectLocks, "withProjectMutationLock").mockImplementation(
      (roots, action, options) => {
        if (options?.operation === "select-canvas:default") lockRequested.resolve();
        return lock(roots, action, options);
      }
    );
    const first = outcome(selectTaskCanvas(root, "default"));
    await lockRequested.promise;
    let admittingSecond = true;
    if (kind === "managed-delayed-resolution") {
      const resolveWorkspace = projects.resolveProjectWorkspaceInHome;
      vi.spyOn(projects, "resolveProjectWorkspaceInHome").mockImplementation(async (...args) => {
        if (admittingSecond) await resumeResolution.promise;
        return resolveWorkspace(...args);
      });
    }
    const second = outcome(selectTaskCanvas(root, "default"));
    admittingSecond = false;
    try {
      replace.resolve();
      await Promise.race([
        replaced.promise,
        holder.then(() => {
          throw new Error("Project holder ended before replacement");
        })
      ]);
      resumeResolution.resolve();
      release.resolve();
      const fresh = await holder;
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      for (const result of results) {
        if (result.status === "rejected")
          expect(String(result.reason)).toContain("identity changed");
      }
      expect(await readActiveTaskCanvasSelectionForWorkspace(fresh.fresh.workspace)).toEqual({
        activeCanvasId: fresh.other.canvas.id
      });
      expect(await readFile(fresh.activePath)).toEqual(fresh.activeBefore);
      expect(await readFile(fresh.layoutPath)).toEqual(fresh.layoutBefore);
      expect(await fresh.store.log.latestUndoable()).toEqual(fresh.historyBefore);
      expect(await selectTaskCanvas(root, "default")).toBe("default");
    } finally {
      replace.resolve();
      resumeResolution.resolve();
      release.resolve();
      await Promise.all([watchedHolder, first, second]);
    }
  });
});
