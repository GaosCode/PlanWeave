import type { AcpTimelineItem } from "@planweave-ai/runtime";
import { projectRemoteAcpTimeline } from "@planweave-ai/runtime/browser";
import type {
  RemoteEventReplay,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { useEffect, useMemo, useRef, useState } from "react";

export type RemoteTaskWorkspaceConversationApi = {
  observe(operationId: string): Promise<RemoteOperationObservation>;
  replay(operationId: string, afterCursor: number): Promise<RemoteEventReplay>;
  replayTerminal?: boolean;
  subscribe?(refresh: () => void): () => void;
};

export type RemoteTaskWorkspaceConversation = {
  blockRef: string;
  error: string | null;
  operationId: string;
  state: RemoteOperationObservation["state"] | "loading";
  timeline: readonly AcpTimelineItem[];
};

const terminalStates = new Set<RemoteOperationObservation["state"]>([
  "completed",
  "failed",
  "cancelled"
]);

type OperationEventCache = {
  key: string;
  cursor: number;
  events: RemoteEventReplay["events"];
  executionAttemptId: string | null;
};

const operationCacheLimit = 8;

function storeOperationCache(
  caches: Map<string, OperationEventCache>,
  cache: OperationEventCache
): void {
  caches.delete(cache.key);
  caches.set(cache.key, cache);
  if (caches.size <= operationCacheLimit) return;
  const oldestKey = caches.keys().next().value;
  if (oldestKey !== undefined) caches.delete(oldestKey);
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isForbiddenError(error: unknown): boolean {
  if (error && typeof error === "object") {
    if ("httpStatus" in error && error.httpStatus === 403) return true;
    if ("kind" in error && error.kind === "forbidden") return true;
    if ("code" in error && error.code === "http_403") return true;
  }
  return error instanceof Error && /(?:http_403|\b403\b|forbidden)/i.test(error.message);
}

function mergeEvents(
  cached: RemoteEventReplay["events"],
  incoming: RemoteEventReplay["events"]
): RemoteEventReplay["events"] {
  const byCursor = new Map(cached.map((event) => [event.cursor, event]));
  for (const event of incoming) byCursor.set(event.cursor, event);
  return [...byCursor.values()].sort((left, right) => left.cursor - right.cursor);
}

async function replayIncrementally(
  api: RemoteTaskWorkspaceConversationApi,
  operationId: string,
  cache: OperationEventCache
): Promise<OperationEventCache> {
  let cachedEvents = cache.events;
  let executionAttemptId = cache.executionAttemptId;
  let afterCursor = cache.cursor;
  let events: RemoteEventReplay["events"] = [];
  for (;;) {
    const replay = await api.replay(operationId, afterCursor);
    const identityChanged =
      executionAttemptId !== null && replay.executionAttemptId !== executionAttemptId;
    const cursorRolledBack = replay.cursor < afterCursor || replay.highWatermark < afterCursor;
    if ((identityChanged || cursorRolledBack) && afterCursor > 0) {
      cachedEvents = [];
      events = [];
      executionAttemptId = null;
      afterCursor = 0;
      continue;
    }
    if (identityChanged || cursorRolledBack) cachedEvents = [];
    events.push(...replay.events);
    executionAttemptId = replay.executionAttemptId;
    if (!replay.hasMore || replay.cursor <= afterCursor) {
      return {
        key: cache.key,
        cursor: replay.cursor,
        events: mergeEvents(cachedEvents, events),
        executionAttemptId
      };
    }
    afterCursor = replay.cursor;
  }
}

export function useRemoteTaskWorkspaceConversation(input: {
  api: RemoteTaskWorkspaceConversationApi | null;
  blockRef: string | null;
  cacheScopeKey?: string | null;
  initialState?: RemoteOperationObservation["state"];
  operationId: string | null;
  onTerminal: () => void;
}): RemoteTaskWorkspaceConversation | null {
  const cachesRef = useRef(new Map<string, OperationEventCache>());
  const onTerminalRef = useRef(input.onTerminal);
  const terminalReportedKeyRef = useRef<string | null>(null);
  onTerminalRef.current = input.onTerminal;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    error: string | null;
    events: RemoteEventReplay["events"];
    state: RemoteTaskWorkspaceConversation["state"];
  } | null>(null);
  const key =
    input.operationId && input.blockRef
      ? `${input.cacheScopeKey ?? ""}\u0000${input.operationId}\u0000${input.blockRef}`
      : null;

  useEffect(() => {
    if (!input.api || !input.operationId || !input.blockRef || !key) {
      setSnapshot(null);
      return;
    }
    const api = input.api;
    const operationId = input.operationId;
    let cache = cachesRef.current.get(key) ?? {
      key,
      cursor: 0,
      events: [],
      executionAttemptId: null
    };
    storeOperationCache(cachesRef.current, cache);
    let disposed = false;
    let refreshInFlight = false;
    let refreshStopped = false;
    let state: RemoteTaskWorkspaceConversation["state"] = input.initialState ?? "loading";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!disposed && !refreshStopped && documentIsVisible()) {
        timer = setTimeout(() => void refresh(), 1_000);
      }
    };
    const refresh = async () => {
      if (disposed || refreshInFlight || refreshStopped || !documentIsVisible()) return;
      refreshInFlight = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        const observationPromise = api.observe(operationId);
        let observationResult: PromiseSettledResult<RemoteOperationObservation>;
        let replayResult: PromiseSettledResult<OperationEventCache> | null = null;
        const canReplayBeforeObservation =
          api.replayTerminal !== false ||
          (input.initialState !== undefined && !terminalStates.has(input.initialState));
        if (!canReplayBeforeObservation) {
          observationResult = await Promise.resolve(observationPromise).then(
            (value): PromiseFulfilledResult<RemoteOperationObservation> => ({
              status: "fulfilled",
              value
            }),
            (reason): PromiseRejectedResult => ({ status: "rejected", reason })
          );
          if (
            observationResult.status === "fulfilled" &&
            !terminalStates.has(observationResult.value.state)
          ) {
            replayResult = await Promise.resolve(replayIncrementally(api, operationId, cache)).then(
              (value): PromiseFulfilledResult<OperationEventCache> => ({
                status: "fulfilled",
                value
              }),
              (reason): PromiseRejectedResult => ({ status: "rejected", reason })
            );
          }
        } else {
          [observationResult, replayResult] = await Promise.allSettled([
            observationPromise,
            replayIncrementally(api, operationId, cache)
          ]);
        }
        if (disposed) return;

        const observation =
          observationResult.status === "fulfilled" ? observationResult.value : null;
        const acceptReplayResult = !(
          api.replayTerminal === false &&
          observation &&
          terminalStates.has(observation.state)
        );
        if (acceptReplayResult && replayResult?.status === "fulfilled") {
          cache = replayResult.value;
          storeOperationCache(cachesRef.current, cache);
        }
        if (observation) state = observation.state;
        const requestError =
          observationResult.status === "rejected"
            ? observationResult.reason
            : acceptReplayResult && replayResult?.status === "rejected"
              ? replayResult.reason
              : null;
        const failureError = observation?.failure
          ? `${observation.failure.message} (${observation.failure.code})`
          : null;
        setSnapshot({
          key,
          error: failureError ?? (requestError === null ? null : errorMessage(requestError)),
          events: cache.events,
          state
        });

        if (observation && terminalStates.has(observation.state)) {
          refreshStopped = true;
          if (terminalReportedKeyRef.current !== key) {
            terminalReportedKeyRef.current = key;
            onTerminalRef.current();
          }
          return;
        }
        if (observation) terminalReportedKeyRef.current = null;
        if (requestError !== null && isForbiddenError(requestError)) {
          refreshStopped = true;
          return;
        }
        schedule();
      } catch (error) {
        if (disposed) return;
        setSnapshot({
          key,
          error: errorMessage(error),
          events: cache.events,
          state
        });
        if (isForbiddenError(error)) refreshStopped = true;
        else schedule();
      } finally {
        refreshInFlight = false;
      }
    };
    setSnapshot({ key, error: null, events: cache.events, state });
    const unsubscribe = api.subscribe?.(() => void refresh()) ?? (() => undefined);
    const handleVisibilityChange = () => {
      if (documentIsVisible()) {
        void refresh();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    void refresh();
    return () => {
      disposed = true;
      unsubscribe();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (timer) clearTimeout(timer);
    };
  }, [input.api, input.blockRef, input.initialState, input.operationId, key]);

  return useMemo(() => {
    if (!key || !input.blockRef || !input.operationId) return null;
    const visible = snapshot?.key === key ? snapshot : null;
    return {
      blockRef: input.blockRef,
      error: visible?.error ?? null,
      operationId: input.operationId,
      state: visible?.state ?? input.initialState ?? "loading",
      timeline: projectRemoteAcpTimeline(visible?.events ?? [])
    };
  }, [input.blockRef, input.initialState, input.operationId, key, snapshot]);
}
