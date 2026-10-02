import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectFromTaskCanvas,
  removeTaskCanvas,
  resolveTaskCanvasWorkspace
} from "../desktop/canvasApi.js";
import {
  readPackageFiles,
  readSelectedPackageFiles,
  readPackageFileInventory
} from "../package/packageFiles.js";
import { loadProjectGraph, projectGraphPath, writeProjectGraph } from "../projectGraph/index.js";
import { registryVersion } from "../desktop/canvasRegistry.js";
import { writeJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import type { ProjectWorkspace } from "../types.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rm: vi.fn(actual.rm), readdir: vi.fn(actual.readdir), cp: vi.fn(actual.cp) };
});
vi.mock("../package/packageFileConsistency.js", async (original) => {
  const actual = await original<typeof import("../package/packageFileConsistency.js")>();
  return { ...actual, withPackageFileConsistency: vi.fn(actual.withPackageFileConsistency) };
});
vi.mock("../initWorkspace.js", async (original) => {
  const actual = await original<typeof import("../initWorkspace.js")>();
  return { ...actual, initManagedWorkspace: vi.fn(actual.initManagedWorkspace) };
});
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { initManagedWorkspace } from "../initWorkspace.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const intents = ["full", "selected", "inventory"] as const;
type Intent = (typeof intents)[number];
function read(root: string, intent: Intent) {
  if (intent === "inventory") return readPackageFileInventory(root);
  if (intent === "selected") return readSelectedPackageFiles(root, ["a.md", "b.md", "a.md"]);
  return readPackageFiles(root);
}
const cleanupRoots: string[] = [];
beforeEach(async () => {
  const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rm).mockReset().mockImplementation(actualFs.rm);
  vi.mocked(fs.readdir).mockReset().mockImplementation(actualFs.readdir);
  vi.mocked(fs.cp).mockReset().mockImplementation(actualFs.cp);
  const lock = await vi.importActual<typeof import("../package/packageFileConsistency.js")>(
    "../package/packageFileConsistency.js"
  );
  vi.mocked(withPackageFileConsistency)
    .mockReset()
    .mockImplementation(lock.withPackageFileConsistency);
  const init = await vi.importActual<typeof import("../initWorkspace.js")>("../initWorkspace.js");
  vi.mocked(initManagedWorkspace).mockReset().mockImplementation(init.initManagedWorkspace);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  for (const root of cleanupRoots.splice(0))
    await actual.rm(root, { recursive: true, force: true });
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function holdBatch(root: string, intent: Intent) {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  await actual.writeFile(join(root, "a.md"), "old-A");
  await actual.writeFile(join(root, "b.md"), "old-B");
  const entered = deferred<void>();
  const release = deferred<void>();
  vi.mocked(fs.readdir).mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
    const result = await Reflect.apply(actual.readdir, actual, args);
    if (args[0] === root) {
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const result = read(root, intent).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await entered.promise;
  return {
    result,
    release: () => {
      release.resolve();
      vi.mocked(fs.readdir).mockImplementation(actual.readdir);
    }
  };
}

async function watchWriter(roots: string[], cleanupRoot?: string) {
  const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
  const actualLock = await vi.importActual<typeof import("../package/packageFileConsistency.js")>(
    "../package/packageFileConsistency.js"
  );
  const event = deferred<"locked" | "deleted">();
  vi.mocked(withPackageFileConsistency).mockImplementation(async (targets, action) => {
    if (targets.length === roots.length && roots.every((root) => targets.includes(root)))
      event.resolve("locked");
    return actualLock.withPackageFileConsistency(targets, action);
  });
  vi.mocked(fs.rm).mockImplementation(async (path, options) => {
    if (roots.includes(String(path)) || path === cleanupRoot) event.resolve("deleted");
    return actualFs.rm(path, options);
  });
  return { event: event.promise };
}

function assertOld(
  outcome: Awaited<ReturnType<typeof holdBatch>>["result"] extends Promise<infer T> ? T : never,
  intent: Intent
) {
  expect(outcome).not.toHaveProperty("error");
  if (!("value" in outcome)) throw new Error("read rejected");
  const bodies = outcome.value.filter((file) => file.path === "a.md" || file.path === "b.md");
  if (intent === "inventory") {
    expect(bodies).toEqual([
      { path: "a.md", contentBytes: 5, encoding: "utf8" },
      { path: "b.md", contentBytes: 5, encoding: "utf8" }
    ]);
  } else {
    const expected = [
      { path: "a.md", content: "old-A", encoding: "utf8" },
      { path: "b.md", content: "old-B", encoding: "utf8" }
    ];
    if (intent === "selected") expected.push(expected[0]!);
    expect(bodies).toEqual(expected);
  }
}

describe("public live canvas writers and complete package batches", () => {
  it.each(
    (["default", "only", "legacy"] as const).flatMap((mode) =>
      intents.map((intent) => [mode, intent] as const)
    )
  )("%s reset protects a complete %s read", async (mode, intent) => {
    const ctx = await createTestWorkspace();
    cleanupRoots.push(ctx.home, ctx.root);
    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    let canvasId = "default";
    let workspace = await resolveTaskCanvasWorkspace(ctx.root, canvasId);
    if (mode === "only") {
      const { createTaskCanvas } = await import("../desktop/canvasApi.js");
      const created = await createTaskCanvas(ctx.root, { name: "Only canvas" });
      const graph = await loadProjectGraph(ctx.root);
      await writeProjectGraph(graph.workspace, {
        ...graph.manifest,
        canvases: graph.manifest.canvases.filter((canvas) => canvas.id === created.canvasId)
      });
      canvasId = created.canvasId;
      workspace = await resolveTaskCanvasWorkspace(ctx.root, canvasId);
    } else if (mode === "legacy") {
      await actualFs.rm(projectGraphPath(ctx.init.workspace), { force: true });
      await actualFs.mkdir(join(ctx.init.workspace.workspaceRoot, "desktop"), {
        recursive: true
      });
      await writeJsonFile(join(ctx.init.workspace.workspaceRoot, "desktop", "canvases.json"), {
        version: registryVersion,
        canvases: [
          {
            canvasId: "default",
            name: "Legacy canvas",
            packageDir: workspace.packageDir,
            stateFile: workspace.stateFile,
            resultsDir: workspace.resultsDir,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString()
          }
        ]
      });
      workspace = await resolveTaskCanvasWorkspace(ctx.root, "default");
    }
    const held = await holdBatch(workspace.packageDir, intent);
    const { event } = await watchWriter([workspace.packageDir]);
    let finished = false;
    const writer = removeTaskCanvas(ctx.root, canvasId).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    void writer.then(() => {
      finished = true;
    });
    const observed = await event;
    let beforeRelease: string[] | undefined;
    let finishedBeforeRelease: boolean | undefined;
    try {
      beforeRelease = await observeOldDisk(workspace.packageDir);
      finishedBeforeRelease = finished;
    } finally {
      held.release();
    }
    const readOutcome = await held.result;
    const writeOutcome = await writer;
    expect(beforeRelease).toEqual(["old-A", "old-B"]);
    expect(finishedBeforeRelease).toBe(false);
    expect(observed).toBe("locked");
    assertOld(readOutcome, intent);
    expect(writeOutcome).not.toHaveProperty("error");
    await expect(fs.access(join(workspace.packageDir, "a.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each(
    intents
  )("project copy waits for complete target %s read before publishing", async (intent) => {
    await copyRace(intent, false);
  });
  it.each(
    intents
  )("failed project copy protects target %s read and releases after cleanup", async (intent) => {
    await copyRace(intent, true);
  });
  it("preserves cleanup failure precedence and releases the failed copy keys", async () => {
    const ctx = await createTestWorkspace();
    cleanupRoots.push(ctx.home, ctx.root);
    const source = await resolveTaskCanvasWorkspace(ctx.root, "default");
    const actualInit =
      await vi.importActual<typeof import("../initWorkspace.js")>("../initWorkspace.js");
    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    const copyFailure = Object.assign(new Error("copy failed"), { code: "EIO" });
    const cleanupFailure = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    const target: { workspace?: ProjectWorkspace; root?: string } = {};
    vi.mocked(initManagedWorkspace).mockImplementation(async (options) => {
      const init = await actualInit.initManagedWorkspace(options);
      target.workspace = await resolveTaskCanvasWorkspace(init.project.rootPath, "default");
      target.root = init.workspace.workspaceRoot;
      vi.mocked(fs.cp).mockImplementation(async (from, to, options) => {
        if (from === source.packageDir && to === target.workspace?.packageDir) {
          await actualFs.cp(from, to, options);
          throw copyFailure;
        }
        return actualFs.cp(from, to, options);
      });
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        if (path === target.root) throw cleanupFailure;
        return actualFs.rm(path, options);
      });
      return init;
    });
    await expect(
      createProjectFromTaskCanvas(ctx.root, "default", { name: "Cleanup failure" })
    ).rejects.toBe(cleanupFailure);
    if (!target.workspace || !target.root) throw new Error("actual target was not created");
    await expect(actualFs.access(target.root)).resolves.toBeUndefined();
    await withPackageFileConsistency([source.packageDir, target.workspace.packageDir], async () => {
      await actualFs.writeFile(join(target.workspace!.packageDir, "retry.md"), "retry-ok");
    });
    expect(await readSelectedPackageFiles(target.workspace.packageDir, ["retry.md"])).toEqual([
      { path: "retry.md", content: "retry-ok", encoding: "utf8" }
    ]);
  });
});

async function copyRace(intent: Intent, fail: boolean) {
  const ctx = await createTestWorkspace();
  cleanupRoots.push(ctx.home, ctx.root);
  const source = await resolveTaskCanvasWorkspace(ctx.root, "default");
  const actualInit =
    await vi.importActual<typeof import("../initWorkspace.js")>("../initWorkspace.js");
  const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
  let cleanupHeld = false;
  let cleanupEntered = false;
  let finished = false;
  const ready = deferred<{
    workspace: ProjectWorkspace;
    held: Awaited<ReturnType<typeof holdBatch>>;
    event: Promise<"locked" | "deleted">;
  }>();
  const copyFailure = Object.assign(new Error("copy permission denied"), { code: "EACCES" });
  vi.mocked(initManagedWorkspace).mockImplementation(async (options) => {
    const init = await actualInit.initManagedWorkspace(options);
    const workspace = await resolveTaskCanvasWorkspace(init.project.rootPath, "default");
    const held = await holdBatch(workspace.packageDir, intent);
    const { event } = await watchWriter(
      [source.packageDir, workspace.packageDir],
      init.workspace.workspaceRoot
    );
    if (fail) {
      const canonicalTarget = await actualFs.realpath(workspace.packageDir);
      const key = createHash("sha256").update(canonicalTarget).digest("hex");
      const lockPath = join(userInfo().homedir, ".cache", "planweave", "package-locks", key);
      const previousRm = vi.mocked(fs.rm).getMockImplementation()!;
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        if (path === init.workspace.workspaceRoot) {
          cleanupEntered = true;
          cleanupHeld = await actualFs.stat(lockPath).then(
            (stat) => stat.isDirectory(),
            () => false
          );
        }
        return previousRm(path, options);
      });
      vi.mocked(fs.cp).mockImplementation(async (from, to, options) => {
        if (from === source.packageDir && to === workspace.packageDir) throw copyFailure;
        return actualFs.cp(from, to, options);
      });
    }
    ready.resolve({ workspace, held, event });
    return init;
  });
  const writer = createProjectFromTaskCanvas(ctx.root, "default", { name: "Copy race" }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  void writer.then(() => {
    finished = true;
  });
  const { workspace, held, event } = await ready.promise;
  const observed = await event;
  let beforeRelease: string[] | undefined;
  let finishedBeforeRelease: boolean | undefined;
  try {
    beforeRelease = await observeOldDisk(workspace.packageDir);
    finishedBeforeRelease = finished;
  } finally {
    held.release();
  }
  const readOutcome = await held.result;
  const outcome = await writer;
  expect(beforeRelease).toEqual(["old-A", "old-B"]);
  expect(finishedBeforeRelease).toBe(false);
  expect(observed).toBe("locked");
  assertOld(readOutcome, intent);
  if (fail) {
    expect(cleanupEntered).toBe(true);
    expect(cleanupHeld).toBe(true);
    expect(outcome).toEqual({ error: copyFailure });
    await expect(fs.access(workspace.packageDir)).rejects.toMatchObject({ code: "ENOENT" });
    // The very same target key must be usable after the failed writer and cleanup.
    await withPackageFileConsistency([workspace.packageDir], async () => {
      await actualFs.mkdir(workspace.packageDir, { recursive: true });
      await actualFs.writeFile(join(workspace.packageDir, "retry.md"), "retry-ok");
    });
    expect(await readSelectedPackageFiles(workspace.packageDir, ["retry.md"])).toEqual([
      { path: "retry.md", content: "retry-ok", encoding: "utf8" }
    ]);
  } else {
    expect(outcome).not.toHaveProperty("error");
    expect(await fs.readFile(join(workspace.packageDir, "manifest.json"), "utf8")).toContain(
      "Copy race"
    );
  }
}

async function observeOldDisk(root: string): Promise<string[]> {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  return Promise.all(
    ["a.md", "b.md"].map((path) => actual.readFile(join(root, path), "utf8"))
  ).catch((error) => [String(error)]);
}
