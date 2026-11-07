import { EventEmitter } from "node:events";
import type {
  AcpEventSubscriptionCloseResult,
  DesktopBridgeApi,
  DesktopRunnerRecordSubscriptionUpdate,
  RunnerRecordReadModel
} from "@planweave-ai/runtime";
import {
  createAcpEventSubscriptionCloseResult,
  runnerRecordReadModelSchema
} from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runnerRecordEventChannel, runnerRecordUnsubscribeChannel } from "../shared/ipcChannels.js";
import { readModel, recordId } from "./helpers/taskWorkspaceConversationFixture.js";

const electronMock = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
  ipcMain: { handle: vi.fn() }
}));
const runtimeMock = vi.hoisted(() => ({
  subscribeRunRecord: vi.fn(),
  resolveTaskCanvasWorkspace: vi.fn()
}));

vi.mock("electron", () => electronMock);
vi.mock("@planweave-ai/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@planweave-ai/runtime")>()),
  ...runtimeMock
}));

type Stream = {
  push(snapshot: RunnerRecordReadModel): void;
  close(result: AcpEventSubscriptionCloseResult): void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

const input = { ref: { projectRoot: "/projects/demo", canvasId: "canvas-main" }, recordId };
let api: DesktopBridgeApi;
let initial: RunnerRecordReadModel;
let streams: Stream[];
let resources: Set<Stream>;
let renderer: EventEmitter;
let sender: EventEmitter & {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
};
let destroyed: boolean;

function continuation(state: "ready" | "finalizing" | "failed" | "active") {
  const model = readModel();
  model.terminal = true;
  model.cursor = {
    ...model.cursor,
    terminal: true,
    canonicalIdentity: {
      identity: {
        projectId: "project-1",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockId: "B-001",
        claimRef: "T-001#B-001",
        runId: "RUN-001",
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: "RUN-001"
      },
      runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" }
    }
  };
  model.intervention.cancel = {
    available: false,
    identity: null,
    reason: "No live owned ACP session is available."
  };
  model.intervention.prompt = {
    ...model.intervention.prompt,
    available: state === "ready",
    inFlight: state === "active",
    reason:
      state === "ready" ? null : state === "active" ? "Turn in progress." : `${state} unavailable.`
  };
  return runnerRecordReadModelSchema.parse(model);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  electronMock.exposed.clear();
  electronMock.handlers.clear();
  resources = new Set();
  streams = [];
  renderer = new EventEmitter();
  destroyed = false;
  sender = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => renderer.emit(channel, {}, payload)
  });
  initial = continuation("ready");
  electronMock.contextBridge.exposeInMainWorld.mockImplementation(
    (name: string, value: unknown) => {
      electronMock.exposed.set(name, value);
    }
  );
  electronMock.ipcMain.handle.mockImplementation(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, handler);
    }
  );
  electronMock.ipcRenderer.on.mockImplementation(
    (channel: string, listener: (...args: unknown[]) => void) => renderer.on(channel, listener)
  );
  electronMock.ipcRenderer.off.mockImplementation(
    (channel: string, listener: (...args: unknown[]) => void) => renderer.off(channel, listener)
  );
  electronMock.ipcRenderer.invoke.mockImplementation(
    async (channel: string, ...args: unknown[]) => {
      const handler = electronMock.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler({ sender }, ...args);
    }
  );
  runtimeMock.resolveTaskCanvasWorkspace.mockResolvedValue({ id: "project-1" });
  runtimeMock.subscribeRunRecord.mockImplementation(
    async (
      _workspace: unknown,
      _recordId: string,
      _cursor: unknown,
      listener: (snapshot: RunnerRecordReadModel) => void
    ) => {
      let resolveClosed = (_result: AcpEventSubscriptionCloseResult): void => undefined;
      const closed = new Promise<AcpEventSubscriptionCloseResult>((resolve) => {
        resolveClosed = resolve;
      });
      let settled = false;
      const stream: Stream = {
        push: listener,
        close: (result) => {
          if (settled) return;
          settled = true;
          resources.delete(stream);
          resolveClosed(result);
        },
        unsubscribe: vi.fn(() =>
          stream.close(createAcpEventSubscriptionCloseResult("explicit_unsubscribe", 1))
        )
      };
      resources.add(stream);
      streams.push(stream);
      return { snapshot: initial, subscription: { unsubscribe: stream.unsubscribe, closed } };
    }
  );
  const { registerRunnerRecordBridgeHandlers } = await import("../main/runnerRecordBridge.js");
  registerRunnerRecordBridgeHandlers();
  await import("../preload/preload.js");
  api = electronMock.exposed.get("planweave") as DesktopBridgeApi;
});

afterEach(async () => {
  destroyed = true;
  sender.emit("destroyed");
  await Promise.resolve();
  expect(resources.size).toBe(0);
  renderer.removeAllListeners();
});

describe("runner record preload subscription ownership", () => {
  it.each([
    "start",
    "push"
  ] as const)("delivers ready and another turn after transient terminal unavailability at %s", async (boundary) => {
    if (boundary === "start") initial = continuation("finalizing");
    const updates: DesktopRunnerRecordSubscriptionUpdate[] = [];
    const subscription = await api.subscribeRunnerRecord(input, (update) => updates.push(update));
    const stream = streams[0]!;
    if (boundary === "push") stream.push(continuation("finalizing"));
    stream.push(continuation("ready"));
    stream.push(continuation("active"));
    stream.push(continuation("ready"));
    expect(
      updates
        .filter((update) => update.kind === "snapshot")
        .map((update) => update.snapshot.intervention.prompt.available)
    ).toEqual(boundary === "push" ? [false, true, false, true] : [true, false, true]);
    expect(resources.size).toBe(1);
    await subscription.unsubscribe();
    expect(resources.size).toBe(0);
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
  });

  it("releases the backend exactly once after failed noncancellable delivery and rejects late updates", async () => {
    const callback = vi.fn();
    const subscription = await api.subscribeRunnerRecord(input, callback);
    const stream = streams[0]!;
    stream.push(continuation("failed"));
    expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "snapshot",
        snapshot: expect.objectContaining({
          terminal: true,
          intervention: expect.objectContaining({
            prompt: expect.objectContaining({ available: false, inFlight: false }),
            cancel: expect.objectContaining({ available: false })
          })
        })
      })
    );
    await Promise.all([subscription.unsubscribe(), subscription.unsubscribe()]);
    expect(resources.size).toBe(0);
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
    const delivered = callback.mock.calls.length;
    stream.push(continuation("ready"));
    expect(callback).toHaveBeenCalledTimes(delivered);
    await subscription.unsubscribe();
    expect(
      electronMock.ipcRenderer.invoke.mock.calls.filter(
        ([channel]) => channel === runnerRecordUnsubscribeChannel
      )
    ).toHaveLength(1);
  });

  it("surfaces a failed backend release and allows an explicit retry without resuming delivery", async () => {
    const callback = vi.fn();
    const subscription = await api.subscribeRunnerRecord(input, callback);
    const invoke = electronMock.ipcRenderer.invoke.getMockImplementation()!;
    let failed = false;
    electronMock.ipcRenderer.invoke.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === runnerRecordUnsubscribeChannel && !failed) {
          failed = true;
          throw new Error("controlled IPC release failure");
        }
        return invoke(channel, ...args);
      }
    );
    await expect(subscription.unsubscribe()).rejects.toThrow("controlled IPC release failure");
    expect(resources.size).toBe(1);
    streams[0]!.push(continuation("ready"));
    expect(callback).not.toHaveBeenCalled();
    await subscription.unsubscribe();
    expect(resources.size).toBe(0);
    expect(streams[0]!.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    "terminal",
    "subscriber_callback_failed"
  ] as const)("accepts explicit publisher close and removes only the closed scope: %s", async (reason) => {
    const first = vi.fn();
    const second = vi.fn();
    const one = await api.subscribeRunnerRecord(input, first);
    const two = await api.subscribeRunnerRecord(
      { ...input, recordId: "T-001#B-001::RUN-002" },
      second
    );
    streams[0]!.close(createAcpEventSubscriptionCloseResult(reason, 1));
    await vi.waitFor(() =>
      expect(first).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "closed", close: expect.objectContaining({ reason }) })
      )
    );
    const delivered = first.mock.calls.length;
    streams[0]!.push(continuation("ready"));
    streams[1]!.push(continuation("ready"));
    expect(first).toHaveBeenCalledTimes(delivered);
    expect(second).toHaveBeenCalledOnce();
    expect(resources.size).toBe(1);
    await one.unsubscribe();
    await two.unsubscribe();
    expect(resources.size).toBe(0);
  });

  it("keeps main ownership correct when closed arrives before the start response", async () => {
    runtimeMock.subscribeRunRecord.mockImplementationOnce(async () => ({
      snapshot: initial,
      subscription: null
    }));
    const callback = vi.fn();
    const subscription = await api.subscribeRunnerRecord(input, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "closed",
        close: expect.objectContaining({ reason: "terminal" })
      })
    );
    expect(renderer.listenerCount(runnerRecordEventChannel)).toBe(0);
    await subscription.unsubscribe();
    expect(resources.size).toBe(0);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("cleans main ownership on registration error and on sender destruction", async () => {
    runtimeMock.subscribeRunRecord.mockRejectedValueOnce(new Error("record identity mismatch"));
    await expect(api.subscribeRunnerRecord(input, vi.fn())).rejects.toThrow(
      "record identity mismatch"
    );
    expect(renderer.listenerCount(runnerRecordEventChannel)).toBe(0);
    expect(sender.listenerCount("destroyed")).toBe(0);
    const callback = vi.fn();
    await api.subscribeRunnerRecord(input, callback);
    destroyed = true;
    sender.emit("destroyed");
    expect(resources.size).toBe(0);
    expect(streams[0]!.unsubscribe).toHaveBeenCalledOnce();
    streams[0]!.push(continuation("ready"));
    expect(callback).not.toHaveBeenCalled();
  });

  it("releases only the replaced scope while a newer scope continues receiving updates", async () => {
    const oldScope = vi.fn();
    const currentScope = vi.fn();
    const one = await api.subscribeRunnerRecord(input, oldScope);
    const two = await api.subscribeRunnerRecord(
      { ...input, recordId: "T-001#B-001::RUN-002" },
      currentScope
    );
    await one.unsubscribe();
    streams[0]!.push(continuation("ready"));
    streams[1]!.push(continuation("finalizing"));
    streams[1]!.push(continuation("ready"));
    expect(oldScope).not.toHaveBeenCalled();
    expect(currentScope).toHaveBeenCalledTimes(2);
    expect(resources.size).toBe(1);
    expect(streams[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(streams[1]!.unsubscribe).not.toHaveBeenCalled();
    await two.unsubscribe();
    expect(resources.size).toBe(0);
  });

  it("releases a backend acquired after its renderer was destroyed during registration", async () => {
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquire = runtimeMock.subscribeRunRecord.getMockImplementation()!;
    runtimeMock.subscribeRunRecord.mockImplementationOnce(async (...args: unknown[]) => {
      const consumer = await acquire(...args);
      await pending;
      return consumer;
    });
    const registering = api.subscribeRunnerRecord(input, vi.fn());
    const rejected = expect(registering).rejects.toThrow("owner was destroyed during registration");
    await vi.waitFor(() => expect(resources.size).toBe(1));
    destroyed = true;
    sender.emit("destroyed");
    release();
    await rejected;
    expect(resources.size).toBe(0);
    expect(streams[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(renderer.listenerCount(runnerRecordEventChannel)).toBe(0);
  });
});
