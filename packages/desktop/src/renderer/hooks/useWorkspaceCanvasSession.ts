import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CanvasCommandLabels } from "../collaboration/CanvasCommandController";
import type { CanvasCommandControllerSnapshot } from "../collaboration/CanvasCommandController";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import type {
  WorkspaceCanvasProjection,
  WorkspaceCanvasProjectionStatus
} from "../../shared/workspaceCanvasProjection";
import type {
  SharedCanvasCommandBridge,
  SharedCanvasSubmitResult
} from "./useSharedCanvasCommands";

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
  labels: CanvasCommandLabels,
  connectionPhase: CanvasCommandControllerSnapshot["connectionPhase"]
): CanvasCommandControllerSnapshot {
  const conflict = projection.status === "conflicted" ? projection.conflict : null;
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
    connectionPhase,
    lastError,
    lastStaleConflict: conflict,
    busy: projection.status === "pending"
  };
}

export type WorkspaceCanvasSessionView = {
  snapshot: CanvasCommandControllerSnapshot;
  projection: CollaborationCanvasBindingReplicaProjection | null;
  projectionStatus: WorkspaceCanvasProjectionStatus | null;
  submit: (input: { intent: CanvasCommandIntent }) => Promise<SharedCanvasSubmitResult>;
  reconnect: () => Promise<boolean>;
};

const IDLE_SNAPSHOT: CanvasCommandControllerSnapshot = {
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
  api: SharedCanvasCommandBridge | null;
  labels: CanvasCommandLabels;
  locator: WorkspaceCanvasLocator | null;
  requested: WorkspaceCanvasLocator | null;
  sessionEnabled: boolean;
  sessionConnected: boolean;
}): WorkspaceCanvasSessionView {
  const [workspaceView, setWorkspaceView] = useState<{
    projection: WorkspaceCanvasProjection;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<CanvasCommandControllerSnapshot>(IDLE_SNAPSHOT);

  useEffect(() => {
    if (!input.api || !input.locator || !input.sessionEnabled) {
      setWorkspaceView(null);
      if (!input.sessionEnabled && input.requested) {
        setSnapshot({
          ...IDLE_SNAPSHOT,
          connectionPhase: input.sessionConnected ? "idle" : "disconnected"
        });
      }
      if (input.api && input.requested && !input.sessionEnabled) {
        void input.api.closeWorkspaceCanvasSession?.(input.requested);
      }
      return undefined;
    }
    const activeApi = input.api;
    const locator = input.locator;
    const labels = input.labels;
    let active = true;
    const applyProjection = (projection: WorkspaceCanvasProjection) => {
      if (!active || !workspaceLocatorEquals(projection.locator, locator)) return;
      setWorkspaceView({ projection });
      setSnapshot(snapshotFromWorkspaceProjection(projection, labels, "connected"));
    };
    const unsubscribe =
      activeApi.onWorkspaceCanvasProjectionSignal?.((signal) => {
        applyProjection(signal.projection);
      }) ?? null;
    setSnapshot({
      ...IDLE_SNAPSHOT,
      connectionPhase: "connecting",
      busy: true
    });
    void activeApi
      .openWorkspaceCanvasSession?.(locator)
      .then((projection) => {
        applyProjection(projection);
      })
      .catch((error: unknown) => {
        if (!active) return;
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
  }, [
    input.api,
    input.labels,
    input.locator,
    input.requested,
    input.sessionConnected,
    input.sessionEnabled
  ]);

  const submit = useCallback(
    async (submitInput: { intent: CanvasCommandIntent }): Promise<SharedCanvasSubmitResult> => {
      if (!input.api?.submitWorkspaceCanvasCommand || !input.locator || !input.sessionEnabled) {
        return { ok: false, error: input.labels.notConnected, staleConflict: null };
      }
      if (snapshot.connectionPhase === "disconnected") {
        return { ok: false, error: null, staleConflict: null };
      }
      try {
        const projection = await input.api.submitWorkspaceCanvasCommand({
          locator: input.locator,
          intent: submitInput.intent
        });
        setWorkspaceView({ projection });
        const nextSnapshot = snapshotFromWorkspaceProjection(projection, input.labels, "connected");
        setSnapshot(nextSnapshot);
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
        setSnapshot((current) => ({ ...current, busy: false, lastError: message }));
        return { ok: false, error: message, staleConflict: null };
      }
    },
    [input.api, input.labels, input.locator, input.sessionEnabled, snapshot.connectionPhase]
  );

  const reconnect = useCallback(async () => {
    if (!input.api?.reconnectWorkspaceCanvasSession || !input.locator || !input.sessionEnabled) {
      return false;
    }
    try {
      const projection = await input.api.reconnectWorkspaceCanvasSession(input.locator);
      setWorkspaceView({ projection });
      setSnapshot(snapshotFromWorkspaceProjection(projection, input.labels, "connected"));
      return projection.status !== "rejected";
    } catch {
      return false;
    }
  }, [input.api, input.labels, input.locator, input.sessionEnabled]);

  const replica = workspaceView?.projection.replica ?? null;
  const projection =
    snapshot.connectionPhase === "disconnected" && replica
      ? { ...replica, canEdit: false, optimisticOperationIds: [] }
      : replica;

  return useMemo(
    () => ({
      snapshot,
      projection,
      projectionStatus: workspaceView?.projection.status ?? null,
      submit,
      reconnect
    }),
    [projection, reconnect, snapshot, submit, workspaceView?.projection.status]
  );
}
