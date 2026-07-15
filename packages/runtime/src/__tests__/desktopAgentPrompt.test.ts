import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acpConversationTurns } from "../autoRun/acpConversationTurn.js";
import { acpEventReadModels } from "../autoRun/acpEventReadModel.js";
import { AcpSessionController } from "../autoRun/acpSessionController.js";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import { getRunRecord, sendAgentPrompt, subscribeRunRecord } from "../desktop/recordsApi.js";
import { consumeAcpPromptRunRecord, resolveAcpPromptContext } from "../desktop/acpPromptApi.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import type { AgentFamily, ExecutorProfile } from "../types.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

function eventBody(options: {
  sequence: number;
  terminal?: boolean;
  projectId: string;
  agentId?: AgentFamily;
  sessionId?: string;
  terminalState?: "succeeded" | "failed";
  artifactValidated?: boolean;
}) {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence: options.sequence,
    timestamp: `2026-07-13T00:00:0${options.sequence}.000Z`,
    identity: {
      projectId: options.projectId,
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
    runner: {
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId: options.agentId ?? "codex"
    },
    correlation: { sessionId: options.sessionId ?? "session-1" },
    body: options.terminal
      ? {
          kind: "terminal",
          outcome: {
            version: "planweave.runner/v1",
            state: options.terminalState ?? "succeeded",
            reason: options.terminalState === "failed" ? "failed" : "completed",
            cleanup: { status: "succeeded" },
            exitCode: options.terminalState === "failed" ? 1 : 0,
            finishedAt: "2026-07-13T00:00:02.000Z",
            diagnostic: null,
            artifactValidated: options.artifactValidated ?? true
          }
        }
      : {
          kind: "message",
          role: "assistant",
          messageId: "original-message",
          chunk: false,
          content: "original answer",
          redaction: { classes: [], replaced: 0 }
        }
  });
}

async function completedRecord(
  agentId: Extract<AgentFamily, "codex" | "opencode" | "pi"> = "codex",
  scenario = "load-capable",
  options: {
    executor?: string;
    profile?: ExecutorProfile;
    eventAgentId?: AgentFamily;
    eventProjectId?: string;
    eventSessionId?: string;
    terminalState?: "succeeded" | "failed";
    artifactValidated?: boolean;
  } = {}
) {
  const manifest = basicManifest();
  const executor = options.executor ?? agentId;
  if (options.profile) manifest.executors = { [executor]: options.profile };
  const { root, init } = await createTestWorkspace(manifest);
  const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
  await mkdir(runDir, { recursive: true });
  const metadata = {
    runId: "RUN-001",
    executorRunId: "RUN-001",
    ref: "T-001#B-001",
    claimRef: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    executor,
    agentId,
    runnerKind: "acp",
    status: "completed",
    outcome: "succeeded",
    sessionId: "session-1",
    capabilities: { loadSession: true }
  };
  await writeJsonFile(join(runDir, "metadata.json"), metadata);
  const originalEvents = [
    eventBody({
      sequence: 1,
      projectId: options.eventProjectId ?? init.workspace.id,
      agentId: options.eventAgentId ?? agentId,
      ...(options.eventSessionId ? { sessionId: options.eventSessionId } : {})
    }),
    eventBody({
      sequence: 2,
      terminal: true,
      projectId: options.eventProjectId ?? init.workspace.id,
      agentId: options.eventAgentId ?? agentId,
      ...(options.eventSessionId ? { sessionId: options.eventSessionId } : {}),
      ...(options.terminalState ? { terminalState: options.terminalState } : {}),
      ...(options.artifactValidated === undefined
        ? {}
        : { artifactValidated: options.artifactValidated })
    })
  ];
  await writeFile(
    join(runDir, "events.ndjson"),
    `${originalEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8"
  );
  await writeFile(join(runDir, "report.md"), "immutable report\n", "utf8");
  const binDir = await mkdtemp(join(tmpdir(), "planweave-acp-bin-"));
  const executable = join(
    binDir,
    agentId === "opencode" ? "opencode" : agentId === "pi" ? "pi-acp" : "codex-acp"
  );
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" ${scenario}\n`,
    "utf8"
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  return { root, workspace: init.workspace, runDir, metadata, originalEvents };
}

function identityFor(prepared: Awaited<ReturnType<typeof completedRecord>>) {
  return {
    ref: { projectRoot: prepared.workspace.rootPath, canvasId: "default" },
    recordId: "T-001#B-001::RUN-001",
    executorRunId: "RUN-001",
    claimRef: "T-001#B-001",
    sessionId: "session-1"
  };
}

describe("Desktop ACP prompt continuation", () => {
  it("queues a prompt on the existing live owned ACP session before terminal artifacts exist", async () => {
    const { root, init } = await createTestWorkspace(basicManifest());
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    const controller = new AcpSessionController();
    const execution = controller
      .execute(
        {
          kind: "implementation",
          identity: {
            scope: runDir,
            desktopRunId: "DESKTOP-RUN-0001",
            runSessionId: "SESSION-0001",
            executorRunId: "RUN-001",
            claimRef: "T-001#B-001"
          },
          runDir,
          metadataPath: join(runDir, "metadata.json"),
          prompt: "original live prompt",
          cwd: root,
          launch: { command: process.execPath, args: [fixture, "long-prompt"] },
          executorName: "codex-acp",
          agentId: "codex",
          taskId: "T-001",
          metadataIdentity: { blockId: "B-001" },
          projectId: init.workspace.id,
          canvasId: "default"
        },
        { timeoutMs: 2_000 }
      )
      .then(
        () => null,
        (error: unknown) => error
      );
    let identity: NonNullable<
      NonNullable<
        Awaited<ReturnType<typeof getRunRecord>>["runnerReadModel"]
      >["intervention"]["prompt"]["identity"]
    > | null = null;
    for (let attempt = 0; attempt < 100 && !identity; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const record = await getRunRecord(init.workspace, "T-001#B-001::RUN-001");
      identity = record.runnerReadModel?.intervention.prompt.available
        ? record.runnerReadModel.intervention.prompt.identity
        : null;
    }
    if (!identity) throw new Error("Expected a live ACP prompt identity.");

    await sendAgentPrompt(identity, "follow up while live");
    const executionError = await execution;

    expect(executionError).toBeInstanceOf(Error);
    expect(await readFile(join(runDir, "events.ndjson"), "utf8")).toContain("follow up while live");
    acpEventReadModels.release(runDir);
  });

  it("loads a completed session, appends only the fresh turn, and preserves terminal artifacts", async () => {
    const prepared = await completedRecord();
    const recordId = "T-001#B-001::RUN-001";
    const beforeMetadata = await readFile(join(prepared.runDir, "metadata.json"));
    const beforeReport = await readFile(join(prepared.runDir, "report.md"));
    const record = await getRunRecord(prepared.workspace, recordId);
    const identity = record.runnerReadModel?.intervention.prompt.identity;
    if (!identity) throw new Error("Expected a completed ACP prompt identity.");
    const snapshots: Array<NonNullable<typeof record.runnerReadModel>> = [];
    const consumer = await subscribeRunRecord(prepared.workspace, recordId, undefined, (snapshot) =>
      snapshots.push(snapshot)
    );

    await sendAgentPrompt(identity, "continue from desktop");

    consumer.subscription?.unsubscribe();
    const events = await readFile(join(prepared.runDir, "events.ndjson"), "utf8");
    expect(events).toContain("continue from desktop");
    expect(events).toContain("hello from session-1");
    expect(events).not.toContain("historical replay");
    expect(await readFile(join(prepared.runDir, "metadata.json"))).toEqual(beforeMetadata);
    expect(await readFile(join(prepared.runDir, "report.md"))).toEqual(beforeReport);
    expect(snapshots.some((snapshot) => snapshot.intervention.prompt.inFlight)).toBe(true);
    expect(snapshots.at(-1)?.intervention.prompt.inFlight).toBe(false);
    expect(
      snapshots.at(-1)?.conversation.some((item) => item.content.includes("hello from session-1"))
    ).toBe(true);
  });

  it("rejects stale identity, path traversal, and non-succeeded terminal metadata", async () => {
    const prepared = await completedRecord();
    const recordId = "T-001#B-001::RUN-001";
    const record = await getRunRecord(prepared.workspace, recordId);
    const identity = record.runnerReadModel?.intervention.prompt.identity;
    if (!identity) throw new Error("Expected a completed ACP prompt identity.");

    await expect(
      sendAgentPrompt({ ...identity, sessionId: "other-session" }, "continue")
    ).rejects.toThrow("does not match");
    await expect(
      sendAgentPrompt({ ...identity, recordId: "T-001#B-001::../RUN-001" }, "continue")
    ).rejects.toThrow("invalid");
    const outside = await mkdtemp(join(tmpdir(), "planweave-outside-run-"));
    await writeJsonFile(join(outside, "metadata.json"), prepared.metadata);
    await symlink(outside, join(dirname(prepared.runDir), "RUN-002"), "dir");
    await expect(
      sendAgentPrompt({ ...identity, recordId: "T-001#B-001::RUN-002" }, "continue")
    ).rejects.toThrow("escapes");
    await writeJsonFile(join(prepared.runDir, "metadata.json"), {
      ...prepared.metadata,
      outcome: "failed"
    });
    await expect(sendAgentPrompt(identity, "continue")).rejects.toThrow("not a completed ACP run");
  });

  it("rejects an authoritative ACP terminal outcome that failed", async () => {
    const prepared = await completedRecord("codex", "load-capable", {
      terminalState: "failed"
    });

    await expect(sendAgentPrompt(identityFor(prepared), "continue")).rejects.toThrow(
      "not a successfully completed run"
    );
  });

  it("rejects authoritative ACP events whose session does not match metadata", async () => {
    const prepared = await completedRecord("codex", "load-capable", {
      eventSessionId: "other-session"
    });

    await expect(sendAgentPrompt(identityFor(prepared), "continue")).rejects.toThrow(
      "session does not match"
    );
  });

  it("rejects authoritative ACP events whose agent does not match metadata", async () => {
    const prepared = await completedRecord("codex", "load-capable", {
      eventAgentId: "pi"
    });
    await acpEventReadModels.create({
      runDir: prepared.runDir,
      identity: prepared.originalEvents[0].identity,
      runner: prepared.originalEvents[0].runner
    });
    try {
      await expect(sendAgentPrompt(identityFor(prepared), "continue")).rejects.toThrow(
        "runner does not match"
      );
    } finally {
      acpEventReadModels.release(prepared.runDir);
    }
  });

  it("rejects an existing event model whose canonical run identity does not match", async () => {
    const prepared = await completedRecord("codex", "load-capable", {
      eventProjectId: "other-project"
    });
    await acpEventReadModels.create({
      runDir: prepared.runDir,
      identity: prepared.originalEvents[0].identity,
      runner: prepared.originalEvents[0].runner
    });
    try {
      await expect(sendAgentPrompt(identityFor(prepared), "continue")).rejects.toThrow(
        "identity does not match"
      );
    } finally {
      acpEventReadModels.release(prepared.runDir);
    }
  });

  it("requires the persisted executor profile to remain the same ACP agent", async () => {
    const invalidProfiles: Array<{
      executor: string;
      profile?: ExecutorProfile;
    }> = [
      { executor: "removed-acp" },
      { executor: "manual-run", profile: { adapter: "manual" } },
      {
        executor: "codex-cli",
        profile: {
          adapter: "agent",
          agent: "codex",
          runner: { transport: "cli" },
          command: "codex",
          args: ["exec", "-"]
        }
      },
      {
        executor: "other-acp",
        profile: { adapter: "agent", agent: "pi", runner: { transport: "acp" } }
      }
    ];
    for (const invalid of invalidProfiles) {
      const prepared = await completedRecord("codex", "load-capable", invalid);
      await expect(sendAgentPrompt(identityFor(prepared), "continue")).rejects.toThrow(
        /no longer available|does not match/
      );
    }
  });

  it("supports a package ACP alias and applies its configured timeout", async () => {
    const successful = await completedRecord("codex", "load-capable", {
      executor: "focused-codex",
      profile: {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp" },
        timeoutMs: 1_000
      }
    });
    await sendAgentPrompt(identityFor(successful), "continue alias");
    expect(await readFile(join(successful.runDir, "events.ndjson"), "utf8")).toContain(
      "continue alias"
    );

    const profile = {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" },
      timeoutMs: 10
    } satisfies ExecutorProfile;
    const prepared = await completedRecord("codex", "load-capable-delayed", {
      executor: "focused-codex",
      profile
    });

    await expect(sendAgentPrompt(identityFor(prepared), "continue")).rejects.toThrow(
      /timed out|timeout/i
    );
  });

  it("cleans up the turn listener on explicit run-record unsubscribe", async () => {
    const prepared = await completedRecord();
    const consumer = await subscribeRunRecord(
      prepared.workspace,
      "T-001#B-001::RUN-001",
      undefined,
      () => undefined
    );
    expect(acpConversationTurns.subscriberCount(prepared.runDir)).toBe(1);

    consumer.subscription?.unsubscribe();
    await consumer.subscription?.closed;

    expect(acpConversationTurns.subscriberCount(prepared.runDir)).toBe(0);
  });

  it("cleans up the turn listener when the underlying live subscription closes", async () => {
    const prepared = await completedRecord();
    const model = await acpEventReadModels.create({
      runDir: prepared.runDir,
      identity: prepared.originalEvents[0].identity,
      runner: prepared.originalEvents[0].runner
    });
    try {
      const consumer = await subscribeRunRecord(
        prepared.workspace,
        "T-001#B-001::RUN-001",
        undefined,
        () => {
          throw new Error("close this subscriber");
        }
      );
      expect(acpConversationTurns.subscriberCount(prepared.runDir)).toBe(1);
      const correlation = prepared.originalEvents[0].correlation;
      if (!correlation) throw new Error("Expected fixture correlation.");
      await model.store.append(
        {
          kind: "message",
          role: "assistant",
          messageId: "close-trigger",
          chunk: false,
          content: "trigger",
          redaction: { classes: [], replaced: 0 }
        },
        correlation
      );

      await consumer.subscription?.closed;
      expect(acpConversationTurns.subscriberCount(prepared.runDir)).toBe(0);
    } finally {
      acpEventReadModels.release(prepared.runDir);
    }
  });

  it("does not resolve wrapper closure before the underlying subscription closes", async () => {
    const prepared = await completedRecord();
    const snapshot = (await getRunRecord(prepared.workspace, "T-001#B-001::RUN-001"))
      .runnerReadModel;
    if (!snapshot) throw new Error("Expected a runner snapshot.");
    const context = resolveAcpPromptContext({
      workspace: prepared.workspace,
      recordId: "T-001#B-001::RUN-001",
      blockRef: "T-001#B-001",
      runId: "RUN-001",
      runDir: prepared.runDir,
      metadata: prepared.metadata
    });
    let resolveUnderlying = (): void => undefined;
    const underlyingClosed = new Promise<void>((resolve) => {
      resolveUnderlying = resolve;
    });
    const underlyingUnsubscribe = vi.fn();
    const unsubscribeTurn = vi.fn();
    const consumer = await consumeAcpPromptRunRecord(
      {
        context,
        runDir: prepared.runDir,
        metadata: prepared.metadata,
        cursor: undefined,
        subscriber: () => undefined
      },
      {
        consume: vi.fn().mockResolvedValue({
          snapshot,
          subscription: {
            unsubscribe: underlyingUnsubscribe,
            closed: underlyingClosed
          }
        }),
        subscribeTurn: () => unsubscribeTurn
      }
    );
    let wrapperClosed = false;
    void consumer.subscription?.closed.then(() => {
      wrapperClosed = true;
    });

    consumer.subscription?.unsubscribe();
    await Promise.resolve();

    expect(unsubscribeTurn).toHaveBeenCalledOnce();
    expect(underlyingUnsubscribe).toHaveBeenCalledOnce();
    expect(wrapperClosed).toBe(false);
    resolveUnderlying();
    await consumer.subscription?.closed;
    expect(wrapperClosed).toBe(true);
  });

  it("does not deliver a refresh that finishes after closure starts", async () => {
    const prepared = await completedRecord();
    const snapshot = (await getRunRecord(prepared.workspace, "T-001#B-001::RUN-001"))
      .runnerReadModel;
    if (!snapshot) throw new Error("Expected a runner snapshot.");
    const context = resolveAcpPromptContext({
      workspace: prepared.workspace,
      recordId: "T-001#B-001::RUN-001",
      blockRef: "T-001#B-001",
      runId: "RUN-001",
      runDir: prepared.runDir,
      metadata: prepared.metadata
    });
    let releaseRefresh = (): void => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markRefreshStarted = (): void => undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let turnSubscriber: (() => void | Promise<void>) | null = null;
    let turnListenerCount = 0;
    let consumeCount = 0;
    const consume = vi.fn(async () => {
      consumeCount += 1;
      if (consumeCount > 1) {
        markRefreshStarted();
        await refreshGate;
      }
      return { snapshot, subscription: null };
    });
    const subscriber = vi.fn();
    const consumer = await consumeAcpPromptRunRecord(
      {
        context,
        runDir: prepared.runDir,
        metadata: prepared.metadata,
        cursor: undefined,
        subscriber
      },
      {
        consume,
        subscribeTurn: (_key, callback) => {
          turnListenerCount += 1;
          turnSubscriber = callback;
          return () => {
            turnListenerCount -= 1;
          };
        }
      }
    );
    if (!turnSubscriber) throw new Error("Expected a turn subscriber.");
    const refresh = turnSubscriber();
    await refreshStarted;
    let wrapperClosed = false;
    void consumer.subscription?.closed.then(() => {
      wrapperClosed = true;
    });

    consumer.subscription?.unsubscribe();
    expect(turnListenerCount).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(wrapperClosed).toBe(false);
    releaseRefresh();
    await refresh;
    await consumer.subscription?.closed;

    expect(wrapperClosed).toBe(true);
    expect(subscriber).not.toHaveBeenCalled();
    expect(turnListenerCount).toBe(0);
  });

  it.each([
    "opencode",
    "pi"
  ] as const)("continues a completed %s ACP session without CLI fallback", async (agentId) => {
    const prepared = await completedRecord(agentId);
    const recordId = "T-001#B-001::RUN-001";
    const record = await getRunRecord(prepared.workspace, recordId);
    const identity = record.runnerReadModel?.intervention.prompt.identity;
    if (!identity) throw new Error(`Expected a completed ${agentId} ACP prompt identity.`);

    await sendAgentPrompt(identity, `continue ${agentId}`);

    const events = await readFile(join(prepared.runDir, "events.ndjson"), "utf8");
    expect(events).toContain(`continue ${agentId}`);
    expect(events).toContain("hello from session-1");
    expect(events).not.toContain("historical replay");
  });

  it("records a continuation error without changing the completed task result", async () => {
    const prepared = await completedRecord("codex", "load-capable-error");
    const recordId = "T-001#B-001::RUN-001";
    const record = await getRunRecord(prepared.workspace, recordId);
    const identity = record.runnerReadModel?.intervention.prompt.identity;
    if (!identity) throw new Error("Expected a completed ACP prompt identity.");
    const beforeMetadata = await readFile(join(prepared.runDir, "metadata.json"));
    const beforeReport = await readFile(join(prepared.runDir, "report.md"));

    await expect(sendAgentPrompt(identity, "fail this turn")).rejects.toThrow(
      "ACP conversation turn failed: Invalid params"
    );

    expect(await readFile(join(prepared.runDir, "metadata.json"))).toEqual(beforeMetadata);
    expect(await readFile(join(prepared.runDir, "report.md"))).toEqual(beforeReport);
    const events = await readFile(join(prepared.runDir, "events.ndjson"), "utf8");
    expect(events).toContain("ACP conversation turn failed");
    expect(events).toContain("Invalid params");
  });
});
