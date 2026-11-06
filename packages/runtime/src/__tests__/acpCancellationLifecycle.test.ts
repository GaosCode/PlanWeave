import {
  AcpConversationTurnCoordinator,
  type AcpConversationTurnInput
} from "../autoRun/acpConversationTurn.js";
import { acpConversationTurnIdentitySchema } from "../autoRun/acpConversationTurnContract.js";
import { createSharedAcpConnectionProvider } from "../autoRun/acpSharedConnectionProvider.js";
import { performance } from "node:perf_hooks";
import {
  createAcpCleanupDeadline,
  type AcpCleanupDeadline
} from "../autoRun/acpExecutionCleanup.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { executeAcp } from "../autoRun/acpExecutionEngine.js";
import { createAcpConnection, type AcpConnection } from "../autoRun/acpConnection.js";

const fixture = fileURLToPath(new URL("./support/acpCancellationAgent.mjs", import.meta.url));

describe("ACP ordered cancellation", () => {
  describe.each(["dedicated", "shared-project"] as const)("%s", (connectionMode) => {
    it.each([
      "responsive",
      "ignored",
      "force",
      "initializing"
    ])("sends cancel before EOF and confirms process exit: %s", async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "acp-ordered-cancel-"));
      const log = join(directory, "events");
      const controller = new AbortController();
      let processId: number | null = null;
      let cleanupDeadline: AcpCleanupDeadline | null = null;
      const cleanupObservations: Array<number | null> = [];
      const run = executeAcp({
        agentId: "test",
        launch: { trusted: true, command: process.execPath, args: [fixture, log, mode] },
        workspace: { cwd: directory },
        env: {},
        clientInfo: { name: "cancel-test", version: "1" },
        shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1000 },
        capabilityPolicy: { required: [], optional: [] },
        prompt: "wait",
        sessionStart: { kind: "new" },
        signal: controller.signal,
        connectionMode,
        poolIdentity: {
          projectRoot: directory,
          profileFingerprint: mode,
          host: { kind: "native" }
        },
        cleanupObserver: (deadline) => {
          cleanupDeadline = deadline;
          cleanupObservations.push(deadline?.expiresAt ?? null);
        },
        lifecycleObserver: async (event) => {
          if (event.kind === "cleanup_starting")
            await new Promise((resolve) => setTimeout(resolve, 70));
        },
        connect: (options) => {
          const connection = createAcpConnection({
            ...options,
            decorateProcessTree: (tree) => ({
              ...tree,
              terminate: (reason, termination) => {
                expect(termination?.deadline).toMatchObject({
                  expiresAt: cleanupDeadline?.expiresAt
                });
                expect(termination?.deadline?.remainingMs).toBe(cleanupDeadline?.remainingMs);
                expect(termination?.deadline?.remainingMs()).toBeLessThanOrEqual(930);
                return tree.terminate(reason, termination);
              }
            })
          });
          processId = connection.processId;
          return connection;
        }
      });
      try {
        await vi.waitFor(async () =>
          expect(await readFile(log, "utf8")).toContain(
            mode === "initializing" ? "initialize" : "prompt"
          )
        );
        controller.abort(new Error("ordered cancellation"));
        const result = await run;
        const events = (await readFile(log, "utf8")).trim().split("\n");
        expect(events.slice(0, mode === "initializing" ? 2 : 3)).toEqual(
          mode === "initializing" ? ["initialize", "eof"] : ["prompt", "cancel", "eof"]
        );
        expect(events.filter((event) => event === "cancel")).toHaveLength(
          mode === "initializing" ? 0 : 1
        );
        expect(cleanupObservations).toEqual([expect.any(Number), null]);
        if (mode !== "responsive") expect(events).toContain("term");
        expect(result.terminal.state).toBe("cancelled");
        expect(result.cleanup).toEqual({ attempted: true, completed: true });
        if (processId === null) throw new Error("missing process id");
        expect(() => process.kill(processId, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" })
        );
      } finally {
        controller.abort();
        await run;
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
  it("uses the caller's monotonic cancellation origin when setup finished after abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cancel-origin-"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled during profile resolution"));
    const cancellationStartedAt = performance.now() - 400;
    const observations: Array<number | null> = [];
    try {
      const result = await executeAcp({
        agentId: "test",
        launch: {
          trusted: true,
          command: process.execPath,
          args: [fixture, join(directory, "events"), "ignored"]
        },
        workspace: { cwd: directory },
        env: {},
        clientInfo: { name: "cancel-origin", version: "1" },
        shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1000 },
        capabilityPolicy: { required: [], optional: [] },
        prompt: "must not run",
        sessionStart: { kind: "new" },
        signal: controller.signal,
        cancellationStartedAt,
        cleanupObserver: (deadline) => observations.push(deadline?.expiresAt ?? null)
      });
      expect(observations).toEqual([cancellationStartedAt + 1000, null]);
      expect(result.terminal.state).toBe("cancelled");
      expect(result.cleanup.completed).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    "cancel-write-stalled",
    "deadline-exhausted"
  ])("does not report completed cleanup for %s", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cancel-failure-"));
    const log = join(directory, "events");
    const controller = new AbortController();
    let connection: AcpConnection | undefined;
    let cancelAttempts = 0;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const observations: Array<number | null> = [];
    const run = executeAcp({
      agentId: "test",
      launch: { trusted: true, command: process.execPath, args: [fixture, log, "ignored"] },
      workspace: { cwd: directory },
      env: {},
      clientInfo: { name: "cancel-failure", version: "1" },
      shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
      capabilityPolicy: { required: [], optional: [] },
      prompt: "wait",
      sessionStart: { kind: "new" },
      signal: controller.signal,
      cleanupObserver: (deadline) => observations.push(deadline?.expiresAt ?? null),
      lifecycleObserver: async (event) => {
        if (failure === "deadline-exhausted" && event.kind === "cleanup_starting")
          await new Promise((resolve) => setTimeout(resolve, 350));
      },
      connect: (options) => {
        connection = createAcpConnection(options);
        return new Proxy(connection, {
          get: (target, key) => {
            if (key === "cancel")
              return (
                notification: Parameters<AcpConnection["cancel"]>[0],
                operation: Parameters<AcpConnection["cancel"]>[1]
              ) => {
                cancelAttempts += 1;
                return failure === "cancel-write-stalled"
                  ? new Promise<void>(() => undefined)
                  : target.cancel(notification, operation);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    });
    try {
      await vi.waitFor(async () => expect(await readFile(log, "utf8")).toContain("prompt"));
      controller.abort(new Error("cancel under cleanup failure"));
      const result = await Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(
            () => reject(new Error("cleanup did not settle within its budget")),
            2000
          );
        })
      ]);
      expect(result.terminal.state).toBe("cancelled");
      expect(result.cleanup).toEqual({ attempted: true, completed: false });
      expect(cancelAttempts).toBe(1);
      expect(observations).toEqual([expect.any(Number)]);
    } finally {
      clearTimeout(guard);
      controller.abort();
      await connection?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ACP setup cancellation budget", () => {
  it("keeps the original physical cleanup budget when cancellation interrupts session/load", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-load-cancel-budget-"));
    const log = join(directory, "events");
    const terminations: Array<{ expiresAt: number; remainingMs: number }> = [];
    let processId: number | null = null;
    let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const coordinator = new AcpConversationTurnCoordinator((options) => {
      const connection = createAcpConnection({
        ...options,
        decorateProcessTree: (tree) => ({
          ...tree,
          terminate: (reason, termination) => {
            if (termination?.deadline) {
              const remainingMs = termination.deadline.remainingMs();
              terminations.push({ expiresAt: performance.now() + remainingMs, remainingMs });
            }
            return tree.terminate(reason, termination);
          }
        })
      });
      processId = connection.processId;
      return connection;
    });
    const input: AcpConversationTurnInput = {
      key: "load-cancel-budget",
      identity: acpConversationTurnIdentitySchema.parse({
        version: "planweave.agent-prompt-turn/v1",
        ref: { projectRoot: directory, canvasId: "default" },
        recordId: "T-001#B-001::RUN-001",
        executorRunId: "RUN-001",
        claimRef: "T-001#B-001",
        sessionId: "session-1",
        turnId: "11111111-1111-4111-8111-111111111111"
      }),
      cwd: directory,
      profile: {
        profileId: "load-budget",
        agentId: "codex",
        displayName: "Load budget",
        host: { kind: "native" },
        launch: { command: process.execPath, args: [fixture, log, "loading"] },
        environment: [],
        shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1000 },
        capabilities: { required: [], optional: [] },
        connection: { mode: "dedicated" },
        source: "builtin",
        fingerprint: "a".repeat(64)
      },
      environment: { env: {}, availableNames: [] },
      text: "must not prompt",
      timeoutMs: 10000,
      eventStore: {
        append: async () => undefined,
        appendProtocol: async () => undefined,
        drain: async () => undefined
      }
    };
    const sending = coordinator.send(input);
    let unsubscribe: (() => void) | undefined;
    try {
      await vi.waitFor(async () => expect(await readFile(log, "utf8")).toContain("load"));
      unsubscribe = coordinator.subscribe(input.key, () => {
        const state = coordinator.query(input.key, input.identity);
        if (state.found && state.state.cancellationRequested) now = 450;
      });
      await coordinator.cancel(input.key, input.identity);
      await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });
      expect(terminations).toEqual([{ expiresAt: 1100, remainingMs: 650 }]);
      expect(await readFile(log, "utf8")).not.toContain("prompt");
      if (processId === null) throw new Error("missing load process id");
      expect(() => process.kill(processId, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" })
      );
    } finally {
      unsubscribe?.();
      await coordinator.cancel(input.key, input.identity);
      await sending.catch(() => undefined);
      clock.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    false,
    true
  ])("preserves the authenticating cold start when another waiter survives: %s", async (anotherWaiter) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-auth-cancel-budget-"));
    const log = join(directory, "events");
    const release = join(directory, "release-auth");
    const terminations: Array<{ expiresAt: number; remainingMs: number }> = [];
    let processId: number | null = null;
    let now = 100;
    let deadline: AcpCleanupDeadline | undefined;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const controller = new AbortController();
    controller.signal.addEventListener(
      "abort",
      () => {
        deadline = createAcpCleanupDeadline(1000);
        now += 350;
      },
      { once: true }
    );
    const provider = createSharedAcpConnectionProvider({
      connect: (options) => {
        const connection = createAcpConnection({
          ...options,
          decorateProcessTree: (tree) => ({
            ...tree,
            terminate: (reason, termination) => {
              if (termination?.deadline) {
                const remainingMs = termination.deadline.remainingMs();
                terminations.push({ expiresAt: performance.now() + remainingMs, remainingMs });
              }
              return tree.terminate(reason, termination);
            }
          })
        });
        processId = connection.processId;
        return connection;
      }
    });
    const request = {
      launch: {
        trusted: true as const,
        command: process.execPath,
        args: [fixture, log, "authenticating", release]
      },
      cwd: directory,
      env: {},
      clientInfo: { name: "auth-budget", version: "1" },
      shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1000 },
      signal: controller.signal,
      get cleanupDeadline() {
        return deadline;
      },
      poolIdentity: {
        projectRoot: directory,
        profileFingerprint: "auth-budget",
        host: { kind: "native" as const }
      }
    };
    const cause = new Error("cancel auth waiter");
    const acquiring = provider.acquire(request);
    const rejected = expect(acquiring).rejects.toBe(cause);
    const surviving = anotherWaiter ? provider.acquire({ ...request, signal: undefined }) : null;
    try {
      await vi.waitFor(async () => expect(await readFile(log, "utf8")).toContain("auth"));
      controller.abort(cause);
      await rejected;
      if (surviving) {
        expect(terminations).toEqual([]);
        await writeFile(release, "continue");
        const lease = await surviving;
        await lease.initialize();
        const session = await lease.openSession({ kind: "new" });
        await expect(
          session.prompt([{ type: "text", text: "surviving waiter" }])
        ).resolves.toMatchObject({ stopReason: "end_turn" });
        expect((await readFile(log, "utf8")).match(/auth/g)).toHaveLength(1);
        await lease.release({
          terminal: "succeeded",
          cleanupDeadline: createAcpCleanupDeadline(1000)
        });
      } else {
        expect(terminations).toEqual([{ expiresAt: 1100, remainingMs: 650 }]);
        if (processId === null) throw new Error("missing authentication process id");
        expect(() => process.kill(processId, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" })
        );
      }
    } finally {
      controller.abort(cause);
      await writeFile(release, "continue");
      await surviving?.catch(() => undefined);
      await provider.shutdown();
      clock.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
