import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PersistentRunnerInteractionChannel,
  RunnerInteractionChannelError
} from "../autoRun/persistentRunnerInteractionChannel.js";
import {
  runnerPermissionInteractionRequestSchema,
  runnerPermissionInteractionResponseSchema
} from "../autoRun/runnerInteractionContract.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import { AcpOwnerStateWriter } from "../autoRun/acpOwnerState.js";

async function fixture() {
  const runDir = await mkdtemp(join(tmpdir(), "planweave-persistent-channel-"));
  const request = runnerPermissionInteractionRequestSchema.parse({
    version: "planweave.runner-interaction/v1",
    kind: "permission",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      claimRef: "T-001#B-001",
      executorRunId: "RUN-001",
      sessionId: "session-1",
      requestId: "permission:1",
      ownerLeaseId: "11111111-1111-4111-8111-111111111111",
      ownerGeneration: 1
    },
    requestedAt: "2026-07-17T00:00:00.000Z",
    summary: "Run the focused tests",
    toolCallId: "tool-1",
    options: [
      { optionId: "allow", label: "Allow once", decision: "approve" },
      { optionId: "deny", label: "Deny", decision: "deny" }
    ]
  });
  const store = new PersistentRunnerInteractionStore(runDir);
  const order: string[] = [];
  const channel = new PersistentRunnerInteractionChannel({
    store,
    pollIntervalMs: 5,
    publishPending: async () => {
      order.push("pending");
    },
    setWaiting: async (_requestId, waiting) => {
      order.push(waiting ? "waiting" : "running");
    },
    notifyRequired: async () => {
      order.push("notified");
    },
    publishResult: async (_request, decision) => {
      order.push(`result:${decision.kind}`);
    }
  });
  return { runDir, request, store, channel, order };
}

async function respond(
  store: PersistentRunnerInteractionStore,
  request: Awaited<ReturnType<typeof fixture>>["request"],
  decision: { kind: "select"; optionId: string } | { kind: "cancel" }
) {
  return store.createResponse(
    runnerPermissionInteractionResponseSchema.parse({
      version: "planweave.runner-interaction-response/v1",
      identity: request.identity,
      decision,
      respondedAt: "2026-07-17T00:00:01.000Z",
      decisionSource: "test-client",
      reason: decision.kind === "cancel" ? "User cancelled" : null
    })
  );
}

describe("PersistentRunnerInteractionChannel", () => {
  it.each([
    ["allow", "approve"],
    ["deny", "deny"]
  ] as const)("returns the advertised %s decision from another store instance", async (optionId, decision) => {
    const item = await fixture();
    const pending = item.channel.requestPermission(item.request, {
      signal: new AbortController().signal,
      deadline: null
    });
    await vi.waitFor(async () => {
      await expect(item.store.readSnapshot("permission:1")).resolves.toMatchObject({
        status: "pending"
      });
    });
    await respond(new PersistentRunnerInteractionStore(item.runDir), item.request, {
      kind: "select",
      optionId
    });
    await expect(pending).resolves.toMatchObject({
      kind: "select",
      option: { optionId, decision }
    });
    expect(item.order).toEqual(["pending", "waiting", "notified", "result:select", "running"]);
  });

  it("keeps cancel distinct from deny", async () => {
    const item = await fixture();
    const pending = item.channel.requestPermission(item.request, {
      signal: new AbortController().signal,
      deadline: null
    });
    await vi.waitFor(() => expect(item.order).toContain("notified"));
    await respond(new PersistentRunnerInteractionStore(item.runDir), item.request, {
      kind: "cancel"
    });
    await expect(pending).resolves.toEqual({ kind: "cancel" });
  });

  it("expires and releases waits on abort and deadline", async () => {
    const aborted = await fixture();
    const abortController = new AbortController();
    const abortWait = aborted.channel.requestPermission(aborted.request, {
      signal: abortController.signal,
      deadline: null
    });
    await vi.waitFor(() => expect(aborted.order).toContain("notified"));
    abortController.abort("test abort");
    await expect(abortWait).resolves.toEqual({ kind: "expired", reason: "aborted" });
    expect(aborted.order.at(-1)).toBe("running");
    await expect(aborted.store.readSnapshot("permission:1")).resolves.toMatchObject({
      status: "expired",
      response: null,
      ownerResult: { reason: "aborted" }
    });

    const expired = await fixture();
    await expect(
      expired.channel.requestPermission(expired.request, {
        signal: new AbortController().signal,
        deadline: new Date(0)
      })
    ).resolves.toEqual({ kind: "expired", reason: "deadline" });
    expect(expired.order.at(-1)).toBe("running");
    await expect(expired.store.readSnapshot("permission:1")).resolves.toMatchObject({
      status: "expired",
      response: null,
      ownerResult: { reason: "deadline" }
    });
    await expect(
      respond(new PersistentRunnerInteractionStore(expired.runDir), expired.request, {
        kind: "select",
        optionId: "allow"
      })
    ).rejects.toMatchObject({
      code: "interaction_already_answered",
      details: { winnerKind: "owner_result" }
    });
  });

  it.each([
    "abort",
    "deadline"
  ] as const)("returns the canonical response when it wins the %s expiry CAS", async (expiryKind) => {
    const item = await fixture();
    const externalStore = new PersistentRunnerInteractionStore(item.runDir);
    class ResponseWinningStore extends PersistentRunnerInteractionStore {
      override async settleOwnerResult(
        result: Parameters<PersistentRunnerInteractionStore["settleOwnerResult"]>[0]
      ) {
        await respond(externalStore, item.request, { kind: "select", optionId: "allow" });
        return super.settleOwnerResult(result);
      }
    }
    const order: string[] = [];
    const channel = new PersistentRunnerInteractionChannel({
      store: new ResponseWinningStore(item.runDir),
      pollIntervalMs: 5,
      publishPending: async () => undefined,
      publishResult: async (_request, decision) => {
        order.push(`result:${decision.kind}`);
      },
      setWaiting: async () => undefined,
      notifyRequired: async () => {
        order.push("notified");
      }
    });
    const abortController = new AbortController();
    const pending = channel.requestPermission(item.request, {
      signal: abortController.signal,
      deadline: expiryKind === "deadline" ? new Date(0) : null
    });
    if (expiryKind === "abort") {
      await vi.waitFor(() => expect(order).toContain("notified"));
      abortController.abort("test abort");
    }

    await expect(pending).resolves.toMatchObject({
      kind: "select",
      option: { optionId: "allow" }
    });
    expect(order).toContain("result:select");
    await expect(item.store.readSnapshot(item.request.identity.requestId)).resolves.toMatchObject({
      status: "answered",
      ownerResult: null,
      response: { decisionSource: "test-client" }
    });
  });

  it.each([
    "audit",
    "heartbeat"
  ] as const)("expires the mailbox without notifying when %s establishment fails", async (failurePoint) => {
    const item = await fixture();
    const order: string[] = [];
    let waitingCalls = 0;
    const channel = new PersistentRunnerInteractionChannel({
      store: item.store,
      pollIntervalMs: 5,
      publishPending: async () => {
        order.push("pending");
        if (failurePoint === "audit") throw new Error("audit unavailable");
      },
      publishResult: async (_request, decision) => {
        order.push(`result:${decision.kind}:${decision.kind === "expired" ? decision.reason : ""}`);
      },
      setWaiting: async (_requestId, waiting) => {
        waitingCalls += 1;
        order.push(waiting ? "waiting" : "running");
        if (failurePoint === "heartbeat" && waiting) throw new Error("heartbeat unavailable");
      },
      notifyRequired: async () => {
        order.push("notified");
      }
    });
    await expect(
      channel.requestPermission(item.request, {
        signal: new AbortController().signal,
        deadline: null
      })
    ).rejects.toMatchObject({ code: "interaction_persistence_failed" });
    await expect(item.store.readSnapshot("permission:1")).resolves.toMatchObject({
      status: "expired",
      response: null,
      ownerResult: { reason: "establishment_failed" }
    });
    expect(order).toContain("result:expired:establishment_failed");
    expect(order).not.toContain("notified");
    expect(waitingCalls).toBe(failurePoint === "heartbeat" ? 2 : 0);
  });

  it("keeps the mailbox responsive when the broker notification fails", async () => {
    const item = await fixture();
    const diagnostics: string[] = [];
    const channel = new PersistentRunnerInteractionChannel({
      store: item.store,
      pollIntervalMs: 5,
      publishPending: async () => undefined,
      publishResult: async () => undefined,
      setWaiting: async () => undefined,
      notifyRequired: async () => {
        throw new Error("broker unavailable");
      },
      publishDiagnostic: async (code) => {
        diagnostics.push(code);
      }
    });
    const pending = channel.requestPermission(item.request, {
      signal: new AbortController().signal,
      deadline: null
    });
    await vi.waitFor(() => expect(diagnostics).toEqual(["interaction_observer_failed"]));
    await respond(new PersistentRunnerInteractionStore(item.runDir), item.request, {
      kind: "select",
      optionId: "allow"
    });
    await expect(pending).resolves.toMatchObject({ kind: "select" });
  });

  it("fails closed on request persistence and invalid canonical responses", async () => {
    const persistence = await fixture();
    const missingStore = new PersistentRunnerInteractionStore(join(persistence.runDir, "missing"));
    const unavailable = new PersistentRunnerInteractionChannel({
      store: missingStore,
      pollIntervalMs: 5,
      publishPending: async () => undefined,
      publishResult: async () => undefined,
      setWaiting: async () => undefined
    });
    await expect(
      unavailable.requestPermission(persistence.request, {
        signal: new AbortController().signal,
        deadline: null
      })
    ).rejects.toMatchObject({ code: "interaction_persistence_failed" });

    const invalid = await fixture();
    const pending = invalid.channel.requestPermission(invalid.request, {
      signal: new AbortController().signal,
      deadline: null
    });
    await vi.waitFor(async () => {
      await expect(invalid.store.readSnapshot("permission:1")).resolves.toMatchObject({
        status: "pending"
      });
    });
    const interactionDir = join(
      invalid.runDir,
      "interactions",
      Buffer.from("permission:1", "utf8").toString("base64url")
    );
    await writeFile(join(interactionDir, "response.json"), "{invalid\n", { mode: 0o600 });
    await expect(pending).rejects.toBeInstanceOf(RunnerInteractionChannelError);
    await expect(pending).rejects.toMatchObject({ code: "interaction_response_invalid" });
  });
});

describe("AcpOwnerStateWriter", () => {
  it("recovers its queue after one-sided failure and preserves terminal ordering", async () => {
    const writes: Array<{ target: string; value: Record<string, unknown> }> = [];
    let failMetadataOnce = true;
    const writer = new AcpOwnerStateWriter({
      heartbeatPath: "heartbeat.json",
      metadataPath: "metadata.json",
      ownerLeaseId: "11111111-1111-4111-8111-111111111111",
      ownerGeneration: 1,
      startedAt: "2026-07-17T00:00:00.000Z",
      metadata: { runId: "RUN-001", sessionId: "session-1" },
      write: async (target, value) => {
        const record = value as Record<string, unknown>;
        writes.push({ target, value: record });
        if (
          target === "metadata.json" &&
          record.runnerLifecycle === "waiting_interaction" &&
          failMetadataOnce
        ) {
          failMetadataOnce = false;
          throw new Error("metadata write failed");
        }
      }
    });
    await writer.update("running", { sessionId: "session-1" });
    await expect(writer.setInteractionWaiting("permission:1", true)).rejects.toThrow(
      "owner state persistence failed"
    );
    await expect(writer.update("failed", { failureReason: "test" })).resolves.toBeUndefined();

    const terminalWrites = writes.filter(({ value }) => value.runnerLifecycle === "terminal");
    expect(terminalWrites).toHaveLength(2);
    expect(terminalWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "heartbeat.json" }),
        expect.objectContaining({ target: "metadata.json" })
      ])
    );
    for (const { value } of terminalWrites) {
      expect(value).toMatchObject({
        ownerLeaseId: "11111111-1111-4111-8111-111111111111",
        ownerGeneration: 1,
        sessionId: "session-1",
        status: "failed",
        pendingInteractionIds: []
      });
    }
    expect(writes.at(-1)?.value.runnerLifecycle).toBe("terminal");
  });
});
