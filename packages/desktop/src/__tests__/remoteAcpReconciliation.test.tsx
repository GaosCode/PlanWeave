/* @vitest-environment jsdom */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpConversationEvent } from "@planweave-ai/agent-host-protocol/browser";
import type {
  DesktopRemoteAcpConversationInput,
  DesktopRemoteAcpConversationPage
} from "../shared/remoteAcpConversation";
import { useRemoteAcpContinuation } from "../renderer/task-workspace/useRemoteAcpContinuation";
import { RemoteAcpComposer } from "../renderer/task-workspace/conversation/RemoteAcpComposer";
import { RemoteAcpRunConversation } from "../renderer/task-workspace/conversation/RemoteAcpRunConversation";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);
const scope = {
  locator: {
    kind: "workspace" as const,
    connectionProfileId: "profile-one",
    workspaceId: "workspace-one",
    projectId: "project-one",
    canvasId: "canvas-one"
  },
  operationId: "operation-one",
  blockRef: "T-1#B-1"
};
type Page = DesktopRemoteAcpConversationPage;
type Prompt = Extract<NonNullable<DesktopRemoteAcpConversationInput["action"]>, { kind: "prompt" }>;
const timestamp = "2026-09-14T00:00:00.000Z";
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
  vi.useFakeTimers();
  vi.setSystemTime(timestamp);
  const f: { page: Page } = {
    page: {
      execution: { state: "completed", cancel: null, interactions: [] },
      available: true,
      canRestoreTask: false,
      restoredOperationId: null,
      reason: null,
      executionAttemptId: "attempt-one",
      sessionId: "session-one",
      turns: [],
      events: [],
      cursor: 0,
      hasMore: false
    }
  };
  const remoteAcpConversation = vi.fn(async (input: DesktopRemoteAcpConversationInput) => {
    if (input.action?.kind === "prompt") {
      f.page = { ...f.page, turns: [...f.page.turns, turn(input.action, "running")] };
    }
    return f.page;
  });
  return {
    get page() {
      return f.page;
    },
    set page(page: Page) {
      f.page = page;
    },
    api: { remoteAcpConversation },
    prompts: () =>
      remoteAcpConversation.mock.calls.flatMap(([input]) =>
        input.action?.kind === "prompt" ? [input.action] : []
      )
  };
}
function turn(prompt: Prompt, status: Page["turns"][number]["status"]): Page["turns"][number] {
  return {
    turnId: prompt.turnId,
    executionAttemptId: prompt.executionAttemptId,
    sessionId: prompt.sessionId,
    status,
    createdAt: timestamp,
    error: status === "failed" ? "agent_failed" : null
  };
}
function userEvent(prompt: Prompt): AcpConversationEvent {
  return {
    protocolVersion: 1,
    type: "acp_conversation.event",
    operationId: scope.operationId,
    executionAttemptId: prompt.executionAttemptId,
    sessionId: prompt.sessionId,
    turnId: prompt.turnId,
    messageId: `event-${prompt.turnId}`,
    sequence: 1,
    timestamp,
    payload: {
      kind: "runner",
      fragment: {
        kind: "runner_body",
        body: {
          kind: "message",
          role: "user",
          messageId: `user-${prompt.turnId}`,
          chunk: false,
          content: prompt.text,
          redaction: { classes: [], replaced: 0 }
        }
      }
    }
  };
}
async function mount(f: ReturnType<typeof setup>) {
  const hook = renderHook(({ input }) => useRemoteAcpContinuation(f.api, input), {
    initialProps: { input: scope }
  });
  await act(async () => {});
  expect(hook.result.current.available).toBe(true);
  return hook;
}
async function uncertain(f: ReturnType<typeof setup>, send: (text: string) => Promise<boolean>) {
  f.api.remoteAcpConversation
    .mockRejectedValueOnce(new Error("post_timeout"))
    .mockRejectedValueOnce(new Error("get_offline"));
  await act(async () => {
    expect(await send("Original prompt")).toBe(false);
  });
  expect(f.prompts()).toHaveLength(1);
  return f.prompts()[0];
}
async function poll(ms = 1500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("remote ACP authoritative prompt reconciliation", () => {
  it.each([
    "completed",
    "failed",
    "cancelled"
  ] as const)("releases a delayed %s confirmation for a new turn without reposting the original", async (status) => {
    const f = setup();
    const { result } = await mount(f);
    const prompt = await uncertain(f, result.current.send);
    expect(result.current.error).toBe("post_timeout");
    await act(async () => {
      expect(await result.current.send("Different prompt")).toBe(false);
    });
    expect(result.current.error).toBe("acp_conversation_retry_original_message");
    f.page = { ...f.page, turns: [turn(prompt, status)] };
    await poll(1499);
    expect(f.api.remoteAcpConversation).toHaveBeenCalledTimes(3);
    await poll(1);
    expect(f.api.remoteAcpConversation).toHaveBeenCalledTimes(4);
    expect(f.prompts()).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.turns[0]).toMatchObject({
      status,
      error: status === "failed" ? "agent_failed" : null
    });
    expect(result.current.pendingMessages[0]).toMatchObject({
      text: prompt.text,
      status: "accepted"
    });
    await act(async () => {
      expect(await result.current.send("Different prompt")).toBe(true);
    });
    expect(f.prompts()).toHaveLength(2);
    expect(f.prompts()[1]).toMatchObject({ text: "Different prompt", sessionId: prompt.sessionId });
    expect(f.prompts()[1].turnId).not.toBe(prompt.turnId);
  });

  it.each([
    "queued",
    "running"
  ] as const)("acknowledges %s while preserving the active-turn guard", async (status) => {
    const f = setup();
    const { result } = await mount(f);
    const prompt = await uncertain(f, result.current.send);
    f.page = { ...f.page, turns: [turn(prompt, status)] };
    await poll();
    expect(result.current.error).toBeNull();
    expect(result.current.active?.status).toBe(status);
    expect(result.current.pendingMessages[0]?.status).toBe("accepted");
    await act(async () => {
      expect(await result.current.send("Next prompt")).toBe(false);
    });
    expect(f.prompts()).toHaveLength(1);
    f.page = { ...f.page, turns: [turn(prompt, "completed")] };
    await poll();
    await act(async () => {
      expect(await result.current.send("Next prompt")).toBe(true);
    });
    expect(f.prompts()[1].turnId).not.toBe(prompt.turnId);
  });

  it("keeps the original identity across unconfirmed polls and explicit retries", async () => {
    const f = setup();
    const { result } = await mount(f);
    const prompt = await uncertain(f, result.current.send);
    await poll();
    expect(result.current.error).toBe("post_timeout");
    expect(result.current.pendingMessages[0]?.status).toBe("unconfirmed");
    await act(async () => {
      expect(await result.current.send("Edited prompt")).toBe(false);
    });
    expect(f.prompts()).toHaveLength(1);
    await act(async () => {
      expect(await result.current.send(prompt.text)).toBe(true);
    });
    expect(f.prompts()).toEqual([prompt, prompt]);
    expect(result.current.error).toBeNull();
  });

  it.each([
    "turnId",
    "sessionId",
    "executionAttemptId",
    "pageSession",
    "pageAttempt"
  ] as const)("does not confirm a matching text with mismatched %s", async (field) => {
    const f = setup();
    const { result } = await mount(f);
    const prompt = await uncertain(f, result.current.send);
    const other = {
      ...prompt,
      ...(["turnId", "sessionId", "executionAttemptId"].includes(field) ? { [field]: "other" } : {})
    };
    f.page = {
      ...f.page,
      ...(field === "pageSession" ? { sessionId: "other" } : {}),
      ...(field === "pageAttempt" ? { executionAttemptId: "other" } : {}),
      turns: [turn(other, "completed")],
      events: [userEvent(other)],
      cursor: 1
    };
    await poll();
    expect(result.current.error).toBe("post_timeout");
    await act(async () => {
      expect(await result.current.send("Edited prompt")).toBe(false);
    });
    expect(f.prompts()).toHaveLength(1);
    await act(async () => {
      await result.current.send(prompt.text);
    });
    expect(f.prompts()).toEqual([prompt, prompt]);
  });

  it("does not treat a wrong-session immediate GET as successful POST recovery", async () => {
    const f = setup();
    const { result } = await mount(f);
    f.api.remoteAcpConversation.mockImplementationOnce(async (input) => {
      if (input.action?.kind !== "prompt") throw new Error("expected_prompt");
      f.page = { ...f.page, turns: [turn({ ...input.action, sessionId: "other" }, "completed")] };
      throw new Error("post_timeout");
    });
    await act(async () => {
      expect(await result.current.send("Original prompt")).toBe(false);
    });
    expect(result.current.error).toBe("post_timeout");
    expect(result.current.pendingMessages[0]?.status).toBe("unconfirmed");
  });

  it("fences an old operation's delayed GET while a new operation has an unconfirmed prompt", async () => {
    const f = setup();
    const { result, rerender } = await mount(f);
    const oldPrompt = await uncertain(f, result.current.send);
    const oldRead = deferred<Page>();
    f.api.remoteAcpConversation.mockImplementationOnce(() => oldRead.promise);
    await poll();
    const oldPage = { ...f.page, turns: [turn(oldPrompt, "completed")] };
    rerender({ input: { ...scope, operationId: "operation-two" } });
    await act(async () => {});
    f.api.remoteAcpConversation
      .mockRejectedValueOnce(new Error("new_post_timeout"))
      .mockRejectedValueOnce(new Error("new_get_offline"));
    await act(async () => {
      expect(await result.current.send("New operation prompt")).toBe(false);
    });
    const newPrompt = f.prompts()[1];
    await act(async () => {
      oldRead.resolve(oldPage);
    });
    expect(result.current.pendingMessages[0]).toMatchObject({
      turnId: newPrompt.turnId,
      status: "unconfirmed"
    });
    expect(result.current.error).toBe("new_post_timeout");
    expect(result.current.turns).toHaveLength(0);
    await act(async () => {
      expect(await result.current.send("Another prompt")).toBe(false);
    });
    expect(f.prompts()).toHaveLength(2);
  });

  it("waits for the last page and atomically replaces optimistic text with one authoritative user message", async () => {
    const f = setup();
    const frames: { pending: string | undefined; messages: number }[] = [];
    const { result } = renderHook(() => {
      const continuation = useRemoteAcpContinuation(f.api, scope);
      frames.push({
        pending: continuation.pendingMessages[0]?.text,
        messages: continuation.turns
          .flatMap((item) => item.timeline)
          .filter((item) => item.kind === "message" && item.role === "user").length
      });
      return continuation;
    });
    await act(async () => {});
    const prompt = await uncertain(f, result.current.send);
    const frameStart = frames.length;
    const middle = deferred<Page>();
    const final = deferred<Page>();
    const event = userEvent(prompt);
    f.api.remoteAcpConversation
      .mockResolvedValueOnce({ ...f.page, cursor: 1, hasMore: true })
      .mockImplementationOnce(() => middle.promise)
      .mockImplementationOnce(() => final.promise);
    await poll();
    expect(result.current.pendingMessages[0]?.status).toBe("unconfirmed");
    await act(async () => {
      middle.resolve({ ...f.page, cursor: 2, events: [event], hasMore: true });
    });
    expect(result.current.pendingMessages[0]?.text).toBe(prompt.text);
    expect(result.current.turns).toHaveLength(0);
    const confirmed = { ...f.page, turns: [turn(prompt, "completed")], events: [event], cursor: 3 };
    await act(async () => {
      final.resolve(confirmed);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.pendingMessages).toHaveLength(0);
    expect(result.current.turns[0].timeline).toEqual([
      expect.objectContaining({ kind: "message", role: "user", content: prompt.text })
    ]);
    expect(
      frames
        .slice(frameStart)
        .every((frame) => Number(frame.pending !== undefined) + frame.messages === 1)
    ).toBe(true);
    expect(
      f.api.remoteAcpConversation.mock.calls.slice(3).map(([input]) => input.afterCursor)
    ).toEqual([0, 1, 2]);
    expect(f.prompts()).toHaveLength(1);
    f.page = confirmed;
    await poll();
    expect(result.current.turns[0].timeline).toHaveLength(1);
    expect(f.prompts()).toHaveLength(1);
  });

  it("retains accepted optimistic text until a later poll replays the authoritative user message", async () => {
    const f = setup();
    const { result } = await mount(f);
    const prompt = await uncertain(f, result.current.send);
    f.page = { ...f.page, turns: [turn(prompt, "completed")] };
    await poll();
    expect(result.current.pendingMessages[0]).toMatchObject({
      text: prompt.text,
      status: "accepted"
    });
    expect(result.current.turns[0].timeline).toHaveLength(0);
    await poll();
    expect(result.current.pendingMessages[0]?.text).toBe(prompt.text);
    f.page = { ...f.page, events: [userEvent(prompt)], cursor: 1 };
    await poll();
    expect(result.current.pendingMessages).toHaveLength(0);
    expect(result.current.turns[0].timeline).toEqual([
      expect.objectContaining({ kind: "message", role: "user", content: prompt.text })
    ]);
    expect(f.prompts()).toHaveLength(1);
  });

  it("keeps consecutive accepted prompts ordered until each is replayed, then clears them on navigation", async () => {
    const f = setup();
    let continuation!: ReturnType<typeof useRemoteAcpContinuation>;
    function View({ input }: { input: typeof scope }) {
      continuation = useRemoteAcpContinuation(f.api, input);
      return (
        <RemoteAcpRunConversation
          conversation={{
            ...input,
            continuation,
            cursor: 0,
            error: null,
            eventProtocolVersion: 2,
            executionAttemptId: "attempt-one",
            replayDiagnostics: [],
            state: "completed",
            terminalOutcome: "completed",
            timeline: [],
            telemetry: null
          }}
          t={createTranslator("en")}
        />
      );
    }
    const { rerender } = render(<View input={scope} />);
    await act(async () => {});
    const first = await uncertain(f, continuation.send);
    f.page = { ...f.page, turns: [turn(first, "completed")] };
    await poll();
    const nextPost = deferred<Page>();
    f.api.remoteAcpConversation.mockImplementationOnce(() => nextPost.promise);
    let sent!: Promise<boolean>;
    act(() => {
      sent = continuation.send("Second prompt");
    });
    const second = f.prompts()[1];
    expect(continuation.pendingMessages.map(({ text, status }) => ({ text, status }))).toEqual([
      { text: first.text, status: "accepted" },
      { text: second.text, status: "sending" }
    ]);
    const visibleMessages = () =>
      screen.getByTestId("task-workspace-conversation-content").textContent;
    const expectBothInOrder = () => {
      expect(screen.getAllByText(first.text)).toHaveLength(1);
      expect(screen.getAllByText(second.text)).toHaveLength(1);
      expect(visibleMessages()?.indexOf(first.text)).toBeLessThan(
        visibleMessages()?.indexOf(second.text) ?? -1
      );
    };
    expectBothInOrder();
    f.page = { ...f.page, turns: [turn(first, "completed"), turn(second, "running")] };
    await act(async () => {
      nextPost.resolve(f.page);
      expect(await sent).toBe(true);
    });
    expectBothInOrder();
    expect(continuation.pendingMessages).toHaveLength(2);
    expect(continuation.turns.flatMap((item) => item.timeline)).toHaveLength(0);
    await act(async () => {
      expect(await continuation.send("Concurrent prompt")).toBe(false);
    });
    expect(f.prompts()).toHaveLength(2);

    // A later turn can replay first; the older optimistic text keeps its original position.
    f.page = { ...f.page, events: [userEvent(second)], cursor: 1 };
    await poll();
    expectBothInOrder();
    expect(continuation.pendingMessages.map((message) => message.turnId)).toEqual([first.turnId]);
    f.page = { ...f.page, events: [userEvent(first), userEvent(second)], cursor: 2 };
    await poll();
    expectBothInOrder();
    expect(continuation.pendingMessages).toHaveLength(0);
    await poll();
    expectBothInOrder();
    expect(f.prompts()).toHaveLength(2);

    f.page = { ...f.page, turns: [turn(first, "completed"), turn(second, "completed")] };
    await poll();
    await act(async () => {
      expect(await continuation.send("Third prompt")).toBe(true);
    });
    expect(continuation.pendingMessages.map((message) => message.text)).toEqual(["Third prompt"]);
    f.page = { ...f.page, turns: [], events: [], cursor: 0 };
    rerender(<View input={{ ...scope, operationId: "operation-two" }} />);
    await act(async () => {});
    expect(continuation.pendingMessages).toHaveLength(0);
    expect(screen.queryByText(first.text)).toBeNull();
    expect(screen.queryByText(second.text)).toBeNull();
    expect(screen.queryByText("Third prompt")).toBeNull();
  });

  it("does not let a prior operation's delayed POST clear the new pending intent", async () => {
    const f = setup();
    const { result, rerender } = await mount(f);
    const oldPost = deferred<Page>();
    f.api.remoteAcpConversation.mockImplementationOnce(() => oldPost.promise);
    let oldSent!: Promise<boolean>;
    act(() => {
      oldSent = result.current.send("Old operation prompt");
    });
    const oldPrompt = f.prompts()[0];
    rerender({ input: { ...scope, operationId: "operation-two" } });
    await act(async () => {});
    f.api.remoteAcpConversation
      .mockRejectedValueOnce(new Error("new_post_timeout"))
      .mockRejectedValueOnce(new Error("new_get_offline"));
    await act(async () => {
      expect(await result.current.send("New operation prompt")).toBe(false);
    });
    const newPrompt = f.prompts()[1];
    await act(async () => {
      oldPost.resolve({ ...f.page, turns: [turn(oldPrompt, "completed")] });
      expect(await oldSent).toBe(false);
    });
    expect(result.current.error).toBe("new_post_timeout");
    expect(result.current.pendingMessages[0]).toMatchObject({
      turnId: newPrompt.turnId,
      status: "unconfirmed"
    });
    await act(async () => {
      expect(await result.current.send("Edited new prompt")).toBe(false);
    });
    expect(f.prompts()).toHaveLength(2);
    await act(async () => {
      expect(await result.current.send(newPrompt.text)).toBe(true);
    });
    expect(f.prompts()[2]).toEqual(newPrompt);
  });

  it("follows newly inserted prompts but preserves upward scrolling when replay removes a pending message", async () => {
    const f = setup();
    let continuation!: ReturnType<typeof useRemoteAcpContinuation>;
    function View() {
      continuation = useRemoteAcpContinuation(f.api, scope);
      return (
        <RemoteAcpRunConversation
          conversation={{
            ...scope,
            continuation,
            cursor: 0,
            error: null,
            eventProtocolVersion: 2,
            executionAttemptId: "attempt-one",
            replayDiagnostics: [],
            state: "completed",
            terminalOutcome: "completed",
            timeline: [],
            telemetry: null
          }}
          t={createTranslator("en")}
        />
      );
    }
    render(<View />);
    await act(async () => {});
    const viewport = screen.getByTestId("task-workspace-conversation-viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 }
    });
    const scrollUp = () => {
      viewport.scrollTop = 100;
      fireEvent.scroll(viewport);
    };
    scrollUp();
    await act(async () => {
      expect(await continuation.send("First prompt")).toBe(true);
    });
    expect(viewport.scrollTop).toBe(1000);
    const first = f.prompts()[0];
    f.page = { ...f.page, turns: [turn(first, "completed")] };
    await poll();
    scrollUp();
    await act(async () => {
      expect(await continuation.send("Second prompt")).toBe(true);
    });
    expect(viewport.scrollTop).toBe(1000);
    const second = f.prompts()[1];
    expect(continuation.pendingMessages).toHaveLength(2);
    scrollUp();
    f.page = { ...f.page, events: [userEvent(second)], cursor: 1 };
    await poll();
    expect(continuation.pendingMessages.map((message) => message.turnId)).toEqual([first.turnId]);
    expect(viewport.scrollTop).toBe(100);
    await poll();
    expect(viewport.scrollTop).toBe(100);
    f.page = {
      ...f.page,
      turns: [turn(first, "completed"), turn(second, "completed")],
      events: [userEvent(first)],
      cursor: 2
    };
    await poll();
    expect(continuation.pendingMessages).toHaveLength(0);
    expect(viewport.scrollTop).toBe(100);
    await act(async () => {
      expect(await continuation.send("Third prompt")).toBe(true);
    });
    expect(viewport.scrollTop).toBe(1000);
    expect(f.prompts()).toHaveLength(3);
  });

  it.each([
    "cancel",
    "respond",
    "restore_task"
  ] as const)("retains a newer %s error when the older prompt is confirmed", async (kind) => {
    const f = setup();
    const { result } = await mount(f);
    const prompt = await uncertain(f, result.current.send);
    const other = turn({ ...prompt, turnId: "other-turn" }, "running");
    f.page = { ...f.page, canRestoreTask: true, turns: kind === "restore_task" ? [] : [other] };
    await poll();
    f.api.remoteAcpConversation.mockRejectedValueOnce(new Error(`${kind}_failed`));
    await act(async () => {
      const response =
        kind === "cancel"
          ? result.current.cancel()
          : kind === "respond"
            ? result.current.respond(other.turnId, "permission-one", {
                kind: "permission",
                optionId: null
              })
            : result.current.restoreTask();
      expect(await response).toBe(false);
    });
    f.page = { ...f.page, turns: [turn(prompt, "completed")] };
    await poll();
    expect(result.current.pendingMessages[0]?.status).toBe("accepted");
    expect(result.current.error).toBe(`${kind}_failed`);
    expect(result.current.restoreFailed).toBe(kind === "restore_task");
    expect(f.prompts()).toHaveLength(1);
    await act(async () => {
      expect(await result.current.send("Next prompt")).toBe(true);
    });
    expect(f.prompts()[1].turnId).not.toBe(prompt.turnId);
  });

  it.each([
    "success",
    "failure"
  ] as const)("ignores a pre-action poll's late %s after a newer restore action", async (outcome) => {
    const f = setup();
    const { result } = await mount(f);
    const prompt = await uncertain(f, result.current.send);
    f.page = { ...f.page, canRestoreTask: true };
    await poll();
    const oldRead = deferred<Page>();
    f.api.remoteAcpConversation.mockImplementationOnce(() => oldRead.promise);
    await poll();
    f.api.remoteAcpConversation.mockResolvedValueOnce(f.page);
    await act(async () => {
      expect(await result.current.restoreTask()).toBe(true);
    });
    await act(async () => {
      if (outcome === "success") oldRead.resolve({ ...f.page, turns: [turn(prompt, "completed")] });
      else oldRead.reject(new Error("stale_poll_error"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.pendingMessages[0]?.status).toBe("unconfirmed");
    expect(result.current.turns).toHaveLength(0);
    await act(async () => {
      expect(await result.current.send("Next prompt")).toBe(false);
    });
    expect(f.prompts()).toHaveLength(1);
  });

  it("keeps the edited composer draft when a failed send is confirmed by polling", async () => {
    const f = setup();
    function Composer() {
      return (
        <RemoteAcpComposer
          continuation={useRemoteAcpContinuation(f.api, scope)}
          t={createTranslator("en")}
        />
      );
    }
    render(<Composer />);
    await act(async () => {});
    const input = screen.getByRole("textbox", { name: "Message the agent" });
    fireEvent.change(input, { target: { value: "Original prompt" } });
    f.api.remoteAcpConversation
      .mockRejectedValueOnce(new Error("post_timeout"))
      .mockRejectedValueOnce(new Error("get_offline"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    fireEvent.change(input, { target: { value: "Edited new draft" } });
    f.page = { ...f.page, turns: [turn(f.prompts()[0], "completed")] };
    await poll();
    expect(screen.getByDisplayValue("Edited new draft")).toBe(input);
    expect(screen.queryByText("post_timeout")).toBeNull();
    expect(f.prompts()).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    expect(f.prompts()[1].text).toBe("Edited new draft");
    expect(f.prompts()[1].turnId).not.toBe(f.prompts()[0].turnId);
  });
});
