import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import {
  createEmptyState,
  createSqlitePlanGraphStore,
  exportCanvasPackageFiles,
  getActiveTaskCanvasId,
  initWorkspace,
  loadPackage,
  previewPackageDraftImport,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeBridgeProjectHandlers } from "../main/runtimeBridgeProjectHandlers";
import { deferred } from "./helpers/desktopProjectFixtures";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, realpath: vi.fn(actual.realpath), rename: vi.fn(actual.rename) };
});

let actual: typeof fs;
let temporaryRoot: string;
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettingsFile = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
// Selection does not consume any Electron event fields; only transport dispatch is substituted.
const event = {} as IpcMainInvokeEvent;

beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  temporaryRoot = await fs.mkdtemp(join(tmpdir(), "planweave-selection-ipc-"));
  process.env.PLANWEAVE_HOME = join(temporaryRoot, "home");
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(temporaryRoot, "desktop-settings.json");
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettingsFile === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettingsFile;
  await actual.rm(temporaryRoot, { recursive: true, force: true });
});

async function fixture(sourceName = "source") {
  const root = join(temporaryRoot, sourceName);
  await fs.mkdir(root, { recursive: true });
  const init = await initWorkspace({ projectRoot: root });
  const b = await runtimeBridgeProjectHandlers.createTaskCanvas(event, root, { name: "Canvas B" });
  const aWorkspace = await resolveTaskCanvasWorkspace(root, "default");
  const bWorkspace = await resolveTaskCanvasWorkspace(root, b.canvasId);
  await fs.writeFile(join(aWorkspace.packageDir, "selection-marker.txt"), "A");
  await fs.writeFile(join(bWorkspace.packageDir, "selection-marker.txt"), "B");
  await runtimeBridgeProjectHandlers.selectTaskCanvas(event, root, b.canvasId);
  await runtimeBridgeProjectHandlers.selectTaskCanvas(event, root, "default");
  return {
    root,
    init,
    aWorkspace,
    bWorkspace,
    bId: b.canvasId,
    activePath: join(init.workspace.workspaceRoot, "desktop", "active-canvas.json")
  };
}

async function expectDefaultReaders(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  marker: string
) {
  expect(await getActiveTaskCanvasId(f.root)).toBe(id);
  expect(JSON.parse(await fs.readFile(f.activePath, "utf8"))).toMatchObject({ activeCanvasId: id });
  const loaded = await loadPackage(f.root);
  expect(loaded.workspace.packageDir).toBe(
    id === "default" ? f.aWorkspace.packageDir : f.bWorkspace.packageDir
  );
  const files = await exportCanvasPackageFiles(loaded.workspace);
  expect(files.find((file) => file.path === "selection-marker.txt")?.content).toBe(marker);
  const preview = await previewPackageDraftImport({
    projectRoot: f.root,
    draftRoot: f.aWorkspace.packageDir
  });
  expect(preview.target.canvasId).toBe(id);
  const snapshot = await runtimeBridgeProjectHandlers.getDesktopProjectSnapshot(event, {
    projectRoot: f.root,
    canvasId: id
  });
  expect(snapshot.graph?.projectId).toBe(f.init.workspace.id);
  expect(snapshot.errors).toEqual([]);
}

function holdNextActiveRename(path: string) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const laterCommitted = deferred<void>();
  let held = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (to.toString() === path) {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      } else {
        await actual.rename(from, to);
        laterCommitted.resolve();
        return;
      }
    }
    await actual.rename(from, to);
  });
  return { entered, release, laterCommitted };
}

async function letLaterCommandReachDisk(gate: ReturnType<typeof holdNextActiveRename>) {
  // A bounded test interleaving lets an unqueued writer commit while the first writer is held.
  // Both operations are always drained after release; no production deadline is asserted.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate.laterCommitted.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("main canvas-selection IPC persistence", () => {
  it.each(
    (["B-A", "B-A-B"] as const).flatMap((sequence) =>
      (["root", "alias", "delayed-alias"] as const).map((mode) => ({ sequence, mode }))
    )
  )("keeps last persisted intent and each command receipt for $sequence via $mode", async ({
    sequence,
    mode
  }) => {
    const f = await fixture();
    const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
    const initialHistory = await store.log.latestUndoable();
    const alias = join(temporaryRoot, "source-alias");
    await fs.symlink(f.root, alias, "dir");
    const firstResolution = deferred<void>(),
      releaseResolution = deferred<void>();
    if (mode === "delayed-alias") {
      let held = false;
      vi.mocked(fs.realpath).mockImplementation(async (...args) => {
        if (!held && args[0].toString() === f.root) {
          held = true;
          firstResolution.resolve();
          await releaseResolution.promise;
        }
        return actual.realpath(...args);
      });
    }
    const gate = holdNextActiveRename(f.activePath);
    const first = runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, f.bId);
    if (mode === "delayed-alias") await firstResolution.promise;
    else await gate.entered.promise;
    const second = runtimeBridgeProjectHandlers.selectTaskCanvas(
      event,
      mode === "root" ? f.root : alias,
      "default"
    );
    const third =
      sequence === "B-A-B"
        ? runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, f.bId)
        : null;
    await letLaterCommandReachDisk(gate);
    releaseResolution.resolve();
    await gate.entered.promise;
    gate.release.resolve();
    expect(await first).toBe(f.bId);
    expect(await second).toBe("default");
    if (third) expect(await third).toBe(f.bId);
    await expectDefaultReaders(f, third ? f.bId : "default", third ? "B" : "A");
    const operation = await store.log.latestUndoable();
    expect(operation?.command).toMatchObject({
      type: "updateLayout",
      layoutScope: "canvas",
      layout: { activeCanvasId: third ? f.bId : "default" }
    });
    expect(operation?.workspaceRef).toMatchObject({
      packageDir: third ? f.aWorkspace.packageDir : f.bWorkspace.packageDir
    });
    if (third) {
      if (!operation) throw new Error("Selection history must record the last command.");
      await store.log.markUndone(operation.id);
      const middle = await store.log.latestUndoable();
      expect(middle?.id).not.toBe(initialHistory?.id);
      expect(middle).toMatchObject({
        command: { layout: { activeCanvasId: "default" } },
        workspaceRef: { packageDir: f.bWorkspace.packageDir }
      });
    }
  });

  it("does not serialize an unrelated project's selection behind a delayed disk write", async () => {
    const a = await fixture("source-a");
    const b = await fixture("source-b");
    const gate = holdNextActiveRename(a.activePath);
    const first = runtimeBridgeProjectHandlers.selectTaskCanvas(event, a.root, a.bId);
    await gate.entered.promise;
    try {
      expect(await runtimeBridgeProjectHandlers.selectTaskCanvas(event, b.root, b.bId)).toBe(b.bId);
      expect(await getActiveTaskCanvasId(b.root)).toBe(b.bId);
    } finally {
      gate.release.resolve();
      await first;
    }
    await expectDefaultReaders(a, a.bId, "B");
  });

  it("orders captured Home aliases as one canonical project owner", async () => {
    const f = await fixture();
    const home = process.env.PLANWEAVE_HOME;
    if (!home) throw new Error("The fixture requires Home.");
    const alias = join(temporaryRoot, "home-alias");
    await fs.symlink(home, alias, "dir");
    const gate = holdNextActiveRename(f.activePath);
    const first = runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, f.bId);
    await gate.entered.promise;
    process.env.PLANWEAVE_HOME = alias;
    const second = runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, "default");
    await letLaterCommandReachDisk(gate);
    gate.release.resolve();
    expect(await first).toBe(f.bId);
    expect(await second).toBe("default");
    process.env.PLANWEAVE_HOME = home;
    await expectDefaultReaders(f, "default", "A");
    const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
    const history = await store.log.latestUndoable();
    expect(history).toMatchObject({
      command: { layout: { activeCanvasId: "default" } },
      workspaceRef: { planweaveHome: alias }
    });
    if (!history || typeof history.workspaceRef === "string") {
      throw new Error("Selection history must record the resolved command owner.");
    }
    expect(await actual.realpath(history.workspaceRef.packageDir)).toBe(
      await actual.realpath(f.bWorkspace.packageDir)
    );
  });

  it("allows a different canonical project to progress while the first resolution is delayed", async () => {
    const a = await fixture("source-a");
    const b = await fixture("source-b");
    const entered = deferred<void>(),
      release = deferred<void>();
    let held = false;
    vi.mocked(fs.realpath).mockImplementation(async (...args) => {
      if (!held && args[0].toString() === a.root) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return actual.realpath(...args);
    });
    const first = runtimeBridgeProjectHandlers.selectTaskCanvas(event, a.root, a.bId);
    await entered.promise;
    try {
      expect(await runtimeBridgeProjectHandlers.selectTaskCanvas(event, b.root, b.bId)).toBe(b.bId);
      await expectDefaultReaders(b, b.bId, "B");
    } finally {
      release.resolve();
      await first;
    }
    await expectDefaultReaders(a, a.bId, "B");
  });

  it("rejects missing root or Home without hiding the error or poisoning a valid retry", async () => {
    const f = await fixture();
    await expect(
      runtimeBridgeProjectHandlers.selectTaskCanvas(
        event,
        join(temporaryRoot, "missing-source"),
        "default"
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    const home = process.env.PLANWEAVE_HOME;
    process.env.PLANWEAVE_HOME = join(temporaryRoot, "missing-home");
    await expect(
      runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, "default")
    ).rejects.toMatchObject({ code: "ENOENT" });
    process.env.PLANWEAVE_HOME = home;
    expect(await runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, f.bId)).toBe(f.bId);
    await expectDefaultReaders(f, f.bId, "B");
  });

  it("captures Home before the first resolution await for disk, command history, and receipt", async () => {
    const a = await fixture();
    const homeA = process.env.PLANWEAVE_HOME;
    process.env.PLANWEAVE_HOME = join(temporaryRoot, "home-b");
    const b = await fixture();
    const bBefore = await fs.readFile(b.activePath);
    process.env.PLANWEAVE_HOME = homeA;
    const entered = deferred<void>(),
      release = deferred<void>();
    let paused = false;
    vi.mocked(fs.realpath).mockImplementation(async (...args) => {
      if (!paused && args[0].toString() === a.root) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return actual.realpath(...args);
    });
    const pending = runtimeBridgeProjectHandlers.selectTaskCanvas(event, a.root, a.bId);
    await entered.promise;
    process.env.PLANWEAVE_HOME = join(temporaryRoot, "home-b");
    release.resolve();
    expect(await pending).toBe(a.bId);
    expect(await fs.readFile(b.activePath)).toEqual(bBefore);
    process.env.PLANWEAVE_HOME = homeA;
    await expectDefaultReaders(a, a.bId, "B");
    const history = await createSqlitePlanGraphStore({ projectRoot: a.root });
    expect(await history.log.latestUndoable()).toMatchObject({
      workspaceRef: { planweaveHome: homeA, packageDir: a.aWorkspace.packageDir },
      command: { layout: { activeCanvasId: a.bId } }
    });
  });

  it.each(
    (["rename", "remove"] as const).flatMap((operation) =>
      (["present", "missing"] as const).map((canonical) => ({ operation, canonical }))
    )
  )("preserves legacy default paths and selection history during $operation with canonical storage $canonical", async ({
    operation,
    canonical
  }) => {
    const f = await fixture();
    const legacyPackage = join(f.init.workspace.workspaceRoot, "legacy-package");
    const legacyState = join(f.init.workspace.workspaceRoot, "legacy-state", "runtime.json");
    const legacyResults = join(f.init.workspace.workspaceRoot, "legacy-results");
    await fs.mkdir(dirname(legacyState), { recursive: true });
    await fs.mkdir(legacyResults, { recursive: true });
    await fs.writeFile(
      legacyState,
      JSON.stringify({
        ...createEmptyState(),
        tasks: { "T-LEGACY": { status: "implemented", openFeedbackCount: 0 } },
        blocks: { "T-LEGACY#B-001": { status: "completed", lastRunId: "RUN-LEGACY" } }
      })
    );
    await fs.writeFile(join(legacyResults, "history.txt"), "legacy history");
    await fs.writeFile(join(f.aWorkspace.resultsDir, "history.txt"), "canonical history");
    await fs.cp(f.aWorkspace.packageDir, legacyPackage, { recursive: true });
    await fs.unlink(join(f.init.workspace.workspaceRoot, "project-graph.json"));
    const timestamp = new Date(0).toISOString();
    await fs.writeFile(
      join(f.init.workspace.workspaceRoot, "desktop", "canvases.json"),
      JSON.stringify({
        version: "desktop-canvases/v1",
        activeCanvasId: "default",
        canvases: [
          {
            canvasId: "default",
            name: "Legacy A",
            packageDir: "legacy-package",
            stateFile: "legacy-state/runtime.json",
            resultsDir: legacyResults,
            createdAt: timestamp,
            updatedAt: timestamp
          },
          {
            canvasId: f.bId,
            name: "Legacy B",
            packageDir: f.bWorkspace.packageDir,
            stateFile: f.bWorkspace.stateFile,
            resultsDir: f.bWorkspace.resultsDir,
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ]
      })
    );
    expect((await loadPackage(f.root)).workspace.packageDir).toBe(legacyPackage);
    expect(await runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, f.bId)).toBe(f.bId);
    expect(await runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, "default")).toBe(
      "default"
    );
    const loaded = await loadPackage(f.root);
    expect(loaded.workspace.packageDir).toBe(legacyPackage);
    expect(
      (await exportCanvasPackageFiles(loaded.workspace)).find(
        (file) => file.path === "selection-marker.txt"
      )?.content
    ).toBe("A");
    const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
    expect(await store.log.latestUndoable()).toMatchObject({
      command: { layout: { activeCanvasId: "default" } },
      workspaceRef: { packageDir: f.bWorkspace.packageDir }
    });
    const registryPath = join(f.init.workspace.workspaceRoot, "desktop", "canvases.json");
    const registryBefore = JSON.parse(await fs.readFile(registryPath, "utf8"));
    const legacyManifest = join(legacyPackage, "manifest.json");
    const manifestBefore = JSON.parse(await fs.readFile(legacyManifest, "utf8"));
    const stateBefore = await fs.readFile(legacyState, "utf8");
    const independentPaths = [
      f.aWorkspace.manifestFile,
      f.aWorkspace.stateFile,
      join(f.aWorkspace.packageDir, "selection-marker.txt"),
      join(f.aWorkspace.resultsDir, "history.txt"),
      f.bWorkspace.manifestFile,
      f.bWorkspace.stateFile,
      join(f.bWorkspace.packageDir, "selection-marker.txt")
    ];
    const independentBefore = await Promise.all(independentPaths.map((path) => fs.readFile(path)));
    const canonicalBackup = join(temporaryRoot, "canonical-default-backup");
    if (canonical === "missing") await fs.rename(dirname(f.aWorkspace.packageDir), canonicalBackup);
    if (operation === "rename") {
      let failed = false;
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (!failed && to.toString() === registryPath) {
          failed = true;
          throw new Error("LEGACY-REGISTRY-COMMIT-FAIL");
        }
        return actual.rename(from, to);
      });
      await expect(
        runtimeBridgeProjectHandlers.renameTaskCanvas(event, f.root, "default", "Renamed legacy")
      ).rejects.toThrow("LEGACY-REGISTRY-COMMIT-FAIL");
      vi.mocked(fs.rename).mockImplementation(actual.rename);
      expect(JSON.parse(await fs.readFile(legacyManifest, "utf8"))).toEqual(manifestBefore);
      expect(JSON.parse(await fs.readFile(registryPath, "utf8"))).toEqual(registryBefore);
      const renamed = await runtimeBridgeProjectHandlers.renameTaskCanvas(
        event,
        f.root,
        "default",
        "Renamed legacy"
      );
      expect(renamed).toMatchObject({
        canvasId: "default",
        name: "Renamed legacy",
        packageDir: "legacy-package"
      });
      expect(JSON.parse(await fs.readFile(legacyManifest, "utf8")).project.title).toBe(
        "Renamed legacy"
      );
      const registryAfter = JSON.parse(await fs.readFile(registryPath, "utf8"));
      expect(registryAfter.canvases[0]).toMatchObject({
        ...registryBefore.canvases[0],
        name: "Renamed legacy",
        updatedAt: expect.any(String)
      });
      expect(registryAfter.canvases[1]).toEqual(registryBefore.canvases[1]);
      expect(await fs.readFile(legacyState, "utf8")).toBe(stateBefore);
      expect(await fs.readFile(join(legacyResults, "history.txt"), "utf8")).toBe("legacy history");
    } else {
      await runtimeBridgeProjectHandlers.removeTaskCanvas(event, f.root, "default");
      await expect(fs.access(join(legacyPackage, "selection-marker.txt"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(JSON.parse(await fs.readFile(legacyManifest, "utf8"))).toMatchObject({
        nodes: [],
        project: { title: "Legacy A" }
      });
      expect(JSON.parse(await fs.readFile(legacyState, "utf8"))).toEqual(createEmptyState());
      expect(await fs.readdir(legacyResults)).toEqual([]);
      expect(JSON.parse(await fs.readFile(registryPath, "utf8"))).toEqual(registryBefore);
    }
    if (canonical === "missing") {
      await expect(fs.access(f.aWorkspace.packageDir)).rejects.toMatchObject({ code: "ENOENT" });
      await fs.rename(canonicalBackup, dirname(f.aWorkspace.packageDir));
    }
    expect(await Promise.all(independentPaths.map((path) => fs.readFile(path)))).toEqual(
      independentBefore
    );
  });

  it("releases a failed canonical-owner resolution for an alias retry", async () => {
    const f = await fixture();
    const alias = join(temporaryRoot, "source-alias");
    await fs.symlink(f.root, alias, "dir");
    vi.mocked(fs.realpath).mockRejectedValueOnce(
      Object.assign(new Error("OWNER-RESOLUTION-FAIL"), { code: "EIO" })
    );
    await expect(
      runtimeBridgeProjectHandlers.selectTaskCanvas(event, alias, f.bId)
    ).rejects.toThrow("OWNER-RESOLUTION-FAIL");
    expect(await getActiveTaskCanvasId(f.root)).toBe("default");
    expect(await runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, f.bId)).toBe(f.bId);
    await expectDefaultReaders(f, f.bId, "B");
  });

  it("rejects a failed disk mutation without poisoning the next selection", async () => {
    const f = await fixture();
    const alias = join(temporaryRoot, "source-alias");
    await fs.symlink(f.root, alias, "dir");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && to === f.activePath) {
        failed = true;
        throw Object.assign(new Error("SELECTION-DISK-FAIL"), { code: "EIO" });
      }
      return actual.rename(from, to);
    });
    await expect(
      runtimeBridgeProjectHandlers.selectTaskCanvas(event, alias, f.bId)
    ).rejects.toThrow("SELECTION-DISK-FAIL");
    expect(await getActiveTaskCanvasId(f.root)).toBe("default");
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    expect(await runtimeBridgeProjectHandlers.selectTaskCanvas(event, f.root, f.bId)).toBe(f.bId);
    await expectDefaultReaders(f, f.bId, "B");
  });
});
