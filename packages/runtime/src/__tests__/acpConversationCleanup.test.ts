import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AcpConversationTurnCoordinator,
  type AcpConversationTurnInput
} from "../autoRun/acpConversationTurn.js";
import {
  createAcpConnection,
  type AcpConnection,
  type CreateAcpConnectionOptions
} from "../autoRun/acpConnection.js";
import { consumeAcpPromptRunRecord, type CompletedAcpMetadata } from "../desktop/acpPromptApi.js";
import { consumeRunnerRecordReadModel } from "../autoRun/runnerRecordReadModel.js";
import { gateAcpCapabilities } from "../autoRun/acpCapabilityGate.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { createSharedAcpConnectionProvider } from "../autoRun/acpSharedConnectionProvider.js";
import {
  createAcpCleanupDeadline,
  type AcpCleanupDeadline
} from "../autoRun/acpExecutionCleanup.js";

const fixture = fileURLToPath(new URL("./support/acpCancellationAgent.mjs", import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function harness(options: { disposalError?: Error; shared?: boolean } = {}) {
  const optionsForHarness = options;
  const directory = await mkdtemp(join(tmpdir(), "acp-conversation-cleanup-"));
  const log = join(directory, "agent-events");
  const store = new AcpEventStore({
    runDir: directory,
    identity: {
      projectId: "cleanup-project",
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: "RUN-001"
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" }
  });
  await store.open();
  await store.append(
    {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "succeeded",
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        diagnostic: null,
        artifactValidated: true
      }
    },
    { sessionId: "session-1" }
  );
  const writer = store.completedConversationWriter("session-1");
  let connection: AcpConnection | undefined;
  let deadline: AcpCleanupDeadline | undefined;
  let remainingAtExit: number | undefined;
  let disposeAt: number | undefined;
  let cancelCount = 0;
  let disposeCount = 0;
  let forced = false;
  let safety = false;
  const order: string[] = [];
  const connect = (options: CreateAcpConnectionOptions) => {
    connection = createAcpConnection({
      ...options,
      decorateProcessTree: (tree) => ({
        ...tree,
        terminate: async (reason, termination) => {
          order.push("terminate");
          if (!safety)
            expect(termination?.deadline).toMatchObject({
              expiresAt: deadline?.expiresAt,
              remainingMs: deadline?.remainingMs
            });
          const result = await tree.terminate(reason, termination);
          forced = result.outcome === "forced";
          remainingAtExit = termination?.deadline?.remainingMs();
          return result;
        }
      })
    });
    return new Proxy(connection, {
      get(target, key) {
        if (key === "cancel")
          return async (...args: Parameters<AcpConnection["cancel"]>) => {
            cancelCount += 1;
            order.push("cancel");
            deadline = args[1]?.cleanupDeadline;
            return target.cancel(...args);
          };
        if (key === "dispose")
          return (options?: Parameters<AcpConnection["dispose"]>[0]) => {
            disposeCount += 1;
            disposeAt = performance.now();
            order.push("dispose");
            deadline ??= options?.cleanupDeadline;
            expect(options?.cleanupDeadline).toMatchObject({
              expiresAt: deadline?.expiresAt,
              remainingMs: deadline?.remainingMs
            });
            return target.dispose(options).then(() => {
              if (optionsForHarness.disposalError) throw optionsForHarness.disposalError;
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };
  const provider = options.shared ? createSharedAcpConnectionProvider({ connect }) : undefined;
  const coordinator = provider
    ? new AcpConversationTurnCoordinator(undefined, { provider })
    : new AcpConversationTurnCoordinator(connect);
  const input: AcpConversationTurnInput = {
    key: directory,
    identity: {
      version: "planweave.agent-prompt-turn/v1",
      ref: { projectRoot: directory, canvasId: "default" },
      recordId: "T-001#B-001::RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1",
      turnId: randomUUID()
    },
    cwd: directory,
    profile: {
      profileId: "conversation-cleanup",
      agentId: "codex",
      displayName: "Cleanup",
      host: { kind: "native" },
      launch: { command: process.execPath, args: [fixture, log, "load-force-tree"] },
      environment: [],
      shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
      capabilities: { required: [], optional: [] },
      connection: { mode: options.shared ? "shared-project" : "dedicated" },
      source: "builtin",
      fingerprint: "a".repeat(64)
    },
    environment: { env: {}, availableNames: [] },
    text: "continue",
    timeoutMs: 10000,
    eventStore: writer
  };
  return {
    directory,
    log,
    store,
    writer,
    coordinator,
    input,
    provider,
    evidence: () => ({
      deadline,
      disposeAt,
      remainingAtExit,
      cancelCount,
      disposeCount,
      forced,
      order
    }),
    pids: async () => [
      connection?.processId,
      Number((await readFile(log, "utf8")).match(/child:(\d+)/)?.[1])
    ],
    cleanup: async () => {
      safety = true;
      await connection
        ?.dispose()
        .catch((error: unknown) => console.info("safety disposal result", String(error)));
      if (connection?.processId) {
        await vi.waitFor(() => expect(alive(connection?.processId)).toBe(false));
        const child = Number((await readFile(log, "utf8")).match(/child:(\d+)/)?.[1]);
        if (Number.isSafeInteger(child)) await vi.waitFor(() => expect(alive(child)).toBe(false));
      }
      await rm(directory, { recursive: true, force: true });
    }
  };
}

type Boundary = "control" | "append" | "drain" | "cleaning" | "terminal";
const cases: Array<[Boundary, "healthy" | "slow" | "stalled" | "reject"]> = [
  ["control", "healthy"],
  ...(["append", "drain", "cleaning", "terminal"] as const).flatMap((boundary) =>
    (["slow", "stalled", "reject"] as const).map(
      (mode) => [boundary, mode] as [Boundary, typeof mode]
    )
  )
];

describe("completed conversation physical cleanup", () => {
  it.each(
    cases
  )("reclaims root and descendants before safety cleanup: %s %s", async (boundary, mode) => {
    const h = await harness();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error(`${boundary} rejected`);
    let entered = false;
    const fault = async () => {
      entered = true;
      if (mode === "slow") await pause(350);
      if (mode === "stalled") await gate;
      if (mode === "reject") throw failure;
    };
    h.input.eventStore = {
      ...h.writer,
      append: async (body, correlation) => {
        if (boundary === "append" && body.kind === "diagnostic") await fault();
        await h.writer.append(body, correlation);
      },
      drain: async () => {
        if (boundary === "drain") await fault();
        await h.writer.drain();
      }
    };
    const { version, turnId, ...identity } = h.input.identity;
    const metadata: CompletedAcpMetadata = {
      projectId: "cleanup-project",
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1",
      agentId: "codex",
      runnerKind: "acp",
      executor: "codex-acp",
      status: "completed",
      outcome: "succeeded",
      acpProfile: {
        profileId: h.input.profile.profileId,
        fingerprint: h.input.profile.fingerprint,
        source: "builtin",
        host: h.input.profile.host,
        environmentNames: [],
        missingEnvironmentNames: []
      },
      acpCapabilitySnapshot: gateAcpCapabilities(
        h.input.profile.capabilities,
        { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        { sessionStart: "new", connectionMode: "dedicated" }
      )
    };
    const consumer = await consumeAcpPromptRunRecord(
      {
        context: {
          available: true,
          mode: "completed",
          runDir: h.directory,
          identity,
          metadata
        },
        runDir: h.directory,
        metadata,
        cursor: undefined,
        subscriber: async () => {
          const result = h.coordinator.query(h.input.key, h.input.identity);
          if (
            result.found &&
            ((boundary === "cleaning" && result.state.phase === "cleaning") ||
              (boundary === "terminal" && result.state.phase === "terminal"))
          )
            await fault();
        }
      },
      {
        consume: consumeRunnerRecordReadModel,
        subscribeTurn: (key, subscriber) => h.coordinator.subscribe(key, subscriber)
      }
    );
    const sending = h.coordinator.send(h.input).then(
      (state) => ({ state, error: undefined }),
      (error: unknown) => ({ state: undefined, error })
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(async () => {
        const events = await readFile(h.log, "utf8");
        expect(events).toContain("prompt");
        expect(events).toMatch(/child:\d+/);
      });
      const started = performance.now();
      const cancellation = h.coordinator.cancel(h.input.key, h.input.identity);
      await expect(cancellation).resolves.toMatchObject({ outcome: "cancel_requested" });
      await pause(310);
      const pids = await h.pids();
      console.info(
        JSON.stringify({
          boundary,
          mode,
          beforeFinally: true,
          elapsedMs: performance.now() - started,
          pids: pids.map((pid) => ({ pid, alive: alive(pid) })),
          ...h.evidence()
        })
      );
      for (const pid of pids) {
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(() => process.kill(pid!, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" })
        );
      }
      const outcome = await Promise.race([
        sending,
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(
            () => reject(new Error("turn did not settle within original cleanup boundary")),
            450
          );
        })
      ]);
      if (boundary === "control" || boundary === "cleaning" || boundary === "terminal") {
        expect(outcome.state).toMatchObject({ terminal: "cancelled" });
        expect(outcome.error).toBeUndefined();
        if (boundary !== "control") {
          expect(entered).toBe(true);
          await expect(consumer.subscription?.closed).resolves.toMatchObject({
            reason: "subscriber_callback_failed",
            recoverable: true,
            message: expect.stringContaining(
              mode === "reject" ? failure.message : "cleanup deadline"
            )
          });
          expect(h.coordinator.subscriberCount(h.input.key)).toBe(0);
        }
      } else {
        expect(entered).toBe(true);
        expect(outcome.error).toBeInstanceOf(Error);
        expect(h.coordinator.query(h.input.key, h.input.identity)).toMatchObject({
          found: true,
          state: { terminal: "failed", cancellationRequested: true }
        });
        if (mode === "reject") expect(errorTree(outcome.error)).toContain(failure);
      }
      const evidence = h.evidence();
      expect(evidence.deadline?.expiresAt).toBeGreaterThanOrEqual(started + 300);
      expect(evidence.deadline?.expiresAt).toBeLessThan(started + 320);
      expect(evidence.disposeAt! - started).toBeLessThan(100);
      expect(evidence.remainingAtExit).toBeGreaterThan(0);
      expect(evidence.cancelCount).toBe(1);
      expect(evidence.disposeCount).toBe(1);
      expect(evidence.forced).toBe(true);
      expect(evidence.order).toEqual(["cancel", "dispose", "terminate"]);
      const events = (await readFile(h.log, "utf8")).trim().split("\n");
      expect(events.filter((event) => event === "cancel")).toHaveLength(1);
      expect(events.indexOf("load")).toBeLessThan(events.indexOf("prompt"));
      expect(events.indexOf("cancel")).toBeLessThan(events.indexOf("eof"));
      expect(events.indexOf("eof")).toBeLessThan(events.indexOf("term"));
      expect(events).toContain("child-term");
      expect(
        h.store.snapshot().events.filter((event) => event.body.kind === "terminal")
      ).toHaveLength(1);
      console.info(JSON.stringify({ boundary, mode, beforeFinally: true, pids, ...evidence }));
    } finally {
      clearTimeout(guard);
      consumer.subscription?.unsubscribe();
      release();
      await sending;
      await consumer.subscription?.closed;
      await h.cleanup();
    }
  });
  it("coalesces a stalled initial subscriber while the real turn progresses through load, prompt and cleanup", async () => {
    const h = await harness();
    let calls = 0;
    let stopped: AbortSignal | undefined;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unsubscribe = h.coordinator.subscribe(h.input.key, async ({ signal }) => {
      calls += 1;
      stopped = signal;
      await gate;
    });
    const sending = h.coordinator.send(h.input);
    try {
      await vi.waitFor(async () => {
        const events = await readFile(h.log, "utf8");
        expect(events).toContain("prompt");
        expect(events).toMatch(/child:\d+/);
      });
      await h.coordinator.cancel(h.input.key, h.input.identity);
      await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });
      expect(calls).toBe(1);
      expect(stopped?.reason).toMatchObject({
        reason: "subscriber_callback_failed",
        message: expect.stringContaining("cleanup deadline")
      });
      expect(h.coordinator.subscriberCount(h.input.key)).toBe(0);
      for (const pid of await h.pids()) expect(alive(pid)).toBe(false);
      release();
      await pause(10);
      expect(calls).toBe(1);
    } finally {
      unsubscribe();
      release();
      await sending;
      await h.cleanup();
    }
  });

  it("keeps an uncompleted durable write busy until it settles before accepting another turn", async () => {
    const h = await harness();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let persisted = false;
    h.input.eventStore = {
      ...h.writer,
      append: async (body, correlation) => {
        if (body.kind === "diagnostic") {
          entered = true;
          await gate;
        }
        await h.writer.append(body, correlation);
        if (body.kind === "diagnostic") persisted = true;
      }
    };
    const first = h.coordinator.send(h.input).catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => {
        const events = await readFile(h.log, "utf8");
        expect(events).toContain("prompt");
        expect(events).toMatch(/child:\d+/);
      });
      await h.coordinator.cancel(h.input.key, h.input.identity);
      expect(await first).toBeInstanceOf(Error);
      expect(entered).toBe(true);
      const next = {
        ...h.input,
        identity: { ...h.input.identity, turnId: randomUUID() },
        eventStore: h.writer
      };
      await expect(h.coordinator.send(next)).rejects.toThrow("already in progress");
      for (const pid of await h.pids()) expect(alive(pid)).toBe(false);
      release();
      await vi.waitFor(() => expect(persisted).toBe(true));
      await h.writer.drain();
      const oldEvents = h.store.snapshot().events.length;
      const second = h.coordinator.send(next);
      await vi.waitFor(async () =>
        expect((await readFile(h.log, "utf8")).match(/prompt/g)).toHaveLength(2)
      );
      await h.coordinator.cancel(next.key, next.identity);
      await expect(second).resolves.toMatchObject({
        terminal: "cancelled",
        identity: next.identity
      });
      expect(
        h.store
          .snapshot()
          .events.slice(oldEvents)
          .filter((event) => event.body.kind === "message")
      ).toHaveLength(1);
      expect(h.coordinator.query(next.key, h.input.identity)).toEqual({
        found: false,
        reason: "not_found"
      });
    } finally {
      release();
      await first;
      await h.cleanup();
    }
  });

  it("preserves primary, disk and disposal causes independently of rejected and stalled subscriptions", async () => {
    const primary = new Error("primary user-message persistence failure");
    const disk = new Error("diagnostic disk failure");
    const disposal = new Error("physical disposal could not be confirmed");
    const subscriber = new Error("cleaning subscriber rejected");
    const h = await harness({ disposalError: disposal });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.input.eventStore = {
      ...h.writer,
      append: async (body) => {
        if (body.kind === "message") {
          await vi.waitFor(async () => expect(await readFile(h.log, "utf8")).toMatch(/child:\d+/));
          throw primary;
        }
        throw disk;
      }
    };
    let subscriberSignal: AbortSignal | undefined;
    const unsubscribe = h.coordinator.subscribe(h.input.key, async ({ signal }) => {
      const current = h.coordinator.query(h.input.key, h.input.identity);
      if (current.found && current.state.phase === "cleaning") {
        subscriberSignal = signal;
        throw subscriber;
      }
    });
    const unsubscribeStalled = h.coordinator.subscribe(h.input.key, async () => {
      const current = h.coordinator.query(h.input.key, h.input.identity);
      if (current.found && current.state.phase === "cleaning") await gate;
    });
    try {
      const error = await h.coordinator.send(h.input).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AggregateError);
      for (const cause of [primary, disk, disposal]) expect(errorTree(error)).toContain(cause);
      expect(errorTree(error)).not.toContain(subscriber);
      expect(subscriberSignal?.reason).toMatchObject({
        reason: "subscriber_callback_failed",
        message: expect.stringContaining(subscriber.message)
      });
      expect(error).toMatchObject({ message: expect.stringContaining(primary.message) });
      expect(h.coordinator.query(h.input.key, h.input.identity)).toMatchObject({
        found: true,
        state: { terminal: "failed", cancellationRequested: false }
      });
      for (const pid of await h.pids()) expect(alive(pid)).toBe(false);
      await expect(
        h.coordinator.send({
          ...h.input,
          eventStore: h.writer,
          identity: { ...h.input.identity, turnId: randomUUID() }
        })
      ).rejects.toThrow("already in progress");
    } finally {
      unsubscribe();
      unsubscribeStalled();
      release();
      await h.cleanup();
    }
  });

  it("releases only the cancelled continuation lease while another real shared session remains promptable", async () => {
    const h = await harness({ shared: true });
    if (!h.provider) throw new Error("missing shared provider");
    const survivor = await h.provider.acquire({
      launch: { trusted: true, ...h.input.profile.launch },
      cwd: h.directory,
      env: h.input.environment.env,
      clientInfo: { name: "planweave", version: "1" },
      shutdown: h.input.profile.shutdown,
      defaultTimeoutMs: h.input.timeoutMs,
      poolIdentity: {
        projectRoot: h.directory,
        profileFingerprint: h.input.profile.fingerprint,
        host: h.input.profile.host
      }
    });
    await survivor.initialize();
    const session = await survivor.openSession({ kind: "new" }, { ownerId: "surviving-session" });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unsubscribe = h.coordinator.subscribe(h.input.key, async () => {
      const current = h.coordinator.query(h.input.key, h.input.identity);
      if (current.found && current.state.phase === "cleaning") await gate;
    });
    const sending = h.coordinator.send(h.input).catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => expect(await readFile(h.log, "utf8")).toContain("prompt"));
      await h.coordinator.cancel(h.input.key, h.input.identity);
      expect(await sending).toMatchObject({ terminal: "cancelled" });
      expect(h.evidence().cancelCount).toBe(1);
      expect(h.evidence().disposeCount).toBe(0);
      for (const pid of await h.pids()) expect(alive(pid)).toBe(true);
      await expect(session.prompt([{ type: "text", text: "survivor" }])).resolves.toMatchObject({
        stopReason: "end_turn"
      });
      expect(h.evidence().disposeCount).toBe(0);
    } finally {
      unsubscribe();
      release();
      await sending;
      await survivor.release({
        terminal: "cancelled",
        cleanupDeadline: createAcpCleanupDeadline(300)
      });
      await h.provider.shutdown();
      await h.cleanup();
    }
  });

  it("starts disposal and necessary tree signals even when the original deadline is already exhausted", async () => {
    const h = await harness();
    const now = performance.now.bind(performance);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const unsubscribe = h.coordinator.subscribe(h.input.key, () => {
      const current = h.coordinator.query(h.input.key, h.input.identity);
      if (!clock && current.found && current.state.cancellationRequested) {
        clock = vi.spyOn(performance, "now").mockImplementation(() => now() + 400);
      }
    });
    const sending = h.coordinator.send(h.input).catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => {
        const events = await readFile(h.log, "utf8");
        expect(events).toContain("prompt");
        expect(events).toMatch(/child:\d+/);
      });
      await h.coordinator.cancel(h.input.key, h.input.identity).catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
      });
      expect(await sending).toBeInstanceOf(Error);
      clock?.mockRestore();
      expect(h.evidence().disposeCount).toBe(1);
      expect(h.evidence().order).toEqual(["cancel", "dispose", "terminate"]);
      await vi.waitFor(async () => {
        for (const pid of await h.pids()) expect(alive(pid)).toBe(false);
      });
      expect(h.coordinator.query(h.input.key, h.input.identity)).toMatchObject({
        found: true,
        state: { terminal: "failed" }
      });
      await expect(
        h.coordinator.send({ ...h.input, identity: { ...h.input.identity, turnId: randomUUID() } })
      ).rejects.toThrow("already in progress");
    } finally {
      unsubscribe();
      clock?.mockRestore();
      await sending;
      await h.cleanup();
    }
  });
});

function errorTree(error: unknown): unknown[] {
  if (!(error instanceof Error)) return [error];
  return [
    error,
    ...(error instanceof AggregateError ? error.errors.flatMap(errorTree) : []),
    ...(error.cause === undefined ? [] : errorTree(error.cause))
  ];
}

function alive(pid: number | null | undefined): boolean {
  if (!pid) throw new Error("missing owned pid");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
