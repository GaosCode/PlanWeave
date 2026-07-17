import { watch, type Dirent, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AcpEventSubscription } from "./acpEventPublisher.js";
import { createAcpEventSubscriptionCloseResult } from "./acpEventPublisher.js";

const DEFAULT_POLL_INTERVAL_MS = 250;

interface RunnerRecordFileSnapshot<T> {
  value: T;
  terminal: boolean;
  sequence: number;
}

type WatchHandle = Pick<FSWatcher, "close">;
type WatchDirectory = (
  path: string,
  onChange: () => void,
  onError: (error: Error) => void
) => WatchHandle;

export function observeRunnerRecordFiles<T>(options: {
  runDir: string;
  refresh: () => Promise<RunnerRecordFileSnapshot<T>>;
  onUpdate: (value: T) => void | Promise<void>;
  pollIntervalMs?: number;
  watchDirectory?: WatchDirectory;
  readDirectory?: (path: string) => Promise<Dirent[]>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}): AcpEventSubscription {
  const startInterval = options.setInterval ?? globalThis.setInterval;
  const stopInterval = options.clearInterval ?? globalThis.clearInterval;
  const readDirectory =
    options.readDirectory ?? ((path: string) => readdir(path, { withFileTypes: true }));
  const watchers = new Map<string, WatchHandle>();
  let isClosed = false;
  let lastSequence = 0;
  let refreshChain = Promise.resolve();
  let resolveClosed!: (result: Awaited<AcpEventSubscription["closed"]>) => void;
  const closed = new Promise<Awaited<AcpEventSubscription["closed"]>>((resolve) => {
    resolveClosed = resolve;
  });

  const close = (
    reason: Parameters<typeof createAcpEventSubscriptionCloseResult>[0],
    message?: string
  ): void => {
    if (isClosed) return;
    isClosed = true;
    stopInterval(pollTimer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    resolveClosed(createAcpEventSubscriptionCloseResult(reason, lastSequence, message));
  };

  function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function scheduleFailure(error: unknown): void {
    if (isClosed) return;
    refreshChain = refreshChain.then(
      () => close("owner_disposed", `Runner record file observer failed: ${failureMessage(error)}`),
      () => close("owner_disposed", `Runner record file observer failed: ${failureMessage(error)}`)
    );
  }

  const watchDirectory: WatchDirectory =
    options.watchDirectory ??
    ((path, onChange, onError) => {
      const watcher = watch(path, { persistent: false }, onChange);
      watcher.on("error", onError);
      return watcher;
    });

  const desiredWatchDirectories = async (): Promise<Set<string>> => {
    const desired = new Set([options.runDir]);
    const interactionsDir = join(options.runDir, "interactions");
    try {
      const entries = await readDirectory(interactionsDir);
      if (isClosed) return desired;
      desired.add(interactionsDir);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          desired.add(join(interactionsDir, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return desired;
  };

  const syncWatchers = async (): Promise<void> => {
    const desired = await desiredWatchDirectories();
    if (isClosed) return;
    for (const [path, watcher] of watchers) {
      if (!desired.has(path)) {
        watcher.close();
        watchers.delete(path);
      }
    }
    for (const path of desired) {
      if (watchers.has(path) || isClosed) continue;
      try {
        const watcher = watchDirectory(path, scheduleRefresh, scheduleFailure);
        if (isClosed) watcher.close();
        else watchers.set(path, watcher);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };

  const refresh = async (): Promise<void> => {
    if (isClosed) return;
    await syncWatchers();
    if (isClosed) return;
    const snapshot = await options.refresh();
    if (isClosed) return;
    lastSequence = snapshot.sequence;
    await options.onUpdate(snapshot.value);
    if (isClosed) return;
    if (snapshot.terminal) close("terminal");
  };

  function scheduleRefresh(): void {
    if (isClosed) return;
    refreshChain = refreshChain.then(refresh).catch(scheduleFailure);
  }

  const pollTimer = startInterval(
    scheduleRefresh,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  );
  pollTimer.unref?.();
  scheduleRefresh();

  return {
    unsubscribe: () => close("explicit_unsubscribe"),
    closed
  };
}
