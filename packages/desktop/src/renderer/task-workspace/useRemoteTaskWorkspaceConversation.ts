import type {
  AcpTimelineItem,
  ProjectedRemoteAcpEvent,
  RemoteAcpReplayDiagnostic
} from "@planweave-ai/runtime";
import {
  projectRemoteAcpProjectedTimeline,
  projectRemoteAcpReplay
} from "@planweave-ai/runtime/browser";
import type {
  RemoteEventReplay,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyRemoteAcpReplayPage,
  createRemoteAcpAttemptReplayState,
  scopeRemoteAcpReplayToAttempt,
  type RemoteAcpAttemptReplayState
} from "../collaboration/remoteAcpReplayState";

export type RemoteTaskWorkspaceConversationApi = {
  observe(operationId: string): Promise<RemoteOperationObservation>;
  replay(operationId: string, afterCursor: number): Promise<RemoteEventReplay>;
  replayTerminal?: boolean;
  subscribe?(refresh: () => void): () => void;
};

export type RemoteTaskWorkspaceConversation = {
  blockRef: string;
  error: string | null;
  eventProtocolVersion: 1 | 2 | null;
  executionAttemptId: string | null;
  operationId: string;
  replayDiagnostics: readonly RemoteAcpReplayDiagnostic[];
  state: RemoteOperationObservation["state"] | "loading";
  timeline: readonly AcpTimelineItem[];
};

const terminalStates = new Set<RemoteOperationObservation["state"]>([
  "completed",
  "failed",
  "cancelled"
]);

type OperationEventCache = RemoteAcpAttemptReplayState & {
  key: string;
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

async function replayIncrementally(
  api: RemoteTaskWorkspaceConversationApi,
  operationId: string,
  cache: OperationEventCache
): Promise<OperationEventCache> {
  let state: RemoteAcpAttemptReplayState = cache;
  for (;;) {
    const requestedAfterCursor = state.cursor;
    const replay = await api.replay(operationId, requestedAfterCursor);
    const projection = projectRemoteAcpReplay(replay);
    state = applyRemoteAcpReplayPage({
      state,
      requestedAfterCursor,
      cursor: replay.cursor,
      hasMore: replay.hasMore,
      projection
    });
    if (!replay.hasMore || replay.cursor <= requestedAfterCursor)
      return { key: cache.key, ...state };
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
    events: ProjectedRemoteAcpEvent[];
    eventProtocolVersion: 1 | 2 | null;
    replayDiagnostics: RemoteAcpReplayDiagnostic[];
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
      ...createRemoteAcpAttemptReplayState()
    };
    storeOperationCache(cachesRef.current, cache);
    let disposed = false;
    let refreshGeneration = 0;
    let refreshStopped = false;
    let state: RemoteTaskWorkspaceConversation["state"] = input.initialState ?? "loading";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!disposed && !refreshStopped && documentIsVisible()) {
        timer = setTimeout(() => void refresh(), 1_000);
      }
    };
    const refresh = async () => {
      if (disposed || refreshStopped || !documentIsVisible()) return;
      const generation = ++refreshGeneration;
      const isCurrent = () => !disposed && generation === refreshGeneration;
      let terminalObserved = false;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        const observation = await api.observe(operationId);
        if (!isCurrent()) return;
        state = observation.state;
        const scoped = scopeRemoteAcpReplayToAttempt(cache, observation.executionAttemptId);
        if (scoped !== cache) {
          cache = { key, ...scoped };
          storeOperationCache(cachesRef.current, cache);
          setSnapshot({
            key,
            error: null,
            eventProtocolVersion: cache.eventProtocolVersion,
            events: cache.events,
            replayDiagnostics: cache.diagnostics,
            state
          });
        }
        terminalObserved = terminalStates.has(observation.state);
        if (terminalObserved) {
          refreshStopped = true;
          if (terminalReportedKeyRef.current !== key) {
            terminalReportedKeyRef.current = key;
            onTerminalRef.current();
          }
        }
        const shouldReplay = api.replayTerminal !== false || !terminalStates.has(observation.state);
        if (shouldReplay) {
          const replayed = await replayIncrementally(api, operationId, cache);
          if (!isCurrent()) return;
          cache = replayed;
          storeOperationCache(cachesRef.current, cache);
        }
        const failureError = observation.failure
          ? `${observation.failure.message} (${observation.failure.code})`
          : null;
        setSnapshot({
          key,
          error: failureError,
          eventProtocolVersion: cache.eventProtocolVersion,
          events: cache.events,
          replayDiagnostics: cache.diagnostics,
          state
        });

        if (terminalObserved) return;
        terminalReportedKeyRef.current = null;
        schedule();
      } catch (error) {
        if (!isCurrent()) return;
        setSnapshot({
          key,
          error: errorMessage(error),
          eventProtocolVersion: cache.eventProtocolVersion,
          events: cache.events,
          replayDiagnostics: cache.diagnostics,
          state
        });
        if (terminalObserved || isForbiddenError(error)) refreshStopped = true;
        else schedule();
      }
    };
    setSnapshot({
      key,
      error: null,
      eventProtocolVersion: cache.eventProtocolVersion,
      events: cache.events,
      replayDiagnostics: cache.diagnostics,
      state
    });
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
      eventProtocolVersion: visible?.eventProtocolVersion ?? null,
      executionAttemptId: cachesRef.current.get(key)?.executionAttemptId ?? null,
      operationId: input.operationId,
      replayDiagnostics: visible?.replayDiagnostics ?? [],
      state: visible?.state ?? input.initialState ?? "loading",
      timeline: projectRemoteAcpProjectedTimeline(visible?.events ?? [])
    };
  }, [input.blockRef, input.initialState, input.operationId, key, snapshot]);
}
