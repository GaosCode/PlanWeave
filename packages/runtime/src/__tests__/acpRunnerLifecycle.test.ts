import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActiveAgentRunRegistry, type ActiveAgentRunHandle } from "../autoRun/activeAgentRunRegistry.js";
import { AcpSessionController } from "../autoRun/acpSessionController.js";
import { createAcpConnection, type CreateAcpConnectionOptions } from "../autoRun/acpConnection.js";
import { createAcpRunner } from "../autoRun/acpRunner.js";
import type { AgentDefinition } from "../autoRun/agentRunner.js";
import { createExecutorAdapter } from "../autoRun/executors.js";
import { codexAgentDefinition } from "../autoRun/codexIntegration.js";
import { runAutoRunStep } from "../taskManager/autoRunStep.js";
import { getExecutionStatus } from "../taskManager/executionStatus.js";
import { createLiveOwnership } from "../autoRun/liveControl.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { startAutoRun, stopAutoRun } from "../desktop/runApi.js";
import { activeAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { trustCommand } from "../taskManager/hookTrustStore.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function mockLaunch(scenario: string) {
  const source = codexAgentDefinition.acp.launch?.source;
  if (!source) throw new Error("Expected Codex ACP launch source metadata.");
  return { command: process.execPath, args: [fixture, scenario], source };
}

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not observed within ${timeoutMs}ms.`);
}

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function handle(scope: string, runId: string, sessionId: string, closed: string[]): ActiveAgentRunHandle {
  const abortController = new AbortController();
  const ownership = createLiveOwnership(`${scope}:${runId}`, 1);
  const connection = createAcpConnection({
    launch: { trusted: true, command: process.execPath, args: [fixture, "success"] },
    cwd: process.cwd(),
    env: environment(),
    clientInfo: { name: "registry-test", version: "1" }
  });
  return {
    identity: { scope, executorRunId: runId, claimRef: "T-001#B-001", sessionId },
    connection,
    abortController,
    eventSink: () => undefined,
    ownership,
    lifecycleState: "initializing",
    control: {
      ownership,
      process: { pid: connection.processId, terminate: () => connection.dispose() },
      connection: {
        send: async () => undefined,
        close: async (reason) => {
          closed.push(reason);
          await connection.dispose();
        },
        cancelSession: (boundSessionId) => connection.cancel({ sessionId: boundSessionId }),
        closeSession: async (boundSessionId) => { await connection.closeSession(boundSessionId); },
        supportsSessionClose: false
      },
      interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
      sessionId,
      pendingRequests: new Map(),
      pendingOperations: connection.pendingOperations
    }
  };
}

describe("ActiveAgentRunRegistry", () => {
  it("indexes concurrent identities, rejects collisions and cross-run lookup, and removes exactly once", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const first = handle("/project-a/results/run", "RUN-001", "session-1", closed);
    const second = handle("/project-b/results/run", "RUN-001", "session-1", closed);
    registry.register(first);
    registry.register(second);
    expect(registry.lookup("sessionId", "/project-a/results/run", "session-1", "RUN-001")).toBe(first);
    expect(registry.lookup("sessionId", "/project-b/results/run", "session-1", "RUN-001")).toBe(second);
    expect(() => registry.lookup("sessionId", "/project-a/results/run", "session-1", "RUN-002")).toThrow("different executor run");
    const collision = handle("/project-a/results/run", "RUN-001", "session-1", closed);
    expect(() => registry.register(collision)).toThrow("collision");
    await expect(Promise.all([registry.remove(first, "done"), registry.remove(first, "again")])).resolves.toEqual([true, true]);
    expect(closed).toEqual(["done"]);
    expect(registry.size).toBe(1);
    await registry.shutdown();
    await Promise.all([
      first.connection.dispose(),
      second.connection.dispose(),
      collision.connection.dispose()
    ]);
    expect(registry.size).toBe(0);
  });

  it("keeps persisted identities non-actionable after restart and removes ownership on cleanup failure", async () => {
    const registry = new ActiveAgentRunRegistry();
    expect(registry.lookup("executorRunId", "/stale/run", "RUN-001")).toBeNull();
    const closed: string[] = [];
    const failing = handle("/live/run", "RUN-001", "session-1", closed);
    failing.control.connection.close = async () => {
      await failing.connection.dispose();
      throw new Error("cleanup failed");
    };
    registry.register(failing);
    await expect(registry.shutdown()).rejects.toThrow("shutdown did not complete cleanly");
    expect(registry.size).toBe(0);
    await expect(registry.remove(failing, "again")).rejects.toThrow(
      "Runner terminal cleanup did not complete cleanly"
    );
  });
});

describe("AcpSessionController lifecycle", () => {
  async function execute(
    scenario: string,
    timeoutMs = ACP_MOCK_OPERATION_TIMEOUT_MS,
    signal?: AbortSignal,
    controller?: AcpSessionController
  ) {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-lifecycle-"));
    const registry = new ActiveAgentRunRegistry();
    const sessionController = controller ?? new AcpSessionController(registry);
    const promise = sessionController.execute(
      {
        kind: "implementation",
        identity: { scope: root, executorRunId: "RUN-001", claimRef: "T-001#B-001" },
        runDir: root,
        metadataPath: join(root, "metadata.json"),
        prompt: "implement",
        cwd: root,
        launch: { command: process.execPath, args: [fixture, scenario] },
        executorName: "mock-acp",
        agentId: "codex",
        taskId: "T-001",
        metadataIdentity: { blockId: "B-001" }
      },
      { timeoutMs, signal }
    );
    return { root, registry, promise };
  }

  it("sends the runner-only artifact instruction, writes the artifact, and releases ownership", async () => {
    const run = await execute("artifact-implementation");
    await expect(run.promise).resolves.toMatchObject({
      kind: "block",
      runId: "RUN-001",
      runnerKind: "acp",
      agentSessionId: "mock-session-1"
    });
    expect(run.registry.size).toBe(0);
    await expect(readFile(join(run.root, "report.md"), "utf8")).resolves.toBe("implemented\n");
    await expect(readFile(join(run.root, "metadata.json"), "utf8")).resolves.toContain('"status": "completed"');
    await expect(readFile(join(run.root, "heartbeat.json"), "utf8")).resolves.toContain('"status": "completed"');
  });

  it("persists failed and timed-out terminal diagnostics and cleans live ownership", async () => {
    const failed = await execute("protocol-error");
    await expect(failed.promise).rejects.toThrow();
    expect(failed.registry.size).toBe(0);
    await expect(readFile(join(failed.root, "metadata.json"), "utf8")).resolves.toContain('"status": "failed"');

    const timedOut = await execute("delayed", 5);
    await expect(timedOut.promise).rejects.toThrow("timed out");
    expect(timedOut.registry.size).toBe(0);
    await expect(readFile(join(timedOut.root, "heartbeat.json"), "utf8")).resolves.toContain('"status": "timed_out"');
  });

  it("persists cancellation and settles registry ownership", async () => {
    const abort = new AbortController();
    const cancelled = await execute("delayed", 500, abort.signal);
    setTimeout(() => abort.abort(new Error("caller cancelled")), 10);
    await expect(cancelled.promise).rejects.toThrow("caller cancelled");
    expect(cancelled.registry.size).toBe(0);
    await expect(readFile(join(cancelled.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "cancelled"'
    );
  });

  it("owns and cancels the connection while initialize is pending", async () => {
    const pending = await execute("delayed", 500);
    for (let attempt = 0; attempt < 20 && pending.registry.size === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(pending.registry.size).toBe(1);
    let live = pending.registry.lookup("executorRunId", pending.root, "RUN-001");
    for (let attempt = 0; attempt < 20 && live?.connection.pendingOperationCount !== 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      live = pending.registry.lookup("executorRunId", pending.root, "RUN-001");
    }
    expect(live?.connection.processId).toEqual(expect.any(Number));
    expect(live?.connection.pendingOperationCount).toBe(1);
    expect(live?.ownership.generation).toBe(1);
    expect(live?.control.ownership).toBe(live?.ownership);
    expect([...live!.control.pendingOperations.values()].map((operation) => operation.operation)).toEqual([
      "initialize"
    ]);
    await pending.registry.shutdown("test shutdown");
    await expect(pending.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(live?.connection.pendingOperationCount).toBe(0);
    expect(pending.registry.size).toBe(0);
    await expect(readFile(join(pending.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "cancelled"'
    );
  });

  it.each([
    ["auth-required", "session creation"],
    ["early-exit", "process exit"]
  ])("fails and cleans ownership on %s during %s", async (scenario) => {
    const failed = await execute(scenario);
    await expect(failed.promise).rejects.toThrow();
    expect(failed.registry.size).toBe(0);
    await expect(readFile(join(failed.root, "heartbeat.json"), "utf8")).resolves.toContain(
      '"status": "failed"'
    );
  });

  it("cancels and settles an in-flight prompt during shutdown", async () => {
    const pending = await execute("long-prompt", 1_000);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const live = pending.registry.lookup("executorRunId", pending.root, "RUN-001");
      if (live?.identity.sessionId) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    let live = pending.registry.lookup("executorRunId", pending.root, "RUN-001");
    for (let attempt = 0; attempt < 100 && live?.connection.pendingOperationCount !== 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      live = pending.registry.lookup("executorRunId", pending.root, "RUN-001");
    }
    expect(live?.identity.sessionId).toBe("mock-session-1");
    expect(live?.connection.pendingOperationCount).toBe(1);
    await pending.registry.shutdown("prompt shutdown");
    await expect(pending.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(live?.connection.pendingOperationCount).toBe(0);
    expect(pending.registry.size).toBe(0);
  });

  it("fails closed when a successful prompt omits the final artifact marker", async () => {
    const missing = await execute("success");
    await expect(missing.promise).rejects.toThrow("Final artifact marker was not found");
    expect(missing.registry.size).toBe(0);
    await expect(readFile(join(missing.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "failed"'
    );
  });

  it.each([
    ["artifact-implementation", "Execution succeeded"],
    ["protocol-error", "Invalid params"]
  ])("persists failed when %s execution is followed by cleanup failure", async (scenario, executionText) => {
    const registry = new ActiveAgentRunRegistry();
    const controller = new AcpSessionController(registry, (options: CreateAcpConnectionOptions) => {
      const base = createAcpConnection(options);
      return new Proxy(base, {
        get(target, property) {
          if (property === "dispose") {
            return async () => {
              await target.dispose();
              throw new Error("cleanup exploded");
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    });
    const failed = await execute(scenario, 500, undefined, controller);
    await expect(failed.promise).rejects.toThrow();
    const metadata = await readFile(join(failed.root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).not.toContain('"outcome": "succeeded"');
    expect(metadata).toContain(executionText);
    expect(metadata).toContain("cleanup exploded");
    expect(registry.size).toBe(0);
  });
});

describe("AcpRunner claim routing", () => {
  const profile = { adapter: "agent", agent: "codex", runner: { transport: "acp" } } as const;
  function definition(scenario: string): AgentDefinition {
    return {
      agent: "codex",
      builtinProfiles: {},
      cli: null,
      acp: {
        launch: mockLaunch(scenario),
        capabilities: [],
        optionalCapabilities: [],
        limitations: []
      }
    };
  }

  it("routes implementation, review, and feedback claims through distinct sessions", async () => {
    const { init } = await createTestWorkspace();
    const runner = createAcpRunner();
    for (const scenario of ["artifact-implementation", "artifact-review", "artifact-feedback"]) {
      const launch = mockLaunch(scenario);
      await trustCommand(init.workspace, launch.command, [...launch.args]);
    }
    const implementation = await runner.runBlock({
      projectRoot: init.workspace,
      claim: { kind: "block", ref: "T-001#B-001", taskId: "T-001", blockId: "B-001", blockType: "implementation", effectiveExecutor: "codex-acp" },
      prompt: "implement",
      executorName: "codex-acp",
      profile
    }, definition("artifact-implementation"));
    const review = await runner.runBlock({
      projectRoot: init.workspace,
      claim: { kind: "block", ref: "T-001#R-001", taskId: "T-001", blockId: "R-001", blockType: "review", effectiveExecutor: "codex-acp" },
      prompt: "review",
      executorName: "codex-acp",
      profile
    }, definition("artifact-review"));
    const feedback = await runner.runFeedback({
      projectRoot: init.workspace,
      workspace: init.workspace,
      claim: { kind: "feedback", feedbackId: "FE-001", sourceReviewBlockRef: "T-001#R-001", taskId: "T-001", content: "fix", effectiveExecutor: "codex-acp" },
      executorName: "codex-acp",
      profile
    }, definition("artifact-feedback"));

    expect(implementation).toMatchObject({ kind: "block", agentSessionId: "mock-session-1" });
    expect(review).toMatchObject({ kind: "review", agentSessionId: "mock-session-1" });
    expect(feedback).toMatchObject({ kind: "feedback", agentSessionId: "mock-session-1" });
    expect(new Set([implementation.runId, review.runId])).toEqual(new Set(["RUN-001"]));
    if (implementation.kind !== "block") throw new Error("Expected implementation result.");
    await expect(readFile(join(dirname(implementation.reportPath), "prompt.md"), "utf8"))
      .resolves.toBe("implement");
  });

  it("propagates cancellation through createExecutorAdapter and restores TaskManager claim state", async () => {
    const { init } = await createTestWorkspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("delayed");
    await trustCommand(init.workspace, process.execPath, [fixture, "delayed"]);
    const abort = new AbortController();
    try {
      const step = runAutoRunStep({
        projectRoot: init.workspace,
        executor: createExecutorAdapter({
          projectRoot: init.workspace,
          executorName: "codex-acp",
          runtime: { signal: abort.signal, timeoutMs: 500, desktopRunId: "DESKTOP-RUN-0001", runSessionId: "SESSION-0001" }
        })
      });
      setTimeout(() => abort.abort(new Error("end-to-end cancelled")), 10);
      await expect(step).rejects.toMatchObject({ name: "AbortError" });
      const status = await getExecutionStatus({ projectRoot: init.workspace });
      expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });

  it("submits a validated ACP final artifact through the TaskManager pipeline", async () => {
    const { init } = await createTestWorkspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("artifact-implementation");
    await trustCommand(init.workspace, process.execPath, [fixture, "artifact-implementation"]);
    try {
      await expect(runAutoRunStep({
        projectRoot: init.workspace,
        executorName: "codex-acp"
      })).resolves.toMatchObject({
        kind: "submitted",
        adapterResult: { kind: "block", runnerKind: "acp" },
        submitResult: { ref: "T-001#B-001", status: "completed" }
      });
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });
});

describe("Desktop ACP stop ownership", () => {
  async function workspace() {
    return createTestWorkspace(
      manifestTestBuilder().withDefaultExecutor("codex-acp").build()
    );
  }

  it("keeps an immediately stopped ACP block ready without submission", async () => {
    const { root, init } = await workspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("delayed-artifact-implementation");
    await trustCommand(init.workspace, process.execPath, [fixture, "delayed-artifact-implementation"]);
    try {
      expect((await getExecutionStatus({ projectRoot: init.workspace })).blocks[0]?.effectiveExecutor).toBe("codex-acp");
      const started = await startAutoRun(root, null, { kind: "project" }, 1, { tmuxEnabled: false });
      await stopAutoRun(started.runId);
      await waitForCondition(async () => {
        const status = await getExecutionStatus({ projectRoot: init.workspace });
        return (
          status.blocks.find((block) => block.ref === "T-001#B-001")?.status === "ready" &&
          activeAgentRunRegistry.lookupDesktopRun(started.runId) === null
        );
      });
      const status = await getExecutionStatus({ projectRoot: init.workspace });
      expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
      expect(activeAgentRunRegistry.lookupDesktopRun(started.runId)).toBeNull();
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });

  it("cancels an ACP prompt in flight without submitting its block", async () => {
    const { root, init } = await workspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("late-update");
    await trustCommand(init.workspace, process.execPath, [fixture, "late-update"]);
    try {
      expect((await getExecutionStatus({ projectRoot: init.workspace })).blocks[0]?.effectiveExecutor).toBe("codex-acp");
      const started = await startAutoRun(root, null, { kind: "project" }, 1, { tmuxEnabled: false });
      await waitForCondition(async () =>
        activeAgentRunRegistry.lookupDesktopRun(started.runId)?.identity.sessionId === "mock-session-1"
      );
      expect(activeAgentRunRegistry.lookupDesktopRun(started.runId)?.identity.sessionId).toBe("mock-session-1");
      await stopAutoRun(started.runId);
      await waitForCondition(async () => {
        const status = await getExecutionStatus({ projectRoot: init.workspace });
        return (
          status.blocks.find((block) => block.ref === "T-001#B-001")?.status === "ready" &&
          activeAgentRunRegistry.lookupDesktopRun(started.runId) === null
        );
      });
      const status = await getExecutionStatus({ projectRoot: init.workspace });
      expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
      expect(activeAgentRunRegistry.lookupDesktopRun(started.runId)).toBeNull();
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });
});
