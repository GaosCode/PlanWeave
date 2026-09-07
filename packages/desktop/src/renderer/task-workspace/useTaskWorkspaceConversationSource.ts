import { useRemoteAcpContinuation } from "./useRemoteAcpContinuation";
import type { RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import type { RemoteOperationState } from "@planweave-ai/collaboration-protocol/remote-run";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { PlanWeaveOperatorControlApi } from "../../shared/operatorControl";
import type { PlanWeaveWorkspaceExecutionApi } from "../../shared/workspaceExecution";
import type { DesktopOwnerCanvasExecutionLocator } from "../../shared/workspaceExecution";
import type { WorkspaceTaskWorkspaceNavigationIdentity } from "../taskWorkspaceNavigation";
import { remoteTaskWorkspaceConversationSource } from "./remoteTaskWorkspaceConversationSource";
import {
  type RemoteTaskWorkspaceConversation,
  useRemoteTaskWorkspaceConversation
} from "./useRemoteTaskWorkspaceConversation";
import { useWorkspaceExecutionTaskWorkspaceConversation } from "./useWorkspaceExecutionTaskWorkspaceConversation";

function projectedRemoteConversationState(
  execution: RemoteBlockExecutionReadModel | null | undefined
): RemoteOperationState | undefined {
  if (!execution) return undefined;
  if (execution.phase === "terminal") {
    return execution.status === "completed"
      ? "completed"
      : execution.status === "stopped"
        ? "cancelled"
        : "failed";
  }
  if (execution.status === "interrupted") return "interrupted";
  if (execution.status === "source_drift") return "action_required";
  return execution.phase === "active" ? "running" : "preparing";
}

export function useTaskWorkspaceConversationSource(input: {
  collaborationApi: Pick<
    PlanWeaveCollaborationApi,
    | "observeCollaborationRemoteOperation"
    | "onCollaborationObserverSignal"
    | "replayCollaborationRemoteOperationEvents"
  > | null;
  execution: RemoteBlockExecutionReadModel | null | undefined;
  onTerminal(): void;
  onTaskRestored(operationId: string): void;
  operatorApi: Pick<
    PlanWeaveOperatorControlApi,
    "observeOwnerFleetRemoteOperation" | "replayOwnerFleetRemoteOperationEvents"
  > | null;
  operatorProfileId: string | null;
  ownerLocator: DesktopOwnerCanvasExecutionLocator | null;
  scopeKey: string;
  selectedBlockRef: string;
  workspaceExecutionApi: PlanWeaveWorkspaceExecutionApi | null;
  workspaceNavigation: WorkspaceTaskWorkspaceNavigationIdentity | null;
}) {
  const workspaceScope = useMemo(() => {
    if (!input.workspaceNavigation || !input.selectedBlockRef) return null;
    return {
      locator: {
        kind: "workspace" as const,
        connectionProfileId: input.workspaceNavigation.connectionProfileId,
        workspaceId: input.workspaceNavigation.workspaceId,
        projectId: input.workspaceNavigation.projectId,
        canvasId: input.workspaceNavigation.canvasId
      },
      blockRef: input.selectedBlockRef
    };
  }, [input.selectedBlockRef, input.workspaceNavigation]);
  const coordinatorScope =
    workspaceScope ??
    (input.ownerLocator ? { locator: input.ownerLocator, blockRef: input.selectedBlockRef } : null);
  const legacyApi = useMemo(
    () =>
      input.execution?.controlPlane && !coordinatorScope
        ? remoteTaskWorkspaceConversationSource({
            controlPlane: input.execution.controlPlane,
            collaborationApi: input.collaborationApi,
            operatorApi: input.operatorApi,
            operatorProfileId: input.operatorProfileId
          })
        : null,
    [
      input.collaborationApi,
      input.execution?.controlPlane,
      input.operatorApi,
      input.operatorProfileId,
      coordinatorScope
    ]
  );
  const [restored, setRestored] = useState<{
    scope: string;
    sourceId: string;
    operationId: string;
    blockRef: string;
    history: NonNullable<RemoteTaskWorkspaceConversation["previousTimelines"]>;
  } | null>(null);
  const sourceOperationId = input.execution?.identity.operationId ?? null;
  const restoration =
    restored?.scope === input.scopeKey &&
    restored.blockRef === input.selectedBlockRef &&
    (restored.sourceId === sourceOperationId || restored.operationId === sourceOperationId)
      ? restored
      : null;
  const operationId = restoration?.operationId ?? sourceOperationId;
  const legacyConversation = useRemoteTaskWorkspaceConversation({
    api: coordinatorScope ? null : legacyApi,
    blockRef: input.selectedBlockRef || null,
    cacheScopeKey: input.scopeKey,
    initialState: projectedRemoteConversationState(input.execution),
    operationId,
    onTerminal: input.onTerminal
  });
  const workspaceConversation = useWorkspaceExecutionTaskWorkspaceConversation({
    api: input.workspaceExecutionApi,
    locator: coordinatorScope?.locator ?? null,
    blockRef: input.selectedBlockRef || null,
    operationId,
    scopeKey: input.scopeKey,
    onTerminal: input.onTerminal
  });
  const continuation = useRemoteAcpContinuation(
    input.workspaceExecutionApi,
    coordinatorScope && operationId ? { ...coordinatorScope, operationId } : null
  );
  const onTerminalRef = useRef(input.onTerminal);
  onTerminalRef.current = input.onTerminal;
  const onTaskRestoredRef = useRef(input.onTaskRestored);
  onTaskRestoredRef.current = input.onTaskRestored;
  const conversation = coordinatorScope ? workspaceConversation : legacyConversation;
  const restoredConversation = useMemo<RemoteTaskWorkspaceConversation | null>(() => {
    if (!restoration) return conversation;
    return {
      blockRef: restoration.blockRef,
      cursor: 0,
      error: null,
      eventProtocolVersion: null,
      executionAttemptId: null,
      operationId: restoration.operationId,
      replayDiagnostics: [],
      state: "preparing",
      terminalOutcome: null,
      telemetry: null,
      timeline: [],
      ...conversation,
      previousTimelines: restoration.history
    };
  }, [conversation, restoration]);
  const visibleConversationRef = useRef(restoredConversation);
  visibleConversationRef.current = restoredConversation;
  const continuationRef = useRef(continuation);
  continuationRef.current = continuation;
  useEffect(() => {
    if (continuation.restoredOperationId && sourceOperationId) {
      setRestored({
        scope: input.scopeKey,
        sourceId: sourceOperationId,
        operationId: continuation.restoredOperationId,
        blockRef: input.selectedBlockRef,
        history: [
          ...(visibleConversationRef.current?.previousTimelines ?? []),
          {
            id: `operation:${sourceOperationId}`,
            timeline: visibleConversationRef.current?.timeline ?? []
          },
          ...continuationRef.current.turns.map((turn) => ({
            id: `turn:${turn.turnId}`,
            timeline: turn.timeline
          }))
        ]
      });
      onTaskRestoredRef.current(continuation.restoredOperationId);
      onTerminalRef.current();
    }
  }, [continuation.restoredOperationId, sourceOperationId, input.scopeKey, input.selectedBlockRef]);
  return restoredConversation && coordinatorScope
    ? {
        ...restoredConversation,
        continuation,
        telemetry: continuation.telemetry ?? restoredConversation.telemetry
      }
    : restoredConversation;
}
