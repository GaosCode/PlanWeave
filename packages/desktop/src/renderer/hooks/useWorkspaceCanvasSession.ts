import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction
} from "react";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type {
  WorkspaceCanvasCommandLabels,
  WorkspaceCanvasCommandSnapshot
} from "../collaboration/workspaceCanvasCommandView";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import type {
  WorkspaceCanvasProjection,
  WorkspaceCanvasProjectionStatus
} from "../../shared/workspaceCanvasProjection";
import type {
  WorkspaceCanvasCommandBridge,
  WorkspaceCanvasSubmitResult
} from "./useWorkspaceCanvasCommands";

export function workspaceLocatorEquals(
  left: WorkspaceCanvasLocator,
  right: WorkspaceCanvasLocator
): boolean {
  return (
    left.connectionProfileId === right.connectionProfileId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

export function snapshotFromWorkspaceProjection(
  projection: WorkspaceCanvasProjection,
  labels: WorkspaceCanvasCommandLabels,
  connectionPhase: WorkspaceCanvasCommandSnapshot["connectionPhase"]
): WorkspaceCanvasCommandSnapshot {
  const conflict = projection.status === "conflicted" ? projection.conflict : null;
  const effectiveConnectionPhase =
    projection.authorityMode === "offline_cache_readonly" ? "disconnected" : connectionPhase;
  const lastError =
    projection.status === "conflicted" && conflict
      ? labels.staleRevision(conflict.expectedRevision, conflict.authoritativeRevision)
      : projection.status === "rejected" && projection.rejectCode
        ? labels.rejected(projection.rejectCode)
        : null;
  return {
    session: {
      canvasId: projection.locator.canvasId,
      revision: projection.replica.revision,
      contentDigest: projection.replica.contentDigest,
      lastOperationId: null,
      lastJournalEntryId: null,
      pendingOperationId: projection.replica.optimisticOperationIds[0] ?? null,
      lastConflict: conflict,
      lastRejectCode: projection.status === "rejected" ? projection.rejectCode : null
    },
    connectionPhase: effectiveConnectionPhase,
    lastError,
    lastStaleConflict: conflict,
    busy: projection.status === "pending"
  };
}

export type WorkspaceCanvasSessionView = {
  snapshot: WorkspaceCanvasCommandSnapshot;
  projection: CollaborationCanvasBindingReplicaProjection | null;
  projectionStatus: WorkspaceCanvasProjectionStatus | null;
  initialRuntimeAvailability: CanvasRuntimeAvailability | null;
  submit: (input: { intent: CanvasCommandIntent }) => Promise<WorkspaceCanvasSubmitResult>;
  reconnect: () => Promise<boolean>;
};

const IDLE_SNAPSHOT: WorkspaceCanvasCommandSnapshot = {
  session: null,
  connectionPhase: "idle",
  lastError: null,
  lastStaleConflict: null,
  busy: false
};

/**
 * Renderer adapter for the main-process Workspace Canvas Session.
 * Durable reconnect/idempotency stay in main; this hook only opens, displays, and submits.
 */
export function useWorkspaceCanvasSession(input: {
  api: WorkspaceCanvasCommandBridge | null;
  labels: WorkspaceCanvasCommandLabels;
  locator: WorkspaceCanvasLocator | null;
  sessionConnected: boolean;
}): WorkspaceCanvasSessionView {
  const generation = useRef(0);
  const locatorKey = JSON.stringify(input.locator);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bridge and connection changes retire the current session authority.
  const authority = useMemo(
    () => ({ locatorKey }),
    [input.api, locatorKey, input.sessionConnected]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the session authority invalidates pending submission publications.
  useLayoutEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [authority]);
  const [workspaceView, setWorkspaceView] = useState<{
    authority: typeof authority;
    projection: WorkspaceCanvasProjection;
  } | null>(null);
  const [snapshotState, setSnapshotState] = useState({ authority, value: IDLE_SNAPSHOT });
  const snapshot = snapshotState.authority === authority ? snapshotState.value : IDLE_SNAPSHOT;
  const setSnapshot = useCallback(
    (update: SetStateAction<WorkspaceCanvasCommandSnapshot>) => {
      setSnapshotState((current) => ({
        authority,
        value:
          typeof update === "function"
            ? update(current.authority === authority ? current.value : IDLE_SNAPSHOT)
            : update
      }));
    },
    [authority]
  );
  const activeWorkspaceProjection =
    workspaceView &&
    workspaceView.authority === authority &&
    input.locator &&
    workspaceLocatorEquals(workspaceView.projection.locator, input.locator)
      ? workspaceView.projection
      : null;

  useEffect(() => {
    if (!input.api || !input.locator) {
      setWorkspaceView(null);
      if (input.locator) {
        setSnapshot({
          ...IDLE_SNAPSHOT,
          connectionPhase: input.sessionConnected ? "idle" : "disconnected"
        });
      }
      return undefined;
    }
    const activeApi = input.api;
    const locator = input.locator;
    const labels = input.labels;
    const openedGeneration = generation.current;
    let active = true;
    const applyProjection = (projection: WorkspaceCanvasProjection) => {
      if (
        !active ||
        generation.current !== openedGeneration ||
        !workspaceLocatorEquals(projection.locator, locator)
      )
        return;
      setWorkspaceView({ authority, projection });
      setSnapshot(snapshotFromWorkspaceProjection(projection, labels, "connected"));
    };
    const unsubscribe =
      activeApi.onWorkspaceCanvasProjectionSignal((signal) => {
        applyProjection(signal.projection);
      }) ?? null;
    setSnapshot({
      ...IDLE_SNAPSHOT,
      connectionPhase: "connecting",
      busy: true
    });
    void activeApi
      .openWorkspaceCanvasSession(locator)
      .then((projection) => {
        applyProjection(projection);
      })
      .catch((error: unknown) => {
        if (!active || generation.current !== openedGeneration) return;
        setWorkspaceView(null);
        setSnapshot({
          ...IDLE_SNAPSHOT,
          lastError: error instanceof Error ? error.message : String(error)
        });
      });
    return () => {
      active = false;
      unsubscribe?.();
      void activeApi.closeWorkspaceCanvasSession?.(locator);
    };
  }, [authority, input.api, input.labels, input.locator, input.sessionConnected, setSnapshot]);

  const submit = useCallback(
    async (submitInput: { intent: CanvasCommandIntent }): Promise<WorkspaceCanvasSubmitResult> => {
      if (!input.api || !input.locator) {
        return { ok: false, error: input.labels.notConnected, staleConflict: null };
      }
      if (snapshot.connectionPhase === "disconnected") {
        return { ok: false, error: null, staleConflict: null };
      }
      if (activeWorkspaceProjection?.readOnly) {
        return { ok: false, error: input.labels.notConnected, staleConflict: null };
      }
      const submittedGeneration = generation.current;
      try {
        const projection = await input.api.submitWorkspaceCanvasCommand({
          locator: input.locator,
          intent: submitInput.intent
        });
        const nextSnapshot = snapshotFromWorkspaceProjection(projection, input.labels, "connected");
        if (generation.current === submittedGeneration) {
          setWorkspaceView({ authority, projection });
          setSnapshot(nextSnapshot);
        }
        if (projection.status === "accepted") {
          return { ok: true, error: null, staleConflict: null };
        }
        return {
          ok: false,
          error: nextSnapshot.lastError,
          staleConflict: nextSnapshot.lastStaleConflict
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (generation.current === submittedGeneration) {
          setSnapshot((current) => ({ ...current, busy: false, lastError: message }));
        }
        return { ok: false, error: message, staleConflict: null };
      }
    },
    [
      input.api,
      input.labels,
      input.locator,
      authority,
      setSnapshot,
      snapshot.connectionPhase,
      activeWorkspaceProjection?.readOnly
    ]
  );

  const reconnect = useCallback(async () => {
    if (!input.api || !input.locator) {
      return false;
    }
    const reconnectedGeneration = generation.current;
    try {
      const projection = await input.api.reconnectWorkspaceCanvasSession(input.locator);
      if (
        generation.current !== reconnectedGeneration ||
        !workspaceLocatorEquals(projection.locator, input.locator)
      )
        return false;
      setWorkspaceView({ authority, projection });
      setSnapshot(snapshotFromWorkspaceProjection(projection, input.labels, "connected"));
      return projection.status !== "rejected";
    } catch {
      return false;
    }
  }, [authority, input.api, input.labels, input.locator, setSnapshot]);

  const replica = activeWorkspaceProjection?.replica ?? null;
  const projection = useMemo(
    () =>
      snapshot.connectionPhase === "disconnected" && replica
        ? { ...replica, canEdit: false, optimisticOperationIds: [] }
        : replica,
    [replica, snapshot.connectionPhase]
  );

  return useMemo(
    () => ({
      snapshot,
      projection,
      projectionStatus: activeWorkspaceProjection?.status ?? null,
      initialRuntimeAvailability: input.sessionConnected
        ? (activeWorkspaceProjection?.initialRuntimeAvailability ?? null)
        : null,
      submit,
      reconnect
    }),
    [
      input.sessionConnected,
      projection,
      reconnect,
      snapshot,
      submit,
      activeWorkspaceProjection?.initialRuntimeAvailability,
      activeWorkspaceProjection?.status
    ]
  );
}
