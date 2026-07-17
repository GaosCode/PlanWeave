import { describe, expect, it, vi } from "vitest";
import {
  ActiveAgentRunRegistry,
  type ActiveAgentRunHandle
} from "../autoRun/activeAgentRunRegistry.js";
import { createActiveAgentRunControlTarget } from "../autoRun/agentRunControlTarget.js";
import {
  createLiveOwnership,
  type LivePendingRequestHandle,
  type RunnerLiveControl
} from "../autoRun/liveControl.js";
import { runnerSessionActionIdentitySchema } from "../autoRun/runnerContractSchemas.js";

const identity = runnerSessionActionIdentitySchema.parse({
  scope: "scope",
  desktopRunId: "desktop-run-1",
  runSessionId: "run-session-1",
  executorRunId: "executor-run-1",
  claimRef: "T-001#B-001",
  sessionId: "session-1"
});

function fixture(
  options: {
    generation?: number;
    request?: LivePendingRequestHandle | null;
    capabilities?: Partial<RunnerLiveControl["interventionCapabilities"]>;
  } = {}
) {
  const ownership = createLiveOwnership("scope:executor-run-1", options.generation ?? 1);
  const request =
    options.request === undefined
      ? {
          requestId: "permission-1",
          interactionId: "permission-1",
          kind: "permission" as const,
          requestedAt: "2026-07-17T07:00:00.000Z",
          summary: "Approve command?",
          permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" as const }],
          respond: vi.fn(async () => undefined),
          reject: vi.fn(async () => undefined)
        }
      : options.request;
  const control: RunnerLiveControl = {
    ownership,
    sessionId: identity.sessionId,
    process: {
      pid: 42,
      terminate: vi.fn(async () => undefined)
    },
    connection: {
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      cancelSession: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      supportsSessionClose: true
    },
    interventionCapabilities: {
      cancel: options.capabilities?.cancel ?? true,
      permission: options.capabilities?.permission ?? true,
      elicitationPreview: options.capabilities?.elicitationPreview ?? true
    },
    pendingRequests: new Map(request ? [[request.requestId, request]] : []),
    pendingOperations: new Map()
  };
  const handle: ActiveAgentRunHandle = {
    identity: { ...identity },
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
    lifecycleState: request ? "waiting_interaction" : "running"
  };
  return { control, handle, request };
}

describe("active agent run control target", () => {
  it("routes a permission response to the exact current registry handle", async () => {
    const registry = new ActiveAgentRunRegistry();
    const item = fixture();
    registry.register(item.handle);
    const target = createActiveAgentRunControlTarget({
      registry,
      handle: item.handle,
      identity,
      now: () => new Date("2026-07-17T07:00:01.000Z")
    });

    await expect(
      target.respond(
        { ...identity, requestId: "permission-1" },
        { kind: "select", optionId: "allow" }
      )
    ).resolves.toEqual({
      status: "delivered",
      deliveredAt: "2026-07-17T07:00:01.000Z"
    });
    expect(item.request?.respond).toHaveBeenCalledWith("allow");
    await registry.remove(item.handle, "test complete");
  });

  it("settles a permission cancellation through the pending request reject path", async () => {
    const registry = new ActiveAgentRunRegistry();
    const item = fixture();
    registry.register(item.handle);
    const target = createActiveAgentRunControlTarget({
      registry,
      handle: item.handle,
      identity
    });

    await expect(
      target.respond({ ...identity, requestId: "permission-1" }, { kind: "cancel" })
    ).resolves.toMatchObject({ status: "delivered" });
    expect(item.request?.reject).toHaveBeenCalledWith(
      "Permission request was cancelled through runner control."
    );
    expect(item.request?.respond).not.toHaveBeenCalled();
    await expect(
      target.respond({ ...identity, requestId: "permission-1" }, { kind: "cancel" })
    ).rejects.toMatchObject({ code: "delivery_failed" });
    await registry.remove(item.handle, "test complete");
  });

  it("keeps authentication on the explicit local-registry response path", async () => {
    const authentication: LivePendingRequestHandle = {
      requestId: "authentication-1",
      interactionId: "authentication-1",
      kind: "authentication",
      requestedAt: "2026-07-17T07:00:00.000Z",
      summary: "Authenticate the ACP client.",
      respond: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined)
    };
    const registry = new ActiveAgentRunRegistry();
    const item = fixture({ request: authentication });
    registry.register(item.handle);
    const target = createActiveAgentRunControlTarget({
      registry,
      handle: item.handle,
      identity
    });

    await expect(
      target.respond(
        { ...identity, requestId: "authentication-1" },
        { kind: "select", optionId: "browser" }
      )
    ).rejects.toMatchObject({ code: "capability_denied" });
    await expect(
      registry.respondAuthentication(
        { ...identity, requestId: "authentication-1" },
        { methodId: "browser" }
      )
    ).resolves.toBeUndefined();
    expect(authentication.respond).toHaveBeenCalledWith({ methodId: "browser" });
    await registry.remove(item.handle, "test complete");
  });

  it("waits for a follow-up to be delivered through the owner prompt queue", async () => {
    const registry = new ActiveAgentRunRegistry();
    const item = fixture({ request: null });
    registry.register(item.handle);
    const target = createActiveAgentRunControlTarget({
      registry,
      handle: item.handle,
      identity,
      now: () => new Date("2026-07-17T07:00:02.000Z")
    });
    const sent: string[] = [];

    const response = target.followUp(identity, "Continue with the focused verification.");
    await vi.waitFor(() => expect(registry.promptInFlight(item.handle)).toBe(true));
    await registry.drainPromptQueue(item.handle, async (prompt) => {
      sent.push(prompt);
    });

    await expect(response).resolves.toEqual({
      status: "delivered",
      deliveredAt: "2026-07-17T07:00:02.000Z"
    });
    expect(sent).toEqual(["Continue with the focused verification."]);
    await registry.remove(item.handle, "test complete");
  });

  it("rejects wrong identity, removed owners, and replacement owners distinctly", async () => {
    const registry = new ActiveAgentRunRegistry();
    const first = fixture({ request: null });
    registry.register(first.handle);
    const target = createActiveAgentRunControlTarget({
      registry,
      handle: first.handle,
      identity
    });

    await expect(
      target.followUp({ ...identity, sessionId: "foreign-session" }, "Rejected")
    ).rejects.toMatchObject({ code: "invalid_identity" });
    await registry.remove(first.handle, "owner stopped");
    await expect(target.followUp(identity, "Rejected")).rejects.toMatchObject({
      code: "not_active"
    });

    const replacement = fixture({ generation: 2, request: null });
    registry.register(replacement.handle);
    await expect(target.followUp(identity, "Rejected")).rejects.toMatchObject({
      code: "not_owner"
    });
    await registry.remove(replacement.handle, "test complete");
  });

  it("returns typed pending, capability, and delivery errors without copying request state", async () => {
    const missingRegistry = new ActiveAgentRunRegistry();
    const missing = fixture({ request: null });
    missing.handle.lifecycleState = "waiting_interaction";
    missingRegistry.register(missing.handle);
    const missingTarget = createActiveAgentRunControlTarget({
      registry: missingRegistry,
      handle: missing.handle,
      identity
    });
    await expect(
      missingTarget.respond(
        { ...identity, requestId: "missing" },
        { kind: "select", optionId: "allow" }
      )
    ).rejects.toMatchObject({ code: "request_not_pending" });
    await missingRegistry.remove(missing.handle, "test complete");

    const deniedRegistry = new ActiveAgentRunRegistry();
    const denied = fixture({ capabilities: { permission: false } });
    deniedRegistry.register(denied.handle);
    const deniedTarget = createActiveAgentRunControlTarget({
      registry: deniedRegistry,
      handle: denied.handle,
      identity
    });
    await expect(
      deniedTarget.respond(
        { ...identity, requestId: "permission-1" },
        { kind: "select", optionId: "allow" }
      )
    ).rejects.toMatchObject({ code: "capability_denied" });
    await deniedRegistry.remove(denied.handle, "test complete");

    const failedRequest: LivePendingRequestHandle = {
      requestId: "permission-1",
      interactionId: "permission-1",
      kind: "permission",
      requestedAt: "2026-07-17T07:00:00.000Z",
      summary: "Approve command?",
      permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }],
      respond: vi.fn(async () => {
        throw new Error("owner delivery failed");
      }),
      reject: vi.fn(async () => undefined)
    };
    const failedRegistry = new ActiveAgentRunRegistry();
    const failed = fixture({ request: failedRequest });
    failedRegistry.register(failed.handle);
    const failedTarget = createActiveAgentRunControlTarget({
      registry: failedRegistry,
      handle: failed.handle,
      identity
    });
    await expect(
      failedTarget.respond(
        { ...identity, requestId: "permission-1" },
        { kind: "select", optionId: "allow" }
      )
    ).rejects.toMatchObject({ code: "delivery_failed" });
    await failedRegistry.remove(failed.handle, "test complete");
  });
});
