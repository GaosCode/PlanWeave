import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsStore } from "../../../desktop/src/main/desktopSettingsStore.js";
import { createTaskCanvas } from "../desktop/canvasApi.js";
import {
  getCanvasMapLayout,
  resetCanvasMapLayout,
  saveCanvasMapLayout
} from "../desktop/canvasGraphApi.js";
import * as layoutLocks from "../desktop/canvasMapLayout.js";
import { renameProject } from "../desktop/projectApi.js";
import * as projectLocks from "../fs/withProjectMutationLock.js";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import type { DesktopCanvasMapLayout } from "../desktop/types.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    )
    .finally(() => {
      settled = true;
    });
  return { outcome, isSettled: () => settled };
}

async function fixture() {
  const owner = await mkdtemp(join(tmpdir(), "pw-layout-home-admission-"));
  directories.push(owner);
  const homeA = join(owner, "home-a");
  const homeB = join(owner, "home-b");
  const source = join(owner, "source");
  await Promise.all([mkdir(homeA), mkdir(homeB), mkdir(source)]);
  const settings = new DesktopSettingsStore({
    settingsFile: join(owner, "settings.json"),
    planweaveHomeBaseline: homeA
  });
  await settings.mergePatch({ planweaveHome: homeA });
  const a = await initWorkspace({ projectRoot: source, projectGraph: true });
  const extra = await createTaskCanvas(source, { name: "Canvas only in A" });
  const layoutA: DesktopCanvasMapLayout = {
    version: "desktop-canvas-map-layout/v1",
    projectId: a.project.id,
    nodes: [
      { canvasId: "default", x: 110, y: 220 },
      { canvasId: extra.canvasId, x: 555, y: 666 }
    ],
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
  await saveCanvasMapLayout(source, layoutA);
  const holder = await initManagedWorkspace({
    name: "Layout Admission Holder",
    projectGraph: true
  });
  const pathA = layoutLocks.canvasMapLayoutPath(a.workspace);
  const beforeA = await readFile(pathA, "utf8");
  const graphPathA = join(a.workspace.workspaceRoot, "project-graph.json");
  const graphBeforeA = await readFile(graphPathA, "utf8");
  await settings.mergePatch({ planweaveHome: homeB });
  const b = await initWorkspace({ projectRoot: source, projectGraph: true });
  await saveCanvasMapLayout(source, {
    ...layoutA,
    nodes: [{ canvasId: "default", x: 900, y: 901 }]
  });
  const pathB = layoutLocks.canvasMapLayoutPath(b.workspace);
  const beforeB = await readFile(pathB, "utf8");
  const graphPathB = join(b.workspace.workspaceRoot, "project-graph.json");
  const graphBeforeB = await readFile(graphPathB, "utf8");
  const projectBeforeB = await readFile(b.workspace.projectFile, "utf8");
  await settings.mergePatch({ planweaveHome: homeA });
  return {
    a,
    b,
    source,
    settings,
    homeB,
    holder,
    layoutA,
    extra,
    pathA,
    pathB,
    beforeA,
    beforeB,
    graphPathA,
    graphPathB,
    graphBeforeA,
    graphBeforeB,
    projectBeforeB
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Operation = "get" | "save" | "reset";
type Boundary = "admission" | "disk";

function invoke(f: Fixture, operation: Operation) {
  if (operation === "get") return getCanvasMapLayout(f.source);
  if (operation === "reset") return resetCanvasMapLayout(f.source);
  return saveCanvasMapLayout(f.source, {
    ...f.layoutA,
    nodes: f.layoutA.nodes.map((node) => ({ ...node, x: node.x + 10, y: node.y + 20 }))
  });
}

async function holdBoundary(f: Fixture, boundary: Boundary) {
  const entered = deferred();
  const release = deferred();
  const holding =
    boundary === "disk"
      ? layoutLocks.withCanvasMapLayoutDiskLock(f.a.workspace, "test-layout-holder", async () => {
          entered.resolve();
          await release.promise;
        })
      : projectLocks.withProjectMutationLock(f.holder.workspace.workspaceRoot, async () => {
          entered.resolve();
          await release.promise;
        });
  await entered.promise;
  const waiting = deferred();
  let relocation: ReturnType<typeof observe<Awaited<ReturnType<typeof renameProject>>>> | undefined;
  if (boundary === "disk") {
    const realDiskLock = layoutLocks.withCanvasMapLayoutDiskLock;
    vi.spyOn(layoutLocks, "withCanvasMapLayoutDiskLock").mockImplementation(
      (workspace, operation, fn) => {
        waiting.resolve();
        return realDiskLock(workspace, operation, fn);
      }
    );
  } else {
    const realParentLock = projectLocks.withProjectMutationLock;
    vi.spyOn(projectLocks, "withProjectMutationLock").mockImplementation((roots, fn, options) => {
      if (options?.operation === "rename-project") waiting.resolve();
      return realParentLock(roots, fn, options);
    });
    relocation = observe(renameProject(f.holder.project.id, "Layout Admission Holder Renamed"));
    await waiting.promise;
  }
  return { holding, release: release.resolve, waiting: waiting.promise, relocation };
}

describe("canvas map layout Home admission", () => {
  const successCases = (["admission", "disk"] as const).flatMap((boundary) =>
    (["get", "save", "reset"] as const).map((operation) => ({ boundary, operation }))
  );
  it.each(
    successCases
  )("keeps $operation layout and canvas membership in A after waiting for $boundary", async ({
    boundary,
    operation
  }) => {
    const f = await fixture();
    const barrier = await holdBoundary(f, boundary);
    const request = observe(invoke(f, operation));
    try {
      if (boundary === "disk") await barrier.waiting;
      await delay(10);
      expect(request.isSettled()).toBe(false);
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      barrier.release();
      await barrier.holding;
      const result = await request.outcome;
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.nodes.map((node) => node.canvasId)).toEqual([
        "default",
        f.extra.canvasId
      ]);
      if (operation === "reset") {
        expect(result.value.nodes).toEqual([
          { canvasId: "default", x: 80, y: 80 },
          { canvasId: f.extra.canvasId, x: 460, y: 80 }
        ]);
        await expect(readFile(f.pathA)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const expectedNodes =
          operation === "get"
            ? f.layoutA.nodes
            : f.layoutA.nodes.map((node) => ({ ...node, x: node.x + 10, y: node.y + 20 }));
        expect(result.value.nodes).toEqual(expectedNodes);
        if (operation === "get") expect(await readFile(f.pathA, "utf8")).toBe(f.beforeA);
        else expect(JSON.parse(await readFile(f.pathA, "utf8"))).toEqual(result.value);
      }
      expect(await readFile(f.pathB, "utf8")).toBe(f.beforeB);
      expect(await readFile(f.graphPathA, "utf8")).toBe(f.graphBeforeA);
      expect(await readFile(f.graphPathB, "utf8")).toBe(f.graphBeforeB);
      expect(await readFile(f.b.workspace.projectFile, "utf8")).toBe(f.projectBeforeB);
    } finally {
      barrier.release();
      await Promise.allSettled([
        barrier.holding,
        request.outcome,
        ...(barrier.relocation ? [barrier.relocation.outcome] : [])
      ]);
    }
  });

  it.each([
    "get",
    "save",
    "reset"
  ] as const)("rejects %s when A graph fails after lock wait and preserves both layout files", async (operation) => {
    const f = await fixture();
    const barrier = await holdBoundary(f, "disk");
    const request = observe(invoke(f, operation));
    try {
      await barrier.waiting;
      expect(request.isSettled()).toBe(false);
      await writeFile(f.graphPathA, "{invalid-project-graph\n");
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      barrier.release();
      await barrier.holding;
      const result = await request.outcome;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SyntaxError);
      expect(await readFile(f.pathA, "utf8")).toBe(f.beforeA);
      expect(await readFile(f.pathB, "utf8")).toBe(f.beforeB);
      expect(await readFile(f.graphPathA, "utf8")).toBe("{invalid-project-graph\n");
      expect(await readFile(f.graphPathB, "utf8")).toBe(f.graphBeforeB);
    } finally {
      barrier.release();
      await Promise.allSettled([barrier.holding, request.outcome]);
    }
  });
});
