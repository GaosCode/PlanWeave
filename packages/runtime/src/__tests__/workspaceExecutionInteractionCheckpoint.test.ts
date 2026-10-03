import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteInteractionViewSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import { projectWorkspaceExecutionCoordinatorView } from "../workspaceExecution/nodeView.js";
import { getRunSession, updateRunSession } from "../runSessions/repository.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import {
  fixture,
  request,
  pendingInteraction,
  emptyInteractions,
  deferred,
  observation
} from "./workspaceExecutionCoordinatorTestFixture.js";

const faults = vi.hoisted(() => ({ failSettled: false, failIntent: false, failRead: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (faults.failRead && String(args[0]).endsWith("session.json"))
        throw new Error("injected session read failure");
      return actual.readFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (
        faults.failIntent &&
        String(args[1]).endsWith("session.json") &&
        (await actual.readFile(args[0], "utf8")).includes('"responseIntent"')
      ) {
        faults.failIntent = false;
        throw new Error("injected intent rename failure");
      }
      if (
        faults.failSettled &&
        String(args[1]).endsWith("session.json") &&
        (await actual.readFile(args[0], "utf8")).includes('"status": "settled"')
      ) {
        faults.failSettled = false;
        throw new Error("injected session rename failure");
      }
      return actual.rename(...args);
    }
  };
});
afterEach(() => {
  faults.failSettled = false;
  faults.failIntent = false;
  faults.failRead = false;
});

const response = {
  type: "interaction.permission_response" as const,
  dispatchId: "dispatch-attempt-1",
  leaseId: "lease-1",
  executionAttemptId: "attempt-1",
  actionId: "action-1",
  acpSessionId: "acp-session-1",
  decision: "select_option" as const,
  optionId: "tool-approve-once"
};

describe("remote interaction checkpoints", () => {
  it("recovers the same settlement after remote acceptance and a failed durable checkpoint", async () => {
    const { root } = await createTestWorkspace();
    const pending = pendingInteraction("attempt-1").items[0]!;
    let settled: ReturnType<typeof remoteInteractionViewSchema.parse> | undefined;
    let deliveries = 0;
    let now = new Date("2030-01-01T00:10:00.000Z");
    const f = fixture({
      packageWorkspace: root,
      clock: () => now,
      interactions: async () => (settled ? emptyInteractions() : pendingInteraction("attempt-1")),
      respond: async (answer) => {
        if (!settled) {
          deliveries += 1;
          settled = remoteInteractionViewSchema.parse({
            ...pending,
            status: "settled",
            settlement: answer,
            settledAt: "2030-01-01T00:10:00.000Z",
            settledBy: "human-1"
          });
        }
        return settled;
      }
    });
    const started = await f.coordinator.execute(request(root));
    faults.failSettled = true;
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response
      })
    ).rejects.toMatchObject({ code: "remote_interaction_checkpoint_failed" });
    const checkpoint = (await getRunSession(root, started.session.sessionId)).session;
    expect(checkpoint.workspaceExecution?.interactions[0]?.responseIntent?.response).toEqual(
      response
    );
    expect(
      projectWorkspaceExecutionCoordinatorView({ ...started, session: checkpoint }).session
        .interactionStatus
    ).toEqual([{ key: checkpoint.workspaceExecution?.interactions[0]?.key, status: "pending" }]);
    now = new Date("2030-01-01T01:00:01.000Z");
    const observed = await f.coordinator.synchronizeInteractions({
      request: request(root),
      sessionId: started.session.sessionId
    });
    expect(observed.items).toEqual([]);
    expect(deliveries).toBe(1);
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response: { ...response, optionId: "tool-reject-once" }
      })
    ).rejects.toMatchObject({ code: "remote_interaction_response_conflict" });
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response: { ...response, acpSessionId: "forged-session" }
      })
    ).rejects.toMatchObject({ code: "workspace_execution_resume_mismatch" });
    expect(f.respond).toHaveBeenCalledTimes(1);
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response
      })
    ).resolves.toMatchObject({ type: "interaction_resolved", data: response });
    expect(
      (await getRunSession(root, started.session.sessionId)).session.workspaceExecution
        ?.interactions
    ).toEqual([expect.objectContaining({ status: "settled" })]);
    expect(deliveries).toBe(1);
    expect(f.respond).toHaveBeenCalledTimes(2);
  });
  it("rejects a changed request before reusing an existing response intent", async () => {
    const { root } = await createTestWorkspace();
    let changed = false;
    const f = fixture({
      packageWorkspace: root,
      interactions: async () => {
        const page = pendingInteraction("attempt-1");
        const permission = page.items[0]!.request;
        if (changed && permission.type === "interaction.permission_requested")
          permission.title = "A different permission request";
        return page;
      },
      respond: async () => {
        throw new Error("network unavailable");
      }
    });
    const started = await f.coordinator.execute(request(root));
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response
      })
    ).rejects.toMatchObject({ code: "remote_interaction_response_unavailable" });
    const durable = (await getRunSession(root, started.session.sessionId)).session
      .workspaceExecution?.interactions[0]?.responseIntent;
    changed = true;
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response
      })
    ).rejects.toMatchObject({ code: "remote_interaction_response_conflict" });
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(
      (await getRunSession(root, started.session.sessionId)).session.workspaceExecution
        ?.interactions[0]?.responseIntent
    ).toEqual(durable);
  });

  it("does not deliver a response when the intent checkpoint or session read fails", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      interactions: async () => pendingInteraction("attempt-1")
    });
    const started = await f.coordinator.execute(request(root));
    faults.failIntent = true;
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response
      })
    ).rejects.toThrow("injected intent rename failure");
    expect(f.respond).not.toHaveBeenCalled();
    expect(
      (await getRunSession(root, started.session.sessionId)).session.workspaceExecution
        ?.interactions[0]?.responseIntent
    ).toBeUndefined();
    faults.failRead = true;
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response
      })
    ).rejects.toThrow();
    expect(f.respond).not.toHaveBeenCalled();
  });

  it.each([
    "network",
    "abort-before",
    "abort-page",
    "cursor"
  ] as const)("fails closed on %s without checkpointing partial pages", async (failure) => {
    const { root } = await createTestWorkspace();
    const controller = new AbortController();
    let activated = false;
    const f = fixture({
      packageWorkspace: root,
      interactions: async () => {
        if (!activated) return emptyInteractions();
        if (failure === "network") throw new Error("network down");
        if (failure === "abort-page") controller.abort();
        return { ...pendingInteraction("attempt-1"), nextCursor: failure === "cursor" ? 0 : null };
      }
    });
    const started = await f.coordinator.execute(request(root));
    activated = true;
    if (failure === "abort-before") controller.abort();
    await expect(
      f.coordinator.synchronizeInteractions({
        request: request(root),
        sessionId: started.session.sessionId,
        signal: controller.signal
      })
    ).rejects.toThrow();
    const stored = (await getRunSession(root, started.session.sessionId)).session;
    expect(stored.workspaceExecution?.interactions).toEqual([]);
    expect(stored.stateVersion).toBe(started.session.stateVersion);
    expect(f.respond).not.toHaveBeenCalled();
  });

  it.each([
    "operation",
    "dispatch",
    "lease",
    "attempt",
    "session",
    "action"
  ] as const)("rejects a mismatched %s before delivery", async (field) => {
    const { root } = await createTestWorkspace();
    let published = false;
    const pending = pendingInteraction("attempt-1");
    const wrongPage =
      field === "operation"
        ? {
            ...pending,
            items: pending.items.map((item) => ({ ...item, operationId: "other-operation" }))
          }
        : pending;
    const f = fixture({
      packageWorkspace: root,
      dispatch: async () => observation({ leaseId: "lease-1" }),
      interactions: async () => (published ? wrongPage : emptyInteractions())
    });
    const started = await f.coordinator.execute(request(root));
    published = true;
    const patch =
      field === "dispatch"
        ? { dispatchId: "other-dispatch" }
        : field === "lease"
          ? { leaseId: "other-lease" }
          : field === "attempt"
            ? { executionAttemptId: "other-attempt" }
            : field === "session"
              ? { acpSessionId: "other-session" }
              : field === "action"
                ? { actionId: "other-action" }
                : {};
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response: { ...response, ...patch }
      })
    ).rejects.toMatchObject({ code: "workspace_execution_resume_mismatch" });
    expect(f.respond).not.toHaveBeenCalled();
  });

  it("expires at the exact deadline and preserves expiry when the peer repeats pending", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      clock: () => new Date("2030-01-01T01:00:00.000Z"),
      interactions: async () => pendingInteraction("attempt-1")
    });
    const started = await f.coordinator.execute(request(root));
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response
      })
    ).rejects.toThrow();
    const observed = await f.coordinator.synchronizeInteractions({
      request: request(root),
      sessionId: started.session.sessionId
    });
    expect(observed.items[0]?.status).toBe("expired");
    expect(f.respond).not.toHaveBeenCalled();
  });

  it("merges pages monotonically and rejects a stale attempt observed during a slow query", async () => {
    const { root } = await createTestWorkspace();
    let published = false;
    const gate = deferred<ReturnType<typeof pendingInteraction>>();
    const entered = deferred<void>();
    const old = fixture({
      packageWorkspace: root,
      interactions: async () => {
        if (!published) return emptyInteractions();
        entered.resolve();
        return gate.promise;
      }
    });
    const started = await old.coordinator.execute(request(root));
    published = true;
    const slow = old.coordinator.synchronizeInteractions({
      request: request(root),
      sessionId: started.session.sessionId
    });
    await entered.promise;
    const next = fixture({
      packageWorkspace: root,
      observe: async () => observation({ attemptId: "attempt-2", revision: 2 }),
      replay: async (afterCursor) => ({
        executionAttemptId: "attempt-2",
        afterCursor,
        cursor: afterCursor,
        highWatermark: afterCursor,
        eventProtocolVersion: 2 as const,
        hasMore: false,
        events: []
      }),
      interactions: async () => pendingInteraction("attempt-2")
    });
    await next.coordinator.follow(request(root), started.session.sessionId);
    gate.resolve(pendingInteraction("attempt-1"));
    await expect(slow).rejects.toMatchObject({ code: "workspace_execution_resume_mismatch" });
    const stored = (await getRunSession(root, started.session.sessionId)).session;
    expect(stored.workspaceExecution?.handle).toMatchObject({ executionAttemptId: "attempt-2" });
    expect(stored.workspaceExecution?.interactions).toHaveLength(1);
    const paged = fixture({
      packageWorkspace: root,
      interactions: async (cursor) =>
        cursor === 0
          ? {
              ...pendingInteraction("attempt-2"),
              items: pendingInteraction("attempt-2").items.map((item) => ({
                ...item,
                status: "settled" as const
              })),
              nextCursor: 1
            }
          : pendingInteraction("attempt-2")
    });
    const merged = await paged.coordinator.synchronizeInteractions({
      request: request(root),
      sessionId: started.session.sessionId
    });
    expect(merged.items.map((item) => item.status)).toEqual(["settled", "settled"]);
    expect(merged.session.workspaceExecution?.interactions).toHaveLength(1);
  });
  it("serializes different decisions and preserves a settlement against a slow older page", async () => {
    const { root } = await createTestWorkspace();
    const pending = pendingInteraction("attempt-1").items[0]!;
    const oldPage = deferred<ReturnType<typeof pendingInteraction>>();
    const pageEntered = deferred<void>();
    const deliveryEntered = deferred<void>();
    const delivery = deferred<ReturnType<typeof remoteInteractionViewSchema.parse>>();
    let holdNext = false;
    const f = fixture({
      packageWorkspace: root,
      interactions: async () => {
        if (holdNext) {
          holdNext = false;
          pageEntered.resolve();
          return oldPage.promise;
        }
        return pendingInteraction("attempt-1");
      },
      respond: async () => {
        const durable = (await getRunSession(root, started.session.sessionId)).session;
        expect(durable.workspaceExecution?.interactions[0]?.responseIntent?.response).toEqual(
          response
        );
        deliveryEntered.resolve();
        return delivery.promise;
      }
    });
    const started = await f.coordinator.execute(request(root));
    holdNext = true;
    const older = f.coordinator.synchronizeInteractions({
      request: request(root),
      sessionId: started.session.sessionId
    });
    await pageEntered.promise;
    await updateRunSession(root, started.session.sessionId, {
      error: "independent concurrent update"
    });
    const first = f.coordinator.respond({
      request: request(root),
      sessionId: started.session.sessionId,
      response
    });
    await deliveryEntered.promise;
    await expect(
      f.coordinator.respond({
        request: request(root),
        sessionId: started.session.sessionId,
        response: { ...response, optionId: "tool-reject-once" }
      })
    ).rejects.toMatchObject({ code: "remote_interaction_response_conflict" });
    delivery.resolve(
      remoteInteractionViewSchema.parse({
        ...pending,
        status: "settled",
        settlement: response,
        settledBy: "human-1",
        settledAt: "2030-01-01T00:10:00.000Z"
      })
    );
    await first;
    oldPage.resolve(pendingInteraction("attempt-1"));
    const stale = await older;
    expect(stale.items[0]?.status).toBe("settled");
    const durable = (await getRunSession(root, started.session.sessionId)).session;
    expect(durable.error).toBe("independent concurrent update");
    expect(durable.workspaceExecution?.interactions).toEqual([
      expect.objectContaining({ status: "settled" })
    ]);
    expect(f.respond).toHaveBeenCalledTimes(1);
  });
});
