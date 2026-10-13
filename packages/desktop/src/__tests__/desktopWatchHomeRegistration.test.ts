import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "@planweave-ai/runtime";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels.js";
import { WatchRuntimeTestDriver } from "./support/watchRuntimeTestDriver.js";

type Registration = {
  projectRoot: string;
  workspaceRoot: string;
  canvasId: string;
  registrationId: string;
};
type Sender = ReturnType<typeof createSender>;
type Handler = (event: { sender: Sender }, ref: Registration) => unknown;
const state = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  watchers: [] as Array<{
    root: string;
    callback: (event: string, path: string) => void;
    closed: boolean;
  }>,
  gate: null as null | { path: string; entered: () => void; wait: Promise<void> }
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler) }
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: (root: string, _options: unknown, callback: (event: string, path: string) => void) => {
      const watcher = { root, callback, closed: false };
      state.watchers.push(watcher);
      return Object.assign(new EventEmitter(), {
        close() {
          watcher.closed = true;
        }
      });
    }
  };
});
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      const gate = state.gate;
      if (gate && String(path) === gate.path) {
        state.gate = null;
        gate.entered();
        await gate.wait;
      }
      return actual.realpath(path);
    }
  };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function createSender(id = 1) {
  return Object.assign(new EventEmitter(), { id, send: vi.fn(), isDestroyed: () => false });
}
const driver = new WatchRuntimeTestDriver();
const roots: string[] = [];
const registrations: Array<{ sender: Sender; ref: Registration; stop: Handler }> = [];
const originalHome = process.env.PLANWEAVE_HOME;

beforeEach(() => {
  vi.resetModules();
  driver.reset();
  state.handlers.clear();
  state.watchers.length = 0;
  state.gate = null;
});
afterEach(async () => {
  for (const { sender, ref, stop } of registrations.splice(0)) await stop({ sender }, ref);
  await driver.drain();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(kind: "package" | "runtime") {
  const temp = await mkdtemp(join(tmpdir(), "planweave-watch-two-homes-"));
  roots.push(temp);
  const projectRoot = join(temp, "source");
  await mkdir(projectRoot);
  const homeA = join(temp, "home-a");
  const homeB = join(temp, "home-b");
  process.env.PLANWEAVE_HOME = homeA;
  const a = (await initWorkspace({ projectRoot })).workspace;
  process.env.PLANWEAVE_HOME = homeB;
  const b = (await initWorkspace({ projectRoot })).workspace;
  if (kind === "package") {
    const { registerPackageWatchHandlers } = await import("../main/packageWatch.js");
    registerPackageWatchHandlers({ scheduler: driver });
  } else {
    const { registerRuntimeStateWatchHandlers } = await import("../main/runtimeStateWatch.js");
    registerRuntimeStateWatchHandlers({ scheduler: driver });
  }
  const start = state.handlers.get(
    kind === "package"
      ? desktopBridgeInvokeChannels.watchPackageFiles
      : desktopBridgeInvokeChannels.watchRuntimeState
  )!;
  const stop = state.handlers.get(
    kind === "package"
      ? desktopBridgeInvokeChannels.unwatchPackageFiles
      : desktopBridgeInvokeChannels.unwatchRuntimeState
  )!;
  function ref(workspaceRoot: string, registrationId: string): Registration {
    return { projectRoot, workspaceRoot, canvasId: "default", registrationId };
  }
  function watch(sender: Sender, registration: Registration) {
    registrations.push({ sender, ref: registration, stop });
    return start({ sender }, registration);
  }
  async function change(workspace: typeof a) {
    const file = kind === "package" ? workspace.manifestFile : workspace.stateFile;
    await writeFile(file, JSON.stringify({ changed: true, token: Math.random() }));
    const watchedRoot =
      kind === "package" ? workspace.packageDir : join(workspace.workspaceRoot, "canvases/default");
    const canonicalRoot = await realpath(watchedRoot);
    for (const watcher of state.watchers) {
      if (!watcher.closed && (await realpath(watcher.root)) === canonicalRoot)
        watcher.callback("change", kind === "package" ? "manifest.json" : "state.json");
    }
    await driver.advanceByAndDrain(150);
  }
  return { a, b, homeA, homeB, projectRoot, ref, watch, stop, change };
}

describe.each(["package", "runtime"] as const)("%s watcher Home registration", (kind) => {
  it.each([
    "complete",
    "fail"
  ] as const)("keeps B subscribed after cancelled A start later %s", async (outcome) => {
    const fixture = await setup(kind);
    const sender = createSender();
    const entered = deferred();
    const delayed = deferred();
    state.gate = { path: fixture.projectRoot, entered: entered.resolve, wait: delayed.promise };
    process.env.PLANWEAVE_HOME = fixture.homeA;
    const oldRef = fixture.ref(fixture.a.workspaceRoot, "A-old");
    const oldStart = Promise.resolve(fixture.watch(sender, oldRef));
    const oldResult = oldStart.catch((error: unknown) => error);
    await entered.promise;
    await fixture.stop({ sender }, oldRef);
    process.env.PLANWEAVE_HOME = fixture.homeB;
    const currentRef = fixture.ref(fixture.b.workspaceRoot, "B-current");
    const currentStart = Promise.resolve(fixture.watch(sender, currentRef));
    if (outcome === "complete") delayed.resolve();
    else delayed.reject(new Error("old A admission failed"));
    await oldResult;
    await currentStart;
    await fixture.stop({ sender }, oldRef);
    await fixture.change(fixture.a);
    expect(sender.send).not.toHaveBeenCalled();
    await fixture.change(fixture.b);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0][1]).toMatchObject({
      workspaceRoot: fixture.b.workspaceRoot,
      registrationId: "B-current"
    });
  });

  it.each([
    "complete",
    "fail"
  ] as const)("keeps a new A token when a fully cancelled same-workspace start later %s", async (outcome) => {
    const fixture = await setup(kind);
    const sender = createSender();
    const enteredOld = deferred();
    const delayedOld = deferred();
    const oldRef = fixture.ref(fixture.a.workspaceRoot, "A-old");
    state.gate = {
      path: fixture.projectRoot,
      entered: enteredOld.resolve,
      wait: delayedOld.promise
    };
    const oldResult = Promise.resolve(fixture.watch(sender, oldRef)).catch(
      (error: unknown) => error
    );
    await enteredOld.promise;
    await fixture.stop({ sender }, oldRef);
    const enteredNew = deferred();
    const delayedNew = deferred();
    state.gate = {
      path: fixture.projectRoot,
      entered: enteredNew.resolve,
      wait: delayedNew.promise
    };
    const newStart = Promise.resolve(
      fixture.watch(sender, fixture.ref(fixture.a.workspaceRoot, "A-new"))
    );
    await enteredNew.promise;
    if (outcome === "complete") delayedOld.resolve();
    else delayedOld.reject(new Error("cancelled same-workspace admission failed"));
    await oldResult;
    await fixture.stop({ sender }, oldRef);
    delayedNew.resolve();
    await newStart;
    await fixture.change(fixture.a);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0][1]).toMatchObject({
      workspaceRoot: fixture.a.workspaceRoot,
      registrationId: "A-new"
    });
  });

  it("protects A to B to A tokens and emits each window's registration identity", async () => {
    const fixture = await setup(kind);
    const first = createSender();
    const second = createSender(2);
    const oldA = fixture.ref(fixture.a.workspaceRoot, "A-old");
    const b = fixture.ref(fixture.b.workspaceRoot, "B");
    const newA = fixture.ref(fixture.a.workspaceRoot, "A-new");
    process.env.PLANWEAVE_HOME = fixture.homeA;
    await fixture.watch(first, oldA);
    await fixture.stop({ sender: first }, oldA);
    process.env.PLANWEAVE_HOME = fixture.homeB;
    await fixture.watch(first, b);
    await fixture.stop({ sender: first }, b);
    // The global Home remains B while the registration explicitly captures A.
    await fixture.watch(first, newA);
    await fixture.watch(second, fixture.ref(fixture.a.workspaceRoot, "window-two"));
    await fixture.stop({ sender: first }, oldA);
    await fixture.change(fixture.b);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
    await fixture.change(fixture.a);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(first.send.mock.calls[0][1]).toMatchObject({
      workspaceRoot: fixture.a.workspaceRoot,
      registrationId: "A-new"
    });
    expect(second.send.mock.calls[0][1]).toMatchObject({
      workspaceRoot: fixture.a.workspaceRoot,
      registrationId: "window-two"
    });
  });
});
