import { ipcMain } from "electron";
import { resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import type { DesktopCanvasReference, DesktopPackageFileChangeEvent } from "@planweave-ai/runtime";
import type { WebContents } from "electron";
import { desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels.js";
import type { PackageWatchBackendHandle } from "./packageWatchBackend.js";
import { startNativePackageWatchBackend } from "./packageWatchNativeBackend.js";
import { startPollingPackageWatchBackend } from "./packageWatchPollingBackend.js";
import { dedupePackageWatchPaths } from "./packageWatchPaths.js";

type PackageWatchSubscriber = {
  webContents: WebContents;
  onDestroyed: () => void;
};

type PackageWatch = {
  backend: PackageWatchBackendHandle;
  subscribers: Map<number, PackageWatchSubscriber>;
  changedPaths: Set<string>;
  timer: NodeJS.Timeout | null;
  closed: boolean;
};

const packageWatches = new Map<string, PackageWatch>();
const pendingPackageWatchStarts = new Map<string, Promise<PackageWatch>>();
const pendingPackageWatchSubscribers = new Map<string, Map<number, WebContents>>();
const packageWatchDebounceMs = 150;

function watchKey(projectRoot: string, canvasId?: string | null): string {
  return `${projectRoot}::${canvasId ?? "default"}`;
}

async function startPackageWatchBackend(
  workspace: Awaited<ReturnType<typeof resolveTaskCanvasWorkspace>>,
  recordChange: (path: string) => void,
  onError?: (error: unknown) => void
): Promise<PackageWatchBackendHandle> {
  const native = startNativePackageWatchBackend(workspace, recordChange, onError);
  if (native) {
    return native;
  }
  return await startPollingPackageWatchBackend(workspace, recordChange, onError);
}

function addPendingPackageWatchSubscriber(key: string, webContents: WebContents): void {
  const subscribers = pendingPackageWatchSubscribers.get(key) ?? new Map<number, WebContents>();
  subscribers.set(webContents.id, webContents);
  pendingPackageWatchSubscribers.set(key, subscribers);
}

function removePendingPackageWatchSubscriber(key: string, webContentsId: number): void {
  const subscribers = pendingPackageWatchSubscribers.get(key);
  if (!subscribers) {
    return;
  }
  subscribers.delete(webContentsId);
  if (subscribers.size === 0) {
    pendingPackageWatchSubscribers.delete(key);
  }
}

function hasPendingPackageWatchSubscribers(key: string): boolean {
  return (pendingPackageWatchSubscribers.get(key)?.size ?? 0) > 0;
}

function hasPendingPackageWatchSubscriber(key: string, webContentsId: number): boolean {
  return pendingPackageWatchSubscribers.get(key)?.has(webContentsId) ?? false;
}

function closePackageWatch(activeWatch: PackageWatch): void {
  if (activeWatch.closed) {
    return;
  }
  activeWatch.closed = true;
  for (const subscriber of activeWatch.subscribers.values()) {
    subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  }
  activeWatch.subscribers.clear();
  activeWatch.backend.close();
  if (activeWatch.timer) {
    clearTimeout(activeWatch.timer);
    activeWatch.timer = null;
  }
}

async function getOrCreatePackageWatch(
  key: string,
  projectRoot: string,
  canvasId: string | null | undefined
): Promise<PackageWatch> {
  const activeWatch = packageWatches.get(key);
  if (activeWatch) {
    return activeWatch;
  }
  const pendingStart = pendingPackageWatchStarts.get(key);
  if (pendingStart) {
    return pendingStart;
  }
  const start = (async () => {
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);

    let controller: PackageWatch | null = null;
    let activeGeneration = 0;
    let hasFailedOver = false;

    const isActiveController = (): boolean =>
      controller !== null && packageWatches.get(key) === controller && !controller.closed;

    const makeGuardedRecord = (gen: number) => (path: string) => {
      if (!isActiveController() || gen !== activeGeneration) {
        return;
      }
      if (!controller) {
        return;
      }
      controller.changedPaths.add(path);
      if (controller.timer) {
        clearTimeout(controller.timer);
      }
      controller.timer = setTimeout(
        () => flushPackageFileChange(projectRoot, canvasId),
        packageWatchDebounceMs
      );
    };

    const recordChange = makeGuardedRecord(0);

    function performFailover(): void {
      if (!isActiveController() || !controller) {
        return;
      }
      if (hasFailedOver || controller.backend.kind === "polling") {
        return;
      }

      hasFailedOver = true;
      activeGeneration += 1;
      const failoverGen = activeGeneration;

      // Native handles are strictly idempotent, so the entry remains the sole backend owner while
      // polling starts. A concurrent controller close may safely close the same handle again.
      controller.backend.close();

      const guardedRecord = makeGuardedRecord(failoverGen);
      // Polling errors stay on the polling path (no native recovery). Backend logs via console.warn;
      // the controller does not re-failover or surface a consumer-facing error DTO.

      void startPollingPackageWatchBackend(workspace, guardedRecord).then((newHandle) => {
        if (!isActiveController() || !controller || failoverGen !== activeGeneration) {
          newHandle.close();
          return;
        }
        controller.backend = newHandle;
        // Surface backend switch so consumers see polling kind on the next event.
        setTimeout(() => {
          if (isActiveController() && controller && failoverGen === activeGeneration) {
            controller.changedPaths.add("package/manifest.json");
            if (controller.timer) {
              clearTimeout(controller.timer);
            }
            controller.timer = setTimeout(
              () => flushPackageFileChange(projectRoot, canvasId),
              packageWatchDebounceMs
            );
          }
        }, 0);
      });
    }

    const onBackendError = (_error: unknown) => {
      if (!isActiveController()) {
        return;
      }
      performFailover();
    };

    const backend = await startPackageWatchBackend(workspace, recordChange, onBackendError);
    controller = {
      backend,
      subscribers: new Map(),
      changedPaths: new Set(),
      timer: null,
      closed: false
    };

    if (!hasPendingPackageWatchSubscribers(key)) {
      closePackageWatch(controller);
      return controller;
    }
    packageWatches.set(key, controller);
    return controller;
  })();
  pendingPackageWatchStarts.set(key, start);
  try {
    return await start;
  } finally {
    pendingPackageWatchStarts.delete(key);
  }
}

function flushPackageFileChange(projectRoot: string, canvasId?: string | null): void {
  const activeWatch = packageWatches.get(watchKey(projectRoot, canvasId));
  if (!activeWatch || activeWatch.closed) {
    return;
  }
  activeWatch.timer = null;
  const paths = dedupePackageWatchPaths(activeWatch.changedPaths);
  activeWatch.changedPaths.clear();
  if (paths.length === 0) {
    return;
  }
  const payload: DesktopPackageFileChangeEvent = {
    projectRoot,
    canvasId: canvasId ?? null,
    paths,
    changedPathCount: paths.length,
    backendKind: activeWatch.backend.kind,
    triggeredAt: new Date().toISOString()
  };
  for (const subscriber of activeWatch.subscribers.values()) {
    if (!subscriber.webContents.isDestroyed()) {
      subscriber.webContents.send(packageFileChangedChannel, payload);
    }
  }
}

async function startPackageWatch(
  projectRoot: string,
  canvasId: string | null | undefined,
  webContents: WebContents
): Promise<void> {
  const key = watchKey(projectRoot, canvasId);
  addPendingPackageWatchSubscriber(key, webContents);
  let activeWatch: PackageWatch;
  try {
    activeWatch = await getOrCreatePackageWatch(key, projectRoot, canvasId);
  } catch (caught) {
    removePendingPackageWatchSubscriber(key, webContents.id);
    throw caught;
  }
  if (!hasPendingPackageWatchSubscriber(key, webContents.id) || webContents.isDestroyed()) {
    removePendingPackageWatchSubscriber(key, webContents.id);
    if (activeWatch.subscribers.size === 0 && !hasPendingPackageWatchSubscribers(key)) {
      closePackageWatch(activeWatch);
      if (packageWatches.get(key) === activeWatch) {
        packageWatches.delete(key);
      }
    }
    return;
  }
  if (!activeWatch.subscribers.has(webContents.id)) {
    const onDestroyed = () => stopPackageWatch(projectRoot, canvasId, webContents);
    activeWatch.subscribers.set(webContents.id, { webContents, onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
  removePendingPackageWatchSubscriber(key, webContents.id);
}

function stopPackageWatch(
  projectRoot: string,
  canvasId: string | null | undefined,
  webContents: WebContents
): void {
  const key = watchKey(projectRoot, canvasId);
  removePendingPackageWatchSubscriber(key, webContents.id);
  const activeWatch = packageWatches.get(key);
  if (!activeWatch) {
    return;
  }
  const subscriber = activeWatch.subscribers.get(webContents.id);
  if (!subscriber) {
    if (activeWatch.subscribers.size === 0 && !hasPendingPackageWatchSubscribers(key)) {
      closePackageWatch(activeWatch);
      packageWatches.delete(key);
    }
    return;
  }
  activeWatch.subscribers.delete(webContents.id);
  subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  if (activeWatch.subscribers.size > 0) {
    return;
  }
  if (hasPendingPackageWatchSubscribers(key)) {
    return;
  }
  closePackageWatch(activeWatch);
  packageWatches.delete(key);
}

export function registerPackageWatchHandlers(): void {
  ipcMain.handle(
    desktopBridgeInvokeChannels.watchPackageFiles,
    (event, ref: DesktopCanvasReference) =>
      startPackageWatch(ref.projectRoot, ref.canvasId, event.sender)
  );
  ipcMain.handle(
    desktopBridgeInvokeChannels.unwatchPackageFiles,
    (event, ref: DesktopCanvasReference) =>
      stopPackageWatch(ref.projectRoot, ref.canvasId, event.sender)
  );
}
