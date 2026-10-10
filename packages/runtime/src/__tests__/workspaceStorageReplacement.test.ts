import {
  applyDefaultCanvasWorkspaceMigration,
  legacyDefaultCanvasWorkspacePaths
} from "../projectGraph/defaultCanvasWorkspaceMigration.js";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../initWorkspace.js";
import {
  createTaskCanvas,
  removeTaskCanvas,
  renameTaskCanvas,
  resolveTaskCanvasWorkspace
} from "../desktop/canvasApi.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { importTransactionIdentityDigest } from "../package/importTransactionContent.js";
import {
  projectGraphPath,
  writeProjectGraph,
  canonicalProjectCanvasNode
} from "../projectGraph/index.js";
import { withCanvasStorageMutation } from "../package/withCanvasStorageMutation.js";
import { withExecutorResultsWriteLease } from "../autoRun/executorResultsLifecycle.js";
import { execWithStreaming } from "../autoRun/executorShared.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import type { ProjectWorkspace } from "../types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  delete process.env.PLANWEAVE_HOME;
});
async function fixture() {
  const value = await createTestWorkspace();
  directories.push(value.home, value.root);
  return value;
}
async function names(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
async function snapshot(workspace: ProjectWorkspace) {
  return {
    targets: await Promise.all(
      [workspace.packageDir, workspace.stateFile, workspace.resultsDir].map(
        importTransactionIdentityDigest
      )
    ),
    backups: await names(join(workspace.workspaceRoot, "backups")),
    quarantine: await names(join(workspace.workspaceRoot, "desktop", "canvas-quarantine")),
    graph: await readFile(projectGraphPath(workspace), "utf8").catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    })
  };
}
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("public workspace storage replacement", () => {
  it.each([
    { entry: "init-results", target: "results" },
    { entry: "init-package", target: "package" },
    { entry: "init-package", target: "state" },
    { entry: "default", target: "results" },
    { entry: "default", target: "package" },
    { entry: "default", target: "state" },
    { entry: "legacy-default", target: "results" },
    { entry: "non-default", target: "results" },
    { entry: "rename", target: "package" }
  ] as const)("preflights $entry before any mutation of pending $target", async ({
    entry,
    target
  }) => {
    const { root, init } = await fixture();
    let workspace = init.workspace;
    let canvasId = "default";
    if (entry === "legacy-default") await rm(projectGraphPath(workspace));
    if (entry === "non-default") {
      canvasId = (await createTaskCanvas(root, { name: "Pending canvas" })).canvasId;
      workspace = await resolveTaskCanvasWorkspace(root, canvasId);
    }
    await mkdir(workspace.resultsDir, { recursive: true });
    await writeFile(join(workspace.resultsDir, "original.txt"), "original results");
    const actualTarget =
      target === "package"
        ? workspace.packageDir
        : target === "state"
          ? workspace.stateFile
          : workspace.resultsDir;
    const staged = join(init.workspace.workspaceRoot, "replacement");
    await cp(actualTarget, staged, { recursive: true });
    const tx = await ImportTransaction.create({
      workspaceRoot: init.workspace.workspaceRoot,
      transactionId: "pending-reset"
    });
    await tx.replacePath(actualTarget, staged);
    const before = await snapshot(workspace);
    const journalPath = join(
      init.workspace.workspaceRoot,
      "desktop",
      "recovery",
      "package-import",
      tx.transactionId,
      "recovery.json"
    );
    const journal = await readFile(journalPath, "utf8");
    const action =
      entry === "init-results"
        ? initWorkspace({ projectRoot: root, resetResults: true })
        : entry === "init-package"
          ? initWorkspace({ projectRoot: root, resetPackage: true })
          : entry === "rename"
            ? renameTaskCanvas(root, canvasId, "New name")
            : removeTaskCanvas(root, canvasId);
    await expect(action).rejects.toThrow("write conflict");
    expect(await snapshot(workspace)).toEqual(before);
    expect(await readFile(journalPath, "utf8")).toBe(journal);
    await tx.rollback();
    expect(await readFile(join(workspace.resultsDir, "original.txt"), "utf8")).toBe(
      "original results"
    );
  });

  it.each([
    "init-results",
    "init-package",
    "default",
    "non-default"
  ] as const)("protects live streaming results from $entry without retaining storage locks", async (entry) => {
    const { root, init } = await fixture();
    let workspace = init.workspace;
    let canvasId = "default";
    if (entry === "non-default") {
      canvasId = (await createTaskCanvas(root, { name: "Live canvas" })).canvasId;
      workspace = await resolveTaskCanvasWorkspace(root, canvasId);
    }
    const ready = barrier();
    const cancellation = new AbortController();
    const running = withExecutorResultsWriteLease(workspace, "live-storage-reset", () =>
      execWithStreaming({
        command: process.execPath,
        args: ["-e", "console.log('ready');setInterval(()=>console.log('writing'),20)"],
        cwd: root,
        stdoutPath: join(workspace.resultsDir, "stdout.log"),
        stderrPath: join(workspace.resultsDir, "stderr.log"),
        stdin: "",
        timeoutMs: 5000,
        signal: cancellation.signal,
        onStdout: () => ready.release()
      })
    );
    void running.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Child output did not arrive")), 3000);
        })
      ]);
      // Acquire the actual short mutation boundary while the child is still alive.
      await withCanvasStorageMutation(workspace, async () => undefined);
      if (entry === "init-results") {
        await expect(initWorkspace({ projectRoot: root })).resolves.toMatchObject({
          created: false
        });
      }
      const manifest = await readFile(workspace.manifestFile, "utf8");
      const state = await readFile(workspace.stateFile, "utf8");
      const action =
        entry === "init-results"
          ? initWorkspace({ projectRoot: root, resetResults: true })
          : entry === "init-package"
            ? initWorkspace({ projectRoot: root, resetPackage: true })
            : removeTaskCanvas(root, canvasId);
      await expect(action).rejects.toThrow("executor results write conflict");
      expect(await readFile(workspace.manifestFile, "utf8")).toBe(manifest);
      expect(await readFile(workspace.stateFile, "utf8")).toBe(state);
      expect(await readFile(join(workspace.resultsDir, "stdout.log"), "utf8")).toContain("ready");
      expect(await names(join(workspace.workspaceRoot, "backups"))).toEqual([]);
    } finally {
      clearTimeout(timer);
      cancellation.abort();
      await running.catch(() => undefined);
    }
  });

  it.each([
    "legacy",
    "canonical"
  ] as const)("preflights both migration trees before quarantining a pending %s results target", async (kind) => {
    const { init } = await fixture();
    const canonical = init.workspace;
    const legacyPaths = legacyDefaultCanvasWorkspacePaths(canonical);
    const legacy = {
      ...canonical,
      ...legacyPaths,
      manifestFile: join(legacyPaths.packageDir, "manifest.json")
    };
    await cp(canonical.packageDir, legacy.packageDir, { recursive: true });
    await cp(canonical.stateFile, legacy.stateFile);
    await writeFile(join(canonical.resultsDir, "old.txt"), "same results");
    await cp(canonical.resultsDir, legacy.resultsDir, { recursive: true });
    const workspace = kind === "legacy" ? legacy : canonical;
    const staged = join(canonical.workspaceRoot, "migration-results");
    await cp(workspace.resultsDir, staged, { recursive: true });
    const tx = await ImportTransaction.create({
      workspaceRoot: canonical.workspaceRoot,
      transactionId: "migration-pending"
    });
    await tx.replacePath(workspace.resultsDir, staged);
    const before = await Promise.all([snapshot(canonical), snapshot(legacy)]);
    const journalPath = join(
      canonical.workspaceRoot,
      "desktop",
      "recovery",
      "package-import",
      tx.transactionId,
      "recovery.json"
    );
    const journal = await readFile(journalPath, "utf8");
    await expect(applyDefaultCanvasWorkspaceMigration(canonical)).rejects.toThrow("write conflict");
    expect(await Promise.all([snapshot(canonical), snapshot(legacy)])).toEqual(before);
    expect(await readFile(journalPath, "utf8")).toBe(journal);
    await tx.rollback();
  });

  it("retains normal init backup semantics", async () => {
    const { root, init } = await fixture();
    const manifest = await readFile(init.workspace.manifestFile, "utf8");
    const state = await readFile(init.workspace.stateFile, "utf8");
    await writeFile(join(init.workspace.resultsDir, "old.txt"), "old result");
    const reset = await initWorkspace({
      projectRoot: root,
      resetPackage: true,
      resetResults: true
    });
    expect(await readFile(join(reset.backup!.packageDir!, "manifest.json"), "utf8")).toBe(manifest);
    expect(await readFile(reset.backup!.stateFile!, "utf8")).toBe(state);
    expect(await readFile(join(reset.backup!.resultsDir!, "old.txt"), "utf8")).toBe("old result");
    expect(await names(reset.workspace.resultsDir)).toEqual([]);
  });

  it("resets actual custom default paths under nested storage ownership", async () => {
    const { root, init } = await fixture();
    const canvas = {
      ...canonicalProjectCanvasNode({ id: "default", title: "Custom" }),
      packageDir: "custom/package",
      stateFile: "custom/runtime.json",
      resultsDir: "custom/output"
    };
    await mkdir(join(init.workspace.workspaceRoot, "custom"));
    await cp(init.workspace.packageDir, join(init.workspace.workspaceRoot, canvas.packageDir), {
      recursive: true
    });
    await cp(init.workspace.stateFile, join(init.workspace.workspaceRoot, canvas.stateFile));
    await mkdir(join(init.workspace.workspaceRoot, canvas.resultsDir));
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [canvas],
      edges: [],
      crossTaskEdges: []
    });
    const workspace = await resolveTaskCanvasWorkspace(root, "default");
    const oldDefault = await readFile(init.workspace.manifestFile, "utf8");
    await withCanvasStorageMutation(workspace, () => removeTaskCanvas(root, "default"));
    expect(JSON.parse(await readFile(workspace.manifestFile, "utf8")).nodes).toEqual([]);
    expect(await names(workspace.resultsDir)).toEqual([]);
    expect(await readFile(init.workspace.manifestFile, "utf8")).toBe(oldDefault);
  });
});
