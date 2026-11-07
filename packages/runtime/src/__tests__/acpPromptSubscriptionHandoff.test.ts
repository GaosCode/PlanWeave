import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  acpConversationTurns,
  type AcpConversationTurnInput,
  type TurnStateSubscriber
} from "../autoRun/acpConversationTurn.js";
import { acpEventReadModels } from "../autoRun/acpEventReadModel.js";
import { gateAcpCapabilities } from "../autoRun/acpCapabilityGate.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import {
  consumeRunnerRecordReadModel,
  desktopAgentPromptIdentitySchema,
  type RunnerRecordReadConsumer,
  type RunnerRecordReadModel
} from "../autoRun/runnerRecordReadModel.js";
import { acpCorrelationSchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { consumeAcpPromptRunRecord, type CompletedAcpMetadata } from "../desktop/acpPromptApi.js";

function gate() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function harness() {
  const runDir = await mkdtemp(join(tmpdir(), "acp-handoff-"));
  const correlation = acpCorrelationSchema.parse({ sessionId: "session-1" });
  const model = await acpEventReadModels.create({
    runDir,
    identity: runnerRunIdentitySchema.parse({
      projectId: "handoff",
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: "RUN-001"
    }),
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" }
  });
  await model.store.append(
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
    correlation
  );
  const identity = desktopAgentPromptIdentitySchema.parse({
    ref: { projectRoot: runDir, canvasId: "default" },
    recordId: "T-001#B-001::RUN-001",
    executorRunId: "RUN-001",
    claimRef: "T-001#B-001",
    sessionId: correlation.sessionId
  });
  const input: AcpConversationTurnInput = {
    key: runDir,
    identity: { version: "planweave.agent-prompt-turn/v1", ...identity, turnId: randomUUID() },
    cwd: runDir,
    profile: {
      profileId: "handoff",
      agentId: "codex",
      displayName: "Handoff",
      host: { kind: "native" },
      launch: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url)),
          "load-capable"
        ]
      },
      environment: [],
      shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 1000 },
      capabilities: { required: [], optional: [] },
      connection: { mode: "dedicated" },
      source: "builtin",
      fingerprint: "a".repeat(64)
    },
    environment: { env: {}, availableNames: [] },
    text: "first turn",
    timeoutMs: 5000,
    eventStore: model.store.completedConversationWriter(correlation.sessionId)
  };
  const metadata: CompletedAcpMetadata = {
    runId: "RUN-001",
    executorRunId: identity.executorRunId,
    claimRef: identity.claimRef,
    sessionId: identity.sessionId,
    runnerKind: "acp",
    agentId: "codex",
    executor: "codex-acp",
    status: "completed",
    outcome: "succeeded",
    acpProfile: {
      profileId: input.profile.profileId,
      fingerprint: input.profile.fingerprint,
      source: "builtin",
      host: input.profile.host,
      environmentNames: [],
      missingEnvironmentNames: []
    },
    acpCapabilitySnapshot: gateAcpCapabilities(
      input.profile.capabilities,
      { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      { sessionStart: "new", connectionMode: "dedicated" }
    )
  };
  const subscribe = (
    subscriber: (snapshot: RunnerRecordReadModel) => void = () => undefined,
    dependencies?: Parameters<typeof consumeAcpPromptRunRecord>[1]
  ) =>
    consumeAcpPromptRunRecord(
      {
        context: { available: true, mode: "completed", runDir, metadata, identity },
        runDir,
        metadata,
        cursor: undefined,
        subscriber
      },
      dependencies
    );
  return { runDir, model, input, subscribe };
}

describe("ACP prompt subscription handoff", () => {
  it.each([
    "subscribe",
    "consume",
    "reread"
  ] as const)("releases ownership when registration fails at %s", async (failure) => {
    const h = await harness();
    let calls = 0;
    const underlying: RunnerRecordReadConsumer[] = [];
    try {
      await expect(
        h.subscribe(undefined, {
          subscribeTurn: (key, subscriber) => {
            if (failure === "subscribe") throw new Error("subscribe rejected");
            const unsubscribe = acpConversationTurns.subscribe(key, subscriber);
            if (failure === "reread") {
              void subscriber({ identity: h.input.identity, signal: new AbortController().signal });
            }
            return unsubscribe;
          },
          consume: async (settings) => {
            if (failure === "consume" || ++calls > 1) throw new Error(`${failure} rejected`);
            const consumer = await consumeRunnerRecordReadModel(settings);
            underlying.push(consumer);
            return consumer;
          }
        })
      ).rejects.toThrow(`${failure} rejected`);
      expect(acpConversationTurns.subscriberCount(h.runDir)).toBe(0);
      expect(h.model.store.publisher.subscriberCount).toBe(0);
      if (underlying[0]?.subscription) {
        expect(await underlying[0].subscription.closed).toMatchObject({
          reason: "explicit_unsubscribe"
        });
      }
    } finally {
      acpEventReadModels.release(h.runDir);
      await rm(h.runDir, { recursive: true, force: true });
    }
  });

  it("ignores queued turn notifications after unsubscribe and accepts immediate registration invalidation", async () => {
    const h = await harness();
    let callback: TurnStateSubscriber | undefined;
    const subscriber = vi.fn();
    let consumer: RunnerRecordReadConsumer | undefined;
    try {
      consumer = await h.subscribe(subscriber, {
        consume: consumeRunnerRecordReadModel,
        subscribeTurn: (key, listener) => {
          callback = listener;
          void listener({ identity: h.input.identity, signal: new AbortController().signal });
          return acpConversationTurns.subscribe(key, listener);
        }
      });
      expect(consumer.snapshot?.intervention.prompt.available).toBe(true);
      consumer.subscription?.unsubscribe();
      await callback?.({ identity: h.input.identity, signal: new AbortController().signal });
      expect(await consumer.subscription?.closed).toMatchObject({ reason: "explicit_unsubscribe" });
      expect(subscriber).not.toHaveBeenCalled();
      expect(acpConversationTurns.subscriberCount(h.runDir)).toBe(0);
    } finally {
      consumer?.subscription?.unsubscribe();
      acpEventReadModels.release(h.runDir);
      await rm(h.runDir, { recursive: true, force: true });
    }
  });

  it("coalesces newer event pushes while the initial snapshot is blocked", async () => {
    const h = await harness();
    const reading = gate();
    const finishRead = gate();
    const delivered = gate();
    const original = PersistentRunnerInteractionStore.prototype.listSnapshots;
    let reads = 0;
    let consumer: RunnerRecordReadConsumer | undefined;
    const spy = vi
      .spyOn(PersistentRunnerInteractionStore.prototype, "listSnapshots")
      .mockImplementation(async function (this: PersistentRunnerInteractionStore, ...args) {
        const snapshots = await original.apply(this, args);
        if (++reads === 2) {
          reading.resolve();
          await finishRead.promise;
        }
        return snapshots;
      });
    const subscriber = vi.fn();
    try {
      const subscribing = h.subscribe(subscriber, {
        subscribeTurn: (key, listener) => acpConversationTurns.subscribe(key, listener),
        consume: (settings) =>
          consumeRunnerRecordReadModel({
            ...settings,
            ...(settings.subscriber
              ? {
                  subscriber: async (snapshot) => {
                    await settings.subscriber?.(snapshot);
                    delivered.resolve();
                  }
                }
              : {})
          })
      });
      await reading.promise;
      await h.model.store.completedConversationWriter(h.input.identity.sessionId).append(
        {
          kind: "message",
          role: "assistant",
          messageId: "registration-push",
          chunk: false,
          content: "newer registration push",
          redaction: { classes: [], replaced: 0 }
        },
        { sessionId: h.input.identity.sessionId }
      );
      await delivered.promise;
      expect(subscriber).not.toHaveBeenCalled();
      finishRead.resolve();
      consumer = await subscribing;
      expect(consumer.snapshot?.events.at(-1)?.body).toMatchObject({
        content: "newer registration push"
      });
      expect(consumer.snapshot?.cursor.afterSequence).toBe(2);
    } finally {
      finishRead.resolve();
      spy.mockRestore();
      consumer?.subscription?.unsubscribe();
      await consumer?.subscription?.closed;
      acpEventReadModels.release(h.runDir);
      await rm(h.runDir, { recursive: true, force: true });
    }
  });

  it.each([
    "new",
    "resubscribe",
    "healthy"
  ] as const)("returns ready after a real turn settles during registration: %s", async (mode) => {
    const h = await harness();
    const finalizing = gate();
    const finishTurn = gate();
    const reading = gate();
    const finishRead = gate();
    let consumer: RunnerRecordReadConsumer | undefined;
    const stop = acpConversationTurns.subscribe(h.runDir, () => {
      if (acpConversationTurns.admission(h.runDir).reason?.includes("finaliz")) {
        finalizing.resolve();
        return finishTurn.promise;
      }
    });
    if (mode === "resubscribe") {
      const prior = await h.subscribe();
      prior.subscription?.unsubscribe();
      await prior.subscription?.closed;
      expect(acpConversationTurns.subscriberCount(h.runDir)).toBe(1);
    }
    const sending = acpConversationTurns.send(h.input);
    let reads = 0;
    const original = PersistentRunnerInteractionStore.prototype.listSnapshots;
    let readSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await finalizing.promise;
      await expect(
        acpConversationTurns.send({
          ...h.input,
          identity: { ...h.input.identity, turnId: randomUUID() }
        })
      ).rejects.toThrow(/finaliz/i);
      if (mode === "healthy") {
        finishTurn.resolve();
        await sending;
      }
      readSpy = vi
        .spyOn(PersistentRunnerInteractionStore.prototype, "listSnapshots")
        .mockImplementation(async function (this: PersistentRunnerInteractionStore, ...args) {
          const snapshots = await original.apply(this, args);
          if (++reads === 2) {
            reading.resolve();
            await finishRead.promise;
          }
          return snapshots;
        });
      const pushes: RunnerRecordReadModel[] = [];
      const subscribing = h.subscribe((snapshot) => {
        pushes.push(snapshot);
      });
      await reading.promise;
      finishTurn.resolve();
      expect((await sending).terminal).toBe("succeeded");
      expect(acpConversationTurns.admission(h.runDir).available).toBe(true);
      finishRead.resolve();
      consumer = await subscribing;
      expect(consumer.snapshot?.intervention.prompt).toMatchObject({
        available: true,
        inFlight: false
      });
      const next = await acpConversationTurns.send({
        ...h.input,
        text: "next actual prompt",
        identity: { ...h.input.identity, turnId: randomUUID() }
      });
      expect(next.terminal).toBe("succeeded");
      await vi.waitFor(() => expect(pushes.at(-1)?.intervention.prompt.available).toBe(true));
      expect(h.model.store.eventsAfterSequence(0)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: expect.objectContaining({ kind: "message", content: "next actual prompt" })
          })
        ])
      );
    } finally {
      finishTurn.resolve();
      finishRead.resolve();
      readSpy?.mockRestore();
      stop();
      consumer?.subscription?.unsubscribe();
      await consumer?.subscription?.closed;
      await sending;
      expect(acpConversationTurns.subscriberCount(h.runDir)).toBe(0);
      acpEventReadModels.release(h.runDir);
      await rm(h.runDir, { recursive: true, force: true });
    }
  });
});
