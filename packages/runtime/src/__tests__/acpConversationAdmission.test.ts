import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAcpConnection, type AcpConnection } from "../autoRun/acpConnection.js";
import {
  AcpConversationTurnCoordinator,
  acpConversationTurns,
  type AcpConversationTurnInput
} from "../autoRun/acpConversationTurn.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import {
  consumeRunnerRecordReadModel,
  type RunnerRecordReadModel
} from "../autoRun/runnerRecordReadModel.js";
import { consumeAcpPromptRunRecord, type CompletedAcpMetadata } from "../desktop/acpPromptApi.js";
import { gateAcpCapabilities } from "../autoRun/acpCapabilityGate.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function gate() {
  let resolve = (): void => undefined;
  let reject = (_error: Error): void => undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function harness(options: { disposal?: "failure" | "timeout" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-admission-"));
  const artifact = join(directory, "report.md");
  await writeFile(artifact, "original validated report");
  const store = new AcpEventStore({
    runDir: directory,
    identity: {
      projectId: "admission-project",
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
  const connections: AcpConnection[] = [];
  const disposal = gate();
  let disposed = 0;
  let prompts = 0;
  const coordinator = new AcpConversationTurnCoordinator((settings) => {
    const connection = createAcpConnection(settings);
    connections.push(connection);
    return new Proxy(connection, {
      get(target, key) {
        if (key === "prompt")
          return (...args: Parameters<AcpConnection["prompt"]>) => {
            prompts += 1;
            return target.prompt(...args);
          };
        if (key === "dispose")
          return async (settings?: Parameters<AcpConnection["dispose"]>[0]) => {
            await target.dispose(settings);
            disposed += 1;
            if (options.disposal === "failure") throw new Error("controlled disposal failure");
            if (options.disposal === "timeout") await disposal.promise;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  });
  const identity = {
    ref: { projectRoot: directory, canvasId: "default" },
    recordId: "T-001#B-001::RUN-001",
    executorRunId: "RUN-001",
    claimRef: "T-001#B-001",
    sessionId: "session-1"
  };
  const input: AcpConversationTurnInput = {
    key: directory,
    identity: { version: "planweave.agent-prompt-turn/v1", ...identity, turnId: randomUUID() },
    cwd: directory,
    profile: {
      profileId: "admission",
      agentId: "codex",
      displayName: "Admission",
      host: { kind: "native" },
      launch: {
        command: process.execPath,
        args: [fixture, "load-capable"]
      },
      environment: [],
      shutdown: { eofDrainMs: 20, terminateGraceMs: 20, cleanupDeadlineMs: 300 },
      capabilities: { required: [], optional: [] },
      connection: { mode: "dedicated" },
      source: "builtin",
      fingerprint: "a".repeat(64)
    },
    environment: { env: {}, availableNames: [] },
    text: "continue",
    timeoutMs: 5000,
    eventStore: writer
  };
  const metadata: CompletedAcpMetadata = {
    runId: "RUN-001",
    executorRunId: "RUN-001",
    claimRef: "T-001#B-001",
    sessionId: "session-1",
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
  const consume: typeof consumeRunnerRecordReadModel = (settings) =>
    consumeRunnerRecordReadModel({
      ...settings,
      promptIdentity: identity,
      promptContinuationAvailable: true,
      promptAdmission: () => coordinator.admission(directory)
    });
  const snapshots: RunnerRecordReadModel[] = [];
  const consumer = await consumeAcpPromptRunRecord(
    {
      context: { available: true, mode: "completed", runDir: directory, metadata, identity },
      runDir: directory,
      metadata,
      cursor: undefined,
      subscriber: (snapshot) => {
        snapshots.push(snapshot);
      }
    },
    { consume, subscribeTurn: (key, subscriber) => coordinator.subscribe(key, subscriber) }
  );
  return {
    directory,
    artifact,
    store,
    writer,
    input,
    coordinator,
    snapshots,
    disposal,
    counts: () => ({ disposed, prompts, connections: connections.length }),
    subscription: consumer.subscription,
    read: async () => (await consume({ runDir: directory, metadata })).snapshot!,
    close: async () => {
      consumer.subscription?.unsubscribe();
      disposal.resolve();
      await Promise.all(connections.map((connection) => connection.dispose()));
      await rm(directory, { recursive: true, force: true });
    }
  };
}

describe("completed conversation admission", () => {
  it.each([
    "failure",
    "timeout"
  ] as const)("keeps terminal failures unavailable after real resource disposal: %s", async (disposal) => {
    const h = await harness({ disposal });
    const canonical = h.store.canonicalIdentity();
    try {
      await expect(h.coordinator.send(h.input)).rejects.toThrow();
      expect(h.counts()).toEqual({ disposed: 1, prompts: 1, connections: 1 });
      expect(h.coordinator.query(h.directory, h.input.identity)).toMatchObject({
        found: true,
        state: { terminal: "failed", cancellable: false }
      });
      expect((await h.read()).intervention).toMatchObject({
        prompt: {
          available: false,
          inFlight: false,
          reason: expect.stringMatching(/cleanup|release/i)
        },
        cancel: { available: false }
      });
      await expect(
        h.coordinator.send({
          ...h.input,
          identity: { ...h.input.identity, turnId: randomUUID() }
        })
      ).rejects.toThrow("already in progress");
      expect(h.counts()).toEqual({ disposed: 1, prompts: 1, connections: 1 });
      expect(h.store.canonicalIdentity()).toEqual(canonical);
      expect(await readFile(h.artifact, "utf8")).toBe("original validated report");
      const terminal = (await h.read()).events.filter((event) => event.body.kind === "terminal");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.body).toMatchObject({
        outcome: { state: "succeeded", artifactValidated: true }
      });
      h.disposal.resolve();
      await vi.waitFor(() => expect(h.coordinator.admission(h.directory).available).toBe(false));
    } finally {
      await h.close();
    }
  });

  it("refreshes subscribers after finalizing and keeps consecutive turns promptable", async () => {
    const h = await harness();
    const finalizing = gate();
    const release = gate();
    const unsubscribe = h.coordinator.subscribe(h.directory, () => {
      if (h.coordinator.admission(h.directory).reason?.includes("finaliz")) {
        finalizing.resolve();
        return release.promise;
      }
    });
    const sending = h.coordinator.send(h.input);
    try {
      await finalizing.promise;
      expect((await h.read()).intervention.prompt).toMatchObject({
        available: false,
        inFlight: false,
        reason: expect.stringMatching(/finaliz/)
      });
      await expect(
        h.coordinator.send({
          ...h.input,
          identity: { ...h.input.identity, turnId: randomUUID() }
        })
      ).rejects.toThrow("already in progress");
      expect(h.counts().connections).toBe(1);
      release.resolve();
      await expect(sending).resolves.toMatchObject({ terminal: "succeeded" });
      await vi.waitFor(() =>
        expect(h.snapshots.at(-1)?.intervention.prompt).toMatchObject({
          available: true,
          inFlight: false,
          reason: null
        })
      );
      expect(
        h.snapshots.some((snapshot) => snapshot.intervention.prompt.reason?.includes("finaliz"))
      ).toBe(true);
      await expect(
        h.coordinator.send({ ...h.input, identity: { ...h.input.identity, turnId: randomUUID() } })
      ).resolves.toMatchObject({ terminal: "succeeded" });
      expect(h.counts().prompts).toBe(2);
    } finally {
      release.resolve();
      await sending;
      unsubscribe();
      await h.close();
    }
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("refreshes the actual record subscriber when a late persistence operation settles: %s", async (settlement) => {
    const h = await harness();
    const pending = gate();
    const entered = gate();
    const sendingInput = {
      ...h.input,
      eventStore: {
        ...h.writer,
        append: async (...args: Parameters<typeof h.writer.append>) => {
          await h.writer.append(...args);
          if (args[0].kind === "message" && args[0].role === "user") {
            entered.resolve();
            await pending.promise;
          }
        }
      }
    };
    const sending = h.coordinator.send(sendingInput).catch((error: unknown) => error);
    try {
      await entered.promise;
      await expect(h.coordinator.cancel(h.directory, h.input.identity)).resolves.toMatchObject({
        outcome: "cancel_requested"
      });
      expect(await sending).toBeInstanceOf(Error);
      expect((await h.read()).intervention.prompt).toMatchObject({
        available: false,
        inFlight: false,
        reason: expect.stringMatching(/persistence/i)
      });
      await expect(
        h.coordinator.send({
          ...h.input,
          identity: { ...h.input.identity, turnId: randomUUID() }
        })
      ).rejects.toThrow("already in progress");
      expect(h.counts().connections).toBe(1);
      h.snapshots.length = 0;
      if (settlement === "resolve") pending.resolve();
      else pending.reject(new Error("controlled late persistence rejection"));
      await vi.waitFor(() =>
        expect(h.snapshots.at(-1)?.intervention.prompt).toMatchObject({
          available: true,
          inFlight: false,
          reason: null,
          identity: {
            recordId: h.input.identity.recordId,
            ref: h.input.identity.ref
          }
        })
      );
      expect(h.coordinator.query(h.directory, h.input.identity)).toMatchObject({
        found: true,
        state: { terminal: "failed", cancellable: false }
      });
      await expect(
        h.coordinator.send({
          ...h.input,
          identity: { ...h.input.identity, turnId: randomUUID() }
        })
      ).resolves.toMatchObject({ terminal: "succeeded" });
      expect(h.counts().connections).toBe(2);
    } finally {
      pending.resolve();
      await sending;
      await h.close();
    }
  });

  it("keeps the record subscription alive when a previous settled callback rejects during a new turn", async () => {
    const h = await harness();
    const oldCallback = gate();
    const deliveredTurns: string[] = [];
    let held = false;
    const unsubscribe = h.coordinator.subscribe(h.directory, ({ identity }) => {
      deliveredTurns.push(identity.turnId);
      if (!held && h.coordinator.admission(h.directory).available) {
        held = true;
        return oldCallback.promise;
      }
    });
    try {
      await h.coordinator.send(h.input);
      expect(held).toBe(true);
      const next = { ...h.input, identity: { ...h.input.identity, turnId: randomUUID() } };
      const sending = h.coordinator.send(next);
      oldCallback.reject(new Error("late old callback failure"));
      await expect(sending).resolves.toMatchObject({ terminal: "succeeded" });
      await vi.waitFor(() => expect(h.snapshots.at(-1)?.intervention.prompt.available).toBe(true));
      expect(deliveredTurns).toContain(next.identity.turnId);
      expect(h.coordinator.subscriberCount(h.directory)).toBe(2);
      expect(await h.read()).toMatchObject({
        terminal: true,
        intervention: { cancel: { available: false } }
      });
    } finally {
      oldCallback.resolve();
      unsubscribe();
      await h.close();
    }
  });

  it("uses the same owner for a reader without an admission override and supports continuation after user cancellation", async () => {
    const h = await harness();
    const entered = gate();
    const release = gate();
    const { version, turnId, ...identity } = h.input.identity;
    const read = () =>
      consumeRunnerRecordReadModel({
        runDir: h.directory,
        metadata: {
          runnerKind: "acp",
          runId: "RUN-001",
          claimRef: "T-001#B-001",
          sessionId: "session-1"
        },
        promptIdentity: identity,
        promptContinuationAvailable: true
      });
    const sending = acpConversationTurns.send({
      ...h.input,
      eventStore: {
        ...h.writer,
        append: async (...args: Parameters<typeof h.writer.append>) => {
          await h.writer.append(...args);
          if (args[0].kind === "message" && args[0].role === "user") {
            entered.resolve();
            await release.promise;
          }
        }
      }
    });
    try {
      await entered.promise;
      expect((await read()).snapshot?.intervention.prompt).toMatchObject({
        available: false,
        inFlight: true
      });
      await expect(
        acpConversationTurns.cancel(h.directory, h.input.identity)
      ).resolves.toMatchObject({ outcome: "cancel_requested" });
      release.resolve();
      await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });
      expect((await read()).snapshot?.intervention.prompt).toMatchObject({
        available: true,
        inFlight: false
      });
      await expect(
        acpConversationTurns.send({
          ...h.input,
          identity: { ...h.input.identity, turnId: randomUUID() }
        })
      ).resolves.toMatchObject({ terminal: "succeeded" });
    } finally {
      release.resolve();
      await sending;
      await h.close();
    }
  });
});
