import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initManagedWorkspace } from "../initWorkspace.js";
import { renameProject, linkProjectSourceRoot } from "../desktop/projectApi.js";
import { setSourceDefaultProject } from "../desktop/sourceDefaultProject.js";
import { claimNext, submitBlockResult } from "../taskManager/index.js";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { normalizeRegistry } from "../desktop/canvasRegistry.js";
import { acquireExecutorResultsWriteLease } from "../package/executorResultsWriteLease.js";
import { withExecutorResultsWriteLease } from "../autoRun/executorResultsLifecycle.js";
import {
  executePlanGraphCommand,
  redoPlanGraphCommand,
  undoPlanGraphCommand
} from "../plangraph/executeCommand.js";
import { createSqlitePlanGraphStore } from "../plangraph/sqliteIndex.js";
import { openDatabase } from "../plangraph/sqlite/connection.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, writePromptFiles } from "./promptTestHelpers.js";
import { createProjectCanvasStore } from "../desktop/projectCanvasStore.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { importTransactionIdentityDigest } from "../package/importTransactionContent.js";
import { createManagedProjectId } from "../projectId.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolveProjectWorkspace } from "../project.js";
import { projectGraphPath } from "../projectGraph/index.js";
import {
  getDesktopLayoutDirect,
  layoutPathForWorkspace,
  saveDesktopLayoutDirect
} from "../desktop/layoutStore.js";
import { buildCanvasCommandApplication } from "../graph/canvasCommandMutation.js";
import { commitCanvasCommandApplication } from "../graph/canvasCommandPort.js";
import { listPendingImportTransactions } from "../package/importRecovery.js";
import * as projectMutation from "../fs/withProjectMutationLock.js";
import * as projectGraph from "../projectGraph/index.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import {
  createDesktopPackageFileSnapshot,
  detectDesktopPackageFileChanges,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges
} from "../desktop/fileSyncApi.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    realpath: vi.fn(actual.realpath),
    mkdir: vi.fn(actual.mkdir)
  };
});
let actualFs: typeof import("node:fs/promises");
beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation((oldPath, newPath) => actualFs.rename(oldPath, newPath));
  vi.mocked(realpath).mockImplementation((path, options) => actualFs.realpath(path, options));
  vi.mocked(mkdir).mockImplementation((path, options) => actualFs.mkdir(path, options));
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([
  "active",
  "committed"
] as const)("includes a canvas added by an in-flight graph writer before relocating its %s WAL", async (state) => {
  const { home, project, workspace } = await fixture();
  const nextRoot = join(home, "projects", createManagedProjectId("Storage destination"));
  const storageEntered = barrier();
  const storageHold = barrier();
  const storage = withPackageFileConsistency([nextRoot], async () => {
    storageEntered.release();
    await storageHold.promise;
  });
  await storageEntered.promise;
  const writerEntered = barrier();
  const writeAllowed = barrier();
  const written = barrier();
  const writerHold = barrier();
  const writer = projectMutation.withProjectMutationLock(
    await actualFs.realpath(workspace.workspaceRoot),
    async () => {
      writerEntered.release();
      await writeAllowed.promise;
      const extra = await createTaskCanvas(workspace.rootPath, { name: "Concurrent canvas" });
      const canvas = await resolveTaskCanvasWorkspace(workspace.rootPath, extra.canvasId);
      const transaction = await ImportTransaction.create({
        workspaceRoot: canvas.workspaceRoot,
        transactionId: "concurrent-canvas"
      });
      if (state === "committed") await transaction.markCommitted();
      written.release();
      await writerHold.promise;
      return { extra, canvas, transaction };
    }
  );
  await writerEntered.promise;
  const renameStarted = barrier();
  const withProjectLock = projectMutation.withProjectMutationLock;
  vi.spyOn(projectMutation, "withProjectMutationLock").mockImplementation((root, fn, options) => {
    if (typeof root !== "string") renameStarted.release();
    return withProjectLock(root, fn, options);
  });
  const loadGraph = projectGraph.loadProjectGraphForWorkspace;
  vi.spyOn(projectGraph, "loadProjectGraphForWorkspace").mockImplementation(async (workspace) => {
    const result = await loadGraph(workspace);
    renameStarted.release();
    return result;
  });
  const renaming = renameProject(project.id, "Storage destination").then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error })
  );
  let before = "";
  try {
    await renameStarted.promise;
    writeAllowed.release();
    await written.promise;
    before = await importTransactionIdentityDigest(workspace.workspaceRoot);
  } finally {
    writeAllowed.release();
    writerHold.release();
    storageHold.release();
    await storage;
  }
  const { extra, canvas, transaction } = await writer;
  const outcome = await renaming;
  expect(outcome.value).toBeNull();
  expect(String(outcome.error)).toContain("write conflict");
  expect(await importTransactionIdentityDigest(workspace.workspaceRoot)).toBe(before);
  await expect(access(nextRoot)).rejects.toThrow();
  expect(
    (
      await ImportTransaction.recover({
        workspaceRoot: canvas.workspaceRoot,
        transactionId: "concurrent-canvas"
      })
    ).getRecoveryTargets()
  ).toEqual([]);
  if (state === "committed") await transaction.cleanupCommitted();
  else await transaction.rollback();
  await renameProject(project.id, "Storage destination");
  expect((await resolveTaskCanvasWorkspace(nextRoot, extra.canvasId)).workspaceRoot).toContain(
    nextRoot
  );
  await expect(createTaskCanvas(nextRoot, { name: "After move" })).resolves.toMatchObject({
    name: "After move"
  });
});

it.each([
  false,
  true
])("relocates a Canvas only after its admitted command commits (later=%s)", async (later) => {
  const { home, project, workspace } = await fixture();
  const canvasId = later
    ? (await createTaskCanvas(workspace.rootPath, { name: "Pending canvas" })).canvasId
    : "default";
  const canvas = await resolveTaskCanvasWorkspace(workspace.rootPath, canvasId);
  const application = buildCanvasCommandApplication(
    (await loadPackage(canvas)).manifest,
    await getDesktopLayoutDirect(canvas),
    {
      kind: "add_task",
      taskId: "T-001",
      title: "First",
      promptMarkdown: "First prompt",
      layout: { nodeId: "T-001", x: 77, y: 88 },
      layoutUpdatedAt: "2030-01-01T00:00:00.000Z"
    }
  );
  const created = barrier();
  const hold = barrier();
  const create = ImportTransaction.create;
  vi.spyOn(ImportTransaction, "create").mockImplementation(async (options) => {
    const transaction = await create(options);
    created.release();
    await hold.promise;
    return transaction;
  });
  const command = commitCanvasCommandApplication({ workspace: canvas, application }).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error })
  );
  const renameAttempted = barrier();
  const withProjectLock = projectMutation.withProjectMutationLock;
  vi.spyOn(projectMutation, "withProjectMutationLock").mockImplementation((root, fn, options) => {
    if (typeof root !== "string") renameAttempted.release();
    return withProjectLock(root, fn, options);
  });
  let renaming: ReturnType<typeof renameProject> | undefined;
  let settled = false;
  try {
    await created.promise;
    const before = await importTransactionIdentityDigest(workspace.workspaceRoot);
    renaming = renameProject(project.id, "Storage destination");
    void renaming.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await renameAttempted.promise;
    expect(settled).toBe(false);
    expect(await importTransactionIdentityDigest(workspace.workspaceRoot)).toBe(before);
    await expect(
      access(join(home, "projects", createManagedProjectId("Storage destination")))
    ).rejects.toThrow();
  } finally {
    hold.release();
    await command;
  }
  expect(await command).toMatchObject({ value: { ok: true }, error: null });
  if (!renaming) throw new Error("Rename was not started");
  const renamed = await renaming;
  const moved = await resolveTaskCanvasWorkspace(renamed.rootPath, canvasId);
  expect((await loadPackage(moved)).manifest.nodes.map((node) => node.id)).toContain("T-001");
  expect((await getDesktopLayoutDirect(moved)).nodes).toContainEqual(
    expect.objectContaining({ nodeId: "T-001", x: 77, y: 88 })
  );
  expect(await listPendingImportTransactions(moved.workspaceRoot)).toEqual([]);
  await expect(access(workspace.workspaceRoot)).rejects.toThrow();
  expect(
    await readFile(
      join(
        renamed.rootPath,
        relative(workspace.workspaceRoot, workspace.resultsDir),
        "history.txt"
      ),
      "utf8"
    )
  ).toBe("history-before-rename");
});

it("rejects a transaction queued after rename preflight without recreating the old root", async () => {
  const { home, project, workspace } = await fixture();
  const extra = await createTaskCanvas(workspace.rootPath, { name: "Queued canvas" });
  const canvas = await resolveTaskCanvasWorkspace(workspace.rootPath, extra.canvasId);
  const moving = barrier();
  const hold = barrier();
  const attempted = barrier();
  const nextRoot = join(home, "projects", createManagedProjectId("Storage destination"));
  vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
    if (oldPath === workspace.workspaceRoot && newPath === nextRoot) {
      moving.release();
      await hold.promise;
    }
    return actualFs.rename(oldPath, newPath);
  });
  const renameResult = renameProject(project.id, "Storage destination");
  await moving.promise;
  vi.mocked(realpath).mockImplementation(async (path, options) => {
    const result = await actualFs.realpath(path, options);
    if (path === canvas.workspaceRoot) attempted.release();
    return result;
  });
  const creation = ImportTransaction.create({
    workspaceRoot: canvas.workspaceRoot,
    transactionId: "queued-after-preflight"
  });
  const outcome = creation.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await attempted.promise;
  } finally {
    hold.release();
  }
  await renameResult;
  expect(await outcome).toBeInstanceOf(Error);
  expect(String(await outcome)).toContain("workspace");
  await expect(access(workspace.workspaceRoot)).rejects.toThrow();
  expect(
    await readFile(
      join(nextRoot, relative(workspace.workspaceRoot, workspace.resultsDir), "history.txt"),
      "utf8"
    )
  ).toBe("history-before-rename");
  const moved = await resolveTaskCanvasWorkspace(nextRoot, extra.canvasId);
  expect(await listPendingImportTransactions(moved.workspaceRoot)).toEqual([]);
});

it("requires committed recovery cleanup before relocating absolute journal paths", async () => {
  const { project, workspace } = await fixture();
  const transaction = await ImportTransaction.create({ workspaceRoot: workspace.workspaceRoot });
  await transaction.markCommitted();
  const before = await importTransactionIdentityDigest(workspace.workspaceRoot);
  await expect(renameProject(project.id, "Storage destination")).rejects.toThrow("write conflict");
  expect(await importTransactionIdentityDigest(workspace.workspaceRoot)).toBe(before);
  await transaction.cleanupCommitted();
  await expect(renameProject(project.id, "Storage destination")).resolves.toMatchObject({
    name: "Storage destination"
  });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "planweave-managed-rename-")));
  directories.push(home);
  process.env.PLANWEAVE_HOME = home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "desktop-settings.json");
  const init = await initManagedWorkspace({ name: "Storage source", projectGraph: true });
  await writeFile(join(init.workspace.resultsDir, "history.txt"), "history-before-rename");
  return { home, ...init };
}

it.each([
  "detect",
  "refresh",
  "refresh-changed"
] as const)("clears real %s file-sync history before project relocation", async (kind) => {
  const { project, workspace } = await fixture();
  const manifest = basicManifest();
  await writeJsonFile(workspace.manifestFile, manifest);
  await writePromptFiles(workspace.packageDir, manifest);
  await createTaskCanvas(workspace.rootPath, { name: "File sync peer" });
  expect(
    await executePlanGraphCommand({
      projectRoot: workspace.rootPath,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "Before external edit" }
      }
    })
  ).toMatchObject({ ok: true });
  const canvas = await resolveTaskCanvasWorkspace(workspace.rootPath, "default");
  const snapshot = await createDesktopPackageFileSnapshot(canvas);
  const prompt = manifest.nodes[0]!.prompt;
  await writeFile(join(canvas.packageDir, prompt), "# Changed externally\n");
  const writing = barrier(),
    allowWrite = barrier(),
    renameAttempted = barrier();
  const cacheRoot = join(await actualFs.realpath(workspace.workspaceRoot), "cache");
  let cacheOpens = 0;
  vi.mocked(mkdir).mockImplementation(async (path, options) => {
    if (String(path) === cacheRoot && ++cacheOpens === 3) {
      writing.release();
      await allowWrite.promise;
    }
    return actualFs.mkdir(path, options);
  });
  const syncing = (
    kind === "detect"
      ? detectDesktopPackageFileChanges(canvas, snapshot.snapshotId)
      : kind === "refresh-changed"
        ? refreshChangedDesktopPackagePrompts(canvas, snapshot.snapshotId)
        : refreshPackageFileChanges(canvas, { changedPaths: [prompt] })
  ).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error })
  );
  await writing.promise;
  const projectLock = projectMutation.withProjectMutationLock;
  vi.spyOn(projectMutation, "withProjectMutationLock").mockImplementation(
    (root, apply, options) => {
      if (typeof root !== "string") renameAttempted.release();
      return projectLock(root, apply, options);
    }
  );
  let finished = false;
  const renaming = renameProject(project.id, "Storage destination").then((value) => {
    finished = true;
    return value;
  });
  let renamedWhilePaused = false;
  try {
    await renameAttempted.promise;
    await delay(80);
    renamedWhilePaused = finished;
  } finally {
    allowWrite.release();
  }
  const result = await syncing;
  const renamed = await renaming;
  expect(renamedWhilePaused).toBe(false);
  expect(result).toMatchObject({ error: null, value: { ok: true, diagnostics: [] } });
  await expect(access(workspace.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  const db = await openDatabase(join(renamed.rootPath, "cache", "plangraph.sqlite"));
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM operation_log").get()).toMatchObject({
      count: 0
    });
  } finally {
    db.close();
  }
});

it.each([
  "undo",
  "redo",
  "command",
  "layout"
] as const)("finishes %s history writes before relocating the default SQLite index", async (kind) => {
  const { project, workspace } = await fixture();
  const manifest = basicManifest();
  await writeJsonFile(workspace.manifestFile, manifest);
  await writePromptFiles(workspace.packageDir, manifest);
  const extra = await createTaskCanvas(workspace.rootPath, { name: "History canvas" });
  if (kind === "undo" || kind === "redo") {
    expect(
      await executePlanGraphCommand({
        projectRoot: workspace.rootPath,
        command: {
          type: "addCanvasDependency",
          fromCanvasId: "default",
          toCanvasId: extra.canvasId
        }
      })
    ).toMatchObject({ ok: true });
    if (kind === "redo") {
      expect(await undoPlanGraphCommand({ projectRoot: workspace.rootPath })).toMatchObject({
        ok: true
      });
    }
  }
  const writing = barrier();
  const allowWrite = barrier();
  const pause = async () => {
    writing.release();
    await allowWrite.promise;
  };
  const dependencies = {
    createIndexStore: async (options: Parameters<typeof createSqlitePlanGraphStore>[0]) => {
      const store = await createSqlitePlanGraphStore(options);
      return {
        ...store,
        log: {
          ...store.log,
          append: async (entry: Parameters<typeof store.log.append>[0]) => {
            if (kind === "command" || kind === "layout") await pause();
            return store.log.append(entry);
          },
          markUndone: async (id: number) => {
            if (kind === "undo") await pause();
            return store.log.markUndone(id);
          },
          markRedone: async (id: number) => {
            if (kind === "redo") await pause();
            return store.log.markRedone(id);
          }
        }
      };
    }
  };
  const options = { projectRoot: workspace.rootPath, dependencies };
  const mutation =
    kind === "undo"
      ? undoPlanGraphCommand(options)
      : kind === "redo"
        ? redoPlanGraphCommand(options)
        : executePlanGraphCommand({
            ...options,
            command:
              kind === "command"
                ? { type: "updateTaskFields", taskId: "T-001", fields: { title: "Changed" } }
                : {
                    type: "updateLayout",
                    layoutScope: "desktop",
                    layout: {
                      version: "desktop-layout/v1",
                      projectId: project.id,
                      nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
                      updatedAt: "2026-10-11T00:00:00.000Z"
                    }
                  }
          });
  await writing.promise;
  const renaming = renameProject(project.id, "History destination");
  let relocatedWhileWriting: boolean;
  try {
    relocatedWhileWriting = await Promise.race([
      renaming.then(() => true),
      delay(150).then(() => false)
    ]);
  } finally {
    allowWrite.release();
  }
  const result = await mutation;
  const renamed = await renaming;
  expect(relocatedWhileWriting).toBe(false);
  expect(result).toMatchObject({ ok: true });
  await expect(access(workspace.workspaceRoot)).rejects.toThrow();
  const db = await openDatabase(join(renamed.rootPath, "cache", "plangraph.sqlite"));
  try {
    const rows = db.prepare("SELECT command_json, undone_at FROM operation_log").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      undone_at: kind === "undo" ? expect.any(String) : null
    });
    if (kind === "command" || kind === "layout") {
      expect(rows[0]).toMatchObject({
        command_json: expect.stringContaining(
          kind === "command" ? "updateTaskFields" : "updateLayout"
        )
      });
    }
  } finally {
    db.close();
  }
  if (kind === "undo" || kind === "redo") {
    const graph = await projectGraph.loadProjectGraph(renamed.rootPath);
    expect(graph.manifest.edges).toEqual(
      kind === "undo" ? [] : [{ from: "default", to: extra.canvasId, type: "depends_on" }]
    );
  } else if (kind === "command") {
    const moved = await loadPackage(renamed.rootPath);
    expect(moved.manifest.nodes[0]?.title).toBe("Changed");
  } else {
    const moved = await getDesktopLayoutDirect(renamed.rootPath);
    expect(moved.nodes).toEqual([{ nodeId: "T-001", x: 10, y: 20 }]);
  }
});

it.each([
  "command",
  "canvas-rename",
  "canvas-remove"
] as const)("finishes %s graph writes before relocating their project", async (kind) => {
  const { home, project, workspace } = await fixture();
  const extra = await createTaskCanvas(workspace.rootPath, { name: "Concurrent canvas" });
  const store = await createProjectCanvasStore(workspace.rootPath);
  const writing = barrier();
  const allowWrite = barrier();
  let pauseWrite = true;
  vi.mocked(mkdir).mockImplementation(async (path, options) => {
    if (pauseWrite && String(path) === workspace.workspaceRoot) {
      pauseWrite = false;
      writing.release();
      await allowWrite.promise;
    }
    return actualFs.mkdir(path, options);
  });
  const mutation = (
    kind === "command"
      ? executePlanGraphCommand({
          projectRoot: workspace.rootPath,
          command: {
            type: "addCanvasDependency",
            fromCanvasId: "default",
            toCanvasId: extra.canvasId
          },
          indexPath: join(home, "graph-command.sqlite"),
          recordOperation: false
        }).then((result) => {
          expect(result.ok).toBe(true);
        })
      : kind === "canvas-rename"
        ? store.rename(extra.canvasId, "Updated canvas")
        : store.remove(extra.canvasId)
  ).then(
    () => ({ error: null }),
    (error: unknown) => ({ error })
  );
  await writing.promise;
  const renaming = renameProject(project.id, "Storage destination");
  let relocatedWhileWriting: boolean;
  try {
    relocatedWhileWriting = await Promise.race([
      renaming.then(() => true),
      delay(150).then(() => false)
    ]);
  } finally {
    allowWrite.release();
  }
  const renamed = await renaming;
  const result = await mutation;
  expect(relocatedWhileWriting).toBe(false);
  expect(result.error).toBeNull();
  await expect(access(workspace.workspaceRoot)).rejects.toThrow();
  const moved = await projectGraph.loadProjectGraph(renamed.rootPath);
  if (kind === "command") {
    expect(moved.manifest.edges).toEqual([
      { from: "default", to: extra.canvasId, type: "depends_on" }
    ]);
  } else if (kind === "canvas-rename") {
    expect(moved.manifest.canvases.find((canvas) => canvas.id === extra.canvasId)?.title).toBe(
      "Updated canvas"
    );
  } else {
    expect(moved.manifest.canvases.some((canvas) => canvas.id === extra.canvasId)).toBe(false);
  }
});

it("rejects an executor queued behind managed relocation before entering its old results path", async () => {
  const { home, project, workspace } = await fixture();
  const destination = join(home, "projects", createManagedProjectId("Storage destination"));
  const moving = barrier();
  const allowMove = barrier();
  const leaseAttempted = barrier();
  let watchLease = false;
  vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
    if (String(oldPath) === workspace.workspaceRoot && String(newPath) === destination) {
      moving.release();
      await allowMove.promise;
    }
    return actualFs.rename(oldPath, newPath);
  });
  vi.mocked(realpath).mockImplementation(async (path, options) => {
    const value = await actualFs.realpath(path, options);
    if (watchLease && String(path) === workspace.workspaceRoot) leaseAttempted.release();
    return value;
  });
  let executorEntered = false;
  const renaming = renameProject(project.id, "Storage destination");
  await moving.promise;
  watchLease = true;
  const execution = withExecutorResultsWriteLease(workspace, "queued-relocation", async () => {
    executorEntered = true;
    await writeFile(join(workspace.resultsDir, "queued.log"), "queued output");
  }).then(
    () => ({ error: null }),
    (error: unknown) => ({ error })
  );
  try {
    await leaseAttempted.promise;
  } finally {
    allowMove.release();
  }
  const renamed = await renaming;
  expect((await execution).error).toBeInstanceOf(Error);
  expect(executorEntered).toBe(false);
  await expect(access(workspace.workspaceRoot)).rejects.toThrow();
  const moved = await resolveProjectWorkspace(renamed.rootPath);
  expect(await readFile(join(moved.resultsDir, "history.txt"), "utf8")).toBe(
    "history-before-rename"
  );
  await withExecutorResultsWriteLease(moved, "after-relocation", async () => {
    await writeFile(join(moved.resultsDir, "next.log"), "next output");
  });
  expect(await readFile(join(moved.resultsDir, "next.log"), "utf8")).toBe("next output");
});

it.each([
  { kind: "package", later: false, sameId: false },
  { kind: "state", later: false, sameId: false },
  { kind: "results", later: false, sameId: false },
  { kind: "layout", later: false, sameId: false },
  { kind: "graph", later: false, sameId: false },
  { kind: "results", later: true, sameId: false },
  { kind: "package", later: false, sameId: true }
] as const)("keeps all storage unchanged for pending $kind (later=$later, sameId=$sameId)", async ({
  kind,
  later,
  sameId
}) => {
  const { home, project, workspace } = await fixture();
  const canvas = later
    ? await resolveTaskCanvasWorkspace(
        workspace.rootPath,
        (await createTaskCanvas(workspace.rootPath, { name: "Later canvas" })).canvasId
      )
    : workspace;
  const target =
    kind === "package"
      ? canvas.packageDir
      : kind === "state"
        ? canvas.stateFile
        : kind === "layout"
          ? layoutPathForWorkspace(canvas)
          : kind === "graph"
            ? projectGraphPath(workspace)
            : canvas.resultsDir;
  if (kind === "layout") {
    await saveDesktopLayoutDirect(canvas, {
      version: "desktop-layout/v1",
      projectId: project.id,
      nodes: [],
      updatedAt: "2030-01-01T00:00:00.000Z"
    });
  }
  const staged = join(workspace.workspaceRoot, "staged-storage");
  await cp(target, staged, { recursive: true });
  const transactionId = "pending-rename";
  const transaction = await ImportTransaction.create({
    workspaceRoot: workspace.workspaceRoot,
    transactionId
  });
  await transaction.replacePath(target, staged);
  const journal = join(
    workspace.workspaceRoot,
    "desktop",
    "recovery",
    "package-import",
    transactionId,
    "recovery.json"
  );
  const before = {
    root: await importTransactionIdentityDigest(workspace.workspaceRoot),
    journal: await readFile(journal, "utf8")
  };
  const nextName = sameId ? project.name : "Storage destination";
  await expect(renameProject(project.id, nextName)).rejects.toThrow("write conflict");
  expect({
    root: await importTransactionIdentityDigest(workspace.workspaceRoot),
    journal: await readFile(journal, "utf8")
  }).toEqual(before);
  if (!sameId)
    await expect(
      access(join(home, "projects", createManagedProjectId(nextName)))
    ).rejects.toThrow();
  await transaction.rollback();
  expect(await readFile(join(workspace.resultsDir, "history.txt"), "utf8")).toBe(
    "history-before-rename"
  );
});

it.each([
  "writing",
  "uncertain"
] as const)("preserves the original writer path and %s lease before moving any canvas", async (status) => {
  const { home, project, workspace } = await fixture();
  const extra = await createTaskCanvas(workspace.rootPath, { name: "Live later canvas" });
  const canvas = await resolveTaskCanvasWorkspace(workspace.rootPath, extra.canvasId);
  const lease = await acquireExecutorResultsWriteLease(canvas, "rename-live-output");
  try {
    if (status === "uncertain") await lease.markUncertain();
    const before = {
      root: await importTransactionIdentityDigest(workspace.workspaceRoot),
      lease: await readFile(lease.path, "utf8")
    };
    await expect(renameProject(project.id, "Storage destination")).rejects.toThrow(
      "executor results write conflict"
    );
    expect({
      root: await importTransactionIdentityDigest(workspace.workspaceRoot),
      lease: await readFile(lease.path, "utf8")
    }).toEqual(before);
    await expect(
      access(join(home, "projects", createManagedProjectId("Storage destination")))
    ).rejects.toThrow();
    await writeFile(join(canvas.resultsDir, "next.log"), "next output on original path");
    expect(await readFile(join(canvas.resultsDir, "next.log"), "utf8")).toBe(
      "next output on original path"
    );
  } finally {
    await lease.release();
  }
});

it("moves normal managed history and preserves state while updating project and canvas titles", async () => {
  const { project, workspace } = await fixture();
  const state = await readFile(workspace.stateFile, "utf8");
  const renamed = await renameProject(project.id, "Storage destination");
  const moved = await resolveProjectWorkspace(renamed.rootPath);
  expect(renamed).toMatchObject({
    projectId: createManagedProjectId("Storage destination"),
    name: "Storage destination",
    kind: "managed"
  });
  await expect(access(workspace.workspaceRoot)).rejects.toThrow();
  expect(await readFile(moved.stateFile, "utf8")).toBe(state);
  expect(await readFile(join(moved.resultsDir, "history.txt"), "utf8")).toBe(
    "history-before-rename"
  );
  expect((await loadPackage(moved)).manifest.project.title).toBe("Storage destination");
});

async function storageContents(root: string): Promise<Record<string, string | null>> {
  const contents: Record<string, string | null> = {};
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        contents[relative(root, path)] = null;
        await visit(path);
      } else contents[relative(root, path)] = (await readFile(path)).toString("base64");
    }
  }
  await visit(root);
  return contents;
}

async function absoluteStorageFixture(formal: boolean) {
  const init = await fixture();
  const manifest = basicManifest();
  await writeJsonFile(init.workspace.manifestFile, manifest);
  await writePromptFiles(init.workspace.packageDir, manifest);
  const loaded = await projectGraph.loadProjectGraph(init.workspace.rootPath);
  const canvases = loaded.manifest.canvases.map((canvas) => ({
    ...canvas,
    packageDir: join(init.workspace.workspaceRoot, canvas.packageDir),
    stateFile: join(init.workspace.workspaceRoot, canvas.stateFile),
    resultsDir: join(init.workspace.workspaceRoot, canvas.resultsDir)
  }));
  await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), {
    version: "desktop-canvases/v1",
    activeCanvasId: "default",
    canvases: canvases.map((canvas) => ({
      canvasId: canvas.id,
      name: canvas.title,
      packageDir: canvas.packageDir,
      stateFile: canvas.stateFile,
      resultsDir: canvas.resultsDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }))
  });
  if (formal)
    await projectGraph.writeProjectGraph(init.workspace, { ...loaded.manifest, canvases });
  else await rm(projectGraphPath(init.workspace));
  const storage = await resolveTaskCanvasWorkspace(init.workspace.rootPath, "default");
  await expect(claimNext({ projectRoot: storage })).resolves.toMatchObject({
    kind: "block",
    ref: "T-001#B-001"
  });
  const reportPath = join(init.home, "implementation.md");
  await writeFile(reportPath, "Completed before absolute storage relocation.\n");
  await submitBlockResult({ projectRoot: storage, ref: "T-001#B-001", reportPath });
  return { ...init, storage };
}

it.each([
  "transaction",
  "lease"
] as const)("rejects an absolute-storage %s before modifying rename metadata", async (kind) => {
  const { home, project, workspace, storage } = await absoluteStorageFixture(true);
  const lease =
    kind === "lease"
      ? await acquireExecutorResultsWriteLease(storage, "absolute-active-writer")
      : null;
  const transaction =
    kind === "transaction"
      ? await ImportTransaction.create({ workspaceRoot: storage.workspaceRoot })
      : null;
  try {
    if (transaction) {
      const staged = join(home, "staged-results");
      await cp(storage.resultsDir, staged, { recursive: true });
      await transaction.replacePath(storage.resultsDir, staged);
    }
    const before = await importTransactionIdentityDigest(workspace.workspaceRoot);
    await expect(renameProject(project.id, "Storage destination")).rejects.toThrow(
      kind === "lease" ? "executor results write conflict" : "write conflict"
    );
    expect(await importTransactionIdentityDigest(workspace.workspaceRoot)).toBe(before);
    await expect(
      access(join(home, "projects", createManagedProjectId("Storage destination")))
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lease?.release();
    await transaction?.rollback();
  }
});

it.each([
  { formal: false, retired: false },
  { formal: true, retired: false },
  { formal: true, retired: true }
])("restores owner references and history after a post-move failure (formal=$formal, retired=$retired)", async ({
  formal,
  retired
}) => {
  const { home, project, workspace, storage } = await absoluteStorageFixture(formal);
  let retiredRoot: string | null = null;
  let retiredBefore: string | null = null;
  if (retired) {
    retiredRoot = await realpath(await mkdtemp(join(tmpdir(), "planweave-retired-owner-")));
    directories.push(retiredRoot);
    await cp(storage.packageDir, join(retiredRoot, "package"), { recursive: true });
    await cp(storage.stateFile, join(retiredRoot, "state.json"));
    await cp(storage.resultsDir, join(retiredRoot, "results"), { recursive: true });
    retiredBefore = await importTransactionIdentityDigest(retiredRoot);
    const registryFile = join(workspace.workspaceRoot, "desktop", "canvases.json");
    const registry = normalizeRegistry(JSON.parse(await readFile(registryFile, "utf8")));
    registry.canvases[0] = {
      ...registry.canvases[0],
      packageDir: join(retiredRoot, "package"),
      stateFile: join(retiredRoot, "state.json"),
      resultsDir: join(retiredRoot, "results")
    };
    await writeJsonFile(registryFile, registry);
    const loaded = await projectGraph.loadProjectGraph(workspace.rootPath);
    await projectGraph.writeProjectGraph(workspace, {
      ...loaded.manifest,
      canvases: loaded.manifest.canvases.map((canvas) => ({
        ...canvas,
        packageDir: relative(workspace.workspaceRoot, canvas.packageDir),
        stateFile: relative(workspace.workspaceRoot, canvas.stateFile),
        resultsDir: relative(workspace.workspaceRoot, canvas.resultsDir)
      }))
    });
  }
  const source = await mkdtemp(join(tmpdir(), "planweave-absolute-source-"));
  directories.push(source);
  await linkProjectSourceRoot(project.id, source);
  await setSourceDefaultProject(source, project.id);
  const before = await storageContents(workspace.workspaceRoot);
  const defaultsBefore = await readFile(join(home, "source-defaults.json"), "utf8");
  let failed = false;
  const nextRoot = join(home, "projects", createManagedProjectId("Storage destination"));
  vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
    if (!failed && String(newPath) === join(home, "source-defaults.json")) {
      await expect(access(workspace.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(nextRoot)).resolves.toBeUndefined();
      expect((await projectGraph.loadProjectGraph(nextRoot)).manifest.canvases[0].title).toBe(
        "Storage destination"
      );
      const published = normalizeRegistry(
        JSON.parse(await readFile(join(nextRoot, "desktop", "canvases.json"), "utf8"))
      );
      expect(published.canvases[0].resultsDir).toBe(
        retiredRoot
          ? join(retiredRoot, "results")
          : join(nextRoot, relative(workspace.workspaceRoot, storage.resultsDir))
      );
      failed = true;
      throw new Error("absolute relocation dependency failure");
    }
    return actualFs.rename(oldPath, newPath);
  });
  await expect(renameProject(project.id, "Storage destination")).rejects.toThrow(
    "absolute relocation dependency failure"
  );
  expect(failed).toBe(true);
  expect(await storageContents(workspace.workspaceRoot)).toEqual(before);
  expect(await readFile(join(home, "source-defaults.json"), "utf8")).toBe(defaultsBefore);
  expect((await projectGraph.loadProjectGraph(workspace.rootPath)).source).toBe(
    formal ? "project_graph" : "legacy_registry"
  );
  const restored = await resolveTaskCanvasWorkspace(workspace.rootPath, "default");
  expect(restored.resultsDir).toBe(storage.resultsDir);
  expect(
    await readFile(
      join(restored.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "report.md"),
      "utf8"
    )
  ).toBe("Completed before absolute storage relocation.\n");
  expect((await loadPackage(restored)).manifest.project.title).toBe("Test Plan");
  await expect(access(nextRoot)).rejects.toMatchObject({ code: "ENOENT" });
  if (retiredRoot) {
    expect(await importTransactionIdentityDigest(retiredRoot)).toBe(retiredBefore);
    const retried = await renameProject(project.id, "Storage destination");
    expect(retried.workspaceRoot).toBe(nextRoot);
    const moved = await resolveTaskCanvasWorkspace(nextRoot, "default");
    expect(
      await readFile(
        join(moved.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "report.md"),
        "utf8"
      )
    ).toBe("Completed before absolute storage relocation.\n");
    await expect(access(workspace.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await importTransactionIdentityDigest(retiredRoot)).toBe(retiredBefore);
  }
});

it.each([
  false,
  true
])("rejects outside-project absolute storage before any rename effect (formal=%s)", async (formal) => {
  const { home, project, workspace } = await absoluteStorageFixture(formal);
  const registryFile = join(workspace.workspaceRoot, "desktop", "canvases.json");
  const graph = await projectGraph.loadProjectGraph(workspace.rootPath);
  const outside = join(home, "outside-results");
  await mkdir(outside);
  await writeFile(join(outside, "untouched.txt"), "outside data");
  if (formal) {
    await projectGraph.writeProjectGraph(workspace, {
      ...graph.manifest,
      canvases: graph.manifest.canvases.map((canvas) => ({ ...canvas, resultsDir: outside }))
    });
  } else {
    const registry = normalizeRegistry(JSON.parse(await readFile(registryFile, "utf8")));
    registry.canvases[0].resultsDir = outside;
    await writeJsonFile(registryFile, registry);
  }
  const before = await importTransactionIdentityDigest(workspace.workspaceRoot);
  await expect(renameProject(project.id, "Storage destination")).rejects.toThrow(
    "outside the PlanWeave workspace"
  );
  expect(await importTransactionIdentityDigest(workspace.workspaceRoot)).toBe(before);
  expect(await readFile(join(outside, "untouched.txt"), "utf8")).toBe("outside data");
  await expect(
    access(join(home, "projects", createManagedProjectId("Storage destination")))
  ).rejects.toMatchObject({ code: "ENOENT" });
});
