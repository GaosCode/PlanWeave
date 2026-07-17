import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCanvasMapLayout,
  getSourceDefaultProject,
  initManagedProject,
  linkProjectSourceRoot,
  renameProject,
  setSourceDefaultProject
} from "../desktop/index.js";
import { canvasMapLayoutDiskLockPath } from "../desktop/canvasMapLayout.js";
import { resolveProjectWorkspace } from "../project.js";
import { createManagedProjectId } from "../projectId.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm)
  };
});

let actualFs: typeof import("node:fs/promises");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const temporaryPaths = new Set<string>();

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation((oldPath, newPath) => actualFs.rename(oldPath, newPath));
  vi.mocked(rm).mockImplementation((path, options) => actualFs.rm(path, options));
});

afterEach(async () => {
  for (const path of temporaryPaths) {
    await actualFs.rm(path, { recursive: true, force: true });
  }
  temporaryPaths.clear();
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe("desktop project rename transaction", () => {
  it("keeps an external next-root writer blocked until failed rename rollback is complete", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-rename-writer-source-"));
    temporaryPaths.add(sourceRoot);
    const project = await initManagedProject("Managed Writer Transaction");
    await linkProjectSourceRoot(project.projectId, sourceRoot);
    await setSourceDefaultProject(sourceRoot, project.projectId);
    const nextName = "Managed Writer Transaction Target";
    const nextProjectId = createManagedProjectId(nextName);
    const nextWorkspaceRoot = join(testHome, "projects", nextProjectId);
    const sourceDefaultsPath = join(testHome, "source-defaults.json");
    const previousWorkspace = await resolveProjectWorkspace(project.workspaceRoot);
    const nextWorkspace = { ...previousWorkspace, id: nextProjectId };
    const transactionLockPaths = new Set([
      canvasMapLayoutDiskLockPath(previousWorkspace),
      canvasMapLayoutDiskLockPath(nextWorkspace)
    ]);
    let signalDependencyUpdate!: () => void;
    const dependencyUpdateReached = new Promise<void>((resolveReached) => {
      signalDependencyUpdate = resolveReached;
    });
    let releaseDependencyUpdate!: () => void;
    const dependencyUpdateGate = new Promise<void>((resolveGate) => {
      releaseDependencyUpdate = resolveGate;
    });
    let signalRollbackMove!: () => void;
    const rollbackMoveReached = new Promise<void>((resolveReached) => {
      signalRollbackMove = resolveReached;
    });
    let releaseRollbackMove!: () => void;
    const rollbackMoveGate = new Promise<void>((resolveGate) => {
      releaseRollbackMove = resolveGate;
    });
    let failDependencyUpdate = true;
    let rollbackComplete = false;
    let prematureLockRelease = false;
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (typeof path === "string" && transactionLockPaths.has(path) && !rollbackComplete) {
        prematureLockRelease = true;
      }
      return actualFs.rm(path, options);
    });
    vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
      if (newPath === sourceDefaultsPath && failDependencyUpdate) {
        failDependencyUpdate = false;
        signalDependencyUpdate();
        await dependencyUpdateGate;
        throw new Error("simulated source-default update failure");
      }
      if (oldPath === nextWorkspaceRoot && newPath === project.workspaceRoot) {
        signalRollbackMove();
        await rollbackMoveGate;
        await actualFs.rename(oldPath, newPath);
        rollbackComplete = true;
        return;
      }
      return actualFs.rename(oldPath, newPath);
    });

    const renameOutcome = renameProject(project.projectId, nextName).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const writerScript = [
      'import { access } from "node:fs/promises";',
      'import { saveCanvasMapLayout } from "./packages/runtime/src/desktop/index.ts";',
      'import { canvasMapLayoutDiskLockPath } from "./packages/runtime/src/desktop/canvasMapLayout.ts";',
      'import { resolveProjectWorkspace } from "./packages/runtime/src/project.ts";',
      "const [projectRoot, projectId] = process.argv.slice(1);",
      "const workspace = await resolveProjectWorkspace(projectRoot);",
      "const lockPath = canvasMapLayoutDiskLockPath(workspace);",
      "await access(lockPath);",
      "process.stdout.write('writer-ready:' + JSON.stringify({projectId:workspace.id,lockPath}) + '\\n');",
      "try {",
      "  const saved = await saveCanvasMapLayout(projectRoot, {version:'desktop-canvas-map-layout/v1',projectId,nodes:[{canvasId:'default',x:707,y:909}],updatedAt:'2026-07-01T00:00:00.000Z'});",
      "  process.stdout.write('writer-result:' + JSON.stringify({status:'fulfilled',projectId:saved.projectId}) + '\\n');",
      "} catch (error) {",
      "  process.stdout.write('writer-result:' + JSON.stringify({status:'rejected',message:error instanceof Error ? error.message : String(error)}) + '\\n');",
      "}"
    ].join("\n");
    let writerOutput = "";
    let dependencyReleased = false;
    let rollbackReleased = false;
    let writer: ReturnType<typeof spawn> | undefined;
    let writerExit: Promise<unknown> | undefined;
    try {
      await withTimeout(dependencyUpdateReached, "forward dependency update barrier");
      expect(prematureLockRelease).toBe(false);
      await expect(access(nextWorkspaceRoot)).resolves.toBeUndefined();

      writer = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          writerScript,
          nextWorkspaceRoot,
          nextProjectId
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, PLANWEAVE_HOME: testHome },
          stdio: ["ignore", "pipe", "inherit"]
        }
      );
      writerExit = once(writer, "exit");
      if (!writer.stdout) {
        throw new Error("External writer stdout pipe is unavailable");
      }
      let signalWriterReady!: () => void;
      const writerReady = new Promise<void>((resolveReady) => {
        signalWriterReady = resolveReady;
      });
      writer.stdout.setEncoding("utf8");
      writer.stdout.on("data", (chunk: string) => {
        writerOutput += chunk;
        if (writerOutput.includes("writer-ready:")) {
          signalWriterReady();
        }
      });

      await withTimeout(
        Promise.race([
          writerReady,
          writerExit.then(() => {
            throw new Error(`External writer exited before ready: ${writerOutput}`);
          })
        ]),
        "external writer ready barrier"
      );
      expect(writerOutput).toContain(`"projectId":"${nextProjectId}"`);
      expect(writerOutput).toContain(`"lockPath":"${canvasMapLayoutDiskLockPath(nextWorkspace)}"`);
      expect(writerOutput).not.toContain("writer-result:");

      dependencyReleased = true;
      releaseDependencyUpdate();
      await withTimeout(rollbackMoveReached, "rollback move barrier");
      expect(prematureLockRelease).toBe(false);
      expect(writerOutput).not.toContain("writer-result:");

      rollbackReleased = true;
      releaseRollbackMove();
      const outcome = await withTimeout(renameOutcome, "rename rollback result");
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toEqual(
          expect.objectContaining({ message: "simulated source-default update failure" })
        );
      }
      await withTimeout(writerExit, "external writer exit");
    } finally {
      if (!dependencyReleased) {
        releaseDependencyUpdate();
      }
      if (!rollbackReleased) {
        releaseRollbackMove();
      }
      if (writer?.exitCode === null) {
        writer.kill("SIGTERM");
        if (writerExit) {
          await withTimeout(writerExit, "external writer cleanup");
        }
      }
      await withTimeout(renameOutcome, "rename transaction cleanup");
    }

    expect(prematureLockRelease).toBe(false);
    expect(writerOutput).toContain('writer-result:{"status":"rejected"');
    expect(writerOutput).toContain("ENOENT");
    await expect(access(project.workspaceRoot)).resolves.toBeUndefined();
    await expect(access(nextWorkspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(getCanvasMapLayout(project.workspaceRoot)).resolves.not.toMatchObject({
      nodes: [{ canvasId: "default", x: 707, y: 909 }]
    });
    await expect(getSourceDefaultProject(sourceRoot)).resolves.toMatchObject({
      projectId: project.projectId,
      projectRoot: project.workspaceRoot
    });
    await expect(access(canvasMapLayoutDiskLockPath(previousWorkspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(canvasMapLayoutDiskLockPath(nextWorkspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
