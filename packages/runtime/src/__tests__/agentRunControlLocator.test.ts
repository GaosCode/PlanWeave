import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActiveAgentRunRegistry,
  type ActiveAgentRunHandle
} from "../autoRun/activeAgentRunRegistry.js";
import {
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlEndpointDescriptorSchema,
  agentRunControlLeaseIdSchema
} from "../autoRun/agentRunControlContract.js";
import { publishAgentRunControlDescriptor } from "../autoRun/agentRunControlEndpoint.js";
import { AgentRunControlLocator } from "../autoRun/agentRunControlLocator.js";
import { AgentRunControlServer } from "../autoRun/agentRunControlServer.js";
import { createActiveAgentRunControlTarget } from "../autoRun/agentRunControlTarget.js";
import { createLiveOwnership, type RunnerLiveControl } from "../autoRun/liveControl.js";
import { runnerSessionActionIdentitySchema } from "../autoRun/runnerContractSchemas.js";

const roots: string[] = [];
const leaseId = agentRunControlLeaseIdSchema.parse("6202e8ad-0634-4f80-ad56-a6a8080b1d65");
const staleLeaseId = agentRunControlLeaseIdSchema.parse("f9a239c5-1ee5-41e5-8caf-a0e59d76dc8e");
const identity = runnerSessionActionIdentitySchema.parse({
  scope: "/workspace/planweave",
  executorRunId: "executor-run-1",
  desktopRunId: "desktop-run-1",
  runSessionId: "run-session-1",
  claimRef: "T-001#B-001",
  sessionId: "acp-session-1"
});

async function temporaryRun(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pw-control-locator-${label}-`));
  roots.push(root);
  return root;
}

function handleFixture(): ActiveAgentRunHandle {
  const ownership = createLiveOwnership("scope:executor-run-1", 1);
  const control: RunnerLiveControl = {
    ownership,
    sessionId: identity.sessionId,
    process: { pid: 42, terminate: vi.fn(async () => undefined) },
    connection: {
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      cancelSession: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      supportsSessionClose: true
    },
    interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
    pendingRequests: new Map(),
    pendingOperations: new Map()
  };
  return {
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
    lifecycleState: "running",
    agentRunControlLeaseId: leaseId
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent run control locator", () => {
  it("prefers the exact in-process owner and reports actual follow-up delivery", async () => {
    const registry = new ActiveAgentRunRegistry();
    const handle = handleFixture();
    registry.register(handle);
    const locator = new AgentRunControlLocator({
      registry,
      randomUUID: () => "405542d4-f89a-4e95-aaaf-104e44188626",
      now: () => new Date("2026-07-17T07:00:00.000Z")
    });
    const execution = locator.execute("/path/without/descriptor", {
      kind: "follow_up",
      identity,
      prompt: "Continue with the focused verification."
    });
    await vi.waitFor(() => expect(registry.promptInFlight(handle)).toBe(true));
    await registry.drainPromptQueue(handle, async () => undefined);

    await expect(execution).resolves.toMatchObject({
      ok: true,
      result: { status: "delivered", deliveredAt: "2026-07-17T07:00:00.000Z" }
    });
    await registry.remove(handle, "test complete");
  });

  it("uses the same typed target mapping for an in-process request response", async () => {
    const registry = new ActiveAgentRunRegistry();
    const handle = handleFixture();
    const respond = vi.fn(async () => undefined);
    handle.lifecycleState = "waiting_interaction";
    handle.control.pendingRequests.set("permission-1", {
      requestId: "permission-1",
      interactionId: "permission-1",
      kind: "permission",
      requestedAt: "2026-07-17T07:00:00.000Z",
      summary: "Approve command?",
      permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }],
      respond,
      reject: vi.fn(async () => undefined)
    });
    registry.register(handle);
    const response = await new AgentRunControlLocator({
      registry,
      randomUUID: () => "405542d4-f89a-4e95-aaaf-104e44188626",
      now: () => new Date("2026-07-17T07:00:00.000Z")
    }).execute("/path/without/descriptor", {
      kind: "respond",
      identity: { ...identity, requestId: "permission-1" },
      outcome: "allow"
    });
    expect(response).toMatchObject({ ok: true, result: { status: "delivered" } });
    expect(respond).toHaveBeenCalledWith("allow");
    await registry.remove(handle, "test complete");
  });

  it("falls back to the persisted descriptor and executes through real IPC", async () => {
    const runDir = await temporaryRun("ipc");
    const followUp = vi.fn(async () => ({ status: "accepted" as const }));
    const server = new AgentRunControlServer({
      runDir,
      leaseId,
      target: {
        cancel: vi.fn(async () => ({ status: "accepted" as const })),
        respond: vi.fn(async () => ({ status: "accepted" as const })),
        followUp
      },
      now: () => new Date("2026-07-17T07:00:00.000Z")
    });
    await server.start();
    try {
      const response = await new AgentRunControlLocator({
        registry: new ActiveAgentRunRegistry(),
        randomUUID: () => "405542d4-f89a-4e95-aaaf-104e44188626"
      }).execute(runDir, { kind: "follow_up", identity, prompt: "Continue." });
      expect(response).toMatchObject({ ok: true, result: { status: "accepted" } });
      expect(followUp).toHaveBeenCalledWith(identity, "Continue.");
    } finally {
      await server.stop();
    }
  });

  it("returns the same typed owner error in process and through IPC", async () => {
    const runDir = await temporaryRun("isomorphic-error");
    const localRegistry = new ActiveAgentRunRegistry();
    const localHandle = handleFixture();
    localHandle.control.interventionCapabilities.cancel = false;
    localRegistry.register(localHandle);
    const remoteRegistry = new ActiveAgentRunRegistry();
    const remoteHandle = handleFixture();
    remoteHandle.control.interventionCapabilities.cancel = false;
    remoteRegistry.register(remoteHandle);
    const server = new AgentRunControlServer({
      runDir,
      leaseId,
      target: createActiveAgentRunControlTarget({
        registry: remoteRegistry,
        handle: remoteHandle,
        identity
      })
    });
    await server.start();
    try {
      const local = await new AgentRunControlLocator({
        registry: localRegistry,
        randomUUID: () => "405542d4-f89a-4e95-aaaf-104e44188626"
      }).execute(runDir, { kind: "cancel", identity });
      const remote = await new AgentRunControlLocator({
        registry: new ActiveAgentRunRegistry(),
        randomUUID: () => "405542d4-f89a-4e95-aaaf-104e44188626"
      }).execute(runDir, { kind: "cancel", identity });
      expect(local).toEqual(remote);
      expect(remote).toMatchObject({ ok: false, code: "capability_denied" });
    } finally {
      await server.stop();
      await Promise.all([
        localRegistry.remove(localHandle, "test complete"),
        remoteRegistry.remove(remoteHandle, "test complete")
      ]);
    }
  });

  it("does not bypass an exact-owner identity conflict through descriptor fallback", async () => {
    const registry = new ActiveAgentRunRegistry();
    const handle = handleFixture();
    registry.register(handle);
    const response = await new AgentRunControlLocator({ registry }).execute(
      await temporaryRun("conflict"),
      {
        kind: "cancel",
        identity: { ...identity, sessionId: "foreign-session" }
      }
    );
    expect(response).toMatchObject({ ok: false, code: "invalid_identity", commandId: null });
    await registry.remove(handle, "test complete");
  });

  it("returns typed descriptor, missing-owner, and stale-lease failures", async () => {
    const missingRun = await temporaryRun("missing");
    const locator = new AgentRunControlLocator({ registry: new ActiveAgentRunRegistry() });
    await expect(locator.execute(missingRun, { kind: "cancel", identity })).resolves.toMatchObject({
      ok: false,
      code: "not_active"
    });

    const corruptRun = await temporaryRun("corrupt");
    await mkdir(join(corruptRun, "control"), { mode: 0o700 });
    await chmod(join(corruptRun, "control"), 0o700);
    await writeFile(join(corruptRun, "control", "endpoint.json"), "{broken", { mode: 0o600 });
    await expect(locator.execute(corruptRun, { kind: "cancel", identity })).resolves.toMatchObject({
      ok: false,
      code: "protocol_mismatch"
    });

    const staleRun = await temporaryRun("stale");
    const server = new AgentRunControlServer({
      runDir: staleRun,
      leaseId,
      target: {
        cancel: vi.fn(async () => ({ status: "accepted" as const })),
        respond: vi.fn(async () => ({ status: "accepted" as const })),
        followUp: vi.fn(async () => ({ status: "accepted" as const }))
      }
    });
    const descriptor = await server.start();
    await publishAgentRunControlDescriptor(
      staleRun,
      agentRunControlEndpointDescriptorSchema.parse({ ...descriptor, leaseId: staleLeaseId })
    );
    try {
      await expect(locator.execute(staleRun, { kind: "cancel", identity })).resolves.toMatchObject({
        ok: false,
        code: "stale_lease"
      });
    } finally {
      await server.stop();
    }
  });
});
