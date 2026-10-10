import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initManagedWorkspace } from "../initWorkspace.js";
import { renameProject } from "../desktop/projectApi.js";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { acquireExecutorResultsWriteLease } from "../package/executorResultsWriteLease.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { importTransactionIdentityDigest } from "../package/importTransactionContent.js";
import { createManagedProjectId } from "../projectId.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolveProjectWorkspace } from "../project.js";
import { projectGraphPath } from "../projectGraph/index.js";
import { layoutPathForWorkspace, saveDesktopLayoutDirect } from "../desktop/layoutStore.js";

const directories: string[] = [];
afterEach(async () => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
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
