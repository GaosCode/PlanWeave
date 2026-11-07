/* @vitest-environment jsdom */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationCompatibilityFixture } from "../../../server/src/__tests__/support/acpConversationCompatibilityFixture";
import { remoteAcpConversationResult } from "../main/remoteAcpConversationResult";
import { createWorkspaceExecutionRendererApi } from "../renderer/workspaceExecutionBridge";
import {
  acpConversationActionSchema,
  acpConversationHttpBodyBytes
} from "@planweave-ai/agent-host-protocol";
import type { AcpConversationAction } from "@planweave-ai/agent-host-protocol";
import { createWorkspaceExecutionPreloadApi } from "../preload/workspaceExecutionPreloadBridge";
import { useRemoteAcpContinuation } from "../renderer/task-workspace/useRemoteAcpContinuation";
import {
  desktopRemoteAcpConversationInputSchema,
  desktopRemoteAcpConversationPageSchema
} from "../shared/remoteAcpConversation";
import { createTranslator } from "../renderer/i18n";
import { RemoteAcpComposer } from "../renderer/task-workspace/conversation/RemoteAcpComposer";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

async function setup(surface: "owner" | "workspace", sessionId = "original-session") {
  const f = await createConversationCompatibilityFixture();
  f.db
    .prepare("UPDATE remote_acp_event_streams SET acp_session_id=? WHERE execution_attempt_id=?")
    .run(sessionId, f.operation.executionAttemptId);
  f.prompt.sessionId = sessionId;
  const scope = {
    locator:
      surface === "owner"
        ? {
            kind: "owner_canvas" as const,
            operatorProfileId: "wire-owner",
            humanPrincipalId: "compat-actor",
            projectRoot: "/wire-budget",
            projectId: f.operation.projectId,
            canvasId: f.operation.canvasId
          }
        : {
            kind: "workspace" as const,
            connectionProfileId: "wire-budget",
            workspaceId: f.operation.workspaceId,
            projectId: f.operation.projectId,
            canvasId: f.operation.canvasId
          },
    operationId: f.operation.id,
    blockRef: f.operation.blockRef
  };
  const requests: AcpConversationAction[] = [];
  const preload = createWorkspaceExecutionPreloadApi(async (_channel, raw) => {
    const input = desktopRemoteAcpConversationInputSchema.parse(raw);
    if (
      input.action &&
      input.action.kind !== "execution_cancel" &&
      input.action.kind !== "execution_respond"
    )
      requests.push(input.action);
    return remoteAcpConversationResult(async () => {
      if (input.action?.kind === "execution_cancel" || input.action?.kind === "execution_respond")
        throw new Error("unexpected_execution_action");
      const page =
        surface === "owner"
          ? await f.owner.acpConversation(f.operation.id, 0, "compat-actor", input.action)
          : await f.workspace.acpConversation(f.operation.id, 0, input.action);
      return desktopRemoteAcpConversationPageSchema.parse({
        ...page,
        execution: { state: "completed", cancel: null, interactions: [] }
      });
    });
  });
  const api = createWorkspaceExecutionRendererApi({
    ...preload,
    remoteAcpConversation: async (input) =>
      structuredClone(await preload.remoteAcpConversation(input))
  });
  const count = () =>
    Number(f.db.prepare("SELECT count(*) AS count FROM acp_conversation_turns").get()?.count);
  return { ...f, scope, requests, api, preload, count };
}

describe("remote ACP complete HTTP body budget", () => {
  it.each([
    "owner",
    "workspace"
  ] as const)("rejects oversized Unicode before pending or delivery on %s and admits an edit", async (surface) => {
    const f = await setup(surface);
    try {
      const { result, unmount } = renderHook(() => useRemoteAcpContinuation(f.api, f.scope));
      await waitFor(() => expect(result.current.available).toBe(true));
      for (const text of [
        "中".repeat(22000),
        "😀".repeat(17000),
        "\u0001".repeat(11000),
        '"'.repeat(32768)
      ]) {
        expect(acpConversationActionSchema.safeParse({ ...f.prompt, text }).success).toBe(true);
        await act(async () => expect(await result.current.send(text)).toBe(false));
        expect(result.current.pendingMessages.length).toBe(0);
        expect(result.current.draftError).toBe("acpPromptBodyTooLarge");
        await expect(
          f.preload.remoteAcpConversation({ ...f.scope, action: { ...f.prompt, text } })
        ).rejects.toThrow();
      }
      expect(f.requests).toHaveLength(0);
      expect(f.count()).toBe(0);
      await act(async () => expect(await result.current.send("a".repeat(32768))).toBe(true));
      expect(f.requests).toHaveLength(1);
      expect(f.count()).toBe(1);
      unmount();
    } finally {
      await f.close();
    }
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("releases a definite rejection from the real %s handler after a transport body expansion", async (surface) => {
    const originalFetch = globalThis.fetch;
    let expand = true;
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (expand && init?.method === "POST" && typeof init.body === "string") {
        expand = false;
        init = {
          ...init,
          body: JSON.stringify({ ...JSON.parse(init.body), text: "中".repeat(22000) })
        };
      }
      return originalFetch(url, init);
    });
    const f = await setup(surface);
    try {
      const { result, unmount } = renderHook(() => useRemoteAcpContinuation(f.api, f.scope));
      await waitFor(() => expect(result.current.available).toBe(true));
      await act(async () => expect(await result.current.send("Rejected draft")).toBe(false));
      expect(result.current.error).toBe(
        surface === "owner" ? "operator_body_too_large" : "human_remote_body_too_large"
      );
      expect(f.count()).toBe(0);
      expect(result.current.pendingMessages.length).toBe(0);
      await act(async () => expect(await result.current.send("Short corrected prompt")).toBe(true));
      expect(f.requests).toHaveLength(2);
      expect(f.count()).toBe(1);
      unmount();
    } finally {
      await f.close();
    }
  });
});

describe("remote ACP request boundary and retry identity", () => {
  it.each(
    (["owner", "workspace"] as const).flatMap((surface) =>
      [65535, 65536, 65537].map((bytes) => ({ surface, bytes }))
    )
  )("uses the exact full Unicode JSON boundary on $surface at $bytes bytes", async ({
    surface,
    bytes
  }) => {
    const f = await setup(surface, '会话😀"\\');
    const turnId = "00000000-0000-4000-8000-000000000001";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(turnId);
    try {
      const prefix = { ...f.prompt, turnId, text: "" };
      const overhead = Buffer.byteLength(JSON.stringify(prefix));
      const contentBytes = bytes - overhead;
      const action = {
        ...prefix,
        text: "中".repeat(Math.floor(contentBytes / 3)) + "a".repeat(contentBytes % 3)
      };
      expect(Buffer.byteLength(JSON.stringify(action))).toBe(bytes);
      expect(acpConversationHttpBodyBytes(action)).toBe(bytes);
      expect(acpConversationActionSchema.safeParse(action).success).toBe(true);
      const { result, unmount } = renderHook(() => useRemoteAcpContinuation(f.api, f.scope));
      await waitFor(() => expect(result.current.available).toBe(true));
      await act(async () => expect(await result.current.send(action.text)).toBe(bytes <= 65536));
      expect(f.requests).toHaveLength(bytes <= 65536 ? 1 : 0);
      expect(f.count()).toBe(bytes <= 65536 ? 1 : 0);
      if (bytes > 65536) {
        const request =
          surface === "owner"
            ? f.owner.acpConversation(f.operation.id, 0, "compat-actor", action)
            : f.workspace.acpConversation(f.operation.id, 0, action);
        await expect(request).rejects.toMatchObject({
          httpStatus: 413,
          code: surface === "owner" ? "operator_body_too_large" : "human_remote_body_too_large"
        });
        expect(f.count()).toBe(0);
      } else {
        expect(f.requests[0]).toEqual(action);
      }
      console.info(
        JSON.stringify({
          surface,
          fullJsonBytes: bytes,
          textCodepoints: [...action.text].length,
          accepted: bytes <= 65536,
          sqliteTurns: f.count()
        })
      );
      unmount();
    } finally {
      await f.close();
    }
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("keeps an earlier unknown delivery after a later real %s body rejection", async (surface) => {
    const originalFetch = globalThis.fetch;
    let posts = 0;
    let hideReceipts = false;
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "GET" && String(url).includes("/conversation") && hideReceipts)
        throw new TypeError("receipt_connection_lost");
      if (init?.method === "POST" && typeof init.body === "string") {
        ++posts;
        if (posts === 1) {
          const response = await originalFetch(url, init);
          expect(response.status).toBe(202);
          await response.text();
          hideReceipts = true;
          throw new TypeError("accepted_response_lost");
        }
        if (posts === 2)
          init = {
            ...init,
            body: JSON.stringify({ ...JSON.parse(init.body), text: "中".repeat(22000) })
          };
      }
      return originalFetch(url, init);
    });
    const f = await setup(surface);
    try {
      const { result, unmount } = renderHook(() => useRemoteAcpContinuation(f.api, f.scope));
      await waitFor(() => expect(result.current.available).toBe(true));
      await act(async () =>
        expect(await result.current.send("Original uncertain draft")).toBe(false)
      );
      expect(f.count()).toBe(1);
      const original = f.requests[0];
      expect(result.current.pendingMessages[0].status).toBe("unconfirmed");
      await act(async () =>
        expect(await result.current.send("Original uncertain draft")).toBe(false)
      );
      expect(result.current.pendingMessages).toHaveLength(1);
      await act(async () => expect(await result.current.send("Edited draft")).toBe(false));
      expect(result.current.error).toBe("acp_conversation_retry_original_message");
      expect(posts).toBe(2);
      hideReceipts = false;
      await act(async () =>
        expect(await result.current.send("Original uncertain draft")).toBe(true)
      );
      expect(f.requests).toEqual([original, original, original]);
      expect(f.count()).toBe(1);
      expect(result.current.pendingMessages[0].status).toBe("accepted");
      unmount();
    } finally {
      await f.close();
    }
  });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("remote ACP rejected draft lifecycle", () => {
  it.each([
    "owner",
    "workspace"
  ] as const)("keeps the %s composer draft editable after a real rejection and deduplicates the corrected submit", async (surface) => {
    const originalFetch = globalThis.fetch;
    let posts = 0;
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST" && typeof init.body === "string" && ++posts === 1)
        init = {
          ...init,
          body: JSON.stringify({ ...JSON.parse(init.body), text: "中".repeat(22000) })
        };
      return originalFetch(url, init);
    });
    const f = await setup(surface);
    function Composer() {
      const continuation = useRemoteAcpContinuation(f.api, f.scope);
      return (
        <>
          <RemoteAcpComposer continuation={continuation} t={createTranslator("en")} />
          <output data-testid="pending">{continuation.pendingMessages.length}</output>
        </>
      );
    }
    try {
      const { unmount } = render(<Composer />);
      const textbox = screen.getByRole<HTMLTextAreaElement>("textbox");
      await waitFor(() => expect(textbox.disabled).toBe(false));
      fireEvent.change(textbox, { target: { value: "Rejected editable draft" } });
      fireEvent.keyDown(textbox, { key: "Enter" });
      await screen.findByRole("alert");
      expect(textbox.value).toBe("Rejected editable draft");
      expect(textbox.disabled).toBe(false);
      expect(screen.getByTestId("pending").textContent).toBe("0");
      expect(f.count()).toBe(0);
      fireEvent.change(textbox, { target: { value: "Corrected draft" } });
      act(() => {
        fireEvent.keyDown(textbox, { key: "Enter" });
        fireEvent.keyDown(textbox, { key: "Enter" });
        fireEvent.click(screen.getByRole("button"));
      });
      await waitFor(() => expect(textbox.value).toBe(""));
      expect(f.requests).toHaveLength(2);
      expect(posts).toBe(2);
      expect(f.count()).toBe(1);
      unmount();
    } finally {
      await f.close();
    }
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("fences a late %s rejection from the new scope pending message and busy state", async (surface) => {
    const originalFetch = globalThis.fetch;
    const oldResponse = barrier();
    const newResponse = barrier();
    let posts = 0;
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method !== "POST" || typeof init.body !== "string") return originalFetch(url, init);
      const ordinal = ++posts;
      if (ordinal === 1)
        init = {
          ...init,
          body: JSON.stringify({ ...JSON.parse(init.body), text: "中".repeat(22000) })
        };
      const response = await originalFetch(url, init);
      await (ordinal === 1 ? oldResponse.promise : newResponse.promise);
      return response;
    });
    const f = await setup(surface);
    try {
      const { result, rerender, unmount } = renderHook(
        ({ input }) => useRemoteAcpContinuation(f.api, input),
        { initialProps: { input: f.scope } }
      );
      await waitFor(() => expect(result.current.available).toBe(true));
      let oldSend!: Promise<boolean>;
      act(() => {
        oldSend = result.current.send("Old scope draft");
      });
      await waitFor(() => expect(posts).toBe(1));
      const nextScope = {
        ...f.scope,
        locator:
          f.scope.locator.kind === "workspace"
            ? { ...f.scope.locator, connectionProfileId: "other-connection" }
            : { ...f.scope.locator, operatorProfileId: "other-owner" }
      };
      rerender({ input: nextScope });
      await waitFor(() => expect(result.current.available).toBe(true));
      let newSend!: Promise<boolean>;
      act(() => {
        newSend = result.current.send("New scope draft");
      });
      await waitFor(() => expect(posts).toBe(2));
      const turnId = result.current.pendingMessages[0].turnId;
      await act(async () => {
        oldResponse.release();
        expect(await oldSend).toBe(false);
      });
      expect(result.current.error).toBeNull();
      expect(result.current.sending).toBe(true);
      expect(result.current.pendingMessages).toEqual([
        expect.objectContaining({ turnId, text: "New scope draft", status: "sending" })
      ]);
      await act(async () => expect(await result.current.send("Duplicate enter")).toBe(false));
      expect(posts).toBe(2);
      await act(async () => {
        newResponse.release();
        expect(await newSend).toBe(true);
      });
      expect(f.count()).toBe(1);
      unmount();
    } finally {
      oldResponse.release();
      newResponse.release();
      await f.close();
    }
  });
});
