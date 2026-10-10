import * as fs from "node:fs/promises";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  applyAuthorizedCanvasCommand,
  commitCanvasCommandApplication
} from "../graph/canvasCommandPort.js";
import { buildCanvasCommandApplication } from "../graph/canvasCommandMutation.js";
import {
  getDesktopLayoutDirect,
  layoutPathForWorkspace,
  saveDesktopLayoutDirect
} from "../desktop/layoutStore.js";
import { resetDesktopLayoutDirect } from "../desktop/layoutStore.js";
import { loadPackage } from "../package/loadPackage.js";
import { ImportTransaction } from "../package/importTransaction.js";
import {
  listPendingImportTransactions,
  rollbackPendingImportTransaction
} from "../package/importRecovery.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { spawnReviewRetryActor } from "./helpers/reviewRetryProcessFixture.js";
import * as transactionContent from "../package/importTransactionContent.js";
import { realFs } from "./support/importTransactionTestHarness.js";

vi.mock("../fs/advisoryDirectoryLock.js", async (original) => {
  const actual = await original<typeof import("../fs/advisoryDirectoryLock.js")>();
  return { ...actual, withAdvisoryDirectoryLock: vi.fn(actual.withAdvisoryDirectoryLock) };
});
const directories: string[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}
function track<T>(promise: Promise<T>) {
  pending.push(promise.catch(() => undefined));
  return promise;
}
afterEach(async () => {
  releases.splice(0).forEach((release) => {
    release();
  });
  await Promise.all(pending.splice(0));
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});
async function fixture(present = false) {
  const f = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
  directories.push(f.home, f.root);
  const workspace = f.init.workspace;
  if (present)
    await saveDesktopLayoutDirect(workspace, {
      ...(await getDesktopLayoutDirect(workspace)),
      nodes: [{ nodeId: "T-002", x: 1, y: 2 }]
    });
  return workspace;
}
async function application(workspace: Awaited<ReturnType<typeof fixture>>) {
  return buildCanvasCommandApplication(
    (await loadPackage(workspace)).manifest,
    await getDesktopLayoutDirect(workspace),
    {
      kind: "update_layout",
      nodes: [{ nodeId: "T-001", x: 777, y: 888 }],
      updatedAt: "2030-01-01T00:00:00.000Z"
    }
  );
}
async function bytes(path: string) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
it.each([
  false,
  true
])("restores package and layout existence after save/publish/marker failure (present=%s)", async (present) => {
  for (const failure of ["save", "publish", "marker"]) {
    const workspace = await fixture(present);
    const path = layoutPathForWorkspace(workspace);
    const before = { manifest: await bytes(workspace.manifestFile), layout: await bytes(path) };
    const original = new Error(`${failure}_failed`);
    const replace = ImportTransaction.prototype.replacePath;
    const spy = vi
      .spyOn(ImportTransaction.prototype, "replacePath")
      .mockImplementation(async function (target, staged) {
        await replace.call(this, target, staged);
        if (failure === "publish" && target === path) throw original;
      });
    try {
      await expect(
        commitCanvasCommandApplication({
          workspace,
          application: await application(workspace),
          dependencies: {
            saveLayout: async (...args) => {
              const result = await saveDesktopLayoutDirect(...args);
              if (failure === "save") throw original;
              return result;
            },
            markTransactionCommitted: async (transaction) => {
              if (failure === "marker") throw original;
              await transaction.markCommitted();
            }
          }
        })
      ).rejects.toBe(original);
      expect({ manifest: await bytes(workspace.manifestFile), layout: await bytes(path) }).toEqual(
        before
      );
      expect(await listPendingImportTransactions(workspace.workspaceRoot)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }
});
it("does not lose independent successful layout intents prepared concurrently", async () => {
  const workspace = await fixture();
  const both = deferred();
  const create = ImportTransaction.create;
  let count = 0;
  vi.spyOn(ImportTransaction, "create").mockImplementation(async (options) => {
    const transaction = await create(options);
    count += 1;
    if (count === 2) both.resolve();
    await both.promise;
    return transaction;
  });
  const results = await Promise.all(
    ["T-001", "T-002"].map((nodeId) =>
      track(
        applyAuthorizedCanvasCommand({
          projectRoot: workspace,
          canvasId: "default",
          intent: {
            kind: "update_layout",
            nodes: [{ nodeId, x: 5, y: 6 }],
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        })
      )
    )
  );
  const nodes = (await getDesktopLayoutDirect(workspace)).nodes.map((node) => node.nodeId);
  for (const [index, result] of results.entries()) {
    if (result.ok) expect(nodes).toContain(index === 0 ? "T-001" : "T-002");
    else expect(result.detail).toContain("layout");
  }
  expect(results.some((result) => result.ok)).toBe(true);
});
it("rolls back before a direct layout writer may publish", async () => {
  const workspace = await fixture(true);
  const marker = deferred(),
    release = deferred(),
    contended = deferred();
  const actual = await vi.importActual<typeof import("../fs/advisoryDirectoryLock.js")>(
    "../fs/advisoryDirectoryLock.js"
  );
  const command = track(
    commitCanvasCommandApplication({
      workspace,
      application: await application(workspace),
      dependencies: {
        markTransactionCommitted: async () => {
          marker.resolve();
          await release.promise;
          throw new Error("marker_failed");
        }
      }
    }).catch((error: unknown) => error)
  );
  await marker.promise;
  vi.mocked(withAdvisoryDirectoryLock).mockImplementation((options, action) => {
    const result = actual.withAdvisoryDirectoryLock(options, action);
    if (options.lockPath.includes("package-locks")) contended.resolve();
    return result;
  });
  const writer = track(
    saveDesktopLayoutDirect(workspace, {
      version: "desktop-layout/v1",
      projectId: workspace.id,
      nodes: [{ nodeId: "T-002", x: 22, y: 33 }],
      updatedAt: "2030-01-02T00:00:00.000Z"
    })
  );
  await contended.promise;
  release.resolve();
  expect(await command).toMatchObject({ message: "marker_failed" });
  await writer;
  expect((await getDesktopLayoutDirect(workspace)).nodes).toEqual([
    { nodeId: "T-002", x: 22, y: 33 }
  ]);
});
it("keeps original and rollback errors and recovers both targets", async () => {
  const workspace = await fixture();
  const original = new Error("marker_failed"),
    rollback = new Error("rollback_failed");
  vi.spyOn(ImportTransaction.prototype, "rollback").mockRejectedValueOnce(rollback);
  const error = await commitCanvasCommandApplication({
    workspace,
    application: await application(workspace),
    dependencies: {
      markTransactionCommitted: async () => {
        throw original;
      }
    }
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([original, rollback]);
  const [recovery] = await listPendingImportTransactions(workspace.workspaceRoot);
  expect(recovery).toBeDefined();
  await rollbackPendingImportTransaction({
    workspaceRoot: workspace.workspaceRoot,
    transactionId: recovery!.transactionId
  });
  expect(await bytes(layoutPathForWorkspace(workspace))).toBeNull();
  expect((await getDesktopLayoutDirect(workspace)).nodes).toEqual([]);
});
it.each([
  "command",
  "layout",
  "identical layout",
  "ABA layout",
  "child graph"
])("preserves a later successful %s write when recovery is delayed after marker and rollback failure", async (writer) => {
  const workspace = await fixture();
  const original = new Error("marker_failed"),
    rollback = new Error("rollback_failed");
  vi.spyOn(ImportTransaction.prototype, "rollback").mockRejectedValueOnce(rollback);
  const failure = await commitCanvasCommandApplication({
    workspace,
    application: await application(workspace),
    dependencies: {
      markTransactionCommitted: async () => {
        throw original;
      }
    }
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([original, rollback]);
  const [recovery] = await listPendingImportTransactions(workspace.workspaceRoot);
  if (!recovery) throw new Error("Missing pending transaction");
  expect(recovery.operationCount).toBe(2);
  const recoveryFile = `${recovery.recoveryRoot}/recovery.json`;
  const recoveryBefore = await bytes(recoveryFile);
  const installed = await getDesktopLayoutDirect(workspace);
  let actor: ReturnType<typeof spawnReviewRetryActor> | undefined;
  try {
    if (writer === "command") {
      expect(
        await applyAuthorizedCanvasCommand({
          projectRoot: workspace,
          canvasId: "default",
          intent: {
            kind: "update_layout",
            nodes: [{ nodeId: "T-002", x: 22, y: 33 }],
            updatedAt: "2030-01-02T00:00:00.000Z"
          }
        })
      ).toMatchObject({ ok: true });
    } else if (writer === "child graph") {
      actor = spawnReviewRetryActor(workspace, true);
      await actor.ready;
    } else {
      if (writer === "ABA layout") {
        await saveDesktopLayoutDirect(
          workspace,
          { ...installed, nodes: [] },
          { updatedAt: installed.updatedAt }
        );
      }
      await saveDesktopLayoutDirect(
        workspace,
        writer === "layout"
          ? { ...installed, nodes: [{ nodeId: "T-002", x: 22, y: 33 }] }
          : installed,
        { updatedAt: installed.updatedAt }
      );
    }
    const saved = {
      manifest: await bytes(workspace.manifestFile),
      layout: await bytes(layoutPathForWorkspace(workspace))
    };
    const contended = deferred();
    if (actor) {
      const actual = await vi.importActual<typeof import("../fs/advisoryDirectoryLock.js")>(
        "../fs/advisoryDirectoryLock.js"
      );
      vi.mocked(withAdvisoryDirectoryLock).mockImplementation((options, action) => {
        return actual.withAdvisoryDirectoryLock(
          {
            ...options,
            fs: {
              ...fs,
              optionalStat: realFs.optionalStat,
              mkdir: async (path) => {
                try {
                  await fs.mkdir(path);
                } catch (error) {
                  if (
                    error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === "EEXIST"
                  )
                    contended.resolve();
                  throw error;
                }
              }
            }
          },
          action
        );
      });
    }
    const recovering = track(
      rollbackPendingImportTransaction({
        workspaceRoot: workspace.workspaceRoot,
        transactionId: recovery.transactionId
      }).catch((error: unknown) => error)
    );
    if (actor) {
      await contended.promise;
      actor.child.stdin.write("continue\n");
      expect(await actor.done).toMatchObject({ code: 0, stderr: "" });
    }
    expect(await recovering).toMatchObject({
      message: expect.stringContaining("ownership conflict")
    });
    expect({
      manifest: await bytes(workspace.manifestFile),
      layout: await bytes(layoutPathForWorkspace(workspace))
    }).toEqual(saved);
    expect(await bytes(recoveryFile)).toBe(recoveryBefore);
    expect(await listPendingImportTransactions(workspace.workspaceRoot)).toHaveLength(1);
  } finally {
    if (actor) {
      if (!actor.child.stdin.destroyed) actor.child.stdin.write("continue\n");
      await actor.done;
    }
  }
});
it("holds both targets from ownership preflight through restore while a direct layout write contends", async () => {
  const workspace = await fixture(true);
  vi.spyOn(ImportTransaction.prototype, "rollback").mockRejectedValueOnce(
    new Error("rollback_failed")
  );
  await expect(
    commitCanvasCommandApplication({
      workspace,
      application: await application(workspace),
      dependencies: {
        markTransactionCommitted: async () => {
          throw new Error("marker_failed");
        }
      }
    })
  ).rejects.toThrow("canvas_command_commit_rollback_failed");
  const [recovery] = await listPendingImportTransactions(workspace.workspaceRoot);
  if (!recovery) throw new Error("Missing recovery");
  const checked = deferred(),
    release = deferred(),
    contended = deferred();
  const identity = transactionContent.importTransactionIdentityDigest;
  vi.spyOn(transactionContent, "importTransactionIdentityDigest").mockImplementation(
    async (target) => {
      const digest = await identity(target);
      if (target === workspace.packageDir) {
        checked.resolve();
        await release.promise;
      }
      return digest;
    }
  );
  const recovering = track(
    rollbackPendingImportTransaction({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: recovery.transactionId
    })
  );
  await checked.promise;
  const actual = await vi.importActual<typeof import("../fs/advisoryDirectoryLock.js")>(
    "../fs/advisoryDirectoryLock.js"
  );
  vi.mocked(withAdvisoryDirectoryLock).mockImplementation((options, action) => {
    const result = actual.withAdvisoryDirectoryLock(options, action);
    if (options.lockPath.includes("package-locks")) contended.resolve();
    return result;
  });
  const writer = track(
    saveDesktopLayoutDirect(workspace, {
      version: "desktop-layout/v1",
      projectId: workspace.id,
      nodes: [{ nodeId: "T-002", x: 22, y: 33 }],
      updatedAt: "2030-01-02T00:00:00.000Z"
    })
  );
  await contended.promise;
  expect(
    (JSON.parse((await bytes(layoutPathForWorkspace(workspace)))!) as { nodes: unknown[] }).nodes
  ).toContainEqual({ nodeId: "T-001", x: 777, y: 888 });
  release.resolve();
  await recovering;
  await writer;
  expect((await getDesktopLayoutDirect(workspace)).nodes).toEqual([
    { nodeId: "T-002", x: 22, y: 33 }
  ]);
  expect(await listPendingImportTransactions(workspace.workspaceRoot)).toEqual([]);
});
it("rejects confirming an absent layout deletion while interrupted recovery still owns its backup", async () => {
  const workspace = await fixture(true);
  const layout = layoutPathForWorkspace(workspace);
  const create = ImportTransaction.create;
  const created = vi.spyOn(ImportTransaction, "create").mockImplementation((options) =>
    create({
      ...options,
      fs: {
        ...realFs,
        rename: async (source, target) => {
          if (String(source).includes("/backups/") && target === layout)
            throw new Error("restore_failed");
          return fs.rename(source, target);
        }
      }
    })
  );
  await expect(
    commitCanvasCommandApplication({
      workspace,
      application: await application(workspace),
      dependencies: {
        markTransactionCommitted: async () => {
          throw new Error("marker_failed");
        }
      }
    })
  ).rejects.toThrow("canvas_command_commit_rollback_failed");
  expect(await bytes(layout)).toBeNull();
  const [recovery] = await listPendingImportTransactions(workspace.workspaceRoot);
  if (!recovery) throw new Error("Missing recovery");
  await expect(resetDesktopLayoutDirect(workspace)).rejects.toThrow("removal conflict");
  expect(await bytes(layout)).toBeNull();
  created.mockRestore();
  await rollbackPendingImportTransaction({
    workspaceRoot: workspace.workspaceRoot,
    transactionId: recovery.transactionId
  });
  expect((await getDesktopLayoutDirect(workspace)).nodes).toEqual([
    { nodeId: "T-002", x: 1, y: 2 }
  ]);
  await resetDesktopLayoutDirect(workspace);
  expect(await bytes(layout)).toBeNull();
});
it("publishes add/remove graph and layout as one transaction", async () => {
  const workspace = await fixture();
  expect(
    await applyAuthorizedCanvasCommand({
      projectRoot: workspace,
      canvasId: "default",
      intent: {
        kind: "add_task",
        taskId: "T-003",
        title: "Added",
        promptMarkdown: "Work",
        layout: { nodeId: "T-003", x: 3, y: 4 },
        layoutUpdatedAt: "2030-01-01T00:00:00.000Z"
      }
    })
  ).toMatchObject({ ok: true });
  expect((await getDesktopLayoutDirect(workspace)).nodes).toContainEqual({
    nodeId: "T-003",
    x: 3,
    y: 4
  });
  expect(
    await applyAuthorizedCanvasCommand({
      projectRoot: workspace,
      canvasId: "default",
      intent: { kind: "remove_task", taskId: "T-003" }
    })
  ).toMatchObject({ ok: true });
  expect((await getDesktopLayoutDirect(workspace)).nodes).toEqual([]);
  expect((await loadPackage(workspace)).manifest.nodes.some((node) => node.id === "T-003")).toBe(
    false
  );
});
