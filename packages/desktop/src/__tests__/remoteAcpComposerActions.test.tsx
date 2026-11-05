/* @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { RemoteAcpComposer } from "../renderer/task-workspace/conversation/RemoteAcpComposer";
import { useRemoteAcpContinuation } from "../renderer/task-workspace/useRemoteAcpContinuation";
import {
  desktopRemoteAcpConversationPageSchema,
  type DesktopRemoteAcpConversationInput,
  type DesktopRemoteAcpConversationPage
} from "../shared/remoteAcpConversation";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const scope = {
  locator: {
    kind: "workspace" as const,
    connectionProfileId: "composer-profile",
    workspaceId: "composer-workspace",
    projectId: "composer-project",
    canvasId: "composer-canvas"
  },
  operationId: "original-operation",
  blockRef: "T-2#B-4"
};
const cancelCommand = {
  kind: "cancel" as const,
  actionId: "original-cancel-action",
  operationId: scope.operationId,
  dispatchId: "original-dispatch",
  leaseId: "original-lease",
  executionAttemptId: "original-attempt",
  expectedAttemptVersion: 7,
  reason: "User cancellation"
};
const activeTurn = {
  turnId: "follow-up-turn",
  turnOrder: 1,
  executionAttemptId: "follow-up-attempt",
  sessionId: "follow-up-session",
  status: "running" as const,
  createdAt: "2030-01-01T00:00:00.000Z",
  error: null
};
const locales = [
  { locale: "en", execution: "Cancel run", turn: "Stop response", send: "Send message" },
  { locale: "zh-CN", execution: "取消运行", turn: "停止回复", send: "发送消息" }
] as const;

function setup(
  mode: "execution" | "turn" | "both" | "send",
  available = mode === "send" || mode === "turn"
) {
  const page = desktopRemoteAcpConversationPageSchema.parse({
    execution: {
      state: mode === "execution" || mode === "both" ? "running" : "completed",
      cancel: mode === "execution" || mode === "both" ? cancelCommand : null,
      interactions: []
    },
    available,
    canRestoreTask: false,
    restoredOperationId: null,
    reason: available ? null : "acp_conversation_execution_not_completed",
    executionAttemptId: "original-attempt",
    sessionId: "original-session",
    turns: mode === "turn" || mode === "both" ? [activeTurn] : [],
    events: [],
    cursor: 0,
    hasMore: false
  });
  let resolveAction: ((response: DesktopRemoteAcpConversationPage) => void) | undefined;
  const response = new Promise<DesktopRemoteAcpConversationPage>((resolve) => {
    resolveAction = resolve;
  });
  const remoteAcpConversation = vi.fn(async (input: DesktopRemoteAcpConversationInput) =>
    input.action ? response : page
  );
  const api = { remoteAcpConversation };
  function Composer({ locale }: { locale: (typeof locales)[number]["locale"] }) {
    const continuation = useRemoteAcpContinuation(api, scope);
    return <RemoteAcpComposer continuation={continuation} t={createTranslator(locale)} />;
  }
  return {
    Composer,
    actionCalls: () =>
      remoteAcpConversation.mock.calls.flatMap(([input]) => (input.action ? [input] : [])),
    finish: async () => {
      await act(async () => resolveAction?.(page));
    }
  };
}

describe.each(locales)("remote ACP composer action labels ($locale)", (labels) => {
  it.each(
    (["execution", "turn", "both"] as const).flatMap((mode) =>
      (["click", "Enter", "Space"] as const).map((activation) => ({ mode, activation }))
    )
  )("routes $mode via $activation and disables duplicate pending actions", async ({
    mode,
    activation
  }) => {
    const f = setup(mode);
    const user = userEvent.setup();
    render(<f.Composer locale={labels.locale} />);
    const label = mode === "turn" ? labels.turn : labels.execution;
    const button = await screen.findByRole("button", { name: label, exact: true });
    expect(button.getAttribute("title")).toBe(label);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
    if (activation === "click") {
      await user.click(button);
    } else {
      await user.tab();
      expect(document.activeElement).toBe(button);
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    const action =
      mode === "turn"
        ? {
            kind: "cancel",
            turnId: activeTurn.turnId,
            executionAttemptId: activeTurn.executionAttemptId,
            sessionId: activeTurn.sessionId
          }
        : { kind: "execution_cancel", command: cancelCommand };
    expect(f.actionCalls()).toEqual([{ ...scope, action }]);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe(label);
    fireEvent.click(button);
    await user.keyboard("{Enter} ");
    expect(f.actionCalls()).toHaveLength(1);
    await f.finish();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });

  it("falls back to sending with the original operation and session when neither cancellation is available", async () => {
    const f = setup("send");
    const user = userEvent.setup();
    render(<f.Composer locale={labels.locale} />);
    const input = screen.getByRole("textbox");
    const button = screen.getByRole("button", { name: labels.send, exact: true });
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
    expect(button.getAttribute("title")).toBe(labels.send);
    expect(button.hasAttribute("disabled")).toBe(true);
    await user.type(input, "Continue the original session");
    expect(button.hasAttribute("disabled")).toBe(false);
    await user.click(button);
    expect(f.actionCalls()).toEqual([
      {
        ...scope,
        action: {
          kind: "prompt",
          turnId: expect.any(String),
          executionAttemptId: "original-attempt",
          sessionId: "original-session",
          text: "Continue the original session"
        }
      }
    ]);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(input.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(f.actionCalls()).toHaveLength(1);
    await f.finish();
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the send fallback disabled while the remote conversation is unavailable", async () => {
    const f = setup("send", false);
    render(<f.Composer locale={labels.locale} />);
    await screen.findByText("acp_conversation_execution_not_completed", { selector: "span" });
    const button = screen.getByRole("button", { name: labels.send, exact: true });
    expect(button.getAttribute("title")).toBe(labels.send);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(f.actionCalls()).toHaveLength(0);
  });
});
