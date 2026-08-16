import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAcpConnection, type AcpConnection } from "../autoRun/acpConnection.js";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { agentRunControlLeaseIdSchema } from "../autoRun/agentRunControlContract.js";
import { createLocalAcpActiveRunHandle } from "../autoRun/acpLocalActiveRunHandle.js";
import { AcpEngineExecutionError } from "../autoRun/acpExecutionEngine.js";
import type { AcpEngineEvent, AcpEngineTerminal } from "../autoRun/acpExecutionEngineContracts.js";
import {
  createLocalAcpPromptSource,
  executeLocalAcpAdapter
} from "../autoRun/acpLocalExecutionAdapter.js";
import {
  type AcpAdapterConformanceObservation,
  type AcpAdapterConformanceScenario,
  defineAcpExecutionAdapterConformance
} from "./support/acpExecutionAdapterConformance.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const mockAgentPath = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

function conformanceTerminal(terminal: AcpEngineTerminal) {
  if (terminal.state === "succeeded") return terminal;
  if (terminal.state === "cancelled") {
    return { state: "cancelled", failureCategory: "cancelled" } as const;
  }
  return { state: "failed", failureCategory: terminal.reason } as const;
}

async function runLocalConformance(
  scenario: AcpAdapterConformanceScenario
): Promise<AcpAdapterConformanceObservation> {
  const controller = new AbortController();
  const events: AcpEngineEvent[] = [];
  let terminal: AcpEngineTerminal | undefined;
  let output: string | undefined;
  const execution = executeLocalAcpAdapter({
    launch: { command: process.execPath, args: [mockAgentPath, scenario] },
    cwd: process.cwd(),
    agentId: "local-conformance",
    env: environment,
    shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
    prompt: "exercise the local ACP adapter",
    sessionStart: { kind: "new" },
    signal: controller.signal,
    timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
    connect: createAcpConnection,
    onConnection: () => undefined,
    interactionBroker: {
      advertiseElicitation: false,
      requestPermission: () => ({ kind: "cancel" }),
      requestElicitation: () => ({ action: "cancel" })
    },
    interactionDeadline: () => null,
    followUpPrompts: (async function* () {})(),
    eventSink: (event) => {
      events.push(event);
      if (event.kind === "terminal") terminal = event.terminal;
    },
    lifecycleObserver: () => undefined
  });
  if (scenario === "long-prompt") setTimeout(() => controller.abort(), 20);

  try {
    output = (await execution).output;
  } catch (error) {
    if (error instanceof AcpEngineExecutionError) {
      terminal ??= error.result.terminal;
      output = error.result.output;
    } else if (!terminal) {
      throw error;
    }
  }
  if (!terminal) throw new Error("Local ACP adapter emitted no terminal event.");

  return {
    terminal: conformanceTerminal(terminal),
    productTexts: terminal.state === "succeeded" && output !== undefined ? [output] : [],
    events: events.map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      ...(event.kind === "lifecycle" ? { state: event.state } : {})
    }))
  };
}

defineAcpExecutionAdapterConformance("Runtime local", {
  exposesRemotePublicFailure: false,
  run: runLocalConformance
});

describe("local ACP execution adapter", () => {
  it("bridges the existing atomic prompt drain into engine-owned prompt turns", async () => {
    const delivered: string[] = [];
    const source = createLocalAcpPromptSource(async (send) => {
      await send("first");
      await send("queued while first is running");
    });

    for await (const prompt of source) delivered.push(prompt);

    expect(delivered).toEqual(["first", "queued while first is running"]);
  });

  it("propagates engine prompt failures back to the queued caller", async () => {
    const queuedFailure = vi.fn();
    const source = createLocalAcpPromptSource(async (send) => {
      await send("first").catch(queuedFailure);
    });

    const consume = (async () => {
      for await (const _prompt of source) throw new Error("prompt failed");
    })();

    await expect(consume).rejects.toThrow("prompt failed");
    await vi.waitFor(() => expect(queuedFailure).toHaveBeenCalled());
  });

  it("keeps registry cleanup transport-neutral and closes the engine connection once", async () => {
    const closeSession = vi.fn(async () => ({}));
    const dispose = vi.fn(async () => undefined);
    const connection = {
      processId: 123,
      pendingOperationCount: 0,
      pendingOperations: new Map(),
      stderr: [],
      closed: Promise.resolve(),
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        agentInfo: { name: "local-adapter-test", version: "1.0.0" }
      })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "local-session" })),
      loadSession: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
      cancel: vi.fn(async () => undefined),
      closeSession,
      setSessionMode: vi.fn(async () => ({})),
      setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
      dispose
    } satisfies AcpConnection;
    const registry = new ActiveAgentRunRegistry();
    const abortController = new AbortController();
    let handle: ReturnType<typeof createLocalAcpActiveRunHandle> | null = null;

    const result = await executeLocalAcpAdapter({
      launch: { command: process.execPath, args: [] },
      cwd: process.cwd(),
      agentId: "codex",
      env: {},
      shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
      prompt: "run once",
      sessionStart: { kind: "new" },
      signal: abortController.signal,
      connect: () => connection,
      onConnection: (owned) => {
        handle = createLocalAcpActiveRunHandle({
          identity: {
            scope: process.cwd(),
            executorRunId: "RUN-LOCAL",
            claimRef: "T-001#B-001"
          },
          connection: owned,
          abortController,
          eventSink: () => undefined,
          agentRunControlLeaseId: agentRunControlLeaseIdSchema.parse(randomUUID()),
          pendingRequests: new Map(),
          supportsSessionClose: () => true
        });
        registry.register(handle);
      },
      interactionBroker: {
        advertiseElicitation: false,
        requestPermission: () => ({ kind: "cancel" }),
        requestElicitation: () => ({ action: "cancel" })
      },
      interactionDeadline: () => null,
      followUpPrompts: (async function* () {})(),
      eventSink: () => undefined,
      lifecycleObserver: async (event) => {
        if (!handle) throw new Error("Local ACP handle was not published.");
        if (event.kind === "session_ready") {
          registry.bindSession(handle, event.session.sessionId);
          registry.transition(handle, "ready");
          registry.transition(handle, "running");
        }
        if (event.kind === "cleanup_starting") {
          await registry.remove(handle, "engine cleanup", "succeeded", true);
          expect(closeSession).not.toHaveBeenCalled();
          expect(dispose).not.toHaveBeenCalled();
        }
      }
    });

    expect(result.terminal.state).toBe("succeeded");
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });
});
