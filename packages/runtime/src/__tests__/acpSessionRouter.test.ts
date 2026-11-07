import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
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
      {
        ownerId: "owner-a",
        handlers: {
          onSessionUpdate: (notification) => {
            received.push(`${notification.sessionId}:${JSON.stringify(notification.update)}`);
          }
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
      {
        ownerId: "owner-a",
        handlers: {
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
      {
        ownerId: "owner-a",
        handlers: {
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
      {
        ownerId: "owner-a",
        handlers: {
          onElicitationRequest: () => {
            received.push("open");
            return { action: "accept" };
          }
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

  it("settles buffered requests when a replay handler fails and permits another owner", async () => {
    const router = new AcpSessionRouter();
    let permission: ReturnType<AcpSessionRouter["permission"]> | undefined;
    const owner = {
      ownerId: "owner-a",
      handlers: {
        onSessionUpdate: () => {
          throw new Error("replay failed");
        }
      }
    };
    await expect(
      router.withOpening(owner, async () => {
        await router.sessionUpdate(update("session-a", "early"));
        permission = router.permission({
          sessionId: "session-a",
          toolCall: { toolCallId: "pending" },
          options: []
        });
        return { sessionId: "session-a" };
      })
    ).rejects.toThrow("replay failed");
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(
      router.withOpening({ ownerId: "owner-a", handlers: {} }, async () => ({ sessionId: "new-a" }))
    ).resolves.toEqual({ sessionId: "new-a" });
  });

  it("does not flush remaining buffered events to a released owner or let its late release remove a new owner", async () => {
    const router = new AcpSessionRouter();
    const received: string[] = [];
    const owner = {
      ownerId: "owner-a",
      handlers: {
        onSessionUpdate: () => {
          received.push("old");
          router.unbindOwner(owner);
        }
      }
    };
    await expect(
      router.withOpening(owner, async () => {
        await router.sessionUpdate(update("session-a", "first"));
        await router.sessionUpdate(update("session-a", "second"));
        return { sessionId: "session-a" };
      })
    ).rejects.toThrow("released during opening");
    const replacement = {
      ownerId: "owner-a",
      handlers: {
        onSessionUpdate: () => {
          received.push("new");
        }
      }
    };
    await router.withOpening(replacement, async () => ({ sessionId: "session-a" }));
    router.unbindOwner(owner);
    await router.sessionUpdate(update("session-a", "fresh"));
    expect(received).toEqual(["old", "new"]);
  });

  it("does not reserve an already-aborted owner and permits its later valid use", async () => {
    const router = new AcpSessionRouter();
    const controller = new AbortController();
    const reason = new Error("cancelled before admission");
    controller.abort(reason);
    const owner = { ownerId: "pre-aborted", handlers: {} };
    const opening = vi.fn(async () => ({ sessionId: "unreachable" }));
    await expect(router.withOpening(owner, opening, { signal: controller.signal })).rejects.toBe(
      reason
    );
    expect(opening).not.toHaveBeenCalled();
    await expect(router.withOpening(owner, async () => ({ sessionId: "valid" }))).resolves.toEqual({
      sessionId: "valid"
    });
  });

  it("settles a released queued owner before its predecessor and protects a same-name replacement", async () => {
    const router = new AcpSessionRouter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = router.withOpening({ ownerId: "a", handlers: {} }, async () => {
      await gate;
      return { sessionId: "a" };
    });
    const old = { ownerId: "queued", handlers: {} };
    const opening = vi.fn(async () => ({ sessionId: "must-not-open" }));
    const cancelled = router.withOpening(old, opening);
    router.unbindOwner(old);
    await expect(cancelled).rejects.toThrow("released during opening");
    const received: string[] = [];
    const replacement = {
      ownerId: "queued",
      handlers: {
        onSessionUpdate: () => {
          received.push("replacement");
        }
      }
    };
    const next = router.withOpening(replacement, async () => ({ sessionId: "new" }));
    router.unbindOwner(old);
    release();
    await a;
    await next;
    expect(opening).not.toHaveBeenCalled();
    await router.sessionUpdate(update("new", "still-routed"));
    expect(received).toEqual(["replacement"]);
  });

  it("hands only the unused queue budget to the active RPC and releases its queue timer", async () => {
    const router = new AcpSessionRouter();
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const a = router.withOpening({ ownerId: "a", handlers: {} }, async () => {
        await gate;
        return { sessionId: "a" };
      });
      let handedTimeout: number | undefined;
      const b = router.withOpening(
        { ownerId: "b", handlers: {} },
        async (options) => {
          handedTimeout = options.timeoutMs;
          return { sessionId: "b" };
        },
        { timeoutMs: 100 }
      );
      now = 40;
      release();
      await a;
      await b;
      expect(handedTimeout).toBe(60);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects an expired handoff without invoking its RPC even before the timer callback runs", async () => {
    const router = new AcpSessionRouter();
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const a = router.withOpening({ ownerId: "a", handlers: {} }, async () => {
        await gate;
        return { sessionId: "a" };
      });
      const opening = vi.fn(async () => ({ sessionId: "unreachable" }));
      const owner = { ownerId: "expired", handlers: {} };
      const b = router.withOpening(owner, opening, { timeoutMs: 100 });
      const rejected = expect(b).rejects.toThrow("timed out");
      now = 100;
      release();
      await a;
      await rejected;
      expect(opening).not.toHaveBeenCalled();
      await expect(
        router.withOpening({ ownerId: "expired", handlers: {} }, async () => ({
          sessionId: "retry"
        }))
      ).resolves.toEqual({ sessionId: "retry" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the active RPC cancellation signal and rolls back after an abort past handoff", async () => {
    const router = new AcpSessionRouter();
    const controller = new AbortController();
    const reason = new Error("active abort");
    let entered = false;
    const owner = { ownerId: "active", handlers: {} };
    const opening = router.withOpening(
      owner,
      (options) =>
        new Promise<{ sessionId: string }>((_resolve, reject) => {
          entered = true;
          expect(options.signal).toBe(controller.signal);
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true
          });
        }),
      { signal: controller.signal, timeoutMs: 1000 }
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort(reason);
    await expect(opening).rejects.toBe(reason);
    await expect(
      router.withOpening({ ownerId: "active", handlers: {} }, async () => ({ sessionId: "retry" }))
    ).resolves.toEqual({ sessionId: "retry" });
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
