import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopSettingsInvokeChannels } from "../shared/desktopSettings.js";
import { workspaceExecutionInvokeChannels } from "../shared/workspaceExecutionIpc.js";
import {
  desktopWorkspaceExecutionStartInputSchema,
  desktopWorkspaceExecutionFollowInputSchema,
  desktopWorkspaceExecutionCancelInputSchema,
  desktopWorkspaceExecutionRespondInputSchema
} from "../shared/workspaceExecution.js";
import { desktopRemoteAcpConversationInputSchema } from "../shared/remoteAcpConversation.js";
import {
  desktopBridgeInvokeChannels,
  runnerRecordSubscribeChannel,
  runnerRecordUnsubscribeChannel
} from "../shared/ipcChannels.js";

type Sender = EventEmitter & {
  id: number;
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
};
type Handler = (event: { sender: Sender }, ...args: unknown[]) => unknown;
const state = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  windows: [] as Array<{
    webContents: Sender;
    focus: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
  }>,
  nextLoad: null as Promise<void> | null,
  renameFailure: null as string | null,
  renameGate: null as { path: string; entered: () => void; wait: Promise<void> } | null,
  realpathGate: null as { path: string; entered: () => void; wait: Promise<void> } | null
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  class BrowserWindow extends EventEmitter {
    static getAllWindows = () => state.windows;
    static fromWebContents = () => null;
    webContents = Object.assign(new EventEmitter(), {
      id: state.windows.length + 1,
      isDestroyed: () => false,
      send: vi.fn()
    });
    focus = vi.fn();
    show = vi.fn();
    isDestroyed = () => false;
    constructor() {
      super();
      state.windows.push(this);
    }
    async loadFile() {
      const wait = state.nextLoad;
      state.nextLoad = null;
      await wait;
    }
    async loadURL() {
      await this.loadFile();
    }
  }
  return {
    BrowserWindow,
    app: { getLocale: () => "en", getPath: () => tmpdir() },
    ipcMain: {
      handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler)
    },
    dialog: { showOpenDialog: vi.fn() },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() }
  };
});
vi.mock("../main/window.js", () => ({
  configureExternalLinkHandling: vi.fn(),
  configureNavigationHandling: vi.fn()
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === state.renameFailure) throw new Error("settings write failed");
      const gate = state.renameGate;
      if (gate && String(args[1]) === gate.path) {
        state.renameGate = null;
        gate.entered();
        await gate.wait;
      }
      return actual.rename(...args);
    },
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      const gate = state.realpathGate;
      if (gate && String(path) === gate.path) {
        state.realpathGate = null;
        gate.entered();
        await gate.wait;
      }
      return actual.realpath(path);
    }
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function sender(id = 100): Sender {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: vi.fn() });
}
function invoke(channel: string, owner: Sender, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler '${channel}'.`);
  return Promise.resolve().then(() => handler({ sender: owner }, ...args));
}

const roots: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalDevServer = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL;
beforeEach(() => {
  vi.resetModules();
  state.handlers.clear();
  state.windows.length = 0;
  state.nextLoad = null;
  state.renameFailure = null;
  state.renameGate = null;
  state.realpathGate = null;
  delete process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL;
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalDevServer === undefined) delete process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL;
  else process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL = originalDevServer;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "planweave-inspector-home-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  const homeA = join(root, "home-a");
  const homeB = join(root, "home-b");
  const runtime = await import("@planweave-ai/runtime");
  process.env.PLANWEAVE_HOME = homeA;
  const a = (await runtime.initWorkspace({ projectRoot: sourceRoot })).workspace;
  expect(
    await runtime.addTaskNode(a, { title: "Inspector", promptMarkdown: "# Inspector\n" })
  ).toMatchObject({ ok: true });
  expect(await runtime.updateTaskTitle(a, "T-INSPECTOR", "A task")).toMatchObject({ ok: true });
  expect(await runtime.updateBlockTitle(a, "T-INSPECTOR#B-001", "A block")).toMatchObject({
    ok: true
  });
  process.env.PLANWEAVE_HOME = homeB;
  const b = (await runtime.initWorkspace({ projectRoot: sourceRoot })).workspace;
  expect(
    await runtime.addTaskNode(b, { title: "Inspector", promptMarkdown: "# Inspector\n" })
  ).toMatchObject({ ok: true });
  expect(await runtime.updateTaskTitle(b, "T-INSPECTOR", "B task")).toMatchObject({ ok: true });
  expect(await runtime.updateBlockTitle(b, "T-INSPECTOR#B-001", "B block")).toMatchObject({
    ok: true
  });
  process.env.PLANWEAVE_HOME = homeA;
  const { DesktopSettingsStore } = await import("../main/desktopSettingsStore.js");
  const store = new DesktopSettingsStore({
    settingsFile: join(root, "settings.json"),
    platform: "linux"
  });
  await store.mergePatch({ planweaveHome: homeA });
  const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers.js");
  const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers.js");
  registerDesktopSettingsHandlers(store);
  registerRuntimeBridgeHandlers();
  const main = sender();
  const canvas = { projectRoot: sourceRoot, canvasId: "default" };
  const save = (patch: unknown) =>
    invoke(desktopSettingsInvokeChannels.saveDesktopSettings, main, patch);
  const open = (kind: "task" | "block") =>
    invoke(
      kind === "task"
        ? desktopBridgeInvokeChannels.openTaskInspectorWindow
        : desktopBridgeInvokeChannels.openBlockInspectorWindow,
      main,
      {
        canvas,
        language: "en",
        ...(kind === "task" ? { taskId: "T-INSPECTOR" } : { blockRef: "T-INSPECTOR#B-001" })
      }
    );
  const write = (kind: "task" | "block", owner: Sender, title: string) =>
    invoke(
      kind === "task"
        ? desktopBridgeInvokeChannels.updateTaskTitle
        : desktopBridgeInvokeChannels.updateBlockTitle,
      owner,
      canvas,
      kind === "task" ? "T-INSPECTOR" : "T-INSPECTOR#B-001",
      title
    );
  async function titles(workspace: typeof a) {
    const { manifest } = await runtime.loadPackage(workspace);
    const task = manifest.nodes.find((node) => node.id === "T-INSPECTOR");
    if (task?.type !== "task") throw new Error("Inspector fixture task missing.");
    return { task: task.title, block: task.blocks[0].title };
  }
  return { a, b, homeA, homeB, sourceRoot, main, canvas, store, save, open, write, titles };
}

describe("Inspector Home admission through Main IPC", () => {
  it.each([
    "task",
    "block"
  ] as const)("preserves the old %s window and prevents writes into B's same sourceRoot", async (kind) => {
    const fixture = await setup();
    await fixture.open(kind);
    const old = state.windows[0];
    await fixture.write(kind, old.webContents, "A edited");
    await fixture.save({ planweaveHome: fixture.homeB });
    await expect(fixture.write(kind, old.webContents, "stale draft")).rejects.toThrow(
      "previous PlanWeave Home"
    );
    expect(await fixture.titles(fixture.b)).toEqual({ task: "B task", block: "B block" });
    expect(old.isDestroyed()).toBe(false);
    await fixture.open(kind);
    expect(state.windows).toHaveLength(2);
    expect(old.focus).not.toHaveBeenCalled();
    await fixture.write(kind, state.windows[1].webContents, "B edited");
    expect((await fixture.titles(fixture.b))[kind]).toBe("B edited");
    expect((await fixture.titles(fixture.a))[kind]).toBe("A edited");
    await fixture.open(kind);
    expect(state.windows).toHaveLength(2);
    expect(state.windows[1].focus).toHaveBeenCalledOnce();
  });

  it("does not revive old A windows after A to B to A", async () => {
    const fixture = await setup();
    await fixture.open("task");
    const old = state.windows[0];
    await fixture.save({ planweaveHome: fixture.homeB });
    await fixture.save({ planweaveHome: fixture.homeA });
    await expect(fixture.write("task", old.webContents, "revived stale draft")).rejects.toThrow(
      "previous PlanWeave Home"
    );
    await fixture.open("task");
    expect(state.windows).toHaveLength(2);
    await fixture.write("task", state.windows[1].webContents, "new A draft");
    expect((await fixture.titles(fixture.a)).task).toBe("new A draft");
  });

  it.each([
    "task",
    "block"
  ] as const)("binds a %s window before its renderer finishes loading", async (kind) => {
    const fixture = await setup();
    const loaded = deferred();
    state.nextLoad = loaded.promise;
    const opening = fixture.open(kind);
    await Promise.resolve();
    const old = state.windows[0];
    expect(old).toBeDefined();
    await fixture.save({ planweaveHome: fixture.homeB });
    loaded.resolve();
    await opening;
    expect(old.show).toHaveBeenCalledOnce();
    await expect(fixture.write(kind, old.webContents, "late renderer draft")).rejects.toThrow(
      "previous PlanWeave Home"
    );
    await fixture.open(kind);
    expect(state.windows).toHaveLength(2);
    expect(await fixture.titles(fixture.b)).toEqual({ task: "B task", block: "B block" });
  });

  it("keeps admission after a real settings write failure, ordinary preferences, and equivalent Home paths", async () => {
    const fixture = await setup();
    await fixture.open("task");
    const owner = state.windows[0].webContents;
    state.renameFailure = fixture.store.settingsFile;
    await expect(fixture.save({ planweaveHome: fixture.homeB })).rejects.toThrow(
      "settings write failed"
    );
    expect(process.env.PLANWEAVE_HOME).toBe(fixture.homeA);
    state.renameFailure = null;
    await fixture.save({ appearance: "dark", language: "zh-CN" });
    await fixture.save({ planweaveHome: `${fixture.homeA}/.` });
    await fixture.write("task", owner, "retained A draft");
    expect((await fixture.titles(fixture.a)).task).toBe("retained A draft");
    expect((await fixture.titles(fixture.b)).task).toBe("B task");
    await fixture.open("task");
    expect(state.windows).toHaveLength(1);
  });

  it("allows already admitted writes to finish against captured A while refusing subsequent old-window requests", async () => {
    const fixture = await setup();
    await fixture.open("task");
    const owner = state.windows[0].webContents;
    const entered = deferred();
    const released = deferred();
    state.realpathGate = {
      path: fixture.sourceRoot,
      entered: entered.resolve,
      wait: released.promise
    };
    const admitted = fixture.write("task", owner, "admitted A draft");
    await entered.promise;
    await fixture.save({ planweaveHome: fixture.homeB });
    released.resolve();
    await admitted;
    expect((await fixture.titles(fixture.a)).task).toBe("admitted A draft");
    expect((await fixture.titles(fixture.b)).task).toBe("B task");
    await expect(fixture.write("task", owner, "next stale draft")).rejects.toThrow(
      "previous PlanWeave Home"
    );
    await fixture.write("task", fixture.main, "main B draft");
    expect((await fixture.titles(fixture.b)).task).toBe("main B draft");
  });

  it("refuses new runner subscriptions from retired Inspectors but permits ownership cleanup", async () => {
    const fixture = await setup();
    await fixture.open("block");
    const owner = state.windows[0].webContents;
    await fixture.save({ planweaveHome: fixture.homeB });
    await expect(
      invoke(runnerRecordSubscribeChannel, owner, {
        subscriptionId: "old-inspector",
        ref: fixture.canvas,
        recordId: "record-missing"
      })
    ).rejects.toThrow("previous PlanWeave Home");
    await expect(
      invoke(runnerRecordUnsubscribeChannel, owner, "old-inspector")
    ).resolves.toBeUndefined();
  });

  it.each([
    "save",
    "migrate"
  ] as const)("rejects retired Inspector %s settings writes but retains global settings reads", async (kind) => {
    const fixture = await setup();
    await fixture.open("task");
    const owner = state.windows[0].webContents;
    await fixture.save({ planweaveHome: fixture.homeB });
    const channel =
      kind === "save"
        ? desktopSettingsInvokeChannels.saveDesktopSettings
        : desktopSettingsInvokeChannels.migrateLegacyDesktopSettings;
    await expect(
      invoke(channel, owner, { execution: { agentEndpointPreferences: {} } })
    ).rejects.toThrow("previous PlanWeave Home");
    await expect(
      invoke(desktopSettingsInvokeChannels.getDesktopSettings, owner)
    ).resolves.toMatchObject({ planweaveHome: fixture.homeB });
    await fixture.save({ appearance: "dark" });
    expect((await fixture.store.read()).appearance).toBe("dark");
  });

  it.each([
    "save",
    "migrate"
  ] as const)("checks a queued Inspector %s again after an earlier Home change commits", async (kind) => {
    const fixture = await setup();
    await fixture.open("task");
    const owner = state.windows[0].webContents;
    const entered = deferred();
    const released = deferred();
    state.renameGate = {
      path: fixture.store.settingsFile,
      entered: entered.resolve,
      wait: released.promise
    };
    const changing = fixture.save({ planweaveHome: fixture.homeB });
    await entered.promise;
    expect(process.env.PLANWEAVE_HOME).toBe(fixture.homeA);
    const channel =
      kind === "save"
        ? desktopSettingsInvokeChannels.saveDesktopSettings
        : desktopSettingsInvokeChannels.migrateLegacyDesktopSettings;
    const queued = invoke(channel, owner, { appearance: "dark" });
    const observed = queued.catch((error: unknown) => error);
    await Promise.resolve();
    released.resolve();
    await changing;
    expect(await observed).toBeInstanceOf(Error);
    await expect(queued).rejects.toThrow("previous PlanWeave Home");
    expect((await fixture.store.read()).appearance).not.toBe("dark");
  });

  it("applies the same Inspector admission to owner-canvas remote execution and control IPC", async () => {
    const fixture = await setup();
    await fixture.open("block");
    const old = state.windows[0].webContents;
    const { CollaborationService } = await import("../main/collaboration/collaborationService.js");
    const { WorkspaceExecutionDesktopService } = await import(
      "../main/workspaceExecutionDesktopService.js"
    );
    const { registerWorkspaceExecutionHandlers } = await import(
      "../main/workspaceExecutionHandlers.js"
    );
    const collaboration = new CollaborationService();
    const remotePort = vi.fn(async (): Promise<never> => {
      throw Object.assign(new Error("workspace_execution_authority_mismatch"), {
        code: "workspace_execution_authority_mismatch"
      });
    });
    const service = new WorkspaceExecutionDesktopService(
      collaboration,
      { withExecutionProfile: remotePort },
      join(roots[roots.length - 1], "sessions")
    );
    registerWorkspaceExecutionHandlers({ collaboration, service });
    const runtime = await import("@planweave-ai/runtime");
    const projectId = (await runtime.getGraphViewModel(fixture.a)).projectId;
    const start = {
      locator: {
        kind: "owner_canvas",
        operatorProfileId: "operator-a",
        humanPrincipalId: "HUMAN-a",
        projectRoot: fixture.sourceRoot,
        projectId,
        canvasId: "default"
      },
      blockRef: "T-INSPECTOR#B-001",
      agentEndpointId: "remote-endpoint",
      effectiveExecutor: { name: "codex-acp", agentId: "codex" }
    };
    try {
      await expect(
        invoke(workspaceExecutionInvokeChannels.start, old, start)
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "workspace_execution_authority_mismatch" }
      });
      expect(remotePort).toHaveBeenCalledOnce();
      remotePort.mockClear();
      await fixture.save({ planweaveHome: fixture.homeB });
      for (const [channel, input] of [
        [
          workspaceExecutionInvokeChannels.start,
          desktopWorkspaceExecutionStartInputSchema.parse(start)
        ],
        [
          workspaceExecutionInvokeChannels.follow,
          desktopWorkspaceExecutionFollowInputSchema.parse({ ...start, sessionId: "SESSION-0001" })
        ],
        [
          workspaceExecutionInvokeChannels.cancel,
          desktopWorkspaceExecutionCancelInputSchema.parse({
            ...start,
            sessionId: "SESSION-0001",
            actionId: "cancel-one",
            reason: "stop"
          })
        ],
        [
          workspaceExecutionInvokeChannels.respond,
          desktopWorkspaceExecutionRespondInputSchema.parse({
            ...start,
            sessionId: "SESSION-0001",
            response: {
              type: "interaction.elicitation_response",
              actionId: "action-one",
              dispatchId: "dispatch-one",
              executionAttemptId: "attempt-one",
              leaseId: "lease-one",
              acpSessionId: "acp-session-one",
              outcome: "accepted",
              response: "continue"
            }
          })
        ],
        [
          workspaceExecutionInvokeChannels.conversation,
          desktopRemoteAcpConversationInputSchema.parse({
            locator: start.locator,
            operationId: "operation-one",
            blockRef: start.blockRef
          })
        ]
      ]) {
        await expect(invoke(String(channel), old, input)).rejects.toThrow(
          "previous PlanWeave Home"
        );
      }
      expect(remotePort).not.toHaveBeenCalled();
      expect(await fixture.titles(fixture.b)).toEqual({ task: "B task", block: "B block" });
      await fixture.open("block");
      await expect(
        invoke(workspaceExecutionInvokeChannels.start, state.windows[1].webContents, start)
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "workspace_execution_authority_mismatch" }
      });
      expect(remotePort).toHaveBeenCalledOnce();
      await expect(
        invoke(workspaceExecutionInvokeChannels.start, fixture.main, start)
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "workspace_execution_authority_mismatch" }
      });
      expect(remotePort).toHaveBeenCalledTimes(2);
    } finally {
      await collaboration.shutdown();
    }
  });
});
