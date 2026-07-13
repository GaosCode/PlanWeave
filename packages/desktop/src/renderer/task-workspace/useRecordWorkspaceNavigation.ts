import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { DesktopRunRecord } from "@planweave-ai/runtime";
import { appViewHistoryChangedEvent, type AppHistoryRoute } from "../hooks/useAppViewHistory";
import {
  recordAuthorityTargetSchema,
  type RecordAuthorityTarget
} from "../taskWorkspaceNavigation";

export type RecordNavigationSource = "autoRun" | "notifications" | "search";

export type RecordWorkspaceLocator = {
  projectRoot: string;
  canvasId: string;
  recordId: string;
  expectedBlockRef?: string;
};

type SourceContextKeys = Record<RecordNavigationSource, string>;

type NavigationLifecycle = {
  route: AppHistoryRoute | null;
  routeGeneration: number;
  sourceContextGenerations: Record<RecordNavigationSource, number>;
  sourceContextKeys: SourceContextKeys;
};

function expectedSourceView(source: RecordNavigationSource) {
  return source === "autoRun" ? "graph" : source;
}

export function recordWorkspaceTarget(
  locator: RecordWorkspaceLocator,
  record: Pick<DesktopRunRecord, "recordId" | "ref" | "taskId">
): RecordAuthorityTarget {
  if (record.recordId !== locator.recordId) {
    throw new Error("Run record response does not match the requested record identity.");
  }
  if (locator.expectedBlockRef && record.ref !== locator.expectedBlockRef) {
    throw new Error("Run record response does not match the requested block identity.");
  }
  const separatorIndex = record.ref.indexOf("#");
  if (separatorIndex <= 0 || record.taskId !== record.ref.slice(0, separatorIndex)) {
    throw new Error("Run record response has inconsistent task and block identities.");
  }
  return recordAuthorityTargetSchema.parse({
    projectRoot: locator.projectRoot,
    canvasId: locator.canvasId,
    taskId: record.taskId,
    blockRef: record.ref,
    recordId: record.recordId
  });
}

export function useRecordWorkspaceNavigation({
  getRunRecord,
  openTarget,
  route,
  sourceContextKeys
}: {
  getRunRecord: ((locator: RecordWorkspaceLocator) => Promise<DesktopRunRecord>) | null;
  openTarget: (source: RecordNavigationSource, target: RecordAuthorityTarget) => void;
  route: AppHistoryRoute;
  sourceContextKeys: SourceContextKeys;
}) {
  const lifecycle = useRef<NavigationLifecycle>({
    route,
    routeGeneration: 0,
    sourceContextGenerations: { autoRun: 0, notifications: 0, search: 0 },
    sourceContextKeys
  });
  const sourceRequests = useRef<Record<RecordNavigationSource, number>>({
    autoRun: 0,
    notifications: 0,
    search: 0
  });

  useLayoutEffect(() => {
    const current = lifecycle.current;
    const sourceContextGenerations = { ...current.sourceContextGenerations };
    for (const source of ["autoRun", "notifications", "search"] as const) {
      if (current.sourceContextKeys[source] !== sourceContextKeys[source]) {
        sourceContextGenerations[source] += 1;
      }
    }
    lifecycle.current = {
      route,
      routeGeneration:
        current.route !== route ? current.routeGeneration + 1 : current.routeGeneration,
      sourceContextGenerations,
      sourceContextKeys
    };
  }, [route, sourceContextKeys]);

  useEffect(() => {
    const invalidateRouteTransition = () => {
      const current = lifecycle.current;
      lifecycle.current = {
        ...current,
        route: null,
        routeGeneration: current.routeGeneration + 1
      };
    };
    window.addEventListener(appViewHistoryChangedEvent, invalidateRouteTransition);
    return () => window.removeEventListener(appViewHistoryChangedEvent, invalidateRouteTransition);
  }, []);

  return useCallback(
    async (source: RecordNavigationSource, locator: RecordWorkspaceLocator) => {
      if (!getRunRecord) {
        throw new Error("Task Workspace bridge is unavailable.");
      }
      const expectedView = expectedSourceView(source);
      const started = lifecycle.current;
      if (started.route?.view !== expectedView) {
        throw new Error(`Cannot open a run record outside the '${expectedView}' source view.`);
      }
      const request = ++sourceRequests.current[source];
      const routeGeneration = started.routeGeneration;
      const sourceContextGeneration = started.sourceContextGenerations[source];
      const isCurrent = () => {
        const current = lifecycle.current;
        return (
          sourceRequests.current[source] === request &&
          current.routeGeneration === routeGeneration &&
          current.sourceContextGenerations[source] === sourceContextGeneration &&
          current.route?.view === expectedView
        );
      };

      let record: DesktopRunRecord;
      try {
        record = await getRunRecord(locator);
      } catch (caught) {
        if (isCurrent()) {
          throw caught;
        }
        return;
      }
      if (!isCurrent()) {
        return;
      }
      openTarget(source, recordWorkspaceTarget(locator, record));
    },
    [getRunRecord, openTarget]
  );
}
