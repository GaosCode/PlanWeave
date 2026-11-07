import { createWorkspaceExecutionRendererApi } from "../renderer/workspaceExecutionBridge";
/* @vitest-environment jsdom */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceExecutionPreloadApi } from "../preload/workspaceExecutionPreloadBridge";
import { createTranslator } from "../renderer/i18n";
import { RemoteAcpComposer } from "../renderer/task-workspace/conversation/RemoteAcpComposer";
import { useRemoteAcpContinuation } from "../renderer/task-workspace/useRemoteAcpContinuation";
import {
  desktopRemoteAcpConversationInputSchema,
  desktopRemoteAcpConversationPageSchema,
  type DesktopRemoteAcpConversationInput,
  type DesktopRemoteAcpConversationPage
} from "../shared/remoteAcpConversation";
import { workspaceExecutionInvokeChannels } from "../shared/workspaceExecutionIpc";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const scope = {
  locator: {
    kind: "workspace" as const,
    connectionProfileId: "validation-profile",
    workspaceId: "validation-workspace",
    projectId: "validation-project",
    canvasId: "validation-canvas"
  },
  operationId: "validation-operation",
  blockRef: "T-1#B-1"
};

function emptyPage(operationId: string): DesktopRemoteAcpConversationPage {
  return desktopRemoteAcpConversationPageSchema.parse({
    execution: { state: "completed", cancel: null, interactions: [] },
    available: true,
    reason: null,
    executionAttemptId: `${operationId}-attempt`,
    sessionId: `${operationId}-session`,
    turns: [],
    events: [],
    cursor: 0,
    hasMore: false
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const pages = new Map<string, DesktopRemoteAcpConversationPage>();
  const page = (operationId = scope.operationId) => {
    let current = pages.get(operationId);
    if (!current) {
      current = emptyPage(operationId);
      pages.set(operationId, current);
    }
    return current;
  };
  const acknowledge = (input: DesktopRemoteAcpConversationInput) => {
    const action = input.action;
    const current = page(input.operationId);
    if (action?.kind === "prompt") {
      pages.set(input.operationId, {
        ...current,
        turns: [
          ...current.turns,
          {
            turnId: action.turnId,
            turnOrder: current.turns.length + 1,
            executionAttemptId: action.executionAttemptId,
            sessionId: action.sessionId,
            status: "completed",
            createdAt: "2030-01-01T00:00:00.000Z",
            error: null
          }
        ]
      });
    }
    return page(input.operationId);
  };
  const respond = vi.fn(async (input: DesktopRemoteAcpConversationInput) => acknowledge(input));
  const invoke = vi.fn(async (_channel: string, input: unknown) => ({
    ok: true,
    value: await respond(desktopRemoteAcpConversationInputSchema.parse(input))
  }));
  const api = createWorkspaceExecutionRendererApi(createWorkspaceExecutionPreloadApi(invoke));
  function Composer({
    input = scope,
    locale = "en"
  }: {
    input?: typeof scope;
    locale?: "en" | "zh-CN";
  }) {
    const continuation = useRemoteAcpContinuation(api, input);
    return (
      <>
        <RemoteAcpComposer
          key={input.operationId}
          continuation={continuation}
          t={createTranslator(locale)}
        />
        <output data-testid="pending-count">{continuation.pendingMessages.length}</output>
      </>
    );
  }
  const actionCalls = () =>
    invoke.mock.calls.flatMap(([, input]) => {
      const request = desktopRemoteAcpConversationInputSchema.parse(input);
      return request.action ? [request] : [];
    });
  return { api, invoke, respond, page, acknowledge, Composer, actionCalls };
}

function textbox() {
  return screen.getByRole<HTMLTextAreaElement>("textbox");
}

function edit(text: string) {
  fireEvent.change(textbox(), { target: { value: text } });
}

function submit() {
  fireEvent.keyDown(textbox(), { key: "Enter" });
}

async function ready() {
  await waitFor(() => expect(textbox().disabled).toBe(false));
}

async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

describe("remote ACP prompt validation", () => {
  it.each([
    { name: "ASCII", invalid: "a".repeat(32769), valid: "a".repeat(32768) },
    {
      name: "trimmed ASCII",
      invalid: ` \n${"a".repeat(32769)}\t`,
      valid: ` \n${"a".repeat(32768)}\t`
    },
    { name: "emoji surrogate pairs", invalid: "😀".repeat(32769), valid: "😀".repeat(16000) },
    {
      name: "mixed emoji and ASCII",
      invalid: `${"😀".repeat(16384)}${"a".repeat(16385)}`,
      valid: `${"😀".repeat(16000)}a`
    }
  ])("rejects $name locally and allows a corrected prompt in the same scope", async ({
    invalid,
    valid
  }) => {
    const f = setup();
    const { result } = renderHook(() => useRemoteAcpContinuation(f.api, scope));
    await waitFor(() => expect(result.current.available).toBe(true));
    const reads = f.invoke.mock.calls.length;
    await act(async () => {
      expect(await result.current.send(invalid)).toBe(false);
      expect(await result.current.send(invalid)).toBe(false);
    });
    expect(f.invoke).toHaveBeenCalledTimes(reads);
    expect(result.current.sending).toBe(false);
    expect(result.current.pendingMessages).toEqual([]);
    expect(result.current.draftError).toBe("acpPromptTooLong");

    let finish!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = f.respond.getMockImplementation()!;
    f.respond.mockImplementationOnce(async (input) => {
      const response = await original(input);
      await acknowledgement;
      return response;
    });
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.send(valid);
    });
    expect(f.invoke).toHaveBeenCalledTimes(reads + 1);
    expect(f.invoke).toHaveBeenLastCalledWith(
      workspaceExecutionInvokeChannels.conversation,
      expect.objectContaining({
        action: expect.objectContaining({ kind: "prompt", text: valid.trim() })
      })
    );
    expect(result.current.pendingMessages).toEqual([
      expect.objectContaining({ text: valid.trim(), status: "sending" })
    ]);
    expect(result.current.draftError).toBeNull();
    await act(async () => {
      finish();
      expect(await sent).toBe(true);
    });
    await act(async () => {
      expect(await result.current.send("Next prompt")).toBe(true);
    });
    expect(f.invoke).toHaveBeenCalledTimes(reads + 2);
    expect(f.page().turns).toHaveLength(2);
    expect(f.page().turns[0].turnId).not.toBe(f.page().turns[1].turnId);
  });

  it("keeps preload input validation before IPC for callers that bypass the hook", async () => {
    const f = setup();
    await expect(
      f.api.remoteAcpConversation({
        ...scope,
        action: {
          kind: "prompt",
          turnId: "direct-call",
          executionAttemptId: f.page().executionAttemptId,
          sessionId: f.page().sessionId!,
          text: "a".repeat(32769)
        }
      })
    ).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only programmatic draft without pending delivery", async () => {
    const f = setup();
    const { result } = renderHook(() => useRemoteAcpContinuation(f.api, scope));
    await waitFor(() => expect(result.current.available).toBe(true));
    const reads = f.invoke.mock.calls.length;
    await act(async () => expect(await result.current.send(" \n\t ")).toBe(false));
    expect(f.invoke).toHaveBeenCalledTimes(reads);
    expect(result.current).toMatchObject({
      draftError: "acpPromptInvalid",
      sending: false,
      pendingMessages: []
    });
  });

  it.each([
    { locale: "en", error: "This message is too long. Shorten it and try again." },
    { locale: "zh-CN", error: "消息过长，请缩短后重试。" }
  ] as const)("retains and corrects the draft with a localized error ($locale)", async ({
    locale,
    error
  }) => {
    const f = setup();
    render(<f.Composer locale={locale} />);
    await ready();
    const reads = f.invoke.mock.calls.length;
    const invalid = "a".repeat(32769);
    edit(invalid);
    submit();
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain(error);
    expect(textbox().value).toBe(invalid);
    expect(textbox().disabled).toBe(false);
    expect(screen.getByTestId("pending-count").textContent).toBe("0");
    expect(f.invoke).toHaveBeenCalledTimes(reads);

    const response = deferred<DesktopRemoteAcpConversationPage>();
    f.respond.mockImplementationOnce(() => response.promise);
    edit("a".repeat(32768));
    const sendButton = screen.getByRole("button");
    act(() => {
      fireEvent.click(sendButton);
      fireEvent.click(sendButton);
      submit();
    });
    expect(f.actionCalls()).toHaveLength(1);
    expect(screen.getByTestId("pending-count").textContent).toBe("1");
    expect(textbox().value).toBe("a".repeat(32768));
    expect(textbox().disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => response.resolve(f.acknowledge(f.actionCalls()[0])));
    await ready();
    expect(textbox().value).toBe("");
    edit("Next prompt");
    submit();
    await waitFor(() => expect(textbox().value).toBe(""));
    expect(f.actionCalls()).toHaveLength(2);
    expect(f.page().turns).toHaveLength(2);
    expect(f.page().turns[0].turnId).not.toBe(f.page().turns[1].turnId);
  });

  it.each([
    {
      locale: "en",
      restoreLabel: "Resume task",
      draftError: "This message is too long.",
      restoreError: "could not be restored"
    },
    {
      locale: "zh-CN",
      restoreLabel: "恢复任务",
      draftError: "消息过长",
      restoreError: "未能恢复任务"
    }
  ] as const)("shows the latest restore failure after a draft error and retains the draft ($locale)", async ({
    locale,
    restoreLabel,
    draftError,
    restoreError
  }) => {
    const f = setup();
    f.page().execution.state = "cancelled";
    f.page().canRestoreTask = true;
    render(<f.Composer locale={locale} />);
    await ready();
    const invalid = "a".repeat(32769);
    edit(invalid);
    submit();
    expect(screen.getByRole("alert").textContent).toContain(draftError);
    expect(f.actionCalls()).toHaveLength(0);

    const restoration = deferred<DesktopRemoteAcpConversationPage>();
    f.respond.mockImplementationOnce(() => restoration.promise);
    fireEvent.click(screen.getByRole("button", { name: restoreLabel }));
    expect(f.actionCalls()).toEqual([
      expect.objectContaining({ action: expect.objectContaining({ kind: "restore_task" }) })
    ]);
    expect(textbox().disabled).toBe(true);
    expect(textbox().value).toBe(invalid);
    expect(screen.getByTestId("pending-count").textContent).toBe("0");
    await act(async () => restoration.reject(new Error("restore_denied")));
    expect(screen.getByRole("alert").textContent).toContain(restoreError);
    expect(screen.getByRole("alert").textContent).not.toContain(draftError);
    expect(textbox().value).toBe(invalid);
    expect(textbox().disabled).toBe(false);

    const calls = f.invoke.mock.calls.length;
    submit();
    expect(screen.getByRole("alert").textContent).toContain(draftError);
    expect(screen.getByRole("alert").textContent).not.toContain(restoreError);
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    expect(screen.getByTestId("pending-count").textContent).toBe("0");
    edit("Corrected prompt");
    submit();
    await waitFor(() => expect(textbox().value).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.actionCalls()).toHaveLength(2);
    expect(f.page().turns).toHaveLength(1);
  });

  it("preserves the original delivery identity after timeout and refuses edited retries", async () => {
    const f = setup();
    const { result } = renderHook(() => useRemoteAcpContinuation(f.api, scope));
    await waitFor(() => expect(result.current.available).toBe(true));
    f.respond.mockRejectedValueOnce(new Error("network_timeout"));
    await act(async () => expect(await result.current.send("  Original prompt  ")).toBe(false));
    const original = f.actionCalls()[0].action;
    expect(original).toMatchObject({ kind: "prompt", text: "Original prompt" });
    expect(f.page().turns).toHaveLength(0);
    expect(result.current.pendingMessages).toEqual([
      expect.objectContaining({ status: "unconfirmed", text: "Original prompt" })
    ]);
    expect(result.current.error).toBe("network_timeout");
    const calls = f.invoke.mock.calls.length;
    await act(async () => expect(await result.current.send("Edited prompt")).toBe(false));
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    expect(result.current.error).toBe("acp_conversation_retry_original_message");
    await act(async () => expect(await result.current.send("\nOriginal prompt\t")).toBe(true));
    expect(f.actionCalls()).toHaveLength(2);
    expect(f.actionCalls()[1].action).toEqual(original);
    expect(f.page().turns).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.pendingMessages).toHaveLength(1);
    expect(result.current.pendingMessages[0].status).toBe("accepted");
  });

  it.each([
    "reconciliation",
    "later poll"
  ] as const)("releases a timed-out prompt when its receipt appears in %s before retry", async (receipt) => {
    vi.useFakeTimers();
    const f = setup();
    const { result } = renderHook(() => useRemoteAcpContinuation(f.api, scope));
    await act(async () => {});
    expect(result.current.available).toBe(true);
    f.respond.mockImplementationOnce(async (input) => {
      if (receipt === "reconciliation") f.acknowledge(input);
      throw new Error("network_timeout");
    });
    await act(async () => {
      expect(await result.current.send("Original prompt")).toBe(receipt === "reconciliation");
    });
    if (receipt === "later poll") {
      expect(result.current.error).toBe("network_timeout");
      f.acknowledge(f.actionCalls()[0]);
      await poll();
    }
    expect(result.current.error).toBeNull();
    expect(result.current.pendingMessages[0].status).toBe("accepted");
    await act(async () => expect(await result.current.send("Different next prompt")).toBe(true));
    expect(f.actionCalls()).toHaveLength(2);
    expect(f.page().turns).toHaveLength(2);
    expect(f.page().turns[1].turnId).not.toBe(f.page().turns[0].turnId);
  });

  it.each(
    (["action", "reconciliation"] as const).flatMap((source) =>
      (["resolve", "reject"] as const).map((outcome) => ({ source, outcome }))
    )
  )("fences a late $source $outcome after switching scopes", async ({ source, outcome }) => {
    const f = setup();
    const { rerender } = render(<f.Composer />);
    await ready();
    const delayed = deferred<DesktopRemoteAcpConversationPage>();
    if (source === "reconciliation") f.respond.mockRejectedValueOnce(new Error("network_timeout"));
    f.respond.mockImplementationOnce(() => delayed.promise);
    edit("Old scope prompt");
    submit();
    await waitFor(() => expect(f.respond).toHaveBeenCalledTimes(source === "action" ? 2 : 3));
    const oldAction = f.actionCalls()[0];
    const nextScope = { ...scope, operationId: "new-operation" };
    rerender(<f.Composer input={nextScope} />);
    await ready();
    const draft = source === "reconciliation" ? "b".repeat(32769) : "New scope draft";
    edit(draft);
    if (source === "reconciliation") submit();
    const alert = screen.queryByRole("alert")?.textContent;
    if (source === "reconciliation") expect(alert).toContain("This message is too long.");
    const calls = f.invoke.mock.calls.length;
    await act(async () => {
      if (outcome === "resolve") delayed.resolve(f.acknowledge(oldAction));
      else delayed.reject(new Error("old_scope_failure"));
    });
    expect(textbox().value).toBe(draft);
    expect(textbox().disabled).toBe(false);
    expect(screen.queryByRole("alert")?.textContent).toBe(alert);
    expect(screen.getByTestId("pending-count").textContent).toBe("0");
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    edit("New scope valid prompt");
    submit();
    await waitFor(() => expect(textbox().value).toBe(""));
    expect(f.actionCalls()).toHaveLength(2);
    expect(f.actionCalls()[1]).toMatchObject({
      operationId: nextScope.operationId,
      action: {
        kind: "prompt",
        executionAttemptId: "new-operation-attempt",
        sessionId: "new-operation-session",
        text: "New scope valid prompt"
      }
    });
    expect(f.page(nextScope.operationId).turns).toHaveLength(1);
  });
});
