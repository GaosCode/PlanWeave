import { useCallback, useEffect, useRef } from "react";
import type {
  DesktopPackageFileChangeEvent,
  DesktopPackageFileRefreshOptions,
  DesktopPackageFileSyncResult,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

function hasProjectPromptChangeDiagnostic(result: DesktopPackageFileSyncResult): boolean {
  return result.diagnostics.some(
    (diagnostic) => diagnostic.code === "package_change_non_package_prompt"
  );
}

function shouldReloadCanvasAfterRefresh(result: DesktopPackageFileSyncResult): boolean {
  return result.fullRefresh || hasProjectPromptChangeDiagnostic(result);
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function syncErrorMessage(result: DesktopPackageFileSyncResult): string {
  return result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
}

function watcherRefreshElapsedMs(triggeredAt: string | undefined): number | undefined {
  if (!triggeredAt) {
    return undefined;
  }
  const startedAt = Date.parse(triggeredAt);
  if (!Number.isFinite(startedAt)) {
    return undefined;
  }
  return Math.max(0, Date.now() - startedAt);
}

function syncResultWithWatcherMetadata(
  result: DesktopPackageFileSyncResult,
  event: DesktopPackageFileChangeEvent | undefined,
  changedPathCount?: number
): DesktopPackageFileSyncResult {
  if (!event) {
    return result;
  }
  const elapsedMs = watcherRefreshElapsedMs(event.triggeredAt);
  return {
    ...result,
    watcherBackendKind: event.backendKind,
    watcherChangedPathCount: changedPathCount ?? event.changedPathCount ?? event.paths.length,
    ...(elapsedMs === undefined ? {} : { watcherRefreshElapsedMs: elapsedMs })
  };
}

type RefreshTarget = {
  canvasId: string | null;
  generation: number;
  project: DesktopProjectSummary;
};

type PendingPackageFileRefresh = {
  changedPaths: Set<string>;
  event: DesktopPackageFileChangeEvent | undefined;
  fullRefreshRequested: boolean;
  resolveWaiters: Array<() => void>;
  target: RefreshTarget;
};

function sortedChangedPaths(paths: Set<string>): string[] {
  return [...paths].sort();
}

function mergeWatcherRefresh(
  pending: PendingPackageFileRefresh,
  event: DesktopPackageFileChangeEvent,
  activeChangedPaths: Set<string> | null
): PendingPackageFileRefresh {
  return mergeChangedPathRefresh(pending, event.paths, event, activeChangedPaths);
}

function mergeChangedPathRefresh(
  pending: PendingPackageFileRefresh,
  paths: string[],
  event: DesktopPackageFileChangeEvent | undefined,
  activeChangedPaths: Set<string> | null
): PendingPackageFileRefresh {
  const changedPaths = new Set(pending.changedPaths);
  for (const path of activeChangedPaths ?? []) {
    changedPaths.add(path);
  }
  for (const path of paths) {
    changedPaths.add(path);
  }
  return {
    ...pending,
    changedPaths,
    event: event ?? pending.event
  };
}

function mergeManualRefresh(
  pending: PendingPackageFileRefresh,
  resolveWaiter: (() => void) | undefined
): PendingPackageFileRefresh {
  return {
    ...pending,
    fullRefreshRequested: true,
    resolveWaiters: resolveWaiter
      ? [...pending.resolveWaiters, resolveWaiter]
      : pending.resolveWaiters
  };
}

function isEventForTarget(event: DesktopPackageFileChangeEvent, target: RefreshTarget): boolean {
  return (
    event.projectRoot === target.project.rootPath && (event.canvasId ?? null) === target.canvasId
  );
}

function isSameRefreshTarget(left: RefreshTarget | null, right: RefreshTarget): boolean {
  return Boolean(
    left &&
      left.generation === right.generation &&
      left.project.rootPath === right.project.rootPath &&
      left.canvasId === right.canvasId
  );
}

function resolvePendingWaiters(pending: PendingPackageFileRefresh | null): void {
  for (const resolveWaiter of pending?.resolveWaiters ?? []) {
    resolveWaiter();
  }
}

type UsePackageFileSyncArgs = {
  reloadCurrentCanvas: () => Promise<void>;
  refreshProjectDerivedState: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  setFileSyncDiagnostics: (diagnostics: string[]) => void;
  setFileSyncResult?: (result: DesktopPackageFileSyncResult | null) => void;
  setLastFileChange: (event: DesktopPackageFileChangeEvent | null) => void;
};

export function usePackageFileSync({
  reloadCurrentCanvas,
  refreshProjectDerivedState,
  selectedCanvasId,
  selectedProject,
  setError,
  setFileSyncDiagnostics,
  setFileSyncResult,
  setLastFileChange
}: UsePackageFileSyncArgs) {
  const activeWatcherChangedPathsRef = useRef<Set<string> | null>(null);
  const activeRefreshTargetRef = useRef<RefreshTarget | null>(null);
  const drainPromiseRef = useRef<Promise<void> | null>(null);
  const pendingWatcherRefreshRef = useRef<PendingPackageFileRefresh | null>(null);
  const refreshGenerationRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const targetKeyRef = useRef<string | null>(null);
  const latestTargetRef = useRef<RefreshTarget | null>(null);
  const targetKey = selectedProject
    ? `${selectedProject.rootPath}\u0000${selectedCanvasId ?? ""}`
    : null;
  if (targetKeyRef.current !== targetKey) {
    targetKeyRef.current = targetKey;
    refreshGenerationRef.current += 1;
  }
  latestTargetRef.current = selectedProject
    ? {
        project: selectedProject,
        canvasId: selectedCanvasId,
        generation: refreshGenerationRef.current
      }
    : null;

  const isCurrentRefreshTarget = useCallback((target: RefreshTarget): boolean => {
    const latestTarget = latestTargetRef.current;
    return Boolean(
      latestTarget &&
        latestTarget.generation === target.generation &&
        latestTarget.project.rootPath === target.project.rootPath &&
        latestTarget.canvasId === target.canvasId
    );
  }, []);

  const activeWatcherChangedPathsForTarget = useCallback(
    (target: RefreshTarget): Set<string> | null => {
      if (
        !refreshInFlightRef.current ||
        !isSameRefreshTarget(activeRefreshTargetRef.current, target)
      ) {
        return null;
      }
      return activeWatcherChangedPathsRef.current;
    },
    []
  );

  const takePendingRefreshForTarget = useCallback(
    (target: RefreshTarget): PendingPackageFileRefresh | null => {
      const pending = pendingWatcherRefreshRef.current;
      if (!pending || isSameRefreshTarget(pending.target, target)) {
        return pending;
      }
      pendingWatcherRefreshRef.current = null;
      resolvePendingWaiters(pending);
      return null;
    },
    []
  );

  useEffect(() => {
    const target = latestTargetRef.current;
    const pending = pendingWatcherRefreshRef.current;
    if (!pending || (target && isSameRefreshTarget(pending.target, target))) {
      return;
    }
    pendingWatcherRefreshRef.current = null;
    resolvePendingWaiters(pending);
  }, [targetKey]);

  const runPackageFileRefresh = useCallback(
    async (pending: PendingPackageFileRefresh) => {
      if (!bridge || !isCurrentRefreshTarget(pending.target)) {
        return;
      }
      try {
        const ref = desktopCanvasReference(pending.target.project, pending.target.canvasId);
        const changedPaths = sortedChangedPaths(pending.changedPaths);
        const options: DesktopPackageFileRefreshOptions | undefined = pending.fullRefreshRequested
          ? undefined
          : { changedPaths };
        const result = options
          ? await bridge.refreshPackageFileChanges(ref, options)
          : await bridge.refreshPackageFileChanges(ref);
        if (!isCurrentRefreshTarget(pending.target)) {
          return;
        }
        const uiResult = syncResultWithWatcherMetadata(result, pending.event, changedPaths.length);
        setFileSyncDiagnostics(uiResult.diagnostics.map((diagnostic) => diagnostic.message));
        setFileSyncResult?.(uiResult);
        if (!uiResult.ok) {
          const message = syncErrorMessage(uiResult);
          setError(message);
          try {
            await refreshProjectDerivedState();
          } catch (caught) {
            setError([message, errorMessage(caught)].filter(Boolean).join("\n"));
          }
          return;
        }
        if (shouldReloadCanvasAfterRefresh(uiResult)) {
          await reloadCurrentCanvas();
        } else {
          await refreshProjectDerivedState();
        }
      } catch (caught) {
        if (isCurrentRefreshTarget(pending.target)) {
          setError(errorMessage(caught));
        }
      }
    },
    [
      isCurrentRefreshTarget,
      refreshProjectDerivedState,
      reloadCurrentCanvas,
      setError,
      setFileSyncDiagnostics,
      setFileSyncResult
    ]
  );

  const drainRefreshQueue = useCallback(() => {
    if (drainPromiseRef.current) {
      return drainPromiseRef.current;
    }
    const drainPromise = (async () => {
      while (pendingWatcherRefreshRef.current) {
        const pending = pendingWatcherRefreshRef.current;
        pendingWatcherRefreshRef.current = null;
        refreshInFlightRef.current = true;
        activeRefreshTargetRef.current = pending.target;
        activeWatcherChangedPathsRef.current = pending.event ? new Set(pending.changedPaths) : null;
        try {
          await runPackageFileRefresh(pending);
        } finally {
          activeWatcherChangedPathsRef.current = null;
          activeRefreshTargetRef.current = null;
          refreshInFlightRef.current = false;
          for (const resolveWaiter of pending.resolveWaiters) {
            resolveWaiter();
          }
        }
      }
    })();
    drainPromiseRef.current = drainPromise.finally(() => {
      drainPromiseRef.current = null;
      if (pendingWatcherRefreshRef.current) {
        void drainRefreshQueue();
      }
    });
    return drainPromiseRef.current;
  }, [runPackageFileRefresh]);

  const enqueueWatcherRefresh = useCallback(
    (event: DesktopPackageFileChangeEvent) => {
      const target = latestTargetRef.current;
      if (!bridge || !target || !isEventForTarget(event, target)) {
        return;
      }
      const pending = takePendingRefreshForTarget(target) ?? {
        changedPaths: new Set<string>(),
        event: undefined,
        fullRefreshRequested: false,
        resolveWaiters: [],
        target
      };
      pendingWatcherRefreshRef.current = mergeWatcherRefresh(
        { ...pending, target },
        event,
        activeWatcherChangedPathsForTarget(target)
      );
      void drainRefreshQueue();
    },
    [activeWatcherChangedPathsForTarget, drainRefreshQueue, takePendingRefreshForTarget]
  );

  const refreshPackageFiles = useCallback(
    async (options?: DesktopPackageFileRefreshOptions, event?: DesktopPackageFileChangeEvent) => {
      const target = latestTargetRef.current;
      if (!bridge || !target) {
        return;
      }
      await new Promise<void>((resolve) => {
        const pending = takePendingRefreshForTarget(target) ?? {
          changedPaths: new Set<string>(),
          event: undefined,
          fullRefreshRequested: options === undefined,
          resolveWaiters: [],
          target
        };
        let nextPending = pending;
        if (options) {
          nextPending = mergeChangedPathRefresh(
            { ...pending, target, fullRefreshRequested: false },
            options.changedPaths ?? [],
            event,
            activeWatcherChangedPathsForTarget(target)
          );
        } else {
          nextPending = mergeManualRefresh({ ...pending, target }, resolve);
        }
        if (options) {
          nextPending = {
            ...nextPending,
            resolveWaiters: [...nextPending.resolveWaiters, resolve]
          };
        }
        pendingWatcherRefreshRef.current = nextPending;
        void drainRefreshQueue();
      });
    },
    [activeWatcherChangedPathsForTarget, drainRefreshQueue, takePendingRefreshForTarget]
  );

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    return bridge.onPackageFileChanged((event) => {
      const target = latestTargetRef.current;
      if (!target || !isEventForTarget(event, target)) {
        return;
      }
      setLastFileChange(event);
      enqueueWatcherRefresh(event);
    });
  }, [enqueueWatcherRefresh, selectedCanvasId, selectedProject, setLastFileChange]);

  useEffect(() => {
    return () => {
      refreshGenerationRef.current += 1;
      latestTargetRef.current = null;
      const pending = pendingWatcherRefreshRef.current;
      pendingWatcherRefreshRef.current = null;
      resolvePendingWaiters(pending);
    };
  }, []);

  return { refreshPackageFiles };
}
