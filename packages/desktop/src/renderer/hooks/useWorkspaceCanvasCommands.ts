import { useMemo } from "react";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { WorkspaceCanvasProjectionStatus } from "../../shared/workspaceCanvasProjection";
import { collaborationBridge } from "../bridge";
import type {
  WorkspaceCanvasCommandLabels,
  WorkspaceCanvasCommandSnapshot
} from "../collaboration/workspaceCanvasCommandView";
import type { createTranslator } from "../i18n";
import { useWorkspaceCanvasSession } from "./useWorkspaceCanvasSession";

export type WorkspaceCanvasCommandBridge = Pick<
  PlanWeaveCollaborationApi,
  | "openWorkspaceCanvasSession"
  | "submitWorkspaceCanvasCommand"
  | "reconnectWorkspaceCanvasSession"
  | "closeWorkspaceCanvasSession"
  | "onWorkspaceCanvasProjectionSignal"
>;

export type WorkspaceCanvasSubmitResult = {
  ok: boolean;
  error: string | null;
  staleConflict: WorkspaceCanvasCommandSnapshot["lastStaleConflict"];
};

export type WorkspaceCanvasCommandsResult = {
  /** Workspace authority always routes durable mutations through the Server command session. */
  enabled: boolean;
  snapshot: WorkspaceCanvasCommandSnapshot;
  projection: CollaborationCanvasBindingReplicaProjection | null;
  projectionStatus: WorkspaceCanvasProjectionStatus | null;
  offline: boolean;
  submit: (input: { intent: CanvasCommandIntent }) => Promise<WorkspaceCanvasSubmitResult>;
  reconnect: () => Promise<boolean>;
};

/** Workspace-only durable command gateway. Local Canvas never enters this hook's command path. */
export function useWorkspaceCanvasCommands(input: {
  locator: WorkspaceCanvasLocator | null;
  sessionConnected: boolean;
  t: ReturnType<typeof createTranslator>;
  api?: WorkspaceCanvasCommandBridge | null;
}): WorkspaceCanvasCommandsResult {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const labels = useMemo<WorkspaceCanvasCommandLabels>(
    () => ({
      staleRevision: (expected, authoritative) =>
        input
          .t("canvasCommandStaleRevision")
          .replace("{expected}", String(expected))
          .replace("{authoritative}", String(authoritative)),
      rejected: (code) => input.t("canvasCommandRejected").replace("{code}", code),
      reconnectFailed: (code) => input.t("canvasCommandReconnectFailed").replace("{code}", code),
      notConnected: input.t("canvasCommandNotConnected")
    }),
    [input.t]
  );
  const session = useWorkspaceCanvasSession({
    api,
    labels,
    locator: input.locator,
    sessionConnected: input.sessionConnected
  });

  return useMemo(
    () => ({
      enabled: input.locator !== null,
      snapshot: session.snapshot,
      projection: session.projection,
      projectionStatus: session.projectionStatus,
      offline:
        input.locator !== null &&
        (!input.sessionConnected || session.snapshot.connectionPhase === "disconnected"),
      submit: session.submit,
      reconnect: session.reconnect
    }),
    [input.locator, input.sessionConnected, session]
  );
}
