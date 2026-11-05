import { useCallback, useEffect, useRef, useState } from "react";
import {
  acpConversationActionSchema,
  type AcpConversationAction
} from "@planweave-ai/agent-host-protocol/browser";
import type {
  DesktopRemoteAcpConversationInput,
  DesktopRemoteAcpConversationPage
} from "../../shared/remoteAcpConversation";
import type { PlanWeaveWorkspaceExecutionApi } from "../../shared/workspaceExecution";
import {
  RemoteAcpContinuationStore,
  type RemoteAcpContinuationProjection
} from "./remoteAcpContinuationStore";

const emptyProjection: RemoteAcpContinuationProjection = {
  turns: [],
  interactions: [],
  telemetry: null
};

function confirmsPrompt(
  page: DesktopRemoteAcpConversationPage | null,
  prompt: Pick<
    Extract<AcpConversationAction, { kind: "prompt" }>,
    "turnId" | "executionAttemptId" | "sessionId"
  >
) {
  return (
    page?.executionAttemptId === prompt.executionAttemptId &&
    page.sessionId === prompt.sessionId &&
    page.turns.some(
      (turn) =>
        turn.turnId === prompt.turnId &&
        turn.executionAttemptId === prompt.executionAttemptId &&
        turn.sessionId === prompt.sessionId
    )
  );
}

export function useRemoteAcpContinuation(
  api: Pick<PlanWeaveWorkspaceExecutionApi, "remoteAcpConversation"> | null,
  input: Omit<DesktopRemoteAcpConversationInput, "action" | "afterCursor" | "afterTurnId"> | null
) {
  const key = input ? JSON.stringify(input) : null;
  const inputRef = useRef(input);
  inputRef.current = input;
  const epoch = useRef(0);
  const sendingRef = useRef(false);
  const actionRevision = useRef(0);
  const pageRef = useRef<DesktopRemoteAcpConversationPage | null>(null);
  const store = useRef<RemoteAcpContinuationStore | null>(null);
  const cursor = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const pendingPrompt = useRef<Extract<AcpConversationAction, { kind: "prompt" }> | null>(null);
  const [state, setState] = useState<{
    key: string;
    page: DesktopRemoteAcpConversationPage;
    projection: RemoteAcpContinuationProjection;
  } | null>(null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [draftError, setDraftError] = useState<{
    key: string;
    message: "acpPromptTooLong" | "acpPromptInvalid";
  } | null>(null);
  const [actionError, setActionError] = useState<{
    action: NonNullable<DesktopRemoteAcpConversationInput["action"]>;
    message: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [localMessages, setLocalMessages] = useState<
    {
      key: string;
      turnId: string;
      executionAttemptId: string;
      sessionId: string;
      text: string;
      timestamp: string;
    }[]
  >([]);
  const acceptPage = useCallback((page: DesktopRemoteAcpConversationPage, scopeKey: string) => {
    const current = store.current;
    if (!current) return;
    const previous = current.snapshot;
    const compactedCount = current.compactedTurns.size;
    const snapshot = current.accept(page);
    if (current.compactedTurns.size !== compactedCount)
      setLocalMessages((messages) => {
        const remaining = messages.filter((message) => !current.compactedTurns.has(message.turnId));
        return remaining.length === messages.length ? messages : remaining;
      });
    cursor.current = Math.max(cursor.current, page.cursor);
    pageRef.current = snapshot.page;
    const prompt = pendingPrompt.current;
    if (prompt && confirmsPrompt(snapshot.page, prompt)) {
      pendingPrompt.current = null;
      setActionError((current) => (current?.action === prompt ? null : current));
    }
    if (snapshot !== previous)
      setState({ key: scopeKey, page: snapshot.page, projection: snapshot.projection });
    setError(null);
  }, []);
  useEffect(() => {
    const scope = inputRef.current;
    const generation = ++epoch.current;
    store.current = new RemoteAcpContinuationStore();
    cursor.current = 0;
    pendingPrompt.current = null;
    setLocalMessages([]);
    sendingRef.current = false;
    pageRef.current = null;
    setRestoreFailed(false);
    setDraftError(null);
    setActionError(null);
    setState(null);
    setError(null);
    setSending(false);
    if (!scope || !key || !api?.remoteAcpConversation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | null = null;
    const refresh = () => {
      if (running) return running;
      running = (async () => {
        clearTimeout(timer);
        const revision = actionRevision.current;
        try {
          let page: DesktopRemoteAcpConversationPage;
          let afterTurnId: string | null = null;
          do {
            page = await api.remoteAcpConversation({
              ...scope,
              afterCursor: cursor.current,
              afterTurnId
            });
            if (epoch.current !== generation || revision !== actionRevision.current) return;
            if (page.hasMoreTurns && page.turnCursor === afterTurnId)
              throw new Error("acp_conversation_turn_cursor_stalled");
            if (page.hasMore && page.cursor <= cursor.current && page.turnCursor === afterTurnId)
              throw new Error("acp_conversation_cursor_stalled");
            afterTurnId = page.turnCursor;
            acceptPage(page, key);
          } while (page.hasMore);
        } catch (cause) {
          if (epoch.current === generation && revision === actionRevision.current)
            setError(cause instanceof Error ? cause.message : "acp_conversation_request_failed");
        } finally {
          running = null;
          if (epoch.current === generation) timer = setTimeout(() => void refresh(), 1500);
        }
      })();
      return running;
    };
    refreshRef.current = refresh;
    void refresh();
    return () => {
      ++epoch.current;
      clearTimeout(timer);
      store.current = null;
    };
  }, [api, key, acceptPage]);
  const page = state?.key === key ? state.page : null;
  const active =
    page?.turns.find((turn) => turn.status === "queued" || turn.status === "running") ?? null;
  const act = async (
    action: NonNullable<DesktopRemoteAcpConversationInput["action"]>
  ): Promise<boolean> => {
    if (!api || !inputRef.current || !key || sendingRef.current) return false;
    const generation = epoch.current;
    sendingRef.current = true;
    ++actionRevision.current;
    setDraftError(null);
    setRestoreFailed(false);
    setActionError(null);
    setSending(true);
    try {
      const response = await api.remoteAcpConversation({ ...inputRef.current, action });
      if (epoch.current !== generation) return false;
      ++actionRevision.current;
      acceptPage(response, key);
      if (response.hasMore) await refreshRef.current();
      return epoch.current === generation;
    } catch (cause) {
      if (epoch.current === generation && action.kind === "prompt") {
        await refreshRef.current();
        if (epoch.current === generation && confirmsPrompt(pageRef.current, action)) return true;
      }
      if (epoch.current === generation) {
        setRestoreFailed(action.kind === "restore_task");
        setActionError({
          action,
          message: cause instanceof Error ? cause.message : "acp_conversation_request_failed"
        });
      }
      return false;
    } finally {
      if (epoch.current === generation) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  };
  const projection = state?.key === key ? state.projection : emptyProjection;
  const isAwaitingReplay = useCallback(
    (message: (typeof localMessages)[number]) =>
      message.key === key &&
      !store.current?.compactedTurns.has(message.turnId) &&
      !projection.turns.some(
        (turn) =>
          turn.turnId === message.turnId &&
          turn.executionAttemptId === message.executionAttemptId &&
          turn.sessionId === message.sessionId &&
          turn.timeline.some((item) => item.kind === "message" && item.role === "user")
      ),
    [key, projection.turns]
  );
  useEffect(() => {
    setLocalMessages((messages) => {
      const remaining = messages.filter(isAwaitingReplay);
      return remaining.length === messages.length ? messages : remaining;
    });
  }, [isAwaitingReplay]);
  return {
    available: page?.available ?? false,
    canRestoreTask: page?.canRestoreTask ?? false,
    restoredOperationId: page?.restoredOperationId ?? null,
    restoreTask: () =>
      page?.canRestoreTask && page.sessionId && !active
        ? act({
            kind: "restore_task",
            turnId: crypto.randomUUID(),
            executionAttemptId: page.executionAttemptId,
            sessionId: page.sessionId
          })
        : Promise.resolve(false),
    reason: page?.reason ?? null,
    error: actionError?.message ?? error,
    draftError: draftError?.key === key ? draftError.message : null,
    restoreFailed,
    sending,
    pendingMessages: localMessages.filter(isAwaitingReplay).map((message) => ({
      ...message,
      status: confirmsPrompt(page, message)
        ? ("accepted" as const)
        : sending && pendingPrompt.current?.turnId === message.turnId
          ? ("sending" as const)
          : ("unconfirmed" as const)
    })),
    active,
    ...projection,
    execution: page?.execution ?? null,
    cancelExecution: () =>
      page?.execution.cancel
        ? act({ kind: "execution_cancel", command: page.execution.cancel })
        : Promise.resolve(false),
    respondExecution: (
      response: import("@planweave-ai/collaboration-protocol/remote-run").RemoteInteractionResponse
    ) => act({ kind: "execution_respond", response }),
    send: async (text: string) => {
      if (!page?.available || !page.sessionId || !key || active || sendingRef.current) return false;
      if (pendingPrompt.current && pendingPrompt.current.text !== text.trim()) {
        setActionError({
          action: pendingPrompt.current,
          message: "acp_conversation_retry_original_message"
        });
        return false;
      }
      let action = pendingPrompt.current;
      if (!action) {
        const parsed = acpConversationActionSchema.safeParse({
          kind: "prompt",
          turnId: crypto.randomUUID(),
          executionAttemptId: page.executionAttemptId,
          sessionId: page.sessionId,
          text
        });
        if (!parsed.success || parsed.data.kind !== "prompt") {
          setDraftError({
            key,
            message:
              !parsed.success &&
              parsed.error.issues.some(
                (issue) => issue.code === "too_big" && issue.path[0] === "text"
              )
                ? "acpPromptTooLong"
                : "acpPromptInvalid"
          });
          return false;
        }
        action = parsed.data;
      }
      pendingPrompt.current = action;
      setLocalMessages((messages) =>
        messages.some(
          (message) =>
            message.turnId === action.turnId &&
            message.executionAttemptId === action.executionAttemptId &&
            message.sessionId === action.sessionId
        )
          ? messages
          : [
              ...messages,
              {
                key,
                turnId: action.turnId,
                executionAttemptId: action.executionAttemptId,
                sessionId: action.sessionId,
                text: action.text,
                timestamp: new Date().toISOString()
              }
            ]
      );
      return act(action);
    },
    cancel: async () =>
      active
        ? act({
            kind: "cancel",
            turnId: active.turnId,
            executionAttemptId: active.executionAttemptId,
            sessionId: active.sessionId
          })
        : false,
    respond: async (
      turnId: string,
      requestId: string,
      decision: Extract<AcpConversationAction, { kind: "respond" }>["decision"]
    ) => {
      const turn = page?.turns.find((item) => item.turnId === turnId);
      return turn
        ? act({
            kind: "respond",
            turnId,
            requestId,
            decision,
            executionAttemptId: turn.executionAttemptId,
            sessionId: turn.sessionId
          })
        : false;
    }
  };
}
export type RemoteAcpContinuation = ReturnType<typeof useRemoteAcpContinuation>;
