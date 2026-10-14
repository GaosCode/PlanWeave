import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as graphStorage from "../projectGraph/loadProjectGraph.js";
import * as canvasContent from "../projectGraph/canvasWorkspaceContent.js";
import * as canvasRecovery from "../projectGraph/canvasWorkspaceRecovery.js";
import {
  renameProjectCanvas,
  removeProjectCanvas
} from "../projectGraph/projectCanvasLifecycleMutation.js";
import * as selectionCommands from "../desktop/canvasSelectionApi.js";
import * as jsonStorage from "../json.js";
import { selectTaskCanvas } from "../desktop/canvasSelectionApi.js";
import {
  readActiveTaskCanvasSelection,
  writeActiveTaskCanvasSelection
} from "../desktop/canvasSelectionStore.js";
import * as planGraphCommands from "../plangraph/index.js";
import { archiveTaskCanvas } from "../desktop/canvasApi.js";
import * as projectLocks from "../fs/withProjectMutationLock.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeJsonFile } from "../json.js";
import { createProjectCanvas } from "../projectGraph/projectCanvasMutation.js";
import { loadProjectGraph, projectGraphPath } from "../projectGraph/index.js";
import type { ProjectGraphManifest } from "../projectGraph/types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  vi.restoreAllMocks();
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
function canvasIdsFromGraph(manifest: ProjectGraphManifest): string[] {
  return manifest.canvases.map((canvas) => canvas.id).sort();
}

describe("canvas lifecycle authoritative project boundary", () => {
  it("rejects an archive when another process selects the target before lock admission", async () => {
    const { root, init } = await createTestWorkspace();
    const target = await createProjectCanvas({ projectRoot: root, title: "Archive target" });
    const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { withProjectMutationLock } from ${JSON.stringify(join(runtimeRoot, "src/fs/withProjectMutationLock.ts"))};
      import { writeActiveTaskCanvasSelection } from ${JSON.stringify(join(runtimeRoot, "src/desktop/canvasSelectionStore.ts"))};
      await withProjectMutationLock(process.env.TEST_LOCK_ROOT, async () => {
        process.send("held");
        await new Promise(resolve => process.once("message", resolve));
        await writeActiveTaskCanvasSelection(process.env.TEST_PROJECT_ROOT, process.env.TEST_CANVAS_ID);
      });
      process.disconnect();
    `
      ],
      {
        cwd: runtimeRoot,
        env: {
          ...process.env,
          TEST_LOCK_ROOT: init.workspace.workspaceRoot,
          TEST_PROJECT_ROOT: root,
          TEST_CANVAS_ID: target.canvas.id
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
      });
      let admit!: () => void;
      const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const lock = projectLocks.withProjectMutationLock;
      vi.spyOn(projectLocks, "withProjectMutationLock").mockImplementation((roots, fn, options) => {
        admit();
        return lock(roots, fn, options);
      });
      const archived = archiveTaskCanvas(root, target.canvas.id);
      const rejection = expect(archived).rejects.toThrow("Cannot archive active task canvas");
      await admitted;
      child.send("select");
      expect(await exited, stderr).toBe(0);
      await rejection;
      const loaded = await loadProjectGraph(root);
      expect(canvasIdsFromGraph(loaded.manifest)).toContain(target.canvas.id);
      expect(await pathExists(target.canvasWorkspace.manifestFile)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});

async function heldChildMutation(root: string, lockRoot: string, action: string) {
  const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { withProjectMutationLock } from ${JSON.stringify(join(runtimeRoot, "src/fs/withProjectMutationLock.ts"))};
    import { createProjectCanvas } from ${JSON.stringify(join(runtimeRoot, "src/projectGraph/projectCanvasMutation.ts"))};
    import { renameTaskCanvas } from ${JSON.stringify(join(runtimeRoot, "src/desktop/canvasApi.ts"))};
    import { loadProjectGraph, writeProjectGraph } from ${JSON.stringify(join(runtimeRoot, "src/projectGraph/loadProjectGraph.ts"))};
    await withProjectMutationLock(process.env.TEST_LOCK_ROOT, async () => {
      process.send("held");
      await new Promise(resolve => process.once("message", resolve));
      ${action}
    });
    process.disconnect();
  `
    ],
    {
      cwd: runtimeRoot,
      env: { ...process.env, TEST_LOCK_ROOT: lockRoot, TEST_PROJECT_ROOT: root },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    }
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
  });
  return { child, exited, stderr: () => stderr };
}

async function queuedAfterChild<T>(
  holder: Awaited<ReturnType<typeof heldChildMutation>>,
  action: () => Promise<T>
) {
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const lock = projectLocks.withProjectMutationLock;
  const spy = vi
    .spyOn(projectLocks, "withProjectMutationLock")
    .mockImplementation((roots, fn, options) => {
      admit();
      return lock(roots, fn, options);
    });
  try {
    const operation = action();
    // Attach immediately so a queued rejection never becomes an unhandled rejection.
    const settled = operation.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await admitted;
    holder.child.send("mutate");
    expect(await holder.exited, holder.stderr()).toBe(0);
    const result = await settled;
    if ("error" in result) throw result.error;
    return result.value;
  } finally {
    spy.mockRestore();
    if (holder.child.exitCode === null) holder.child.kill();
  }
}

describe("canvas lifecycle concurrent storage and recovery", () => {
  it.each([
    "rename",
    "archive"
  ] as const)("preserves a child-process registration and unrelated dependencies during %s", async (operation) => {
    const { root, init } = await createTestWorkspace();
    const target = await createProjectCanvas({ projectRoot: root, title: "Target" });
    const holder = await heldChildMutation(
      root,
      init.workspace.workspaceRoot,
      `
      const created = await createProjectCanvas({ projectRoot: process.env.TEST_PROJECT_ROOT, title: "Independent" });
      const loaded = await loadProjectGraph(process.env.TEST_PROJECT_ROOT);
      await writeProjectGraph(loaded.workspace, { ...loaded.manifest,
        edges: [{ from: created.canvas.id, to: "default", type: "depends_on" }],
        crossTaskEdges: [{ from: { canvasId: created.canvas.id, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" }, type: "depends_on" }] });
    `
    );
    await queuedAfterChild(holder, () =>
      operation === "rename"
        ? renameProjectCanvas({ projectRoot: root, canvasId: target.canvas.id, name: "Renamed" })
        : archiveTaskCanvas(root, target.canvas.id)
    );
    const loaded = await loadProjectGraph(root);
    expect(canvasIdsFromGraph(loaded.manifest)).toContain("independent");
    expect(loaded.manifest.canvases.find((canvas) => canvas.id === "independent")?.title).toBe(
      "Independent"
    );
    expect(loaded.manifest.edges).toEqual([
      { from: "independent", to: "default", type: "depends_on" }
    ]);
    expect(loaded.manifest.crossTaskEdges).toEqual([
      {
        from: { canvasId: "independent", taskId: "T-001" },
        to: { canvasId: "default", taskId: "T-001" },
        type: "depends_on"
      }
    ]);
    expect(
      await pathExists(
        join(init.workspace.workspaceRoot, "canvases", "independent", "package", "manifest.json")
      )
    ).toBe(true);
    if (operation === "rename") {
      expect(loaded.manifest.canvases.find((canvas) => canvas.id === target.canvas.id)?.title).toBe(
        "Renamed"
      );
      expect(
        JSON.parse(await readFile(target.canvasWorkspace.manifestFile, "utf8")).project.title
      ).toBe("Renamed");
    } else expect(canvasIdsFromGraph(loaded.manifest)).not.toContain(target.canvas.id);
  });

  it.each([
    "same",
    "different"
  ] as const)("serializes %s canvas renames across processes", async (scope) => {
    const { root, init } = await createTestWorkspace();
    const first = await createProjectCanvas({ projectRoot: root, title: "First" });
    const second = await createProjectCanvas({ projectRoot: root, title: "Second" });
    const childId = scope === "same" ? first.canvas.id : second.canvas.id;
    const holder = await heldChildMutation(
      root,
      init.workspace.workspaceRoot,
      `await renameTaskCanvas(process.env.TEST_PROJECT_ROOT, ${JSON.stringify(childId)}, "Child title");`
    );
    await queuedAfterChild(holder, () =>
      renameProjectCanvas({ projectRoot: root, canvasId: first.canvas.id, name: "Parent title" })
    );
    const loaded = await loadProjectGraph(root);
    expect(loaded.manifest.canvases.find((canvas) => canvas.id === first.canvas.id)?.title).toBe(
      "Parent title"
    );
    expect(loaded.manifest.canvases.find((canvas) => canvas.id === second.canvas.id)?.title).toBe(
      scope === "same" ? "Second" : "Child title"
    );
    for (const canvas of [first, second]) {
      const title = JSON.parse(await readFile(canvas.canvasWorkspace.manifestFile, "utf8")).project
        .title;
      expect(title).toBe(
        loaded.manifest.canvases.find((node) => node.id === canvas.canvas.id)?.title
      );
    }
  });

  it.each([
    "canvas",
    "cross-task"
  ] as const)("rejects archive after a child adds a %s dependency", async (edgeKind) => {
    const { root, init } = await createTestWorkspace();
    const target = await createProjectCanvas({ projectRoot: root, title: "Referenced" });
    const holder = await heldChildMutation(
      root,
      init.workspace.workspaceRoot,
      `
      const loaded = await loadProjectGraph(process.env.TEST_PROJECT_ROOT);
      await writeProjectGraph(loaded.workspace, { ...loaded.manifest,
        edges: ${edgeKind === "canvas" ? JSON.stringify([{ from: "default", to: target.canvas.id, type: "depends_on" }]) : "[]"},
        crossTaskEdges: ${edgeKind === "cross-task" ? JSON.stringify([{ from: { canvasId: "default", taskId: "T-001" }, to: { canvasId: target.canvas.id, taskId: "T-001" }, type: "depends_on" }]) : "[]"}
      });
    `
    );
    await expect(
      queuedAfterChild(holder, () => archiveTaskCanvas(root, target.canvas.id))
    ).rejects.toThrow("referenced by project graph dependencies");
    expect(await pathExists(target.canvasWorkspace.manifestFile)).toBe(true);
    expect(canvasIdsFromGraph((await loadProjectGraph(root)).manifest)).toContain(target.canvas.id);
  });

  it.each([
    "title",
    "quarantine",
    "graph-rename",
    "graph-remove"
  ] as const)("recovers %s failure and retries without losing an independent mutation", async (failure) => {
    const { root } = await createTestWorkspace();
    const target = await createProjectCanvas({ projectRoot: root, title: "Before failure" });
    const rename = failure === "title" || failure === "graph-rename";
    const manifestBefore = await readFile(target.canvasWorkspace.manifestFile, "utf8");
    const graphBefore = (await loadProjectGraph(root)).manifest;
    const spy =
      failure === "title"
        ? vi
            .spyOn(canvasContent, "writeManifestTitle")
            .mockRejectedValueOnce(new Error("title fault"))
        : failure === "quarantine"
          ? vi
              .spyOn(canvasRecovery, "quarantineCanvasWorkspace")
              .mockRejectedValueOnce(new Error("quarantine fault"))
          : vi
              .spyOn(graphStorage, "writeProjectGraph")
              .mockImplementationOnce(async (workspace, manifest) => {
                await writeJsonFile(projectGraphPath(workspace), manifest, {
                  rename: async () => {
                    throw new Error("graph fault");
                  }
                });
                return manifest;
              });
    await expect(
      rename
        ? renameProjectCanvas({
            projectRoot: root,
            canvasId: target.canvas.id,
            name: "After retry"
          })
        : removeProjectCanvas({ projectRoot: root, canvasId: target.canvas.id })
    ).rejects.toThrow(/fault/);
    spy.mockRestore();
    expect((await loadProjectGraph(root)).manifest).toEqual(graphBefore);
    expect(await readFile(target.canvasWorkspace.manifestFile, "utf8")).toBe(manifestBefore);
    const independent = await createProjectCanvas({
      projectRoot: root,
      title: "Independent success"
    });
    if (rename)
      await renameProjectCanvas({
        projectRoot: root,
        canvasId: target.canvas.id,
        name: "After retry"
      });
    else await removeProjectCanvas({ projectRoot: root, canvasId: target.canvas.id });
    expect(canvasIdsFromGraph((await loadProjectGraph(root)).manifest)).toContain(
      independent.canvas.id
    );
  });

  it.each([
    "rename",
    "remove"
  ] as const)("retains both errors when %s compensation fails and releases the project lock", async (operation) => {
    const { root } = await createTestWorkspace();
    const target = await createProjectCanvas({ projectRoot: root, title: "Recovery evidence" });
    vi.spyOn(graphStorage, "writeProjectGraph").mockRejectedValueOnce(
      new Error("primary graph fault")
    );
    if (operation === "rename") {
      const writeTitle = canvasContent.writeManifestTitle;
      vi.spyOn(canvasContent, "writeManifestTitle")
        .mockImplementationOnce(writeTitle)
        .mockRejectedValueOnce(new Error("title rollback fault"));
    } else
      vi.spyOn(canvasRecovery, "restoreQuarantinedCanvasWorkspace").mockRejectedValueOnce(
        new Error("restore rollback fault")
      );
    await expect(
      operation === "rename"
        ? renameProjectCanvas({
            projectRoot: root,
            canvasId: target.canvas.id,
            name: "Written before fault"
          })
        : removeProjectCanvas({ projectRoot: root, canvasId: target.canvas.id })
    ).rejects.toThrow(/primary graph fault.*rollback.*fault/);
    vi.restoreAllMocks();
    expect(canvasIdsFromGraph((await loadProjectGraph(root)).manifest)).toContain(target.canvas.id);
    const next = await createProjectCanvas({ projectRoot: root, title: "Lock released" });
    expect(canvasIdsFromGraph((await loadProjectGraph(root)).manifest)).toContain(next.canvas.id);
  });
});

describe("forced archive selection transaction", () => {
  it("restores selection and exposes both errors when real index opening fails after selection persistence", async () => {
    const { root, init } = await createTestWorkspace();
    const target = await createProjectCanvas({ projectRoot: root, title: "Index failure target" });
    await writeActiveTaskCanvasSelection(root, target.canvas.id);
    const graphBefore = (await loadProjectGraph(root)).manifest;
    const packageBefore = await readFile(target.canvasWorkspace.manifestFile, "utf8");
    await mkdir(join(init.workspace.workspaceRoot, "cache", "plangraph.sqlite"), {
      recursive: true
    });
    const failure = archiveTaskCanvas(root, target.canvas.id, { force: true, reason: "fixture" });
    await expect(failure).rejects.toThrow("unable to open database file");
    const error: unknown = await failure.catch((caught) => caught);
    expect(error).toMatchObject({
      cause: expect.objectContaining({
        errors: [
          expect.objectContaining({
            message: expect.stringContaining("unable to open database file")
          }),
          expect.objectContaining({
            message: expect.stringContaining("unable to open database file")
          })
        ]
      })
    });
    expect((await readActiveTaskCanvasSelection(root)).activeCanvasId).toBe(target.canvas.id);
    expect((await loadProjectGraph(root)).manifest).toEqual(graphBefore);
    expect(await readFile(target.canvasWorkspace.manifestFile, "utf8")).toBe(packageBefore);
    const independent = await createProjectCanvas({
      projectRoot: root,
      title: "After index failure"
    });
    expect(canvasIdsFromGraph((await loadProjectGraph(root)).manifest)).toContain(
      independent.canvas.id
    );
  });

  it("restores legacy selection when registry refresh fails after the fallback command succeeds", async () => {
    const { root, init } = await createTestWorkspace();
    const target = await createProjectCanvas({
      projectRoot: root,
      title: "Legacy metadata target"
    });
    const graphBefore = (await loadProjectGraph(root)).manifest;
    const registryPath = join(init.workspace.workspaceRoot, "desktop", "canvases.json");
    const now = new Date().toISOString();
    await writeJsonFile(registryPath, {
      version: "desktop-canvases/v1",
      activeCanvasId: target.canvas.id,
      canvases: graphBefore.canvases.map((canvas) => ({
        canvasId: canvas.id,
        name: canvas.title,
        packageDir: canvas.packageDir,
        stateFile: canvas.stateFile,
        resultsDir: canvas.resultsDir,
        createdAt: now,
        updatedAt: now
      }))
    });
    await rm(projectGraphPath(init.workspace));
    const packageBefore = await readFile(target.canvasWorkspace.manifestFile, "utf8");
    let refreshPending = false;
    let successfulFallback: string | null = null;
    const select = selectionCommands.selectTaskCanvasForWorkspace;
    vi.spyOn(selectionCommands, "selectTaskCanvasForWorkspace").mockImplementation(
      async (workspace, canvasId) => {
        const selected = await select(workspace, canvasId);
        if (canvasId === "default") {
          successfulFallback = selected;
          refreshPending = true;
        }
        return selected;
      }
    );
    const read = jsonStorage.readJsonFile;
    vi.spyOn(jsonStorage, "readJsonFile").mockImplementation(
      async <T>(path: string): Promise<T> => {
        if (refreshPending && path === registryPath) {
          refreshPending = false;
          throw new Error("registry refresh fault");
        }
        return read<T>(path);
      }
    );
    await expect(
      archiveTaskCanvas(root, target.canvas.id, { force: true, reason: "fixture" })
    ).rejects.toThrow("registry refresh fault");
    expect(successfulFallback).toBe("default");
    expect((await readActiveTaskCanvasSelection(root)).activeCanvasId).toBe(target.canvas.id);
    expect((await loadProjectGraph(root)).manifest).toEqual(graphBefore);
    expect(await readFile(target.canvasWorkspace.manifestFile, "utf8")).toBe(packageBefore);
    vi.restoreAllMocks();
    const independent = await createProjectCanvas({
      projectRoot: root,
      title: "After refresh failure"
    });
    expect(canvasIdsFromGraph((await loadProjectGraph(root)).manifest)).toContain(
      independent.canvas.id
    );
  });

  it("restores the prior selection when an active canvas archive cannot commit", async () => {
    const { root } = await createTestWorkspace();
    const target = await createProjectCanvas({ projectRoot: root, title: "Active target" });
    await selectTaskCanvas(root, target.canvas.id);
    const before = (await loadProjectGraph(root)).manifest;
    vi.spyOn(graphStorage, "writeProjectGraph").mockRejectedValueOnce(
      new Error("archive commit fault")
    );
    await expect(
      archiveTaskCanvas(root, target.canvas.id, { force: true, reason: "fixture" })
    ).rejects.toThrow("archive commit fault");
    expect((await readActiveTaskCanvasSelection(root)).activeCanvasId).toBe(target.canvas.id);
    expect((await loadProjectGraph(root)).manifest).toEqual(before);
    expect(await pathExists(target.canvasWorkspace.manifestFile)).toBe(true);
  });

  it("does not wait on an outer selection queue while holding the archive project lock", async () => {
    const { root } = await createTestWorkspace();
    const target = await createProjectCanvas({
      projectRoot: root,
      title: "Queued selection target"
    });
    await writeActiveTaskCanvasSelection(root, target.canvas.id);
    let reached!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = planGraphCommands.executePlanGraphCommand;
    vi.spyOn(planGraphCommands, "executePlanGraphCommand").mockImplementationOnce(
      async (options) => {
        reached();
        await resumed;
        return execute(options);
      }
    );
    const queued = selectTaskCanvas(root, "default").then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    try {
      await admitted;
      const result = await archiveTaskCanvas(root, target.canvas.id, {
        force: true,
        reason: "fixture"
      });
      expect(result.activeCanvasId).toBe("default");
      expect(result.remaining.map((canvas) => canvas.canvasId)).not.toContain(target.canvas.id);
    } finally {
      release();
      await queued;
    }
  });
});
