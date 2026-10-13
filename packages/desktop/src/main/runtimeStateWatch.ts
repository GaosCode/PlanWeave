import { createHash } from "node:crypto";
import { ipcMain } from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  desktopWatchRegistrationSchema,
  resolveDesktopWatchWorkspace
} from "@planweave-ai/runtime";
import type {
  DesktopWatchRegistration,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import type { WebContents } from "electron";
import { desktopWatchBackendKey, desktopWatchSubscriberKey } from "./desktopWatchRegistration.js";
import { desktopBridgeInvokeChannels, runtimeStateChangedChannel } from "../shared/ipcChannels.js";
import {
  PollingWatchLane,
  systemWatchScheduler,
  type WatchScheduler,
  type WatchTimer
} from "./watchRuntime.js";

type RuntimeStateFingerprint = {
  mtimeMs: number;
  size: number;
  hash: string;
};

type RuntimeStateMetadata = Omit<RuntimeStateFingerprint, "hash">;

type RuntimeStateWatchBackend = {
  kind: "native" | "polling";
  watcher: FSWatcher | null;
  pollLane: PollingWatchLane | null;
  hashSweepTimer: WatchTimer | null;
  lastFingerprint: RuntimeStateFingerprint | null;
  lastObservedMetadata: RuntimeStateMetadata | null;
  closed: boolean;
  generation: number;
};

type RuntimeStateWatchPendingSubscriber = {
  registration: DesktopWatchRegistration;
  webContents: WebContents;
};

type RuntimeStateWatchSubscriber = RuntimeStateWatchPendingSubscriber & {
  onDestroyed: () => void;
};

type RuntimeStateWatch = {
  backend: RuntimeStateWatchBackend;
  subscribers: Map<string, RuntimeStateWatchSubscriber>;
  stateFile: string;
  timer: WatchTimer | null;
  scheduler: WatchScheduler;
  flushInFlight: boolean;
  flushRequested: boolean;
  flushFailureBackoffMs: number;
  flushRetryNotBeforeMs: number;
  closed: boolean;
};

type RuntimeStateWatchHandlerOptions = {
  scheduler?: WatchScheduler;
};

const runtimeStateWatches = new Map<string, RuntimeStateWatch>();
const pendingRuntimeStateWatchStarts = new Map<string, Promise<RuntimeStateWatch>>();
const pendingRuntimeStateWatchSubscribers = new Map<
  string,
  Map<string, RuntimeStateWatchPendingSubscriber>
>();
const runtimeStateWatchDebounceMs = 150;
const runtimeStateWatchPollIntervalMs = 1000;
const runtimeStateWatchHashSweepIntervalMs = 30_000;
const runtimeStateWatchFailureBackoffMaxMs = 16_000;

function isMissingPathError(caught: unknown): boolean {
  return caught instanceof Error && "code" in caught && caught.code === "ENOENT";
}

async function metadataStateFile(path: string): Promise<RuntimeStateMetadata | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return null;
    }
    return {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size
    };
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return null;
    }
    throw caught;
  }
}

function sameMetadata(
  left: RuntimeStateMetadata | null,
  right: RuntimeStateMetadata | null
): boolean {
  return left?.mtimeMs === right?.mtimeMs && left?.size === right?.size;
}

async function fingerprintStateFile(path: string): Promise<RuntimeStateFingerprint | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await metadataStateFile(path);
    if (!before) {
      return null;
    }
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (caught) {
      if (isMissingPathError(caught)) {
        continue;
      }
      throw caught;
    }
    const after = await metadataStateFile(path);
    if (!after) {
      return null;
    }
    if (sameMetadata(before, after)) {
      return {
        ...after,
        hash: createHash("sha256").update(content).digest("hex")
      };
    }
  }
  throw new Error(`Runtime state file '${path}' kept changing while it was fingerprinted.`);
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

function nextFailureBackoffMs(currentMs: number): number {
  if (currentMs <= 0) {
    return runtimeStateWatchPollIntervalMs;
  }
  return Math.min(runtimeStateWatchFailureBackoffMaxMs, currentMs * 2);
}

function closeNativeRuntimeStateWatcher(backend: RuntimeStateWatchBackend): void {
  const watcher = backend.watcher;
  backend.watcher = null;
  watcher?.close();
}

function startPollingRuntimeStateWatchBackend(
  backend: RuntimeStateWatchBackend,
  stateFile: string,
  recordChange: (generation: number) => void,
  scheduler: WatchScheduler
): void {
  if (backend.closed || backend.pollLane) {
    return;
  }
  backend.kind = "polling";
  const generation = backend.generation;
  const isCurrentBackend = () => !backend.closed && backend.generation === generation;
  const pollLane = new PollingWatchLane({
    scheduler,
    intervalMs: runtimeStateWatchPollIntervalMs,
    backoffBaseMs: runtimeStateWatchPollIntervalMs,
    backoffMaxMs: runtimeStateWatchFailureBackoffMaxMs,
    run: async (isCurrent) => {
      const nextMetadata = await metadataStateFile(stateFile);
      if (!isCurrent() || !isCurrentBackend()) {
        return;
      }
      const changed = !sameMetadata(backend.lastObservedMetadata, nextMetadata);
      backend.lastObservedMetadata = nextMetadata;
      if (changed) {
        recordChange(generation);
      }
    },
    onError: (error) => warnPollingSnapshotFailure(stateFile, error)
  });
  backend.pollLane = pollLane;
  pollLane.start();
  backend.hashSweepTimer = scheduler.repeat(runtimeStateWatchHashSweepIntervalMs, () => {
    if (isCurrentBackend()) {
      recordChange(generation);
    }
  });
}

async function startRuntimeStateWatchBackend(
  stateFile: string,
  recordChange: (generation: number) => void,
  scheduler: WatchScheduler,
  transferPendingFlush: () => void
): Promise<RuntimeStateWatchBackend> {
  const lastFingerprint = await fingerprintStateFile(stateFile);
  const backend: RuntimeStateWatchBackend = {
    kind: "native",
    watcher: null,
    pollLane: null,
    hashSweepTimer: null,
    lastFingerprint,
    lastObservedMetadata: lastFingerprint,
    closed: false,
    generation: 0
  };
  const failover = (caught: unknown): void => {
    if (backend.closed || backend.generation !== 0) {
      return;
    }
    backend.generation += 1;
    console.warn(
      `PlanWeave native runtime state watch failed for '${stateFile}'; switching to polling: ${caught instanceof Error ? caught.message : String(caught)}`
    );
    closeNativeRuntimeStateWatcher(backend);
    transferPendingFlush();
    startPollingRuntimeStateWatchBackend(backend, stateFile, recordChange, scheduler);
  };
  const parentDir = dirname(stateFile);
  const stateFileName = basename(stateFile);
  if (existsSync(parentDir)) {
    try {
      const watcher = watch(parentDir, { recursive: false }, (_eventType, filename) => {
        if (
          !backend.closed &&
          backend.generation === 0 &&
          (!filename || filename.toString() === stateFileName)
        ) {
          recordChange(0);
        }
      });
      backend.watcher = watcher;
      // Explicit close queues a close event; native errors may close without one.
      // Keep the guarded error listener until close, or until the failed watcher is collected.
      watcher.once("close", () => watcher.removeListener("error", failover));
      watcher.on("error", failover);
    } catch (caught) {
      failover(caught);
    }
  } else {
    startPollingRuntimeStateWatchBackend(backend, stateFile, recordChange, scheduler);
  }
  return backend;
}

function addPendingRuntimeStateWatchSubscriber(
  key: string,
  subscriberKey: string,
  registration: DesktopWatchRegistration,
  webContents: WebContents
): RuntimeStateWatchPendingSubscriber {
  const subscribers =
    pendingRuntimeStateWatchSubscribers.get(key) ??
    new Map<string, RuntimeStateWatchPendingSubscriber>();
  const subscriber = subscribers.get(subscriberKey) ?? { registration, webContents };
  subscribers.set(subscriberKey, subscriber);
  pendingRuntimeStateWatchSubscribers.set(key, subscribers);
  return subscriber;
}

function removePendingRuntimeStateWatchSubscriber(
  key: string,
  subscriberKey: string,
  subscriber?: RuntimeStateWatchPendingSubscriber
): void {
  const subscribers = pendingRuntimeStateWatchSubscribers.get(key);
  if (!subscribers || (subscriber && subscribers.get(subscriberKey) !== subscriber)) return;
  subscribers.delete(subscriberKey);
  if (subscribers.size === 0) {
    pendingRuntimeStateWatchSubscribers.delete(key);
    pendingRuntimeStateWatchStarts.delete(key);
  }
}

function hasPendingRuntimeStateWatchSubscribers(key: string): boolean {
  return (pendingRuntimeStateWatchSubscribers.get(key)?.size ?? 0) > 0;
}

function closeRuntimeStateWatch(activeWatch: RuntimeStateWatch): void {
  if (activeWatch.closed) {
    return;
  }
  activeWatch.closed = true;
  activeWatch.backend.closed = true;
  activeWatch.backend.generation += 1;
  for (const subscriber of activeWatch.subscribers.values()) {
    subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  }
  activeWatch.subscribers.clear();
  closeNativeRuntimeStateWatcher(activeWatch.backend);
  activeWatch.backend.pollLane?.close();
  if (activeWatch.backend.hashSweepTimer) {
    activeWatch.backend.hashSweepTimer.cancel();
  }
  if (activeWatch.timer) {
    activeWatch.timer.cancel();
  }
}

function scheduleRuntimeStateFlush(
  activeWatch: RuntimeStateWatch,
  key: string,
  delayMs: number
): void {
  if (activeWatch.closed) {
    return;
  }
  const now = activeWatch.scheduler.nowMs();
  const scheduledAt =
    activeWatch.flushRetryNotBeforeMs > 0
      ? Math.max(now, activeWatch.flushRetryNotBeforeMs)
      : now + delayMs;
  if (activeWatch.timer) {
    if (activeWatch.flushRetryNotBeforeMs > 0) {
      return;
    }
    activeWatch.timer.cancel();
  }
  const generation = activeWatch.backend.generation;
  const timer: WatchTimer = activeWatch.scheduler.schedule(Math.max(0, scheduledAt - now), () => {
    if (activeWatch.timer !== timer) return;
    activeWatch.timer = null;
    return flushRuntimeStateChange(key, activeWatch, generation);
  });
  activeWatch.timer = timer;
}

async function flushRuntimeStateChange(
  key: string,
  activeWatch: RuntimeStateWatch,
  generation: number
): Promise<void> {
  if (
    runtimeStateWatches.get(key) !== activeWatch ||
    activeWatch.closed ||
    generation !== activeWatch.backend.generation
  ) {
    return;
  }
  if (activeWatch.flushInFlight) {
    activeWatch.flushRequested = true;
    return;
  }
  activeWatch.flushInFlight = true;
  activeWatch.flushRequested = false;
  try {
    const nextFingerprint = await fingerprintStateFile(activeWatch.stateFile);
    if (
      activeWatch.closed ||
      runtimeStateWatches.get(key) !== activeWatch ||
      generation !== activeWatch.backend.generation
    ) {
      return;
    }
    if (!changedFingerprint(activeWatch.backend.lastFingerprint, nextFingerprint)) {
      activeWatch.flushFailureBackoffMs = 0;
      activeWatch.flushRetryNotBeforeMs = 0;
      return;
    }
    activeWatch.backend.lastFingerprint = nextFingerprint;
    activeWatch.flushFailureBackoffMs = 0;
    activeWatch.flushRetryNotBeforeMs = 0;
    for (const subscriber of activeWatch.subscribers.values()) {
      if (!subscriber.webContents.isDestroyed()) {
        const payload: DesktopRuntimeStateChangeEvent = {
          projectRoot: subscriber.registration.projectRoot,
          workspaceRoot: subscriber.registration.workspaceRoot,
          registrationId: subscriber.registration.registrationId,
          canvasId: subscriber.registration.canvasId ?? null,
          stateFile: activeWatch.stateFile,
          changedAt: new Date(activeWatch.scheduler.nowMs()).toISOString()
        };
        subscriber.webContents.send(runtimeStateChangedChannel, payload);
      }
    }
  } catch (caught) {
    if (
      !activeWatch.closed &&
      runtimeStateWatches.get(key) === activeWatch &&
      generation === activeWatch.backend.generation
    ) {
      activeWatch.flushFailureBackoffMs = nextFailureBackoffMs(activeWatch.flushFailureBackoffMs);
      activeWatch.flushRetryNotBeforeMs =
        activeWatch.scheduler.nowMs() + activeWatch.flushFailureBackoffMs;
      console.warn(
        `PlanWeave runtime state watch flush failed for '${activeWatch.stateFile}': ${caught instanceof Error ? caught.message : String(caught)}`
      );
      scheduleRuntimeStateFlush(activeWatch, key, 0);
    }
  } finally {
    activeWatch.flushInFlight = false;
    if (
      activeWatch.flushRequested &&
      !activeWatch.closed &&
      runtimeStateWatches.get(key) === activeWatch
    ) {
      activeWatch.flushRequested = false;
      scheduleRuntimeStateFlush(activeWatch, key, runtimeStateWatchDebounceMs);
    }
  }
}

async function getOrCreateRuntimeStateWatch(
  key: string,
  registration: DesktopWatchRegistration,
  scheduler: WatchScheduler
): Promise<RuntimeStateWatch> {
  const activeWatch = runtimeStateWatches.get(key);
  if (activeWatch && !activeWatch.closed) {
    return activeWatch;
  }
  if (activeWatch) {
    runtimeStateWatches.delete(key);
  }
  const pendingStart = pendingRuntimeStateWatchStarts.get(key);
  if (pendingStart) {
    return pendingStart;
  }
  let start: Promise<RuntimeStateWatch> | null = null;
  start = (async () => {
    const workspace = await resolveDesktopWatchWorkspace(registration);
    let createdWatch: RuntimeStateWatch | null = null;
    const recordChange = (generation: number) => {
      const currentWatch = createdWatch;
      if (
        !currentWatch ||
        currentWatch.closed ||
        runtimeStateWatches.get(key) !== currentWatch ||
        generation !== currentWatch.backend.generation
      ) {
        return;
      }
      if (currentWatch.flushInFlight) {
        currentWatch.flushRequested = true;
        return;
      }
      if (currentWatch.flushRetryNotBeforeMs > 0) {
        currentWatch.flushRequested = true;
      }
      scheduleRuntimeStateFlush(currentWatch, key, runtimeStateWatchDebounceMs);
    };
    const backend = await startRuntimeStateWatchBackend(
      workspace.stateFile,
      recordChange,
      scheduler,
      () => {
        const currentWatch = createdWatch;
        if (
          !currentWatch?.timer ||
          currentWatch.closed ||
          runtimeStateWatches.get(key) !== currentWatch
        )
          return;
        currentWatch.timer.cancel();
        currentWatch.timer = null;
        scheduleRuntimeStateFlush(currentWatch, key, 0);
      }
    );
    createdWatch = {
      backend,
      subscribers: new Map(),
      stateFile: workspace.stateFile,
      timer: null,
      scheduler,
      flushInFlight: false,
      flushRequested: false,
      flushFailureBackoffMs: 0,
      flushRetryNotBeforeMs: 0,
      closed: false
    };
    if (
      pendingRuntimeStateWatchStarts.get(key) !== start ||
      !hasPendingRuntimeStateWatchSubscribers(key)
    ) {
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
    if (pendingRuntimeStateWatchStarts.get(key) === start)
      pendingRuntimeStateWatchStarts.delete(key);
  }
}

async function startRuntimeStateWatch(
  registration: DesktopWatchRegistration,
  webContents: WebContents,
  scheduler: WatchScheduler
): Promise<void> {
  const key = desktopWatchBackendKey(registration);
  const subscriberKey = desktopWatchSubscriberKey(webContents.id, registration.registrationId);
  const pendingSubscriber = addPendingRuntimeStateWatchSubscriber(
    key,
    subscriberKey,
    registration,
    webContents
  );
  let activeWatch: RuntimeStateWatch;
  try {
    activeWatch = await getOrCreateRuntimeStateWatch(key, registration, scheduler);
  } catch (caught) {
    removePendingRuntimeStateWatchSubscriber(key, subscriberKey, pendingSubscriber);
    throw caught;
  }
  if (
    pendingRuntimeStateWatchSubscribers.get(key)?.get(subscriberKey) !== pendingSubscriber ||
    webContents.isDestroyed() ||
    activeWatch.closed
  ) {
    removePendingRuntimeStateWatchSubscriber(key, subscriberKey, pendingSubscriber);
    if (activeWatch.subscribers.size === 0 && !hasPendingRuntimeStateWatchSubscribers(key)) {
      closeRuntimeStateWatch(activeWatch);
      if (runtimeStateWatches.get(key) === activeWatch) runtimeStateWatches.delete(key);
    }
    return;
  }
  if (!activeWatch.subscribers.has(subscriberKey)) {
    const onDestroyed = () => stopRuntimeStateWatch(registration, webContents);
    activeWatch.subscribers.set(subscriberKey, { ...pendingSubscriber, onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
  removePendingRuntimeStateWatchSubscriber(key, subscriberKey, pendingSubscriber);
}

function stopRuntimeStateWatch(
  registration: DesktopWatchRegistration,
  webContents: WebContents
): void {
  const key = desktopWatchBackendKey(registration);
  const subscriberKey = desktopWatchSubscriberKey(webContents.id, registration.registrationId);
  removePendingRuntimeStateWatchSubscriber(key, subscriberKey);
  const activeWatch = runtimeStateWatches.get(key);
  if (!activeWatch) return;
  const subscriber = activeWatch.subscribers.get(subscriberKey);
  if (subscriber) {
    activeWatch.subscribers.delete(subscriberKey);
    subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  }
  if (activeWatch.subscribers.size > 0 || hasPendingRuntimeStateWatchSubscribers(key)) return;
  closeRuntimeStateWatch(activeWatch);
  if (runtimeStateWatches.get(key) === activeWatch) runtimeStateWatches.delete(key);
}

export function registerRuntimeStateWatchHandlers(
  options: RuntimeStateWatchHandlerOptions = {}
): void {
  const scheduler = options.scheduler ?? systemWatchScheduler;
  ipcMain.handle(desktopBridgeInvokeChannels.watchRuntimeState, (event, input: unknown) =>
    startRuntimeStateWatch(desktopWatchRegistrationSchema.parse(input), event.sender, scheduler)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.unwatchRuntimeState, (event, input: unknown) =>
    stopRuntimeStateWatch(desktopWatchRegistrationSchema.parse(input), event.sender)
  );
}
