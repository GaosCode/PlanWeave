import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, cp: vi.fn(actual.cp) };
});

const originalHome = process.env.PLANWEAVE_HOME;
let temporaryRoot: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(cp).mockReset();
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
    "managed"
  ] as const)("rejects every old queued selection after in-place package reset: %s", async (kind) => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "pw-selection-reset-"));
    process.env.PLANWEAVE_HOME = join(temporaryRoot, "home");
    const source = join(temporaryRoot, "source");
    await mkdir(source);
    const previous =
      kind === "external"
        ? await initWorkspace({ projectRoot: source, projectGraph: true })
        : await initManagedWorkspace({ name: "Reset project", projectGraph: true });
    const root = previous.workspace.rootPath;
    const other = await createProjectCanvas({
      projectRoot: previous.workspace,
      title: "Surviving canvas"
    });
    await selectTaskCanvas(root, other.canvas.id);
    await saveDesktopLayoutDirect(previous.workspace, defaultDesktopLayout(previous.project.id));
    const oldDirectory = await stat(previous.workspace.workspaceRoot);
    const canonicalPackageDir = await realpath(previous.workspace.packageDir);
    const backupEntered = deferred(),
      resumeBackup = deferred(),
      resetDone = deferred(),
      release = deferred(),
      selectionQueued = deferred();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(cp).mockImplementation(async (...args) => {
      if (args[0] === previous.workspace.packageDir || args[0] === canonicalPackageDir) {
        backupEntered.resolve();
        await resumeBackup.promise;
      }
      return actual.cp(...args);
    });
    const lock = projectLocks.withProjectMutationLock;
    const holder = lock(previous.workspace.workspaceRoot, async () => {
      const fresh = await initWorkspace({ projectRoot: root, resetPackage: true });
      const directory = await stat(fresh.workspace.workspaceRoot);
      const activePath = join(fresh.workspace.workspaceRoot, "desktop", "active-canvas.json");
      const layoutPath = join(fresh.workspace.workspaceRoot, "desktop", "layout.json");
      const store = await createSqlitePlanGraphStore({ projectRoot: fresh.workspace });
      await store.log.latestUndoable();
      const paths = [activePath, layoutPath, store.indexPath];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      resetDone.resolve();
      await release.promise;
      return { fresh, directory, paths, before };
    });
    const watchedHolder = outcome(holder);
    const selections: Array<ReturnType<typeof outcome<string>>> = [];
    try {
      await Promise.race([backupEntered.promise, holder]);
      vi.spyOn(projectLocks, "withProjectMutationLock").mockImplementation(
        (roots, action, options) => {
          if (options?.operation === "select-canvas:default") selectionQueued.resolve();
          return lock(roots, action, options);
        }
      );
      selections.push(outcome(selectTaskCanvas(root, "default")));
      await selectionQueued.promise;
      selections.push(outcome(selectTaskCanvas(root, "default")));
      resumeBackup.resolve();
      await Promise.race([resetDone.promise, holder]);
      release.resolve();
      const snapshot = await holder;
      expect(snapshot.directory.dev).toBe(oldDirectory.dev);
      expect(snapshot.directory.ino).toBe(oldDirectory.ino);
      expect(snapshot.directory.birthtimeMs).toBe(oldDirectory.birthtimeMs);
      expect(snapshot.fresh.project.createdAt).not.toBe(previous.project.createdAt);
      const results = await Promise.all(selections);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      for (const result of results) {
        if (result.status === "rejected")
          expect(String(result.reason)).toContain("identity changed");
      }
      expect(await readActiveTaskCanvasSelectionForWorkspace(snapshot.fresh.workspace)).toEqual({
        activeCanvasId: other.canvas.id
      });
      expect(await Promise.all(snapshot.paths.map((path) => readFile(path)))).toEqual(
        snapshot.before
      );
      expect(await selectTaskCanvas(root, "default")).toBe("default");
    } finally {
      resumeBackup.resolve();
      release.resolve();
      await Promise.all([watchedHolder, ...selections]);
    }
  });

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
