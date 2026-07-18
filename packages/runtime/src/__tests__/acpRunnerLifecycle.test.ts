import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ActiveAgentRunRegistry,
  type ActiveAgentRunHandle
} from "../autoRun/activeAgentRunRegistry.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
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
import { getAutoRunState, startAutoRun, stopAutoRun } from "../desktop/runApi.js";
import { getTaskWorkspace, listTaskWorkspaceRuns } from "../desktop/taskWorkspaceApi.js";
import { activeAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { trustCommand } from "../taskManager/hookTrustStore.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../autoRun/executorShared.js";
import { executionWaveIdSchema } from "../autoRun/runnerContractSchemas.js";
import { recordBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import { readJsonFile } from "../json.js";
import { claimNext } from "../taskManager/index.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function mockLaunch(scenario: string) {
  const source = codexAgentDefinition.acp.launch?.source;
  if (!source) throw new Error("Expected Codex ACP launch source metadata.");
  return { command: process.execPath, args: [fixture, scenario], source };
}

async function withLifecycleTrace<T>(run: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-acp-run-lifecycle-"));
  const path = join(directory, "lifecycle.log");
  await writeFile(path, "", "utf8");
  const previous = process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE;
  process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE = path;
  try {
    const result = await run(path);
    return { result, lifecycle: await readFile(path, "utf8") };
  } finally {
    if (previous === undefined) delete process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE;
    else process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE = previous;
  }
}

function lifecycleOperations(lifecycle: string): string[] {
  return lifecycle
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(line.indexOf(" ") + 1));
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
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

function handle(
  scope: string,
  runId: string,
  sessionId: string,
  closed: string[]
): ActiveAgentRunHandle {
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
        closeSession: async (boundSessionId) => {
          await connection.closeSession(boundSessionId);
        },
        supportsSessionClose: false
      },
      interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
      sessionId,
      pendingRequests: new Map(),
      pendingOperations: connection.pendingOperations
    }
  };
}

function cleanupTestHandle(
  scope: string,
  runId: string,
  sessionId: string,
  closed: string[]
): ActiveAgentRunHandle {
  const result = handle(scope, runId, sessionId, closed);
  result.control.process.terminate = async () => undefined;
  return result;
}

function registryIndexHandle(
  scope: string,
  runId: string,
  sessionId: string,
  closed: string[]
): ActiveAgentRunHandle {
  const result = cleanupTestHandle(scope, runId, sessionId, closed);
  result.control.connection.close = async (reason) => {
    closed.push(reason);
  };
  return result;
}

describe("ActiveAgentRunRegistry", () => {
  it("indexes concurrent identities, rejects collisions and cross-run lookup, and removes exactly once", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const first = registryIndexHandle("/project-a/results/run", "RUN-001", "session-1", closed);
    const second = registryIndexHandle("/project-b/results/run", "RUN-001", "session-1", closed);
    registry.register(first);
    registry.register(second);
    expect(registry.lookup("sessionId", "/project-a/results/run", "session-1", "RUN-001")).toBe(
      first
    );
    expect(registry.lookup("sessionId", "/project-b/results/run", "session-1", "RUN-001")).toBe(
      second
    );
    expect(() =>
      registry.lookup("sessionId", "/project-a/results/run", "session-1", "RUN-002")
    ).toThrow("different executor run");
    const collision = registryIndexHandle(
      "/project-a/results/run",
      "RUN-001",
      "session-1",
      closed
    );
    expect(() => registry.register(collision)).toThrow("collision");
    await expect(
      Promise.all([registry.remove(first, "done"), registry.remove(first, "again")])
    ).resolves.toEqual([true, true]);
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
    const shutdownFailure = await registry.shutdown().catch((error: unknown) => error);
    expect(registry.size).toBe(0);
    const removalFailure = await registry.remove(failing, "again").catch((error: unknown) => error);
    expect(shutdownFailure).toBe(removalFailure);
    expect(removalFailure).toMatchObject({
      message: "Runner terminal cleanup did not complete cleanly."
    });
  });

  it("rethrows a single pre-removal failure after completing live cleanup", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const failing = cleanupTestHandle("/live/single-failure", "RUN-001", "session-1", closed);
    const preparationFailure = new Error("owner preparation failed");
    failing.beforeRemove = async () => {
      throw preparationFailure;
    };
    registry.register(failing);

    await expect(registry.remove(failing, "done")).rejects.toBe(preparationFailure);
    expect(closed).toEqual(["done"]);
    expect(registry.size).toBe(0);
  });

  it("rethrows a single pre-removal failure for an already absent handle", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const absent = cleanupTestHandle("/live/absent", "RUN-001", "session-1", closed);
    const preparationFailure = new Error("absent owner preparation failed");
    absent.beforeRemove = async () => {
      throw preparationFailure;
    };

    await expect(registry.remove(absent, "done")).rejects.toBe(preparationFailure);
    expect(closed).toEqual([]);
    expect(registry.size).toBe(0);
    await absent.connection.dispose();
  });

  it("aggregates independent pre-removal and live cleanup failures", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const failing = cleanupTestHandle("/live/multiple-failures", "RUN-001", "session-1", closed);
    const preparationFailure = new Error("owner preparation failed");
    failing.beforeRemove = async () => {
      throw preparationFailure;
    };
    failing.control.connection.close = async (reason) => {
      closed.push(reason);
      await failing.connection.dispose();
      throw new Error("live cleanup failed");
    };
    registry.register(failing);

    const failure = await registry.remove(failing, "done").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors).toHaveLength(2);
    expect(failure instanceof AggregateError && failure.errors[0]).toBe(preparationFailure);
    expect(failure instanceof AggregateError && failure.errors[1]).toMatchObject({
      message: "Runner terminal cleanup did not complete cleanly."
    });
    expect(closed).toEqual(["done"]);
    expect(registry.size).toBe(0);
  });

  it("aggregates direct failures from independent handles during shutdown", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const first = cleanupTestHandle("/live/shutdown-a", "RUN-001", "session-1", closed);
    const second = cleanupTestHandle("/live/shutdown-b", "RUN-002", "session-2", closed);
    const firstFailure = new Error("first shutdown preparation failed");
    const secondFailure = new Error("second shutdown preparation failed");
    first.beforeRemove = async () => {
      throw firstFailure;
    };
    second.beforeRemove = async () => {
      throw secondFailure;
    };
    registry.register(first);
    registry.register(second);

    const failure = await registry.shutdown().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors).toEqual([
      firstFailure,
      secondFailure
    ]);
    expect(closed).toEqual(["PlanWeave runtime shutdown.", "PlanWeave runtime shutdown."]);
    expect(registry.size).toBe(0);
  });

  it("rethrows a single Desktop-run shutdown failure by identity", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const failing = cleanupTestHandle("/live/desktop-single", "RUN-001", "session-1", closed);
    failing.identity.desktopRunId = "DESKTOP-RUN-001";
    const preparationFailure = new Error("Desktop owner preparation failed");
    failing.beforeRemove = async () => {
      throw preparationFailure;
    };
    registry.register(failing);

    await expect(registry.shutdownDesktopRun("DESKTOP-RUN-001", "Desktop shutdown")).rejects.toBe(
      preparationFailure
    );
    expect(closed).toEqual(["Desktop shutdown"]);
    expect(registry.size).toBe(0);
  });

  it("aggregates direct failures from matching Desktop runs", async () => {
    const registry = new ActiveAgentRunRegistry();
    const closed: string[] = [];
    const first = cleanupTestHandle("/live/desktop-a", "RUN-001", "session-1", closed);
    const second = cleanupTestHandle("/live/desktop-b", "RUN-002", "session-2", closed);
    first.identity.desktopRunId = "DESKTOP-RUN-001";
    second.identity.desktopRunId = "DESKTOP-RUN-001";
    const firstFailure = new Error("first Desktop owner preparation failed");
    const secondFailure = new Error("second Desktop owner preparation failed");
    first.beforeRemove = async () => {
      throw firstFailure;
    };
    second.beforeRemove = async () => {
      throw secondFailure;
    };
    registry.register(first);
    registry.register(second);

    const failure = await registry
      .shutdownDesktopRun("DESKTOP-RUN-001", "Desktop shutdown")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors).toEqual([
      firstFailure,
      secondFailure
    ]);
    expect(closed).toEqual(["Desktop shutdown", "Desktop shutdown"]);
    expect(registry.size).toBe(0);
  });
});

describe("AcpSessionController lifecycle", () => {
  async function execute(
    scenario: string,
    timeoutMs = ACP_MOCK_OPERATION_TIMEOUT_MS,
    signal?: AbortSignal,
    controller?: AcpSessionController,
    runPatch: Partial<AcpSessionRun> = {}
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
        metadataIdentity: { blockId: "B-001" },
        ...runPatch
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
    await expect(readFile(join(run.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "completed"'
    );
    await expect(readFile(join(run.root, "heartbeat.json"), "utf8")).resolves.toContain(
      '"status": "completed"'
    );
  });

  it("orders initialize, authentication, session creation, and prompt before becoming runnable", async () => {
    const { result, lifecycle } = await withLifecycleTrace(async () => {
      const run = await execute(
        "authenticated-artifact-implementation",
        1_000,
        undefined,
        undefined,
        {
          authenticationHints: {
            preferredMethodIds: ["mock-login"],
            headlessSafeMethodIds: ["mock-login"]
          },
          projectId: "project-1",
          canvasId: "default"
        }
      );
      return { run, output: await run.promise };
    });

    expect(result.output).toMatchObject({ kind: "block", exitCode: 0 });
    expect(lifecycleOperations(lifecycle)).toEqual([
      "spawn",
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt"
    ]);
    const events = await readFile(join(result.run.root, "events.ndjson"), "utf8");
    const selectedIndex = events.indexOf("ACP authentication method selected: mock-login");
    const completedIndex = events.indexOf("ACP authentication completed.");
    const readyIndex = events.indexOf("ACP runner is ready.");
    expect(selectedIndex).toBeGreaterThanOrEqual(0);
    expect(selectedIndex).toBeLessThan(completedIndex);
    expect(completedIndex).toBeLessThan(readyIndex);
  });

  it("does not authenticate when no methods are advertised", async () => {
    const { result, lifecycle } = await withLifecycleTrace(async () => {
      const run = await execute("artifact-implementation", 1_000);
      return { run, output: await run.promise };
    });

    expect(result.output).toMatchObject({ kind: "block", exitCode: 0 });
    expect(lifecycleOperations(lifecycle)).toEqual([
      "spawn",
      "initialize",
      "session/new",
      "session/prompt"
    ]);
  });

  it("fails action-required authentication before ready, session creation, or prompt", async () => {
    const { result, lifecycle } = await withLifecycleTrace(async () => {
      const run = await execute("action-required", 1_000, undefined, undefined, {
        projectId: "project-1",
        canvasId: "default"
      });
      await expect(run.promise).rejects.toThrow("headless-safe authentication method");
      return run;
    });

    expect(lifecycleOperations(lifecycle)).toEqual(["spawn", "initialize"]);
    const events = await readFile(join(result.root, "events.ndjson"), "utf8");
    expect(events).toContain("ACP authentication requires user action.");
    expect(events).not.toContain("ACP runner is ready.");
    expect(events).not.toContain('"state":"running"');
    expect(events).toContain('"kind":"terminal"');
    expect(events).toContain('"state":"failed"');
    await expect(readFile(join(result.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "failed"'
    );
  });

  it("preserves authentication protocol failures before session creation", async () => {
    const { result, lifecycle } = await withLifecycleTrace(async () => {
      const run = await execute("authenticate-protocol-error", 1_000, undefined, undefined, {
        authenticationHints: {
          preferredMethodIds: ["mock-login"],
          headlessSafeMethodIds: ["mock-login"]
        }
      });
      await expect(run.promise).rejects.toThrow("Invalid params");
      return run;
    });

    expect(lifecycleOperations(lifecycle)).toEqual(["spawn", "initialize", "authenticate"]);
    await expect(readFile(join(result.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "failed"'
    );
  });

  it("preserves authentication timeout and cancellation without creating a session", async () => {
    const authenticationHints = {
      preferredMethodIds: ["mock-login"],
      headlessSafeMethodIds: ["mock-login"]
    } as const;
    const timedOut = await execute("authenticate-delayed", 25, undefined, undefined, {
      authenticationHints
    });
    await expect(timedOut.promise).rejects.toThrow("timed out");
    await expect(readFile(join(timedOut.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "timed_out"'
    );

    const abort = new AbortController();
    const { result, lifecycle } = await withLifecycleTrace(async (path) => {
      const cancelled = await execute("authenticate-delayed", 1_000, abort.signal, undefined, {
        authenticationHints
      });
      await waitForCondition(async () =>
        (await readFile(path, "utf8")).includes(" authenticate\n")
      );
      abort.abort(new Error("cancel authentication"));
      await expect(cancelled.promise).rejects.toThrow("cancel authentication");
      return cancelled;
    });
    expect(lifecycleOperations(lifecycle)).toEqual(["spawn", "initialize", "authenticate"]);
    await expect(readFile(join(result.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "cancelled"'
    );
  });

  it("persists failed and timed-out terminal diagnostics and cleans live ownership", async () => {
    const failed = await execute("protocol-error");
    await expect(failed.promise).rejects.toThrow();
    expect(failed.registry.size).toBe(0);
    await expect(readFile(join(failed.root, "metadata.json"), "utf8")).resolves.toContain(
      '"status": "failed"'
    );

    const timedOut = await execute("delayed", 5);
    await expect(timedOut.promise).rejects.toThrow("timed out");
    expect(timedOut.registry.size).toBe(0);
    await expect(readFile(join(timedOut.root, "heartbeat.json"), "utf8")).resolves.toContain(
      '"status": "timed_out"'
    );
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
    for (
      let attempt = 0;
      attempt < 20 && live?.connection.pendingOperationCount !== 1;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      live = pending.registry.lookup("executorRunId", pending.root, "RUN-001");
    }
    expect(live?.connection.processId).toEqual(expect.any(Number));
    expect(live?.connection.pendingOperationCount).toBe(1);
    expect(live?.ownership.generation).toBe(1);
    expect(live?.control.ownership).toBe(live?.ownership);
    expect(
      [...live!.control.pendingOperations.values()].map((operation) => operation.operation)
    ).toEqual(["initialize"]);
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
    for (
      let attempt = 0;
      attempt < 100 && live?.connection.pendingOperationCount !== 1;
      attempt += 1
    ) {
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
    ["artifact-implementation", "Execution succeeded", {}],
    ["protocol-error", "Invalid params", {}],
    [
      "authenticate-protocol-error",
      "Invalid params",
      {
        authenticationHints: {
          preferredMethodIds: ["mock-login"],
          headlessSafeMethodIds: ["mock-login"]
        }
      }
    ]
  ])("persists failed when %s execution is followed by cleanup failure", async (scenario, executionText, runPatch) => {
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
    const failed = await execute(scenario, 500, undefined, controller, runPatch);
    await expect(failed.promise).rejects.toThrow();
    const metadata = await readFile(join(failed.root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).not.toContain('"outcome": "succeeded"');
    expect(metadata).toContain(executionText);
    expect(metadata).toContain("cleanup exploded");
    expect(registry.size).toBe(0);
  });
});

describe("ACP runner runtime limits", () => {
  it.each([
    { profileTimeoutMs: undefined, expectedTimeoutMs: DEFAULT_EXECUTOR_TIMEOUT_MS },
    { profileTimeoutMs: 12_345, expectedTimeoutMs: 12_345 }
  ])("uses the executor profile timeout $expectedTimeoutMs when no call-level timeout is provided", async ({
    profileTimeoutMs,
    expectedTimeoutMs
  }) => {
    const { init } = await createTestWorkspace();
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    const execute = vi.spyOn(controller, "execute").mockRejectedValue(new Error("captured"));
    const runner = createAcpRunner({ sessionController: controller });
    const runtimeProfile = {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" },
      ...(profileTimeoutMs === undefined ? {} : { timeoutMs: profileTimeoutMs })
    } as const;
    const runtimeDefinition: AgentDefinition = {
      agent: "codex",
      builtinProfiles: {},
      cli: null,
      acp: {
        launch: mockLaunch("artifact-implementation"),
        authentication: {
          preferredMethodIds: ["mock-login"],
          headlessSafeMethodIds: ["mock-login"]
        },
        capabilities: [],
        optionalCapabilities: [],
        limitations: []
      }
    };

    await expect(
      runner.runBlock(
        {
          projectRoot: init.workspace,
          claim: {
            kind: "block",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            blockType: "implementation",
            effectiveExecutor: "codex-acp"
          },
          prompt: "implement",
          executorName: "codex-acp",
          profile: runtimeProfile,
          profileSource: "builtin"
        },
        runtimeDefinition
      )
    ).rejects.toThrow("captured");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationHints: {
          preferredMethodIds: ["mock-login"],
          headlessSafeMethodIds: ["mock-login"]
        }
      }),
      expect.objectContaining({ timeoutMs: expectedTimeoutMs })
    );
  });

  it("prefers a call-level timeout over the executor profile timeout", async () => {
    const { init } = await createTestWorkspace();
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    const execute = vi.spyOn(controller, "execute").mockRejectedValue(new Error("captured"));
    const runner = createAcpRunner({ sessionController: controller });
    const runtimeProfile = {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" },
      timeoutMs: 12_345
    } as const;
    const runtimeDefinition: AgentDefinition = {
      agent: "codex",
      builtinProfiles: {},
      cli: null,
      acp: {
        launch: mockLaunch("artifact-implementation"),
        capabilities: [],
        optionalCapabilities: [],
        limitations: []
      }
    };

    await expect(
      runner.runBlock(
        {
          projectRoot: init.workspace,
          claim: {
            kind: "block",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            blockType: "implementation",
            effectiveExecutor: "codex-acp"
          },
          prompt: "implement",
          executorName: "codex-acp",
          profile: runtimeProfile,
          profileSource: "builtin",
          runtime: { timeoutMs: 4_321 }
        },
        runtimeDefinition
      )
    ).rejects.toThrow("captured");

    expect(execute).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 4_321 })
    );
  });

  it.each([
    { profileTimeoutMs: undefined, expectedTimeoutMs: DEFAULT_EXECUTOR_TIMEOUT_MS },
    { profileTimeoutMs: 12_345, expectedTimeoutMs: 12_345 }
  ])("uses timeout $expectedTimeoutMs for feedback runs", async ({
    profileTimeoutMs,
    expectedTimeoutMs
  }) => {
    const { init } = await createTestWorkspace();
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    const execute = vi.spyOn(controller, "execute").mockRejectedValue(new Error("captured"));
    const runner = createAcpRunner({ sessionController: controller });
    const runtimeProfile = {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" },
      ...(profileTimeoutMs === undefined ? {} : { timeoutMs: profileTimeoutMs })
    } as const;
    const runtimeDefinition: AgentDefinition = {
      agent: "codex",
      builtinProfiles: {},
      cli: null,
      acp: {
        launch: mockLaunch("artifact-feedback"),
        authentication: {
          preferredMethodIds: ["mock-login"],
          headlessSafeMethodIds: ["mock-login"]
        },
        capabilities: [],
        optionalCapabilities: [],
        limitations: []
      }
    };

    await expect(
      runner.runFeedback(
        {
          projectRoot: init.workspace,
          workspace: init.workspace,
          claim: {
            kind: "feedback",
            feedbackId: "FE-001",
            sourceReviewBlockRef: "T-001#R-001",
            taskId: "T-001",
            content: "fix",
            effectiveExecutor: "codex-acp"
          },
          executorName: "codex-acp",
          profile: runtimeProfile,
          profileSource: "builtin"
        },
        runtimeDefinition
      )
    ).rejects.toThrow("captured");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationHints: {
          preferredMethodIds: ["mock-login"],
          headlessSafeMethodIds: ["mock-login"]
        }
      }),
      expect.objectContaining({ timeoutMs: expectedTimeoutMs })
    );
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

  it("requires exact trust for a package override before creating a run record", async () => {
    const { init } = await createTestWorkspace();
    const runner = createAcpRunner();
    const agentDefinition = definition("artifact-implementation");
    const input = {
      projectRoot: init.workspace,
      claim: {
        kind: "block",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        effectiveExecutor: "codex-acp"
      },
      prompt: "implement",
      executorName: "codex-acp",
      profile,
      profileSource: "package"
    } as const;
    const before = await readdir(init.workspace.resultsDir, { recursive: true });

    await expect(runner.runBlock(input, agentDefinition)).rejects.toThrow("not trusted");
    expect(await readdir(init.workspace.resultsDir, { recursive: true })).toEqual(before);

    const launch = mockLaunch("artifact-implementation");
    await trustCommand(init.workspace, launch.command, [...launch.args]);
    await expect(runner.runBlock(input, agentDefinition)).resolves.toMatchObject({
      kind: "block"
    });
  });

  it("routes implementation, review, and feedback claims through distinct sessions", async () => {
    const { init } = await createTestWorkspace();
    const runner = createAcpRunner();
    for (const scenario of ["artifact-implementation", "artifact-review", "artifact-feedback"]) {
      const launch = mockLaunch(scenario);
      await trustCommand(init.workspace, launch.command, [...launch.args]);
    }
    const executionWaveId = executionWaveIdSchema.parse(
      "WAVE-123e4567-e89b-42d3-a456-426614174000"
    );
    const implementation = await runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "codex-acp"
        },
        prompt: "implement",
        executorName: "codex-acp",
        profile,
        executionWaveId
      },
      definition("artifact-implementation")
    );
    const review = await runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#R-001",
          taskId: "T-001",
          blockId: "R-001",
          blockType: "review",
          effectiveExecutor: "codex-acp"
        },
        prompt: "review",
        executorName: "codex-acp",
        profile
      },
      definition("artifact-review")
    );
    const feedback = await runner.runFeedback(
      {
        projectRoot: init.workspace,
        workspace: init.workspace,
        claim: {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          content: "fix",
          effectiveExecutor: "codex-acp"
        },
        executorName: "codex-acp",
        profile
      },
      definition("artifact-feedback")
    );

    expect(implementation).toMatchObject({ kind: "block", agentSessionId: "mock-session-1" });
    expect(review).toMatchObject({ kind: "review", agentSessionId: "mock-session-1" });
    expect(feedback).toMatchObject({ kind: "feedback", agentSessionId: "mock-session-1" });
    expect(new Set([implementation.runId, review.runId])).toEqual(new Set(["RUN-001"]));
    if (implementation.kind !== "block") throw new Error("Expected implementation result.");
    await expect(
      readFile(join(dirname(implementation.reportPath), "prompt.md"), "utf8")
    ).resolves.toBe("implement");
    await expect(
      readJsonFile<Record<string, unknown>>(
        join(dirname(implementation.reportPath), "metadata.json")
      )
    ).resolves.toMatchObject({ executionWaveId });
    if (review.kind !== "review" || feedback.kind !== "feedback") {
      throw new Error("Expected review and feedback results.");
    }
    await expect(
      readJsonFile<Record<string, unknown>>(join(dirname(review.resultPath), "metadata.json"))
    ).resolves.not.toHaveProperty("executionWaveId");
    await expect(
      readJsonFile<Record<string, unknown>>(join(dirname(feedback.reportPath), "metadata.json"))
    ).resolves.not.toHaveProperty("executionWaveId");
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
          runtime: {
            signal: abort.signal,
            timeoutMs: 500,
            desktopRunId: "DESKTOP-RUN-0001",
            runSessionId: "SESSION-0001"
          }
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

  it("publishes an active ACP block run before execution settles", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: init.workspace });
    let releaseIndex!: () => void;
    const indexRelease = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    let announceIndex!: () => void;
    const indexPublished = new Promise<void>((resolve) => {
      announceIndex = resolve;
    });
    let firstRecord = true;
    const runner = createAcpRunner({
      recordBlockRun: async (runRoot, runId, options) => {
        await recordBlockRunInIndex(runRoot, runId, options);
        if (!firstRecord) return;
        firstRecord = false;
        announceIndex();
        await indexRelease;
      }
    });
    const execution = runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "codex-acp"
        },
        prompt: "implement",
        executorName: "codex-acp",
        profile,
        profileSource: "builtin"
      },
      definition("artifact-implementation")
    );
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await indexPublished;
    const workspace = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    const runs = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(settled).toBe(false);
    const liveRun = runs.items.find((item) => item.run.duration.finishedAt === null);
    if (!liveRun) throw new Error("Expected the indexed ACP run to remain unfinished.");
    expect(workspace.activeRecordIds).toContain(liveRun.run.record.recordId);
    expect(liveRun).toMatchObject({
      active: true,
      run: { metadata: { runnerKind: "acp" } }
    });

    releaseIndex();
    await expect(execution).resolves.toMatchObject({ kind: "block", runnerKind: "acp" });
  });

  it("submits a validated ACP final artifact through the TaskManager pipeline", async () => {
    const { init } = await createTestWorkspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("artifact-implementation");
    await trustCommand(init.workspace, process.execPath, [fixture, "artifact-implementation"]);
    try {
      await expect(
        runAutoRunStep({
          projectRoot: init.workspace,
          executorName: "codex-acp"
        })
      ).resolves.toMatchObject({
        kind: "submitted",
        adapterResult: { kind: "block", runnerKind: "acp" },
        submitResult: { ref: "T-001#B-001", status: "completed" }
      });
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });

  it("persists a scheduler-provided wave id through the profiled ACP adapter", async () => {
    const { init } = await createTestWorkspace(
      manifestTestBuilder().withDefaultExecutor("codex-acp").build()
    );
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("artifact-implementation");
    await trustCommand(init.workspace, process.execPath, [fixture, "artifact-implementation"]);
    try {
      const executionWaveId = executionWaveIdSchema.parse(
        "WAVE-123e4567-e89b-42d3-a456-426614174001"
      );
      const adapter = createExecutorAdapter({
        projectRoot: init.workspace,
        executorName: "codex-acp"
      });
      await expect(
        adapter.runBlock({
          claim: {
            kind: "block",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            blockType: "implementation",
            effectiveExecutor: "codex-acp"
          },
          prompt: "implement",
          executionWaveId
        })
      ).resolves.toMatchObject({ kind: "block" });
      const metadata = await readJsonFile<Record<string, unknown>>(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      );

      expect(metadata.executionWaveId).toBe(executionWaveId);
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });
});

describe("Desktop ACP stop ownership", () => {
  async function workspace() {
    return createTestWorkspace(manifestTestBuilder().withDefaultExecutor("codex-acp").build());
  }

  it("keeps an immediately stopped ACP block ready without submission", async () => {
    const { root, init } = await workspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("delayed-artifact-implementation");
    await trustCommand(init.workspace, process.execPath, [
      fixture,
      "delayed-artifact-implementation"
    ]);
    try {
      expect(
        (await getExecutionStatus({ projectRoot: init.workspace })).blocks[0]?.effectiveExecutor
      ).toBe("codex-acp");
      const started = await startAutoRun(root, null, { kind: "project" }, 1, {
        tmuxEnabled: false
      });
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
    codexAgentDefinition.acp.launch = mockLaunch("long-prompt");
    await trustCommand(init.workspace, process.execPath, [fixture, "long-prompt"]);
    try {
      expect(
        (await getExecutionStatus({ projectRoot: init.workspace })).blocks[0]?.effectiveExecutor
      ).toBe("codex-acp");
      const started = await startAutoRun(root, null, { kind: "project" }, 1, {
        tmuxEnabled: false
      });
      await waitForCondition(async () => {
        const handle = activeAgentRunRegistry.lookupDesktopRun(started.runId);
        return [...(handle?.control.pendingOperations.values() ?? [])].some(
          (operation) => operation.operation === "session/prompt"
        );
      });
      const handle = activeAgentRunRegistry.lookupDesktopRun(started.runId);
      if (!(handle?.identity.desktopRunId && handle.identity.runSessionId)) {
        throw new Error("Expected the Desktop ACP run to expose its exact action identity.");
      }
      expect(handle.identity.sessionId).toBe("mock-session-1");
      let markCancelStarted: (() => void) | undefined;
      const cancelStarted = new Promise<void>((resolve) => {
        markCancelStarted = resolve;
      });
      let releaseCancel: (() => void) | undefined;
      const cancelGate = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      const originalCancelSession = handle.control.connection.cancelSession;
      const cancelSession = vi
        .spyOn(handle.control.connection, "cancelSession")
        .mockImplementation(async (sessionId) => {
          markCancelStarted?.();
          await cancelGate;
          await originalCancelSession(sessionId);
        });
      const stopping = stopAutoRun(started.runId);
      await cancelStarted;
      try {
        expect(await getAutoRunState(started.runId)).toMatchObject({
          phase: "running",
          stepCount: 0
        });
        expect(activeAgentRunRegistry.lookupDesktopRun(started.runId)).toBeNull();
        await expect(
          activeAgentRunRegistry.queuePrompt(
            {
              scope: handle.identity.scope,
              executorRunId: handle.identity.executorRunId,
              desktopRunId: handle.identity.desktopRunId,
              runSessionId: handle.identity.runSessionId,
              claimRef: handle.identity.claimRef,
              sessionId: handle.identity.sessionId
            },
            "must not be accepted"
          )
        ).rejects.toThrow("does not exist");
      } finally {
        releaseCancel?.();
      }
      await stopping;
      expect(cancelSession).toHaveBeenCalledWith("mock-session-1");
      expect(handle.abortController.signal.aborted).toBe(true);
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
