import { describe, expect, it } from "vitest";
import { AcpSessionRouter } from "../autoRun/acpSessionRouter.js";
import type { CreateElicitationRequest, SessionNotification } from "@agentclientprotocol/sdk";

function update(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text }
    }
  };
}

describe("ACP session router", () => {
  it("buffers early updates until the opening owner binds", async () => {
    const router = new AcpSessionRouter();
    const received: string[] = [];
    const opening = router.withOpening(
      "owner-a",
      {
        onSessionUpdate: (notification) => {
          received.push(`${notification.sessionId}:${JSON.stringify(notification.update)}`);
        }
      },
      async () => {
        await router.sessionUpdate(update("session-a", "early"));
        return { sessionId: "session-a" };
      }
    );
    await opening;
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("session-a");
  });

  it("buffers permission, elicitation, and terminal during opening then flushes after bind", async () => {
    const router = new AcpSessionRouter();
    const received: string[] = [];
    let permission: ReturnType<AcpSessionRouter["permission"]> | undefined;
    let elicitation: ReturnType<AcpSessionRouter["elicitation"]> | undefined;
    let terminal: ReturnType<AcpSessionRouter["terminalOutput"]> | undefined;
    let unmatched: ReturnType<AcpSessionRouter["permission"]> | undefined;
    await router.withOpening(
      "owner-a",
      {
        onPermissionRequest: (request) => {
          received.push(`permission:${request.sessionId}`);
          return { outcome: { outcome: "selected", optionId: "allow" } };
        },
        onElicitationRequest: (request) => {
          const sessionId =
            "sessionId" in request && typeof request.sessionId === "string"
              ? request.sessionId
              : "none";
          received.push(`elicitation:${sessionId}`);
          return { action: "accept" };
        },
        onTerminalOutput: (request) => {
          received.push(`terminal:${request.sessionId}`);
          return { output: "out", truncated: false };
        }
      },
      async () => {
        permission = router.permission({
          sessionId: "session-a",
          toolCall: { toolCallId: "tool-1" },
          options: []
        });
        elicitation = router.elicitation({
          mode: "form",
          sessionId: "session-a",
          message: "early",
          requestedSchema: { type: "object", properties: {} }
        } satisfies CreateElicitationRequest);
        terminal = router.terminalOutput({
          sessionId: "session-a",
          terminalId: "term-1"
        });
        unmatched = router.permission({
          sessionId: "other",
          toolCall: { toolCallId: "tool-2" },
          options: []
        });
        expect(received).toEqual([]);
        return { sessionId: "session-a" };
      }
    );
    await expect(permission).resolves.toMatchObject({ outcome: { outcome: "selected" } });
    await expect(elicitation).resolves.toEqual({ action: "accept" });
    await expect(terminal).resolves.toEqual({ output: "out", truncated: false });
    await expect(unmatched).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(received).toEqual([
      "permission:session-a",
      "elicitation:session-a",
      "terminal:session-a"
    ]);
  });

  it("does not broadcast unknown session updates or permissions", async () => {
    const router = new AcpSessionRouter();
    const received: string[] = [];
    await router.withOpening(
      "owner-a",
      {
        onSessionUpdate: () => {
          received.push("update");
        },
        onPermissionRequest: () => {
          received.push("permission");
          return { outcome: { outcome: "selected", optionId: "allow" } };
        },
        onElicitationRequest: () => {
          received.push("elicitation");
          return { action: "accept" };
        }
      },
      async () => ({ sessionId: "session-a" })
    );
    await router.sessionUpdate(update("unknown", "nope"));
    const permission = await router.permission({
      sessionId: "unknown",
      toolCall: { toolCallId: "tool-1" },
      options: []
    });
    const elicitation = await router.elicitation({
      mode: "form",
      sessionId: "unknown",
      message: "x",
      requestedSchema: { type: "object", properties: {} }
    } satisfies CreateElicitationRequest);
    expect(received).toEqual([]);
    expect(permission).toEqual({ outcome: { outcome: "cancelled" } });
    expect(elicitation).toEqual({ action: "cancel" });
  });

  it("routes null-session elicitation only to the unique opening owner", async () => {
    const router = new AcpSessionRouter();
    const received: string[] = [];
    await router.withOpening(
      "owner-a",
      {
        onElicitationRequest: () => {
          received.push("open");
          return { action: "accept" };
        }
      },
      async () => {
        const response = await router.elicitation({
          mode: "form",
          requestId: 1,
          message: "during-open",
          requestedSchema: { type: "object", properties: {} }
        } satisfies CreateElicitationRequest);
        expect(response).toEqual({ action: "accept" });
        return { sessionId: "session-a" };
      }
    );
    const afterOpen = await router.elicitation({
      mode: "form",
      requestId: 2,
      message: "after-open",
      requestedSchema: { type: "object", properties: {} }
    } satisfies CreateElicitationRequest);
    expect(received).toEqual(["open"]);
    expect(afterOpen).toEqual({ action: "cancel" });
  });

  it("single-flights prompts on the same session and allows different sessions to run concurrently", async () => {
    const router = new AcpSessionRouter();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = router.runPrompt("session-a", async () => {
      order.push("a-start");
      await firstGate;
      order.push("a-end");
      return "a";
    });
    const second = router.runPrompt("session-a", async () => {
      order.push("a2");
      return "a2";
    });
    const other = router.runPrompt("session-b", async () => {
      order.push("b");
      return "b";
    });
    await expect(other).resolves.toBe("b");
    expect(order).toContain("b");
    expect(order).not.toContain("a2");
    releaseFirst?.();
    await expect(first).resolves.toBe("a");
    await expect(second).resolves.toBe("a2");
    expect(order).toEqual(["a-start", "b", "a-end", "a2"]);
  });
});
