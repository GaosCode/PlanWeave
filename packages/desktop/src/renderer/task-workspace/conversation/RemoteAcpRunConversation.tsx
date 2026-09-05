import { useLayoutEffect, useRef } from "react";
import type { createTranslator } from "../../i18n";
import { AcpConversationItems } from "../../inspector/AcpConversationTimeline";
import type { TaskWorkspaceConversationSlotProps } from "../contracts";

export function RemoteAcpRunConversation({
  conversation,
  t
}: {
  conversation: NonNullable<TaskWorkspaceConversationSlotProps["remoteConversation"]>;
  t: ReturnType<typeof createTranslator>;
}) {
  const viewportRef = useRef<HTMLElement>(null);
  const followRef = useRef(true);
  const previousPrompt = useRef<string | undefined>(undefined);
  const pendingId = conversation.continuation?.pendingMessage?.turnId;
  useLayoutEffect(() => {
    void conversation.operationId;
    followRef.current = true;
  }, [conversation.operationId]);
  useLayoutEffect(() => {
    void conversation.timeline;
    void conversation.continuation?.turns;
    if (pendingId && pendingId !== previousPrompt.current) followRef.current = true;
    previousPrompt.current = pendingId;
    if (followRef.current && viewportRef.current)
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [conversation.timeline, conversation.continuation?.turns, pendingId]);
  const latestTurn = conversation.continuation?.active ?? conversation.continuation?.turns.at(-1);
  const state = latestTurn?.status ?? conversation.state;
  const statusKeys = {
    loading: "remoteAcpConversationLoading",
    preparing: "remoteRunPhasePreparing",
    claimed: "remoteRunPhasePreparing",
    reserved: "remoteRunPhasePreparing",
    activated: "remoteRunPhasePreparing",
    interrupted: "remoteRunPhaseInterrupted",
    action_required: "remoteRunPhaseActionRequired",
    awaiting_writeback: "remoteAcpConversationFinalizing",
    queued: "remoteAcpTurnQueued",
    running: "taskWorkspaceRunning",
    completed: "taskWorkspaceCompleted",
    cancelled: "remoteAcpConversationStopped",
    failed: "taskWorkspaceFailed"
  } as const;
  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-operation-id={conversation.operationId}
      data-testid="task-workspace-remote-acp-conversation"
    >
      <div className="shrink-0 space-y-3 px-5 pt-5">
        <p
          role="status"
          className={
            conversation.error || state === "failed"
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {t(statusKeys[state])}
        </p>
        {conversation.error ? (
          <p
            className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
            role="alert"
            data-testid="task-workspace-remote-acp-error"
          >
            {conversation.error}
          </p>
        ) : null}
        {conversation.timeline.length === 0 && !conversation.error ? (
          <p className="text-sm text-muted-foreground">{t("taskWorkspaceRemoteAcpEmpty")}</p>
        ) : null}
      </div>
      <section
        className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-[calc(var(--task-workspace-composer-height,0px)+1.25rem)] [scrollbar-gutter:stable_both-edges]"
        ref={viewportRef}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          followRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
        }}
        data-testid="task-workspace-conversation-viewport"
      >
        <div
          className="mx-auto w-full max-w-3xl space-y-4"
          data-testid="task-workspace-conversation-content"
        >
          <AcpConversationItems presentation="workspace" timeline={conversation.timeline} t={t} />
          {conversation.continuation?.turns.map((turn) => (
            <section key={turn.turnId} data-turn-id={turn.turnId}>
              {conversation.continuation?.pendingMessage?.turnId === turn.turnId ? (
                <PendingMessage message={conversation.continuation.pendingMessage} t={t} />
              ) : null}
              <AcpConversationItems presentation="workspace" timeline={turn.timeline} t={t} />
              {turn.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {turn.error}
                </p>
              ) : null}
            </section>
          ))}
          {conversation.continuation?.pendingMessage &&
          !conversation.continuation.turns.some(
            (turn) => turn.turnId === conversation.continuation?.pendingMessage?.turnId
          ) ? (
            <PendingMessage message={conversation.continuation.pendingMessage} t={t} />
          ) : null}
        </div>
      </section>
    </section>
  );
}

function PendingMessage({
  message,
  t
}: {
  message: NonNullable<
    NonNullable<TaskWorkspaceConversationSlotProps["remoteConversation"]>["continuation"]
  >["pendingMessage"];
  t: ReturnType<typeof createTranslator>;
}) {
  if (!message) return null;
  return (
    <div data-testid="remote-acp-pending-message">
      <AcpConversationItems
        presentation="workspace"
        timeline={[
          {
            kind: "message",
            role: "user",
            sequence: 0,
            timestamp: message.timestamp,
            content: message.text
          }
        ]}
        t={t}
      />
      <p className="mt-1 text-right text-xs text-muted-foreground" role="status">
        {t(
          message.status === "sending"
            ? "remoteAcpMessageSending"
            : message.status === "accepted"
              ? "remoteAcpMessageAccepted"
              : "remoteAcpMessageUnconfirmed"
        )}
      </p>
    </div>
  );
}
