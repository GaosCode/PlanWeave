import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AcpConversationAction,
  AcpConversationEvent
} from "@planweave-ai/agent-host-protocol/browser";
import { projectRemoteAcpReplay, projectRemoteAcpTelemetry } from "@planweave-ai/runtime/browser";
import type {
  DesktopRemoteAcpConversationInput,
  DesktopRemoteAcpConversationPage
} from "../../shared/remoteAcpConversation";
import type { PlanWeaveWorkspaceExecutionApi } from "../../shared/workspaceExecution";

export function useRemoteAcpContinuation(
  api: Pick<PlanWeaveWorkspaceExecutionApi, "remoteAcpConversation"> | null,
  input: Omit<DesktopRemoteAcpConversationInput, "action" | "afterCursor"> | null
) {
  const key = input ? JSON.stringify(input) : null;
  const inputRef = useRef(input);
  inputRef.current = input;
  const epoch = useRef(0);
  const sendingRef = useRef(false);
  const pageRef = useRef<DesktopRemoteAcpConversationPage | null>(null);
  const events = useRef(new Map<string, AcpConversationEvent>());
  const cursor = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const pendingPrompt = useRef<Extract<AcpConversationAction, { kind: "prompt" }> | null>(null);
  const [state, setState] = useState<{
    key: string;
    page: DesktopRemoteAcpConversationPage;
    events: AcpConversationEvent[];
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const scope = inputRef.current;
    const generation = ++epoch.current;
    events.current = new Map();
    cursor.current = 0;
    pendingPrompt.current = null;
    sendingRef.current = false;
    pageRef.current = null;
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
        try {
          let page: DesktopRemoteAcpConversationPage;
          do {
            page = await api.remoteAcpConversation({ ...scope, afterCursor: cursor.current });
            if (epoch.current !== generation) return;
            for (const event of page.events)
              events.current.set(`${event.turnId}:${event.sequence}`, event);
            if (page.hasMore && page.cursor <= cursor.current)
              throw new Error("acp_conversation_cursor_stalled");
            cursor.current = page.cursor;
          } while (page.hasMore);
          pageRef.current = page;
          setState({ key, page, events: [...events.current.values()] });
          setError(null);
        } catch (cause) {
          if (epoch.current === generation)
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
    };
  }, [api, key]);
  const page = state?.key === key ? state.page : null;
  const active =
    page?.turns.find((turn) => turn.status === "queued" || turn.status === "running") ?? null;
  const act = async (
    action: NonNullable<DesktopRemoteAcpConversationInput["action"]>
  ): Promise<boolean> => {
    if (!api || !inputRef.current || sendingRef.current) return false;
    const generation = epoch.current;
    sendingRef.current = true;
    setActionError(null);
    setSending(true);
    try {
      await api.remoteAcpConversation({ ...inputRef.current, action });
      if (epoch.current !== generation) return false;
      await refreshRef.current();
      return epoch.current === generation;
    } catch (cause) {
      if (epoch.current === generation && action.kind === "prompt") {
        await refreshRef.current();
        if (
          epoch.current === generation &&
          pageRef.current?.turns.some((turn) => turn.turnId === action.turnId)
        )
          return true;
      }
      if (epoch.current === generation)
        setActionError(cause instanceof Error ? cause.message : "acp_conversation_request_failed");
      return false;
    } finally {
      if (epoch.current === generation) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  };
  const projection = useMemo(() => {
    if (!state || state.key !== key) return { turns: [], telemetry: null, interactions: [] };
    const pending = new Map<
      string,
      {
        turnId: string;
        request: Extract<AcpConversationEvent["payload"], { kind: "interaction" }>["request"];
      }
    >();
    const turns = state.page.turns.map((turn) => {
      const turnEvents = state.events.filter((event) => event.turnId === turn.turnId);
      for (const event of turnEvents) {
        const payload = event.payload;
        if (payload.kind === "interaction")
          pending.set(`${turn.turnId}:${payload.request.requestId}`, {
            turnId: turn.turnId,
            request: payload.request
          });
        if (payload.kind === "interaction_settled")
          pending.delete(`${turn.turnId}:${payload.requestId}`);
      }
      const projected = projectRemoteAcpReplay({
        executionAttemptId: turn.executionAttemptId,
        eventProtocolVersion: 2,
        events: turnEvents.flatMap((event) =>
          event.payload.kind === "runner"
            ? [
                {
                  eventVersion: 2 as const,
                  cursor: event.sequence,
                  sourceSequence: event.sequence,
                  timestamp: event.timestamp,
                  fragment: event.payload.fragment
                }
              ]
            : []
        )
      });
      return { ...turn, timeline: projected.timeline, projected: projected.events };
    });
    const all = turns
      .flatMap((turn) => turn.projected)
      .map((event, index) => ({ ...event, cursor: index + 1 }));
    return {
      turns,
      telemetry: all.length ? projectRemoteAcpTelemetry(all) : null,
      interactions: [...pending.values()].filter((item) =>
        state.page.turns.some(
          (turn) =>
            turn.turnId === item.turnId && (turn.status === "queued" || turn.status === "running")
        )
      )
    };
  }, [state, key]);
  return {
    available: page?.available ?? false,
    reason: page?.reason ?? null,
    error: actionError ?? error,
    sending,
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
      if (!page?.available || !page.sessionId || active) return false;
      if (pendingPrompt.current && pendingPrompt.current.text !== text) {
        setActionError("acp_conversation_retry_original_message");
        return false;
      }
      const action = pendingPrompt.current ?? {
        kind: "prompt",
        turnId: crypto.randomUUID(),
        executionAttemptId: page.executionAttemptId,
        sessionId: page.sessionId,
        text
      };
      pendingPrompt.current = action;
      const sent = await act(action);
      if (sent && pendingPrompt.current === action) pendingPrompt.current = null;
      return sent;
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
