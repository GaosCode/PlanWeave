import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ActiveAgentRunRegistry,
  type ActiveAgentRunHandle
} from "../autoRun/activeAgentRunRegistry.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
import { acpEventReadModels } from "../autoRun/acpEventReadModel.js";
import {
  consumeRunnerRecordReadModel,
  readRunnerRecordReadModel,
  type RunnerRecordReadModel
} from "../autoRun/runnerRecordReadModel.js";
import {
  cleanupRunnerLiveControl,
  createLiveOwnership,
  respondToPendingRunnerRequest,
  type LivePendingRequestHandle,
  type RunnerLiveControl
} from "../autoRun/liveControl.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const acpFixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function controllerRun(root: string, scenario: string, prompt = scenario): AcpSessionRun {
  return {
    kind: "implementation",
    identity: {
      scope: root,
      desktopRunId: "AUTO-RUN-001",
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001"
    },
    runDir: root,
    metadataPath: join(root, "metadata.json"),
    prompt,
    cwd: root,
    launch: { command: process.execPath, args: [acpFixture, scenario] },
    executorName: "mock-acp",
    agentId: "codex",
    taskId: "T-001",
    metadataIdentity: { blockId: "B-001" },
    projectId: "project-1",
    canvasId: "default"
  };
}

function fixture(options: { closeSupported?: boolean; order?: string[] } = {}) {
  const order = options.order ?? [];
  const ownership = createLiveOwnership("scope:RUN-001", 1);
  const respond = vi.fn(async () => {
    order.push("respond");
  });
  const reject = vi.fn(async () => {
    order.push("reject-request");
  });
  const control: RunnerLiveControl = {
    ownership,
    sessionId: "session-1",
    process: {
      pid: 42,
      terminate: vi.fn(async () => {
        order.push("process");
      })
    },
    connection: {
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        order.push("connection");
      }),
      cancelSession: vi.fn(async () => {
        order.push("cancel");
      }),
      closeSession: vi.fn(async () => {
        order.push("close-session");
      }),
      supportsSessionClose: options.closeSupported === true
    },
    interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
    pendingRequests: new Map([
      [
        "permission-1",
        {
          requestId: "permission-1",
          interactionId: "permission-1",
          kind: "permission",
          requestedAt: "2026-07-11T00:00:00.000Z",
          summary: "Approve command?",
          permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }],
          respond,
          reject
        }
      ]
    ]),
    pendingOperations: new Map()
  };
  const handle: ActiveAgentRunHandle = {
    identity: {
      scope: "scope",
      desktopRunId: "AUTO-RUN-001",
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-006#B-001",
      sessionId: "session-1"
    },
    connection: {
      processId: 42,
      pendingOperationCount: 0,
      pendingOperations: new Map(),
      stderr: [],
      closed: Promise.resolve(),
      initialize: vi.fn(),
      newSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(async () => undefined),
      closeSession: vi.fn(),
      dispose: vi.fn(async () => undefined)
    },
    abortController: new AbortController(),
    eventSink: () => undefined,
    ownership,
    control,
    lifecycleState: "waiting_interaction"
  };
  return { control, handle, order, ownership, reject, respond };
}

describe("ACP live actions", () => {
  it("uses one canonical producer identity for live permission and elicitation state", async () => {
    for (const scenario of ["permission-deny", "elicitation-secret"] as const) {
      const root = await mkdtemp(join(tmpdir(), `planweave-acp-canonical-${scenario}-`));
      const controller = new AcpSessionController();
      let activeSnapshot: RunnerRecordReadModel | null = null;
      let inactiveSnapshot: RunnerRecordReadModel | null = null;
      let resolveInactive!: (snapshot: RunnerRecordReadModel) => void;
      const inactive = new Promise<RunnerRecordReadModel>((resolve) => {
        resolveInactive = resolve;
      });
      try {
        await expect(
          controller.execute(controllerRun(root, scenario), {
            timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
            interactionBroker: {
              mode: "interactive",
              requestAvailable: async (request) => {
                const consumer = await consumeRunnerRecordReadModel({
                  runDir: root,
                  metadata: {
                    runnerKind: "acp",
                    runId: "RUN-001",
                    ref: "T-001#B-001",
                    taskId: "T-001",
                    blockId: "B-001",
                    executorRunId: "RUN-001",
                    desktopRunId: "AUTO-RUN-001",
                    runSessionId: "SESSION-001",
                    sessionId: "mock-session-1"
                  },
                  subscriber: (snapshot) => {
                    if (!snapshot.interaction.active) resolveInactive(snapshot);
                  }
                });
                activeSnapshot = consumer.snapshot;
                const persisted = consumer.snapshot?.events.find(
                  (event) => event.body.kind === "interaction"
                );
                expect(persisted?.body.kind).toBe("interaction");
                if (persisted?.body.kind === "interaction") {
                  expect(persisted.body.interaction.requestId).toBe(request.requestId);
                  expect(persisted.body.interaction.requestedAt).toBe(request.requestedAt);
                }
                if (request.kind === "permission") await request.respond("deny");
                else await request.reject("test resolution");
              }
            }
          })
        ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
        inactiveSnapshot = await inactive;
        expect(activeSnapshot?.interaction.persisted).toBe(true);
        expect(inactiveSnapshot?.interaction.active).toBe(false);

        const reopened = await readRunnerRecordReadModel({
          runDir: root,
          metadata: {
            runnerKind: "acp",
            runId: "RUN-001",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            executorRunId: "RUN-001",
            desktopRunId: "AUTO-RUN-001",
            runSessionId: "SESSION-001",
            sessionId: "mock-session-1"
          }
        });
        expect(reopened?.interaction).toMatchObject({
          persisted: true,
          active: false,
          stale: true,
          activeRequests: []
        });
        expect(
          reopened?.events.some(
            (event) =>
              event.body.kind === "interaction_result" &&
              event.body.outcome === (scenario === "permission-deny" ? "denied" : "cancelled")
          )
        ).toBe(true);
      } finally {
        acpEventReadModels.release(root);
      }
    }
  });

  it("sends a Desktop broker deny exactly once and clears the pending request", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-deny-"));
    const registry = new ActiveAgentRunRegistry();
    const available = vi.fn(async (request: LivePendingRequestHandle) => {
      await request.respond("deny");
    });
    const controller = new AcpSessionController(registry);
    await expect(
      controller.execute(controllerRun(root, "permission-deny"), {
        timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
        interactionBroker: { mode: "interactive", requestAvailable: available }
      })
    ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    expect(available).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    const protocol = await readFile(join(root, "protocol.ndjson"), "utf8");
    expect(protocol).toContain('"optionId":"deny"');
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"kind":"permission"');
    expect(events).toContain('"actionable":false');
  });

  it("keeps a brokerless permission pending until the operation deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-headless-permission-"));
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    await expect(
      controller.execute(controllerRun(root, "permission-secret"), {
        timeoutMs: 1000
      })
    ).rejects.toThrow("timed out");
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"interactionKind":"permission"');
    expect(events).toContain('"status":"pending"');
    expect(events).toContain('"outcome":"expired"');
    expect(events).not.toContain("headless default-deny policy");
  });

  it("advertises preview elicitation only for an explicit interactive broker", async () => {
    for (const [scenario, interactionBroker] of [
      ["expect-headless-capabilities", undefined],
      [
        "expect-broker-capabilities",
        { mode: "interactive" as const, requestAvailable: () => undefined }
      ]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `planweave-acp-${scenario}-`));
      const controller = new AcpSessionController(new ActiveAgentRunRegistry());
      await expect(
        controller.execute(controllerRun(root, scenario), {
          timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
          ...(interactionBroker ? { interactionBroker } : {})
        })
      ).rejects.toThrow("Final artifact marker was not found");
    }
  });

  it("cancels unsupported elicitation modes without exposing them to the broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-unsupported-elicitation-"));
    const available = vi.fn();
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    await expect(
      controller.execute(controllerRun(root, "unsupported-elicitation"), {
        timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
        interactionBroker: { mode: "interactive", requestAvailable: available }
      })
    ).rejects.toThrow("Final artifact marker was not found");
    expect(available).not.toHaveBeenCalled();
    const protocol = await readFile(join(root, "protocol.ndjson"), "utf8");
    expect(protocol).toContain('"action":"cancel"');
  });

  it("redacts live permission and elicitation summaries while preserving action ids", async () => {
    const summaries: string[] = [];
    const protocols: string[] = [];
    for (const scenario of ["permission-secret", "elicitation-secret"]) {
      const root = await mkdtemp(join(tmpdir(), `planweave-acp-${scenario}-`));
      const controller = new AcpSessionController(new ActiveAgentRunRegistry());
      await expect(
        controller.execute(controllerRun(root, scenario), {
          timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
          interactionBroker: {
            mode: "interactive",
            requestAvailable: async (request) => {
              summaries.push(request.summary);
              if (request.kind === "permission") {
                await request.respond("token=opaque-action-id");
              } else {
                await request.reject("test decision");
              }
            }
          }
        })
      ).resolves.toMatchObject({ kind: "block" });
      protocols.push(await readFile(join(root, "protocol.ndjson"), "utf8"));
    }
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).not.toContain("token=opaque-action-id");
    expect(summaries.join(" ")).not.toContain("super-secret");
    expect(summaries.join(" ")).not.toContain("secret-token");
    expect(summaries.join(" ")).not.toContain("raw-secret");
    expect(summaries.join(" ")).toContain("[REDACTED:CREDENTIAL]");
    expect(summaries[0]).toContain("Permission requested for:");
    expect(protocols.join(" ")).toContain("token=opaque-action-id");
    expect(protocols.join(" ")).not.toContain("super-secret");
    expect(protocols.join(" ")).not.toContain("secret-token");
    expect(protocols.join(" ")).not.toContain("raw-secret");
  });

  it("stays waiting until every concurrent pending interaction settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-multi-interaction-"));
    const registry = new ActiveAgentRunRegistry();
    const pending: LivePendingRequestHandle[] = [];
    const controller = new AcpSessionController(registry);
    await expect(
      controller.execute(controllerRun(root, "multi-interaction"), {
        timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
        interactionBroker: {
          mode: "interactive",
          requestAvailable: async (request) => {
            pending.push(request);
            if (pending.length !== 2) return;
            const handle = registry.lookupDesktopRun("AUTO-RUN-001");
            expect(handle?.lifecycleState).toBe("waiting_interaction");
            await pending[0]?.reject("first settled");
            expect(handle?.lifecycleState).toBe("waiting_interaction");
            expect(handle?.control.pendingRequests.size).toBe(1);
            await pending[1]?.reject("second settled");
            expect(handle?.lifecycleState).toBe("running");
            expect(handle?.control.pendingRequests.size).toBe(0);
          }
        }
      })
    ).resolves.toMatchObject({ kind: "block" });
    expect(pending).toHaveLength(2);
  });

  it("requires the complete live identity and isolates concurrent runs", async () => {
    const registry = new ActiveAgentRunRegistry();
    const first = fixture();
    registry.register(first.handle);
    const actionIdentity = { ...first.handle.identity, requestId: "permission-1" };
    expect(registry.listPending(actionIdentity)).toHaveLength(1);
    for (const field of [
      "scope",
      "executorRunId",
      "desktopRunId",
      "runSessionId",
      "claimRef",
      "sessionId",
      "requestId"
    ] as const) {
      expect(() =>
        Reflect.apply(registry.listPending, registry, [{ ...actionIdentity, [field]: undefined }])
      ).toThrow(`requires a non-empty ${field}`);
    }
    expect(() =>
      registry.lookupExact({
        ...first.handle.identity,
        sessionId: "another-session"
      })
    ).toThrow("does not match executor run");
    await expect(
      registry.respond(
        {
          ...actionIdentity,
          desktopRunId: "AUTO-RUN-999"
        },
        "allow_once"
      )
    ).rejects.toThrow("does not match executor run");
    for (const mismatch of [
      { sessionId: "other-session" },
      { claimRef: "T-999#B-001" },
      { runSessionId: "SESSION-999" }
    ]) {
      await expect(
        registry.respond({ ...actionIdentity, ...mismatch }, "allow_once")
      ).rejects.toThrow("does not match executor run");
    }
    expect(first.respond).not.toHaveBeenCalled();
  });

  it("queues live prompts and drains them serially through the owned session", async () => {
    const registry = new ActiveAgentRunRegistry();
    const item = fixture();
    item.handle.lifecycleState = "running";
    item.control.pendingRequests.clear();
    registry.register(item.handle);
    const identity = {
      scope: "scope",
      desktopRunId: "AUTO-RUN-001",
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-006#B-001",
      sessionId: "session-1"
    };
    const sent: string[] = [];

    const first = registry.queuePrompt(identity, "first follow-up");
    const second = registry.queuePrompt(identity, "second follow-up");
    expect(sent).toEqual([]);
    expect(registry.promptInFlight(item.handle)).toBe(true);

    await registry.drainPromptQueue(item.handle, async (text) => {
      sent.push(text);
    });

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(sent).toEqual(["first follow-up", "second follow-up"]);
    expect(registry.promptInFlight(item.handle)).toBe(false);
    await registry.remove(item.handle, "test complete");
  });

  it("accepts a final queued turn while draining and closes intake atomically afterward", async () => {
    const registry = new ActiveAgentRunRegistry();
    const item = fixture();
    item.handle.lifecycleState = "running";
    item.control.pendingRequests.clear();
    registry.register(item.handle);
    const identity = {
      scope: "scope",
      desktopRunId: "AUTO-RUN-001",
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-006#B-001",
      sessionId: "session-1"
    };
    const sent: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = registry.queuePrompt(identity, "first follow-up");
    const draining = registry.drainPromptQueue(item.handle, async (text) => {
      sent.push(text);
      if (text === "first follow-up") await firstSend;
    });

    await vi.waitFor(() => expect(sent).toEqual(["first follow-up"]));
    const finalTurn = registry.queuePrompt(identity, "queued as the initial round ends");
    releaseFirst?.();
    await draining;

    await expect(first).resolves.toBeUndefined();
    await expect(finalTurn).resolves.toBeUndefined();
    expect(sent).toEqual(["first follow-up", "queued as the initial round ends"]);
    expect(registry.promptAccepting(item.handle)).toBe(false);
    await expect(registry.queuePrompt(identity, "terminal race")).rejects.toThrow(
      "session is finishing"
    );
    await registry.remove(item.handle, "test complete");
  });

  it("fails live prompts closed during permission waits and after ownership removal", async () => {
    const registry = new ActiveAgentRunRegistry();
    const waiting = fixture();
    registry.register(waiting.handle);
    const identity = {
      scope: "scope",
      desktopRunId: "AUTO-RUN-001",
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-006#B-001",
      sessionId: "session-1"
    };
    await expect(registry.queuePrompt(identity, "do not bypass permission")).rejects.toThrow(
      "pending permission"
    );

    waiting.handle.lifecycleState = "running";
    waiting.control.pendingRequests.clear();
    const queued = registry.queuePrompt(identity, "late follow-up");
    const queuedRejection = expect(queued).rejects.toThrow("test complete");
    await registry.remove(waiting.handle, "test complete");
    await queuedRejection;
    await expect(registry.queuePrompt(identity, "after terminal")).rejects.toThrow(
      "does not exist"
    );
  });

  it("allows a pending response at most once and rejects duplicate and late actions", async () => {
    const item = fixture();
    await respondToPendingRunnerRequest({
      control: item.control,
      ownership: item.ownership,
      requestId: "permission-1",
      value: "allow_once"
    });
    await expect(
      respondToPendingRunnerRequest({
        control: item.control,
        ownership: item.ownership,
        requestId: "permission-1",
        value: "allow_once"
      })
    ).rejects.toThrow("already answered");
    await cleanupRunnerLiveControl(item.control, item.ownership, "finished");
    await expect(
      respondToPendingRunnerRequest({
        control: item.control,
        ownership: item.ownership,
        requestId: "permission-1",
        value: "allow_once"
      })
    ).rejects.toThrow("no longer actionable");
    expect(item.respond).toHaveBeenCalledTimes(1);
    expect(item.reject).not.toHaveBeenCalled();
  });

  it("rejects unnegotiated request kinds before invoking the live response", async () => {
    const registry = new ActiveAgentRunRegistry();
    const item = fixture();
    item.control.interventionCapabilities.permission = false;
    registry.register(item.handle);
    const identity = { ...item.handle.identity, requestId: "permission-1" };
    await expect(registry.respond(identity, "allow")).rejects.toThrow(
      "Permission intervention is not negotiated"
    );
    expect(item.respond).not.toHaveBeenCalled();
    await registry.remove(item.handle, "test complete");
  });

  it("cancels only the exact live session and rejects mismatch, duplicate, and late cancellation", async () => {
    const registry = new ActiveAgentRunRegistry();
    const item = fixture();
    registry.register(item.handle);
    const { requestId: _requestId, ...identity } = {
      ...item.handle.identity,
      requestId: "permission-1"
    };
    await expect(registry.cancel({ ...identity, sessionId: "foreign-session" })).rejects.toThrow(
      "does not match executor run"
    );
    await expect(registry.cancel(identity)).resolves.toBeUndefined();
    expect(item.order).toEqual(["reject-request", "cancel", "connection", "process"]);
    await expect(registry.cancel(identity)).rejects.toThrow("does not exist");
    expect(item.order).toEqual(["reject-request", "cancel", "connection", "process"]);
  });

  it("settles pending requests before cancel, optional close, and process teardown", async () => {
    const item = fixture({ closeSupported: true });
    await cleanupRunnerLiveControl(item.control, item.ownership, "Desktop stopped");
    expect(item.order).toEqual([
      "reject-request",
      "cancel",
      "close-session",
      "connection",
      "process"
    ]);
    await cleanupRunnerLiveControl(item.control, item.ownership, "duplicate stop");
    expect(item.order).toEqual([
      "reject-request",
      "cancel",
      "close-session",
      "connection",
      "process"
    ]);
  });

  it("waits for an in-flight durable response before terminal teardown", async () => {
    const item = fixture();
    let releaseResponse!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    item.respond.mockImplementation(async () => {
      markStarted();
      await gate;
      item.order.push("respond");
    });
    const responding = respondToPendingRunnerRequest({
      control: item.control,
      ownership: item.ownership,
      requestId: "permission-1",
      value: "allow"
    });
    await started;
    const cleanup = cleanupRunnerLiveControl(item.control, item.ownership, "terminal race");
    await Promise.resolve();
    expect(item.order).toEqual([]);
    releaseResponse();
    await Promise.all([responding, cleanup]);
    expect(item.order).toEqual(["respond", "cancel", "connection", "process"]);
    expect(item.reject).not.toHaveBeenCalled();
  });

  it("cancels a permission after its in-flight durable response fails", async () => {
    const item = fixture();
    let releaseResponse!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    item.respond.mockImplementation(async () => {
      markStarted();
      await gate;
      throw new Error("permission commit failed");
    });
    const responding = respondToPendingRunnerRequest({
      control: item.control,
      ownership: item.ownership,
      requestId: "permission-1",
      value: "allow"
    });
    await started;
    const cleanup = cleanupRunnerLiveControl(item.control, item.ownership, "terminal race");
    releaseResponse();
    await expect(responding).rejects.toThrow("permission commit failed");
    await expect(cleanup).resolves.toMatchObject({ alreadyCleaned: false });
    expect(item.order).toEqual(["reject-request", "cancel", "connection", "process"]);
    expect(item.reject).toHaveBeenCalledTimes(1);
  });
});
