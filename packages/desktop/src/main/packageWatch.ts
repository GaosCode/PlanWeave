import { ipcMain } from "electron";
import {
  desktopWatchRegistrationSchema,
  resolveDesktopWatchWorkspace
} from "@planweave-ai/runtime";
import type {
  DesktopWatchRegistration,
  DesktopPackageFileChangeEvent
} from "@planweave-ai/runtime";
import type { WebContents } from "electron";
import { desktopWatchBackendKey, desktopWatchSubscriberKey } from "./desktopWatchRegistration.js";
import { desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels.js";
import type { PackageWatchBackendHandle } from "./packageWatchBackend.js";
import { startNativePackageWatchBackend } from "./packageWatchNativeBackend.js";
import { startPollingPackageWatchBackend } from "./packageWatchPollingBackend.js";
import { dedupePackageWatchPaths } from "./packageWatchPaths.js";
import { systemWatchScheduler, type WatchScheduler, type WatchTimer } from "./watchRuntime.js";

type PackageWatchPendingSubscriber = {
  registration: DesktopWatchRegistration;
  webContents: WebContents;
};

type PackageWatchSubscriber = PackageWatchPendingSubscriber & {
  onDestroyed: () => void;
};

type PackageWatch = {
  backend: PackageWatchBackendHandle;
  subscribers: Map<string, PackageWatchSubscriber>;
  changedPaths: Set<string>;
  timer: WatchTimer | null;
  scheduledTasks: Set<WatchTimer>;
  closed: boolean;
};

type PackageWatchHandlerOptions = {
  scheduler?: WatchScheduler;
};

const packageWatches = new Map<string, PackageWatch>();
const pendingPackageWatchStarts = new Map<string, Promise<PackageWatch>>();
const pendingPackageWatchSubscribers = new Map<
  string,
  Map<string, PackageWatchPendingSubscriber>
>();
const packageWatchDebounceMs = 150;

async function startPackageWatchBackend(
  workspace: Awaited<ReturnType<typeof resolveDesktopWatchWorkspace>>,
  recordChange: (path: string) => void,
  scheduler: WatchScheduler,
  onError?: (error: unknown) => void
): Promise<PackageWatchBackendHandle> {
  const native = startNativePackageWatchBackend(workspace, recordChange, onError);
  if (native) {
    return native;
  }
  return await startPollingPackageWatchBackend(workspace, recordChange, onError, scheduler);
}

function addPendingPackageWatchSubscriber(
  key: string,
  subscriberKey: string,
  registration: DesktopWatchRegistration,
  webContents: WebContents
): PackageWatchPendingSubscriber {
  const subscribers =
    pendingPackageWatchSubscribers.get(key) ?? new Map<string, PackageWatchPendingSubscriber>();
  const subscriber = subscribers.get(subscriberKey) ?? { registration, webContents };
  subscribers.set(subscriberKey, subscriber);
  pendingPackageWatchSubscribers.set(key, subscribers);
  return subscriber;
}

function removePendingPackageWatchSubscriber(
  key: string,
  subscriberKey: string,
  subscriber?: PackageWatchPendingSubscriber
): void {
  const subscribers = pendingPackageWatchSubscribers.get(key);
  if (!subscribers || (subscriber && subscribers.get(subscriberKey) !== subscriber)) return;
  subscribers.delete(subscriberKey);
  if (subscribers.size === 0) {
    pendingPackageWatchSubscribers.delete(key);
    pendingPackageWatchStarts.delete(key);
  }
}

function hasPendingPackageWatchSubscribers(key: string): boolean {
  return (pendingPackageWatchSubscribers.get(key)?.size ?? 0) > 0;
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
    activeWatch.timer.cancel();
    activeWatch.timer = null;
  }
  for (const task of activeWatch.scheduledTasks) {
    task.cancel();
  }
  activeWatch.scheduledTasks.clear();
}

async function getOrCreatePackageWatch(
  key: string,
  registration: DesktopWatchRegistration,
  scheduler: WatchScheduler
): Promise<PackageWatch> {
  const activeWatch = packageWatches.get(key);
  if (activeWatch && !activeWatch.closed) {
    return activeWatch;
  }
  if (activeWatch) {
    packageWatches.delete(key);
  }
  const pendingStart = pendingPackageWatchStarts.get(key);
  if (pendingStart) {
    return pendingStart;
  }
  let start: Promise<PackageWatch> | null = null;
  start = (async () => {
    const workspace = await resolveDesktopWatchWorkspace(registration);

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
        controller.timer.cancel();
      }
      controller.timer = scheduler.schedule(packageWatchDebounceMs, () =>
        flushPackageFileChange(key, controller, scheduler)
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

      const failoverTask = scheduler.schedule(0, async () => {
        const newHandle = await startPollingPackageWatchBackend(
          workspace,
          guardedRecord,
          undefined,
          scheduler
        );
        if (!isActiveController() || !controller || failoverGen !== activeGeneration) {
          newHandle.close();
          return;
        }
        controller.backend = newHandle;
        // Surface backend switch so consumers see polling kind on the next event.
        const publishTask = scheduler.schedule(0, () => {
          if (isActiveController() && controller && failoverGen === activeGeneration) {
            controller.changedPaths.add("package/manifest.json");
            if (controller.timer) {
              controller.timer.cancel();
            }
            controller.timer = scheduler.schedule(packageWatchDebounceMs, () =>
              flushPackageFileChange(key, controller, scheduler)
            );
          }
        });
        controller.scheduledTasks.add(publishTask);
      });
      controller.scheduledTasks.add(failoverTask);
    }

    const onBackendError = (_error: unknown) => {
      if (!isActiveController()) {
        return;
      }
      performFailover();
    };

    const backend = await startPackageWatchBackend(
      workspace,
      recordChange,
      scheduler,
      onBackendError
    );
    controller = {
      backend,
      subscribers: new Map(),
      changedPaths: new Set(),
      timer: null,
      scheduledTasks: new Set(),
      closed: false
    };

    if (pendingPackageWatchStarts.get(key) !== start || !hasPendingPackageWatchSubscribers(key)) {
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
    if (pendingPackageWatchStarts.get(key) === start) pendingPackageWatchStarts.delete(key);
  }
}

function flushPackageFileChange(
  key: string,
  activeWatch: PackageWatch | null,
  scheduler: WatchScheduler
): void {
  if (!activeWatch || packageWatches.get(key) !== activeWatch || activeWatch.closed) {
    return;
  }
  activeWatch.timer = null;
  const paths = dedupePackageWatchPaths(activeWatch.changedPaths);
  activeWatch.changedPaths.clear();
  if (paths.length === 0) {
    return;
  }
  for (const subscriber of activeWatch.subscribers.values()) {
    if (!subscriber.webContents.isDestroyed()) {
      const payload: DesktopPackageFileChangeEvent = {
        projectRoot: subscriber.registration.projectRoot,
        workspaceRoot: subscriber.registration.workspaceRoot,
        registrationId: subscriber.registration.registrationId,
        canvasId: subscriber.registration.canvasId ?? null,
        paths,
        changedPathCount: paths.length,
        backendKind: activeWatch.backend.kind,
        triggeredAt: new Date(scheduler.nowMs()).toISOString()
      };
      subscriber.webContents.send(packageFileChangedChannel, payload);
    }
  }
}

async function startPackageWatch(
  registration: DesktopWatchRegistration,
  webContents: WebContents,
  scheduler: WatchScheduler
): Promise<void> {
  const key = desktopWatchBackendKey(registration);
  const subscriberKey = desktopWatchSubscriberKey(webContents.id, registration.registrationId);
  const pendingSubscriber = addPendingPackageWatchSubscriber(
    key,
    subscriberKey,
    registration,
    webContents
  );
  let activeWatch: PackageWatch;
  try {
    activeWatch = await getOrCreatePackageWatch(key, registration, scheduler);
  } catch (caught) {
    removePendingPackageWatchSubscriber(key, subscriberKey, pendingSubscriber);
    throw caught;
  }
  if (
    pendingPackageWatchSubscribers.get(key)?.get(subscriberKey) !== pendingSubscriber ||
    webContents.isDestroyed() ||
    activeWatch.closed
  ) {
    removePendingPackageWatchSubscriber(key, subscriberKey, pendingSubscriber);
    if (activeWatch.subscribers.size === 0 && !hasPendingPackageWatchSubscribers(key)) {
      closePackageWatch(activeWatch);
      if (packageWatches.get(key) === activeWatch) packageWatches.delete(key);
    }
    return;
  }
  if (!activeWatch.subscribers.has(subscriberKey)) {
    const onDestroyed = () => stopPackageWatch(registration, webContents);
    activeWatch.subscribers.set(subscriberKey, { ...pendingSubscriber, onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
  removePendingPackageWatchSubscriber(key, subscriberKey, pendingSubscriber);
}

function stopPackageWatch(registration: DesktopWatchRegistration, webContents: WebContents): void {
  const key = desktopWatchBackendKey(registration);
  const subscriberKey = desktopWatchSubscriberKey(webContents.id, registration.registrationId);
  removePendingPackageWatchSubscriber(key, subscriberKey);
  const activeWatch = packageWatches.get(key);
  if (!activeWatch) return;
  const subscriber = activeWatch.subscribers.get(subscriberKey);
  if (subscriber) {
    activeWatch.subscribers.delete(subscriberKey);
    subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  }
  if (activeWatch.subscribers.size > 0 || hasPendingPackageWatchSubscribers(key)) return;
  closePackageWatch(activeWatch);
  if (packageWatches.get(key) === activeWatch) packageWatches.delete(key);
}

export function registerPackageWatchHandlers(options: PackageWatchHandlerOptions = {}): void {
  const scheduler = options.scheduler ?? systemWatchScheduler;
  ipcMain.handle(desktopBridgeInvokeChannels.watchPackageFiles, (event, input: unknown) =>
    startPackageWatch(desktopWatchRegistrationSchema.parse(input), event.sender, scheduler)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.unwatchPackageFiles, (event, input: unknown) =>
    stopPackageWatch(desktopWatchRegistrationSchema.parse(input), event.sender)
  );
}
