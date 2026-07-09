import { createHash } from "node:crypto";
import { ipcMain } from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import type { DesktopCanvasReference, DesktopRuntimeStateChangeEvent } from "@planweave-ai/runtime";
import type { WebContents } from "electron";
import { desktopBridgeInvokeChannels, runtimeStateChangedChannel } from "../shared/ipcChannels.js";

type RuntimeStateFingerprint = {
  mtimeMs: number;
  size: number;
  hash: string;
};

type RuntimeStateWatchBackend = {
  kind: "native" | "polling";
  watcher: FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  lastFingerprint: RuntimeStateFingerprint | null;
};

type RuntimeStateWatchSubscriber = {
  webContents: WebContents;
  onDestroyed: () => void;
};

type RuntimeStateWatch = {
  backend: RuntimeStateWatchBackend;
  subscribers: Map<number, RuntimeStateWatchSubscriber>;
  stateFile: string;
  timer: NodeJS.Timeout | null;
  closed: boolean;
};

const runtimeStateWatches = new Map<string, RuntimeStateWatch>();
const pendingRuntimeStateWatchStarts = new Map<string, Promise<RuntimeStateWatch>>();
const pendingRuntimeStateWatchSubscribers = new Map<string, Map<number, WebContents>>();
const runtimeStateWatchDebounceMs = 150;
const runtimeStateWatchPollIntervalMs = 1000;

function watchKey(projectRoot: string, canvasId?: string | null): string {
  return `${projectRoot}::${canvasId ?? "default"}`;
}

function isMissingPathError(caught: unknown): boolean {
  return caught instanceof Error && "code" in caught && caught.code === "ENOENT";
}

async function fingerprintStateFile(path: string): Promise<RuntimeStateFingerprint | null> {
  try {
    const [metadata, content] = await Promise.all([stat(path), readFile(path)]);
    if (!metadata.isFile()) {
      return null;
    }
    return {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      hash: createHash("sha256").update(content).digest("hex")
    };
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return null;
    }
    throw caught;
  }
}

function changedFingerprint(
  left: RuntimeStateFingerprint | null,
  right: RuntimeStateFingerprint | null
): boolean {
  return (
    left?.mtimeMs !== right?.mtimeMs || left?.size !== right?.size || left?.hash !== right?.hash
  );
}

function warnPollingSnapshotFailure(stateFile: string, caught: unknown): void {
  console.warn(
    `PlanWeave runtime state polling watch failed for '${stateFile}': ${caught instanceof Error ? caught.message : String(caught)}`
  );
}

function startNativeRuntimeStateWatchBackend(
  stateFile: string,
  lastFingerprint: RuntimeStateFingerprint | null,
  recordChange: () => void
): RuntimeStateWatchBackend | null {
  const parentDir = dirname(stateFile);
  if (!existsSync(parentDir)) {
    return null;
  }
  const stateFileName = basename(stateFile);
  try {
    const watcher = watch(parentDir, { recursive: false }, (_eventType, filename) => {
      if (!filename || filename.toString() === stateFileName) {
        recordChange();
      }
    });
    return {
      kind: "native",
      watcher,
      pollTimer: null,
      lastFingerprint
    };
  } catch (caught) {
    console.warn(
      `PlanWeave native runtime state watch failed for '${stateFile}': ${caught instanceof Error ? caught.message : String(caught)}`
    );
    return null;
  }
}

async function startPollingRuntimeStateWatchBackend(
  stateFile: string,
  lastFingerprint: RuntimeStateFingerprint | null,
  recordChange: () => void
): Promise<RuntimeStateWatchBackend> {
  const backend: RuntimeStateWatchBackend = {
    kind: "polling",
    watcher: null,
    pollTimer: null,
    lastFingerprint
  };
  const poll = async () => {
    try {
      const nextFingerprint = await fingerprintStateFile(stateFile);
      if (changedFingerprint(backend.lastFingerprint, nextFingerprint)) {
        recordChange();
      }
    } catch (caught) {
      warnPollingSnapshotFailure(stateFile, caught);
    }
  };
  backend.pollTimer = setInterval(() => {
    void poll();
  }, runtimeStateWatchPollIntervalMs);
  return backend;
}

async function startRuntimeStateWatchBackend(
  stateFile: string,
  recordChange: () => void
): Promise<RuntimeStateWatchBackend> {
  const lastFingerprint = await fingerprintStateFile(stateFile);
  return (
    startNativeRuntimeStateWatchBackend(stateFile, lastFingerprint, recordChange) ??
    (await startPollingRuntimeStateWatchBackend(stateFile, lastFingerprint, recordChange))
  );
}

function addPendingRuntimeStateWatchSubscriber(key: string, webContents: WebContents): void {
  const subscribers =
    pendingRuntimeStateWatchSubscribers.get(key) ?? new Map<number, WebContents>();
  subscribers.set(webContents.id, webContents);
  pendingRuntimeStateWatchSubscribers.set(key, subscribers);
}

function removePendingRuntimeStateWatchSubscriber(key: string, webContentsId: number): void {
  const subscribers = pendingRuntimeStateWatchSubscribers.get(key);
  if (!subscribers) {
    return;
  }
  subscribers.delete(webContentsId);
  if (subscribers.size === 0) {
    pendingRuntimeStateWatchSubscribers.delete(key);
  }
}

function hasPendingRuntimeStateWatchSubscribers(key: string): boolean {
  return (pendingRuntimeStateWatchSubscribers.get(key)?.size ?? 0) > 0;
}

function hasPendingRuntimeStateWatchSubscriber(key: string, webContentsId: number): boolean {
  return pendingRuntimeStateWatchSubscribers.get(key)?.has(webContentsId) ?? false;
}

function closeRuntimeStateWatch(activeWatch: RuntimeStateWatch): void {
  if (activeWatch.closed) {
    return;
  }
  activeWatch.closed = true;
  for (const subscriber of activeWatch.subscribers.values()) {
    subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  }
  activeWatch.subscribers.clear();
  activeWatch.backend.watcher?.close();
  if (activeWatch.backend.pollTimer) {
    clearInterval(activeWatch.backend.pollTimer);
  }
  if (activeWatch.timer) {
    clearTimeout(activeWatch.timer);
  }
}

async function flushRuntimeStateChange(
  projectRoot: string,
  canvasId?: string | null
): Promise<void> {
  const key = watchKey(projectRoot, canvasId);
  const activeWatch = runtimeStateWatches.get(key);
  if (!activeWatch || activeWatch.closed) {
    return;
  }
  activeWatch.timer = null;
  const nextFingerprint = await fingerprintStateFile(activeWatch.stateFile);
  if (!changedFingerprint(activeWatch.backend.lastFingerprint, nextFingerprint)) {
    return;
  }
  activeWatch.backend.lastFingerprint = nextFingerprint;
  const payload: DesktopRuntimeStateChangeEvent = {
    projectRoot,
    canvasId: canvasId ?? null,
    stateFile: activeWatch.stateFile,
    changedAt: new Date().toISOString()
  };
  for (const subscriber of activeWatch.subscribers.values()) {
    if (!subscriber.webContents.isDestroyed()) {
      subscriber.webContents.send(runtimeStateChangedChannel, payload);
    }
  }
}

async function getOrCreateRuntimeStateWatch(
  key: string,
  projectRoot: string,
  canvasId: string | null | undefined
): Promise<RuntimeStateWatch> {
  const activeWatch = runtimeStateWatches.get(key);
  if (activeWatch) {
    return activeWatch;
  }
  const pendingStart = pendingRuntimeStateWatchStarts.get(key);
  if (pendingStart) {
    return pendingStart;
  }
  const start = (async () => {
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
    const recordChange = () => {
      const currentWatch = runtimeStateWatches.get(key);
      if (!currentWatch || currentWatch.closed) {
        return;
      }
      if (currentWatch.timer) {
        clearTimeout(currentWatch.timer);
      }
      currentWatch.timer = setTimeout(() => {
        void flushRuntimeStateChange(projectRoot, canvasId).catch((caught: unknown) => {
          console.warn(
            `PlanWeave runtime state watch flush failed for '${workspace.stateFile}': ${caught instanceof Error ? caught.message : String(caught)}`
          );
        });
      }, runtimeStateWatchDebounceMs);
    };
    const backend = await startRuntimeStateWatchBackend(workspace.stateFile, recordChange);
    const createdWatch: RuntimeStateWatch = {
      backend,
      subscribers: new Map(),
      stateFile: workspace.stateFile,
      timer: null,
      closed: false
    };
    if (!hasPendingRuntimeStateWatchSubscribers(key)) {
      closeRuntimeStateWatch(createdWatch);
      return createdWatch;
    }
    runtimeStateWatches.set(key, createdWatch);
    return createdWatch;
  })();
  pendingRuntimeStateWatchStarts.set(key, start);
  try {
    return await start;
  } finally {
    pendingRuntimeStateWatchStarts.delete(key);
  }
}

async function startRuntimeStateWatch(
  projectRoot: string,
  canvasId: string | null | undefined,
  webContents: WebContents
): Promise<void> {
  const key = watchKey(projectRoot, canvasId);
  addPendingRuntimeStateWatchSubscriber(key, webContents);
  let activeWatch: RuntimeStateWatch;
  try {
    activeWatch = await getOrCreateRuntimeStateWatch(key, projectRoot, canvasId);
  } catch (caught) {
    removePendingRuntimeStateWatchSubscriber(key, webContents.id);
    throw caught;
  }
  if (!hasPendingRuntimeStateWatchSubscriber(key, webContents.id) || webContents.isDestroyed()) {
    removePendingRuntimeStateWatchSubscriber(key, webContents.id);
    if (activeWatch.subscribers.size === 0 && !hasPendingRuntimeStateWatchSubscribers(key)) {
      closeRuntimeStateWatch(activeWatch);
      if (runtimeStateWatches.get(key) === activeWatch) {
        runtimeStateWatches.delete(key);
      }
    }
    return;
  }
  if (!activeWatch.subscribers.has(webContents.id)) {
    const onDestroyed = () => stopRuntimeStateWatch(projectRoot, canvasId, webContents);
    activeWatch.subscribers.set(webContents.id, { webContents, onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
  removePendingRuntimeStateWatchSubscriber(key, webContents.id);
}

function stopRuntimeStateWatch(
  projectRoot: string,
  canvasId: string | null | undefined,
  webContents: WebContents
): void {
  const key = watchKey(projectRoot, canvasId);
  removePendingRuntimeStateWatchSubscriber(key, webContents.id);
  const activeWatch = runtimeStateWatches.get(key);
  if (!activeWatch) {
    return;
  }
  const subscriber = activeWatch.subscribers.get(webContents.id);
  if (!subscriber) {
    if (activeWatch.subscribers.size === 0 && !hasPendingRuntimeStateWatchSubscribers(key)) {
      closeRuntimeStateWatch(activeWatch);
      runtimeStateWatches.delete(key);
    }
    return;
  }
  activeWatch.subscribers.delete(webContents.id);
  subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  if (activeWatch.subscribers.size > 0 || hasPendingRuntimeStateWatchSubscribers(key)) {
    return;
  }
  closeRuntimeStateWatch(activeWatch);
  runtimeStateWatches.delete(key);
}

export function registerRuntimeStateWatchHandlers(): void {
  ipcMain.handle(
    desktopBridgeInvokeChannels.watchRuntimeState,
    (event, ref: DesktopCanvasReference) =>
      startRuntimeStateWatch(ref.projectRoot, ref.canvasId, event.sender)
  );
  ipcMain.handle(
    desktopBridgeInvokeChannels.unwatchRuntimeState,
    (event, ref: DesktopCanvasReference) =>
      stopRuntimeStateWatch(ref.projectRoot, ref.canvasId, event.sender)
  );
}
