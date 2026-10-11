import { access, cp, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initManagedWorkspace } from "../initWorkspace.js";
import { renameProject } from "../desktop/projectApi.js";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { acquireExecutorResultsWriteLease } from "../package/executorResultsWriteLease.js";
import { withExecutorResultsWriteLease } from "../autoRun/executorResultsLifecycle.js";
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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), realpath: vi.fn(actual.realpath) };
});
let actualFs: typeof import("node:fs/promises");
beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation((oldPath, newPath) => actualFs.rename(oldPath, newPath));
  vi.mocked(realpath).mockImplementation((path, options) => actualFs.realpath(path, options));
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
])("keeps a created Canvas journal on its original workspace (later=%s)", async (later) => {
  const { home, project, workspace } = await fixture();
  const canvas = later
    ? await resolveTaskCanvasWorkspace(
        workspace.rootPath,
        (await createTaskCanvas(workspace.rootPath, { name: "Pending canvas" })).canvasId
      )
    : workspace;
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
  try {
    await created.promise;
    const before = await importTransactionIdentityDigest(workspace.workspaceRoot);
    await expect(renameProject(project.id, "Storage destination")).rejects.toThrow(
      "write conflict"
    );
    expect(await importTransactionIdentityDigest(workspace.workspaceRoot)).toBe(before);
    await expect(
      access(join(home, "projects", createManagedProjectId("Storage destination")))
    ).rejects.toThrow();
  } finally {
    hold.release();
    await command;
  }
  expect(await command).toMatchObject({ value: { ok: true }, error: null });
  expect((await loadPackage(canvas)).manifest.nodes.map((node) => node.id)).toContain("T-001");
  expect((await getDesktopLayoutDirect(canvas)).nodes).toContainEqual(
    expect.objectContaining({ nodeId: "T-001", x: 77, y: 88 })
  );
  expect(await listPendingImportTransactions(canvas.workspaceRoot)).toEqual([]);
  expect(await readFile(join(workspace.resultsDir, "history.txt"), "utf8")).toBe(
    "history-before-rename"
  );
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
  const home = await mkdtemp(join(tmpdir(), "planweave-managed-rename-"));
  directories.push(home);
  process.env.PLANWEAVE_HOME = home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "desktop-settings.json");
  const init = await initManagedWorkspace({ name: "Storage source", projectGraph: true });
  await writeFile(join(init.workspace.resultsDir, "history.txt"), "history-before-rename");
  return { home, ...init };
}

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
    if (watchLease && String(path) === workspace.resultsDir) leaseAttempted.release();
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
