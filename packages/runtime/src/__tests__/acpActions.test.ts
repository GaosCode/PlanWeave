import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ActiveAgentRunRegistry, type ActiveAgentRunHandle } from "../autoRun/activeAgentRunRegistry.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
import {
  cleanupRunnerLiveControl,
  createLiveOwnership,
  respondToPendingRunnerRequest,
  type LivePendingRequestHandle,
  type RunnerLiveControl
} from "../autoRun/liveControl.js";

const acpFixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function controllerRun(root: string, scenario: string): AcpSessionRun {
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
    prompt: scenario,
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
  const respond = vi.fn(async () => { order.push("respond"); });
  const reject = vi.fn(async () => { order.push("reject-request"); });
  const control: RunnerLiveControl = {
    ownership,
    sessionId: "session-1",
    process: { pid: 42, terminate: vi.fn(async () => { order.push("process"); }) },
    connection: {
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => { order.push("connection"); }),
      cancelSession: vi.fn(async () => { order.push("cancel"); }),
      closeSession: vi.fn(async () => { order.push("close-session"); }),
      supportsSessionClose: options.closeSupported === true
    },
    pendingRequests: new Map([["permission-1", {
      requestId: "permission-1",
      interactionId: "permission-1",
      kind: "permission",
      requestedAt: "2026-07-11T00:00:00.000Z",
      summary: "Approve command?",
      respond,
      reject
    }]]),
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
  it("sends a Desktop broker deny exactly once and clears the pending request", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-deny-"));
    const registry = new ActiveAgentRunRegistry();
    const available = vi.fn(async (request: LivePendingRequestHandle) => {
      await request.respond("deny");
    });
    const controller = new AcpSessionController(registry);
    await expect(controller.execute(controllerRun(root, "permission-deny"), {
      timeoutMs: 1_000,
      interactionBroker: { mode: "interactive", requestAvailable: available }
    })).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    expect(available).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    const protocol = await readFile(join(root, "protocol.ndjson"), "utf8");
    expect(protocol).toContain('"optionId":"deny"');
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"kind":"permission"');
    expect(events).toContain('"actionable":false');
  });

  it("advertises preview elicitation only for an explicit interactive broker", async () => {
    for (const [scenario, interactionBroker] of [
      ["expect-headless-capabilities", undefined],
      ["expect-broker-capabilities", { mode: "interactive" as const, requestAvailable: () => undefined }]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `planweave-acp-${scenario}-`));
      const controller = new AcpSessionController(new ActiveAgentRunRegistry());
      await expect(controller.execute(controllerRun(root, scenario), {
        timeoutMs: 1_000,
        ...(interactionBroker ? { interactionBroker } : {})
      })).rejects.toThrow("Final artifact marker was not found");
    }
  });

  it("cancels unsupported elicitation modes without exposing them to the broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-unsupported-elicitation-"));
    const available = vi.fn();
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    await expect(controller.execute(controllerRun(root, "unsupported-elicitation"), {
      timeoutMs: 1_000,
      interactionBroker: { mode: "interactive", requestAvailable: available }
    })).rejects.toThrow("Final artifact marker was not found");
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
      await expect(controller.execute(controllerRun(root, scenario), {
        timeoutMs: 1_000,
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
      })).resolves.toMatchObject({ kind: "block" });
      protocols.push(await readFile(join(root, "protocol.ndjson"), "utf8"));
    }
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain("token=opaque-action-id");
    expect(summaries.join(" ")).not.toContain("super-secret");
    expect(summaries.join(" ")).not.toContain("secret-token");
    expect(summaries.join(" ")).not.toContain("raw-secret");
    expect(summaries.join(" ")).toContain("[REDACTED:CREDENTIAL]");
    for (const summary of summaries) expect(() => JSON.parse(summary)).not.toThrow();
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
    await expect(controller.execute(controllerRun(root, "multi-interaction"), {
      timeoutMs: 1_000,
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
    })).resolves.toMatchObject({ kind: "block" });
    expect(pending).toHaveLength(2);
  });

  it("requires the complete live identity and isolates concurrent runs", async () => {
    const registry = new ActiveAgentRunRegistry();
    const first = fixture();
    registry.register(first.handle);
    const actionIdentity = { ...first.handle.identity, requestId: "permission-1" };
    expect(registry.listPending(actionIdentity)).toHaveLength(1);
    for (const field of ["scope", "executorRunId", "desktopRunId", "runSessionId", "claimRef", "sessionId", "requestId"] as const) {
      expect(() => Reflect.apply(registry.listPending, registry, [{ ...actionIdentity, [field]: undefined }]))
        .toThrow(`requires a non-empty ${field}`);
    }
    expect(() => registry.lookupExact({
      ...first.handle.identity,
      sessionId: "another-session"
    })).toThrow("does not match executor run");
    await expect(registry.respond({
      ...actionIdentity,
      desktopRunId: "AUTO-RUN-999"
    }, "allow_once")).rejects.toThrow("does not match executor run");
    for (const mismatch of [
      { sessionId: "other-session" },
      { claimRef: "T-999#B-001" },
      { runSessionId: "SESSION-999" }
    ]) {
      await expect(registry.respond({ ...actionIdentity, ...mismatch }, "allow_once"))
        .rejects.toThrow("does not match executor run");
    }
    expect(first.respond).not.toHaveBeenCalled();
  });

  it("allows a pending response at most once and rejects duplicate and late actions", async () => {
    const item = fixture();
    await respondToPendingRunnerRequest({
      control: item.control,
      ownership: item.ownership,
      requestId: "permission-1",
      value: "allow_once"
    });
    await expect(respondToPendingRunnerRequest({
      control: item.control,
      ownership: item.ownership,
      requestId: "permission-1",
      value: "allow_once"
    })).rejects.toThrow("already answered");
    await cleanupRunnerLiveControl(item.control, item.ownership, "finished");
    await expect(respondToPendingRunnerRequest({
      control: item.control,
      ownership: item.ownership,
      requestId: "permission-1",
      value: "allow_once"
    })).rejects.toThrow("no longer actionable");
    expect(item.respond).toHaveBeenCalledTimes(1);
    expect(item.reject).not.toHaveBeenCalled();
  });

  it("settles pending requests before cancel, optional close, and process teardown", async () => {
    const item = fixture({ closeSupported: true });
    await cleanupRunnerLiveControl(item.control, item.ownership, "Desktop stopped");
    expect(item.order).toEqual(["reject-request", "cancel", "close-session", "connection", "process"]);
    await cleanupRunnerLiveControl(item.control, item.ownership, "duplicate stop");
    expect(item.order).toEqual(["reject-request", "cancel", "close-session", "connection", "process"]);
  });
});
