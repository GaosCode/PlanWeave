import {
  projectWorkspaceExecutionTimeline,
  type WorkspaceExecutionEvent,
  type WorkspaceExecutionTimeline
} from "@planweave-ai/runtime/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopOwnerCanvasExecutionLocator,
  DesktopWorkspaceExecutionResponse,
  PlanWeaveWorkspaceExecutionApi
} from "../../shared/workspaceExecution";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import type { WorkspaceExecutionIpcErrorCode } from "../../shared/workspaceExecutionIpc";
import type { RemoteTaskWorkspaceConversation } from "./useRemoteTaskWorkspaceConversation";
import {
  workspaceExecutionPollingKey,
  workspaceExecutionSuccessPollDelay
} from "./workspaceExecutionPollingCadence";

function conversationState(phase: string): RemoteTaskWorkspaceConversation["state"] {
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  if (phase === "stopped") return "cancelled";
  if (phase === "blocked") return "action_required";
  return "running";
}

type WorkspaceExecutionConversationCache = {
  events: Map<string, WorkspaceExecutionEvent>;
  key: string;
  value: RemoteTaskWorkspaceConversation | null;
};

const cacheLimit = 8;
const basePollDelayMs = 1_000;
const maximumRetryDelayMs = 30_000;
const maximumTransientRetries = 6;

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const permanentFollowErrorCodes: ReadonlySet<string> = new Set<WorkspaceExecutionIpcErrorCode>([
  "human_auth_unauthenticated",
  "human_cross_project_forbidden",
  "human_remote_resource_not_found",
  "collaboration_workspace_connection_mismatch",
  "workspace_execution_authority_mismatch",
  "workspace_execution_scope_mismatch",
  "workspace_execution_resume_mismatch",
  "workspace_execution_locator_mismatch"
]);

function isPermanentFollowError(error: unknown): boolean {
  return permanentFollowErrorCodes.has(errorMessage(error));
}

function progressFingerprint(
  view: DesktopWorkspaceExecutionResponse,
  timeline: WorkspaceExecutionTimeline
): string {
  const remoteHandle = view.handle.target === "remote" ? view.handle : null;
  const terminalPhase = ["completed", "failed", "stopped"].includes(view.session.phase)
    ? view.session.phase
    : null;
  return JSON.stringify([
    remoteHandle?.operationRevision ?? null,
    remoteHandle?.executionAttemptId ?? null,
    timeline.cursor,
    timeline.pendingInteractions,
    timeline.terminalOutcome,
    terminalPhase
  ]);
}

function storeCache(
  caches: Map<string, WorkspaceExecutionConversationCache>,
  cache: WorkspaceExecutionConversationCache
): void {
  caches.delete(cache.key);
  caches.set(cache.key, cache);
  if (caches.size <= cacheLimit) return;
  const oldest = caches.keys().next().value;
  if (oldest !== undefined) caches.delete(oldest);
}

export function useWorkspaceExecutionTaskWorkspaceConversation(input: {
  api: PlanWeaveWorkspaceExecutionApi | null;
  locator: WorkspaceCanvasLocator | DesktopOwnerCanvasExecutionLocator | null;
  blockRef: string | null;
  operationId: string | null;
  scopeKey: string;
  onTerminal: () => void;
}): RemoteTaskWorkspaceConversation | null {
  const cachesRef = useRef(new Map<string, WorkspaceExecutionConversationCache>());
  const onTerminalRef = useRef(input.onTerminal);
  onTerminalRef.current = input.onTerminal;
  const locatorKey = input.locator
    ? input.locator.kind === "workspace"
      ? [
          input.locator.kind,
          input.locator.connectionProfileId,
          input.locator.workspaceId,
          input.locator.projectId,
          input.locator.canvasId
        ].join("\u0000")
      : [
          input.locator.kind,
          input.locator.operatorProfileId,
          input.locator.humanPrincipalId,
          input.locator.projectRoot,
          input.locator.projectId,
          input.locator.canvasId
        ].join("\u0000")
    : null;
  const locatorRef = useRef<{
    key: string | null;
    value: WorkspaceCanvasLocator | DesktopOwnerCanvasExecutionLocator | null;
  }>({ key: null, value: null });
  if (locatorRef.current.key !== locatorKey) {
    locatorRef.current = { key: locatorKey, value: input.locator };
  }
  const locator = locatorRef.current.value;
  const locatorIdentity = locatorKey;
  const key =
    locatorIdentity && input.blockRef && input.operationId
      ? `${locatorIdentity}\u0000${input.scopeKey}\u0000${input.operationId}\u0000${input.blockRef}`
      : null;
  const pollingKey = input.operationId
    ? workspaceExecutionPollingKey(input.scopeKey, input.operationId)
    : null;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    value: RemoteTaskWorkspaceConversation;
  } | null>(null);

  useEffect(() => {
    if (!input.api || !locator || !input.blockRef || !input.operationId || !key || !pollingKey) {
      setSnapshot(null);
      return;
    }
    const api = input.api;
    const blockRef = input.blockRef;
    const operationId = input.operationId;
    const cache = cachesRef.current.get(key) ?? {
      events: new Map<string, WorkspaceExecutionEvent>(),
      key,
      value: null
    };
    storeCache(cachesRef.current, cache);
    let disposed = false;
    let requestEpoch = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let terminalReported = false;
    let refreshStopped = false;
    let refreshing = false;
    let transientFailures = 0;
    let lastProgressFingerprint: string | null = null;
    let noProgressCount = 0;
    const schedule = (delayMs = basePollDelayMs) => {
      if (!disposed && !refreshStopped && documentIsVisible()) {
        timer = setTimeout(() => void refresh(), delayMs);
      }
    };
    const refresh = async () => {
      if (disposed || refreshStopped || refreshing || !documentIsVisible()) return;
      refreshing = true;
      const epoch = ++requestEpoch;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        const view = await api.followWorkspaceExecution(
          locator.kind === "workspace"
            ? { locator, blockRef, operationId }
            : { locator, blockRef, operationId }
        );
        if (disposed || epoch !== requestEpoch) return;
        transientFailures = 0;
        for (const event of view.events) cache.events.set(event.eventId, event);
        const timeline = projectWorkspaceExecutionTimeline([...cache.events.values()]);
        const nextProgressFingerprint = progressFingerprint(view, timeline);
        if (
          lastProgressFingerprint === null ||
          nextProgressFingerprint !== lastProgressFingerprint
        ) {
          lastProgressFingerprint = nextProgressFingerprint;
          noProgressCount = 0;
        } else {
          noProgressCount += 1;
        }
        const state =
          timeline.pendingInteractions.length > 0
            ? "action_required"
            : conversationState(view.session.phase);
        cache.value = {
          blockRef,
          cursor: timeline.cursor,
          error: view.session.error,
          eventProtocolVersion: null,
          executionAttemptId: timeline.executionAttemptIds.at(-1) ?? null,
          operationId,
          replayDiagnostics: [],
          state,
          terminalOutcome: timeline.terminalOutcome,
          timeline: timeline.runnerTimeline
        };
        storeCache(cachesRef.current, cache);
        setSnapshot({
          key,
          value: cache.value
        });
        if (
          timeline.terminalOutcome ||
          view.session.phase === "completed" ||
          view.session.phase === "failed" ||
          view.session.phase === "stopped"
        ) {
          refreshStopped = true;
          if (!terminalReported) onTerminalRef.current();
          terminalReported = true;
          return;
        }
        schedule(workspaceExecutionSuccessPollDelay(noProgressCount, pollingKey));
      } catch (error) {
        if (disposed || epoch !== requestEpoch) return;
        const message = errorMessage(error);
        const stale = cache.value;
        if (stale) cache.value = { ...stale, error: message };
        setSnapshot({
          key,
          value: cache.value ?? {
            blockRef,
            cursor: 0,
            error: message,
            eventProtocolVersion: null,
            executionAttemptId: null,
            operationId,
            replayDiagnostics: [],
            state: "loading",
            terminalOutcome: null,
            timeline: []
          }
        });
        if (isPermanentFollowError(error) || transientFailures >= maximumTransientRetries) {
          refreshStopped = true;
          return;
        }
        transientFailures += 1;
        schedule(Math.min(basePollDelayMs * 2 ** (transientFailures - 1), maximumRetryDelayMs));
      } finally {
        refreshing = false;
      }
    };
    if (cache.value) setSnapshot({ key, value: cache.value });
    const handleVisibilityChange = () => {
      if (documentIsVisible()) {
        lastProgressFingerprint = null;
        noProgressCount = 0;
        transientFailures = 0;
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
      requestEpoch += 1;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (timer) clearTimeout(timer);
    };
  }, [input.api, input.blockRef, input.operationId, key, locator, pollingKey]);

  return useMemo(() => (snapshot?.key === key ? snapshot.value : null), [key, snapshot]);
}
