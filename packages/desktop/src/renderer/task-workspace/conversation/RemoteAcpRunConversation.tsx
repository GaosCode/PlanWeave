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
  const state = conversation.continuation?.active?.status ?? conversation.state;
  const terminal = state === "failed" || state === "cancelled" || state === "completed";
  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-operation-id={conversation.operationId}
      data-testid="task-workspace-remote-acp-conversation"
    >
      <div className="shrink-0 space-y-3 px-5 pt-5">
        <div
          className={
            conversation.error || state === "failed"
              ? "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              : "rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
          }
        >
          {terminal
            ? `${t("taskWorkspaceRemoteAcpTerminal")} · ${state}`
            : `${t("taskWorkspaceRemoteAcpLive")} · ${state}`}
          <div className="mt-1 font-mono text-[11px] opacity-80">
            operationId: {conversation.operationId}
          </div>
        </div>
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
        className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-5"
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
