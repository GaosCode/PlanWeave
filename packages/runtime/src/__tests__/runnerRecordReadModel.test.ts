import { appendFile, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  consumeRunnerRecordReadModel,
  desktopAgentPromptIdentitySchema,
  readRunnerRecordReadModel
} from "../autoRun/runnerRecordReadModel.js";
import { acpEventReadModels } from "../autoRun/acpEventReadModel.js";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import { runnerIdentitySchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import {
  activeAgentRunRegistry,
  type ActiveAgentRunHandle
} from "../autoRun/activeAgentRunRegistry.js";
import { createLiveOwnership } from "../autoRun/liveControl.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import { writeJsonFile } from "../json.js";

const metadata = {
  runnerKind: "acp",
  runId: "RUN-001",
  ref: "T-001#B-001",
  taskId: "T-001",
  blockId: "B-001",
  executorRunId: "RUN-001",
  sessionId: "session-1"
};
const retentionBoundaryMessage =
  "Ordinary ACP events were dropped at the configured retention boundary.";
const ownerLeaseId = "11111111-1111-4111-8111-111111111111";
const mailboxMetadata = {
  ...metadata,
  projectId: "project-1",
  canvasId: "default",
  ownerLeaseId,
  ownerGeneration: 1,
  status: "running"
};

async function createMailbox(runDir: string, lastHeartbeatAt: string): Promise<void> {
  await chmod(runDir, 0o700);
  await new PersistentRunnerInteractionStore(runDir).createRequest({
    version: "planweave.runner-interaction/v1",
    kind: "permission",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      claimRef: "T-001#B-001",
      executorRunId: "RUN-001",
      sessionId: "session-1",
      requestId: "permission-1",
      ownerLeaseId,
      ownerGeneration: 1
    },
    requestedAt: "2026-07-11T00:00:00.000Z",
    summary: "approval required",
    toolCallId: "tool-1",
    options: [{ optionId: "allow", label: "Allow", decision: "approve" }]
  });
  await writeJsonFile(join(runDir, "heartbeat.json"), {
    status: "running",
    pid: null,
    startedAt: "2026-07-11T00:00:00.000Z",
    lastHeartbeatAt,
    finishedAt: null,
    ownerLeaseId,
    ownerGeneration: 1,
    runnerLifecycle: "waiting_interaction",
    pendingInteractionIds: ["permission-1"]
  });
}

function activeHandle(
  runDir: string,
  ownerIds: { desktopRunId?: string; runSessionId?: string } = {
    desktopRunId: "DESKTOP-001",
    runSessionId: "SESSION-001"
  }
): ActiveAgentRunHandle {
  const ownership = createLiveOwnership(`${runDir}:RUN-001`, 1);
  const pendingRequests = new Map([
    [
      "permission-1",
      {
        requestId: "permission-1",
        interactionId: "permission-1",
        kind: "permission" as const,
        requestedAt: "2026-07-11T00:00:00.000Z",
        summary: "approval required",
        permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" as const }],
        respond: vi.fn(async () => undefined),
        reject: vi.fn(async () => undefined)
      }
    ]
  ]);
  return {
    identity: {
      scope: runDir,
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1",
      ...ownerIds
    },
    connection: {
      processId: null,
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
    lifecycleState: "waiting_interaction",
    control: {
      ownership,
      process: { pid: null, terminate: vi.fn(async () => undefined) },
      connection: {
        send: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        cancelSession: vi.fn(async () => undefined),
        closeSession: vi.fn(async () => undefined),
        supportsSessionClose: false
      },
      sessionId: "session-1",
      interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
      pendingRequests,
      pendingOperations: new Map()
    }
  };
}

function event(
  sequence: number,
  kind: "interaction" | "terminal" | "message",
  claimRef = "T-001#B-001",
  ownerIds: { desktopRunId?: string | null; runSessionId?: string | null } = {}
) {
  const [taskId, blockId] = claimRef.split("#");
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: "2026-07-11T00:00:00.000Z",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      taskId,
      blockId,
      claimRef,
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: ownerIds.runSessionId === undefined ? "SESSION-001" : ownerIds.runSessionId,
      desktopRunId: ownerIds.desktopRunId === undefined ? "DESKTOP-001" : ownerIds.desktopRunId,
      executorRunId: "RUN-001"
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body:
      kind === "interaction"
        ? {
            kind: "interaction",
            interaction: {
              version: "planweave.runner/v1",
              interactionId: "permission-1",
              requestId: "permission-1",
              kind: "permission",
              requestedAt: "2026-07-11T00:00:00.000Z",
              summary: "approval required",
              status: "cancelled",
              actionable: false,
              nonActionableReason: "terminal_cleanup"
            }
          }
        : kind === "terminal"
          ? {
              kind: "terminal",
              outcome: {
                version: "planweave.runner/v1",
                state: "succeeded",
                exitCode: 0,
                finishedAt: "2026-07-11T00:00:01.000Z",
                diagnostic: null,
                artifactValidated: true
              }
            }
          : {
              kind: "message",
              role: "assistant",
              messageId: `message-${sequence}`,
              chunk: true,
              content: `message ${sequence}`,
              redaction: { classes: [], replaced: 0 }
            }
  });
}

function configurationEvent(sequence: number, body: unknown) {
  return normalizedRunnerEventSchema.parse({
    ...event(sequence, "message"),
    body
  });
}

function retentionBoundaryEvent(sequence: number) {
  return normalizedRunnerEventSchema.parse({
    ...event(sequence, "message"),
    body: {
      kind: "diagnostic",
      code: "retention_boundary",
      message: retentionBoundaryMessage
    }
  });
}

describe("runner record read model", () => {
  it("replays authoritative session configuration from persisted events", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-config-"));
    const initial = configurationEvent(1, {
      kind: "session_configuration_snapshot",
      phase: "initial",
      configuration: {
        modes: {
          currentModeId: "read-only",
          availableModes: [
            { id: "read-only", name: "Read only", description: null },
            { id: "agent", name: "Agent", description: null }
          ]
        },
        configOptions: [
          {
            id: "model",
            type: "select",
            name: "Model",
            description: null,
            category: "model",
            currentValue: "gpt-5",
            options: [
              { value: "gpt-5", name: "GPT-5", description: null, group: null },
              { value: "gpt-5.2", name: "GPT-5.2", description: null, group: null }
            ]
          }
        ]
      }
    });
    const live = configurationEvent(2, {
      kind: "session_config_options_update",
      configOptions: [
        {
          id: "model",
          type: "select",
          name: "Model",
          description: null,
          category: "model",
          currentValue: "gpt-5.2",
          options: [
            { value: "gpt-5", name: "GPT-5", description: null, group: null },
            { value: "gpt-5.2", name: "GPT-5.2", description: null, group: null }
          ]
        }
      ]
    });
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(initial)}\n${JSON.stringify(live)}\n`,
      "utf8"
    );

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result?.actualConfiguration).toMatchObject({
      available: true,
      sequence: 2,
      sessionId: "session-1",
      fields: { model: { available: true, value: "gpt-5.2" } }
    });
  });

  it("keeps persisted interactions stale when no live owner exists", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(event(1, "interaction"))}\n${JSON.stringify(event(2, "terminal"))}\n`,
      "utf8"
    );

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result).toMatchObject({
      terminal: true,
      interaction: { persisted: true, active: false, stale: true }
    });
    expect(result?.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(result?.diagnostics).toEqual([]);
  });

  it("keeps offline cursor retention evidence aligned across events and projections", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-retained-record-"));
    const message = event(1, "message");
    const boundary = retentionBoundaryEvent(2);
    const terminal = event(3, "terminal");
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(message)}\n${JSON.stringify(boundary)}\n${JSON.stringify(terminal)}\n`,
      "utf8"
    );

    const consumer = await consumeRunnerRecordReadModel({
      runDir,
      metadata,
      cursor: {
        version: "planweave.runner-event-cursor/v1",
        runId: "RUN-001",
        afterSequence: 1,
        canonicalIdentity: null,
        terminal: false
      }
    });

    expect(consumer.subscription).toBeNull();
    expect(
      consumer.snapshot?.events.map((persistedEvent) => ({
        sequence: persistedEvent.sequence,
        kind: persistedEvent.body.kind
      }))
    ).toEqual([
      { sequence: 2, kind: "diagnostic" },
      { sequence: 3, kind: "terminal" }
    ]);
    expect(consumer.snapshot?.timeline).toEqual([
      expect.objectContaining({ sequence: 1, kind: "message", content: "message 1" })
    ]);
    expect(consumer.snapshot?.diagnostics).toEqual([
      {
        code: "retention_boundary",
        line: null,
        message: retentionBoundaryMessage
      }
    ]);
    expect(consumer.snapshot?.cursor).toMatchObject({ afterSequence: 3, terminal: true });
  });

  it("surfaces missing, corrupt, and partial logs as diagnostics", async () => {
    const missingDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    const missing = await readRunnerRecordReadModel({ runDir: missingDir, metadata });
    expect(missing?.diagnostics.map((item) => item.code)).toContain("missing_log");

    const damagedDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    await writeFile(join(damagedDir, "events.ndjson"), 'not-json\n{"partial":', "utf8");
    const damaged = await readRunnerRecordReadModel({ runDir: damagedDir, metadata });
    expect(damaged?.diagnostics.map((item) => item.code)).toEqual(["corrupt_line", "partial_line"]);
  });

  it.each([
    ["available_commands_update", { availableCommands: [] }],
    ["current_mode_update", { currentModeId: "code" }],
    ["config_option_update", { configOptions: [] }],
    ["session_info_update", { title: "Renamed session" }],
    ["session_info_update", { updatedAt: "2026-07-13T00:00:00.000Z" }],
    ["agent_thought_chunk", { content: { type: "text", text: "private" } }],
    ["plan_removed", { planId: "plan-1" }]
  ])("hides historical false-positive corrupt_line for %s", async (sessionUpdate, payload) => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    const legacy = normalizedRunnerEventSchema.parse({
      ...event(1, "message"),
      body: {
        kind: "diagnostic",
        code: "corrupt_line",
        message: `Unsupported ACP session update: ${JSON.stringify({ sessionUpdate, ...payload })}`
      }
    });
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(legacy)}\n`, "utf8");

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result?.events).toEqual([]);
    expect(result?.diagnostics).toEqual([]);
  });

  it("keeps malformed known ACP updates visible", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    const malformed = normalizedRunnerEventSchema.parse({
      ...event(1, "message"),
      body: {
        kind: "diagnostic",
        code: "corrupt_line",
        message: 'Unsupported ACP session update: {"sessionUpdate":"available_commands_update"}'
      }
    });
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(malformed)}\n`, "utf8");

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result?.events).toHaveLength(1);
  });

  it("keeps a known ACP update with a malformed array member visible", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    const malformed = normalizedRunnerEventSchema.parse({
      ...event(1, "message"),
      body: {
        kind: "diagnostic",
        code: "corrupt_line",
        message:
          'Unsupported ACP session update: {"sessionUpdate":"available_commands_update","availableCommands":[{"name":"missing-description"}]}'
      }
    });
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(malformed)}\n`, "utf8");

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result?.events).toHaveLength(1);
  });

  it("keeps genuinely unknown historical ACP session updates visible", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    const unknown = normalizedRunnerEventSchema.parse({
      ...event(1, "message"),
      body: {
        kind: "diagnostic",
        code: "corrupt_line",
        message: 'Unsupported ACP session update: {"sessionUpdate":"future_unknown_update"}'
      }
    });
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(unknown)}\n`, "utf8");

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result?.events).toHaveLength(1);
    expect(result?.events[0]?.body).toMatchObject({
      kind: "diagnostic",
      code: "corrupt_line"
    });
  });

  it("fails closed when a same-run log belongs to another claim", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(event(1, "message", "T-002#B-009"))}\n`,
      "utf8"
    );

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result?.events).toEqual([]);
    expect(result?.conversation).toEqual([]);
    expect(result?.interaction).toEqual({
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    });
    expect(result?.diagnostics.map((item) => item.code)).toContain("identity_mismatch");
  });

  it("fails closed for conflicting metadata identity fields before replay", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(event(1, "message"))}\n`,
      "utf8"
    );

    const result = await readRunnerRecordReadModel({
      runDir,
      metadata: { ...metadata, taskId: "T-999", blockId: "B-999" }
    });

    expect(result?.events).toEqual([]);
    expect(result?.conversation).toEqual([]);
    expect(result?.diagnostics.map((item) => item.code)).toEqual(["identity_mismatch"]);
  });

  it("fails the whole persisted record closed when a valid event is followed by a foreign identity", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(event(1, "message"))}\n${JSON.stringify(event(2, "message", "T-999#B-999"))}\n`,
      "utf8"
    );

    const result = await readRunnerRecordReadModel({ runDir, metadata });

    expect(result?.events).toEqual([]);
    expect(result?.conversation).toEqual([]);
    expect(result?.interaction).toEqual({
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    });
    expect(result?.diagnostics.map((item) => item.code)).toContain("identity_mismatch");
  });

  it("exposes one atomic replay-to-live consumer authority", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-live-record-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "message").identity),
      runner: runnerIdentitySchema.parse(event(1, "message").runner)
    });
    try {
      await model.store.append(event(1, "message").body);
      const live: number[] = [];
      const consumer = await consumeRunnerRecordReadModel({
        runDir,
        metadata,
        subscriber: (snapshot) => {
          live.push(snapshot.cursor.afterSequence);
        }
      });
      expect(consumer.snapshot?.events.map((item) => item.sequence)).toEqual([1]);
      expect(consumer.subscription).not.toBeNull();

      await model.store.append(event(2, "message").body);
      await model.store.append(event(3, "terminal").body);
      await consumer.subscription?.closed;

      expect(live).toEqual([2, 3]);
      expect(model.store.publisher.subscriberCount).toBe(0);
    } finally {
      acpEventReadModels.release(runDir);
    }
  });

  it("follows a persisted running record when its in-memory read model is unavailable", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-persisted-live-record-"));
    const unicodeMessage = normalizedRunnerEventSchema.parse({
      ...event(2, "message"),
      body: {
        ...event(2, "message").body,
        content: "消息 2"
      }
    });
    const messageBytes = Buffer.from(JSON.stringify(unicodeMessage));
    const unicodeStart = messageBytes.indexOf(Buffer.from("消息"));
    expect(unicodeStart).toBeGreaterThan(0);
    const splitInsideUnicode = unicodeStart + 1;
    await writeFile(
      join(runDir, "events.ndjson"),
      Buffer.concat([
        Buffer.from(`${JSON.stringify(event(1, "message"))}\n`),
        messageBytes.subarray(0, splitInsideUnicode)
      ])
    );
    const live: Array<{ sequences: number[]; terminal: boolean }> = [];
    const consumer = await consumeRunnerRecordReadModel({
      runDir,
      metadata: { ...metadata, status: "running" },
      subscriber: (snapshot) => {
        live.push({
          sequences: snapshot.events.map((item) => item.sequence),
          terminal: snapshot.terminal
        });
      }
    });

    expect(consumer.snapshot?.events.map((item) => item.sequence)).toEqual([1]);
    expect(consumer.subscription).not.toBeNull();
    await appendFile(
      join(runDir, "events.ndjson"),
      Buffer.concat([
        messageBytes.subarray(splitInsideUnicode),
        Buffer.from(`\n${JSON.stringify(event(3, "terminal"))}\n`)
      ])
    );

    await vi.waitFor(() => expect(live).toContainEqual({ sequences: [2, 3], terminal: true }), {
      timeout: 2000
    });
    await expect(consumer.subscription?.closed).resolves.toMatchObject({
      reason: "terminal",
      lastSequence: 3
    });
  });

  it("keeps a completed prompt-capable record subscribed for later conversation turns", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-resume-record-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "message").identity),
      runner: runnerIdentitySchema.parse(event(1, "message").runner)
    });
    try {
      await model.store.append(event(1, "message").body);
      await model.store.append(event(2, "terminal").body);
      const live: number[] = [];
      const consumer = await consumeRunnerRecordReadModel({
        runDir,
        metadata,
        promptIdentity: desktopAgentPromptIdentitySchema.parse({
          ref: { projectRoot: "/tmp/project", canvasId: "default" },
          recordId: "T-001#B-001::RUN-001",
          executorRunId: "RUN-001",
          claimRef: "T-001#B-001",
          sessionId: "session-1"
        }),
        subscriber: (snapshot) => {
          live.push(snapshot.cursor.afterSequence);
        }
      });

      expect(consumer.snapshot?.terminal).toBe(true);
      expect(consumer.subscription).not.toBeNull();
      await model.store.append(event(3, "message").body);
      await vi.waitFor(() => expect(live).toEqual([3]));
      consumer.subscription?.unsubscribe();
      await consumer.subscription?.closed;
    } finally {
      acpEventReadModels.release(runDir);
    }
  });

  it("keeps a live subscription when metadata has not learned the ACP session id yet", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-null-session-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "message").identity),
      runner: runnerIdentitySchema.parse(event(1, "message").runner)
    });
    try {
      const live: number[] = [];
      const consumer = await consumeRunnerRecordReadModel({
        runDir,
        metadata: { ...metadata, sessionId: null },
        subscriber: (snapshot) => {
          live.push(snapshot.cursor.afterSequence);
        }
      });

      await model.store.append(event(1, "message").body, { sessionId: "session-1" });
      await vi.waitFor(() => expect(live).toEqual([1]));
      expect(model.store.snapshot().diagnostics.map((item) => item.code)).not.toContain(
        "subscriber_callback_failed"
      );
      consumer.subscription?.unsubscribe();
    } finally {
      acpEventReadModels.release(runDir);
    }
  });

  it("exposes the existing live owned ACP session as prompt-capable", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-live-prompt-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "message").identity),
      runner: runnerIdentitySchema.parse(event(1, "message").runner)
    });
    const handle = activeHandle(runDir);
    handle.lifecycleState = "running";
    handle.control.pendingRequests.clear();
    activeAgentRunRegistry.register(handle);
    try {
      await model.store.append(event(1, "message").body, { sessionId: "session-1" });
      const promptIdentity = desktopAgentPromptIdentitySchema.parse({
        ref: { projectRoot: "/tmp/project", canvasId: "default" },
        recordId: "T-001#B-001::RUN-001",
        executorRunId: "RUN-001",
        claimRef: "T-001#B-001",
        sessionId: "session-1"
      });

      const snapshot = await readRunnerRecordReadModel({
        runDir,
        metadata,
        promptIdentity
      });

      expect(snapshot?.intervention.prompt).toEqual({
        available: true,
        reason: null,
        identity: promptIdentity,
        inFlight: false
      });
    } finally {
      await activeAgentRunRegistry.remove(handle, "test complete");
      acpEventReadModels.release(runDir);
    }
  });

  it("keeps persisted running metadata prompt-unavailable after live ownership disappears", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-owner-gone-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "message").identity),
      runner: runnerIdentitySchema.parse(event(1, "message").runner)
    });
    try {
      await model.store.append(event(1, "message").body, { sessionId: "session-1" });
      const promptIdentity = desktopAgentPromptIdentitySchema.parse({
        ref: { projectRoot: "/tmp/project", canvasId: "default" },
        recordId: "T-001#B-001::RUN-001",
        executorRunId: "RUN-001",
        claimRef: "T-001#B-001",
        sessionId: "session-1"
      });

      const snapshot = await readRunnerRecordReadModel({
        runDir,
        metadata: {
          ...metadata,
          status: "running",
          desktopRunId: "DESKTOP-001",
          runSessionId: "SESSION-001"
        },
        promptIdentity
      });

      expect(snapshot?.intervention.prompt).toEqual({
        available: false,
        reason: "No live owned ACP session is available.",
        identity: promptIdentity,
        inFlight: false
      });
    } finally {
      acpEventReadModels.release(runDir);
    }
  });

  it("pushes authoritative interaction appearance and resolution without inferring from events", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-live-interaction-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "interaction").identity),
      runner: runnerIdentitySchema.parse(event(1, "interaction").runner)
    });
    const handle = activeHandle(runDir);
    activeAgentRunRegistry.register(handle);
    try {
      await model.store.append(event(1, "interaction").body);
      const updates: Array<{ active: boolean; terminal: boolean }> = [];
      const consumer = await consumeRunnerRecordReadModel({
        runDir,
        metadata,
        subscriber: (snapshot) => {
          updates.push({ active: snapshot.interaction.active, terminal: snapshot.terminal });
        }
      });
      expect(consumer.snapshot?.interaction.activeRequests).toMatchObject([
        { requestId: "permission-1", kind: "permission" }
      ]);

      handle.control.pendingRequests.clear();
      activeAgentRunRegistry.notifyInteractionChanged(handle);
      await vi.waitFor(() => expect(updates).toContainEqual({ active: false, terminal: false }));

      await model.store.append(event(2, "terminal").body);
      await consumer.subscription?.closed;
      expect(updates.at(-1)).toEqual({ active: false, terminal: true });
    } finally {
      await activeAgentRunRegistry.remove(handle, "test complete");
      acpEventReadModels.release(runDir);
    }
  });

  it("resnapshots after listener registration when removal occurs in the initial gap", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-registration-gap-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "interaction").identity),
      runner: runnerIdentitySchema.parse(event(1, "interaction").runner)
    });
    const handle = activeHandle(runDir);
    activeAgentRunRegistry.register(handle);
    const subscribeInteractionChanges =
      activeAgentRunRegistry.subscribeInteractionChanges.bind(activeAgentRunRegistry);
    const registration = vi
      .spyOn(activeAgentRunRegistry, "subscribeInteractionChanges")
      .mockImplementation((subscriber) => {
        handle.control.pendingRequests.clear();
        activeAgentRunRegistry.notifyInteractionChanged(handle);
        return subscribeInteractionChanges(subscriber);
      });
    try {
      await model.store.append(event(1, "interaction").body);
      const consumer = await consumeRunnerRecordReadModel({
        runDir,
        metadata,
        subscriber: vi.fn()
      });

      expect(consumer.snapshot?.interaction).toEqual({
        persisted: true,
        active: false,
        stale: true,
        activeRequests: []
      });
      consumer.subscription?.unsubscribe();
    } finally {
      registration.mockRestore();
      await activeAgentRunRegistry.remove(handle, "test complete");
      acpEventReadModels.release(runDir);
    }
  });

  it("normalizes a foreign active cursor to a fail-closed diagnostic", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-live-record-"));
    const model = await acpEventReadModels.create({
      runDir,
      identity: runnerRunIdentitySchema.parse(event(1, "message").identity),
      runner: runnerIdentitySchema.parse(event(1, "message").runner)
    });
    try {
      await model.store.append(event(1, "message").body);
      const foreignCursor = {
        version: "planweave.runner-event-cursor/v1" as const,
        runId: "RUN-001",
        afterSequence: 0,
        canonicalIdentity: {
          identity: event(1, "message", "T-999#B-999").identity,
          runner: event(1, "message").runner
        },
        terminal: false
      };

      const consumer = await consumeRunnerRecordReadModel({
        runDir,
        metadata,
        cursor: foreignCursor,
        subscriber: vi.fn()
      });

      expect(consumer.snapshot?.events).toEqual([]);
      expect(consumer.snapshot?.conversation).toEqual([]);
      expect(consumer.snapshot?.diagnostics.map((item) => item.code)).toContain(
        "identity_mismatch"
      );
      expect(consumer.subscription).toBeNull();
    } finally {
      acpEventReadModels.release(runDir);
    }
  });

  it("marks interaction active only for exact live registry ownership", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-owned-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(event(1, "interaction"))}\n`,
      "utf8"
    );
    const handle = activeHandle(runDir);
    activeAgentRunRegistry.register(handle);
    try {
      const owned = await readRunnerRecordReadModel({ runDir, metadata });
      expect(owned?.interaction).toMatchObject({
        persisted: true,
        active: true,
        stale: false,
        activeRequests: [{ requestId: "permission-1", kind: "permission" }]
      });
      const foreign = await readRunnerRecordReadModel({
        runDir,
        metadata: { ...metadata, ref: "T-002#B-001" }
      });
      expect(foreign?.events).toEqual([]);
      expect(foreign?.diagnostics.map((item) => item.code)).toContain("identity_mismatch");
      expect(foreign?.interaction.active).toBe(false);
    } finally {
      await activeAgentRunRegistry.remove(handle, "test complete");
    }
  });

  it("keeps live interaction inactive for foreign owner ids or a nonmatching pending request", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-owned-record-"));
    const ownedEvent = event(1, "interaction", "T-001#B-001", {
      desktopRunId: "DESKTOP-good",
      runSessionId: "SESSION-good"
    });
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(ownedEvent)}\n`, "utf8");
    const handle = activeHandle(runDir, {
      desktopRunId: "DESKTOP-foreign",
      runSessionId: "SESSION-foreign"
    });
    activeAgentRunRegistry.register(handle);
    try {
      const foreignOwner = await readRunnerRecordReadModel({ runDir, metadata });
      expect(foreignOwner?.interaction).toEqual({
        persisted: true,
        active: false,
        stale: true,
        activeRequests: []
      });
    } finally {
      await activeAgentRunRegistry.remove(handle, "test complete");
    }

    const requestRunDir = await mkdtemp(join(tmpdir(), "planweave-acp-owned-record-"));
    await writeFile(
      join(requestRunDir, "events.ndjson"),
      `${JSON.stringify(ownedEvent)}\n`,
      "utf8"
    );
    const requestHandle = activeHandle(requestRunDir, {
      desktopRunId: "DESKTOP-good",
      runSessionId: "SESSION-good"
    });
    requestHandle.control.pendingRequests.clear();
    requestHandle.control.pendingRequests.set("permission-other", {
      requestId: "permission-other",
      interactionId: "permission-other",
      kind: "permission",
      requestedAt: "2026-07-11T00:00:00.000Z",
      summary: "other approval",
      respond: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined)
    });
    activeAgentRunRegistry.register(requestHandle);
    try {
      const wrongRequest = await readRunnerRecordReadModel({ runDir: requestRunDir, metadata });
      expect(wrongRequest?.interaction).toEqual({
        persisted: true,
        active: false,
        stale: true,
        activeRequests: []
      });
    } finally {
      await activeAgentRunRegistry.remove(requestHandle, "test complete");
    }
  });

  it("keeps interaction inactive when canonical null owner ids have live foreign owners", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-owned-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(event(1, "interaction"))}\n`,
      "utf8"
    );
    const handle = activeHandle(runDir, {
      desktopRunId: "DESKTOP-foreign",
      runSessionId: "SESSION-foreign"
    });
    activeAgentRunRegistry.register(handle);
    try {
      const result = await readRunnerRecordReadModel({ runDir, metadata });

      expect(result?.events).toHaveLength(1);
      expect(result?.interaction).toEqual({
        persisted: true,
        active: false,
        stale: true,
        activeRequests: []
      });
    } finally {
      await activeAgentRunRegistry.remove(handle, "test complete");
    }
  });

  it("projects a mailbox permission without desktopRunId or a live registry owner", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-mailbox-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(
        event(1, "interaction", "T-001#B-001", {
          desktopRunId: null,
          runSessionId: "SESSION-001"
        })
      )}\n`
    );
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const result = await readRunnerRecordReadModel({
      runDir,
      metadata: { ...mailboxMetadata, desktopRunId: null },
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(result?.interaction).toMatchObject({
      active: true,
      stale: false,
      activeRequests: [
        {
          kind: "permission",
          identity: { ownerLeaseId },
          availability: { available: true, reason: null }
        }
      ]
    });
    expect(result?.intervention.cancel.available).toBe(false);
  });

  it("reprojects a stale same-lease mailbox as actionable after heartbeat recovery", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-mailbox-stale-"));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:00.000Z");
    const options = {
      runDir,
      metadata: mailboxMetadata,
      now: () => new Date("2026-07-11T00:01:00.000Z")
    };
    const stale = await readRunnerRecordReadModel(options);
    expect(stale?.interaction.activeRequests[0]?.availability).toEqual({
      available: false,
      reason: "owner_unavailable"
    });
    await writeJsonFile(join(runDir, "heartbeat.json"), {
      status: "running",
      pid: null,
      startedAt: "2026-07-11T00:00:00.000Z",
      lastHeartbeatAt: "2026-07-11T00:01:00.000Z",
      finishedAt: null,
      ownerLeaseId,
      ownerGeneration: 1,
      runnerLifecycle: "waiting_interaction",
      pendingInteractionIds: ["permission-1"]
    });
    const recovered = await readRunnerRecordReadModel(options);
    expect(recovered?.interaction.activeRequests[0]?.availability).toEqual({
      available: true,
      reason: null
    });
  });

  it("projects terminal metadata and replaced metadata ownership as closed reasons", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-mailbox-metadata-"));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const baseMetadata = mailboxMetadata;
    const terminal = await readRunnerRecordReadModel({
      runDir,
      metadata: { ...baseMetadata, status: "completed" },
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(terminal?.interaction.activeRequests[0]?.availability).toEqual({
      available: false,
      reason: "run_terminal"
    });
    const replaced = await readRunnerRecordReadModel({
      runDir,
      metadata: {
        ...baseMetadata,
        ownerLeaseId: "22222222-2222-4222-8222-222222222222",
        ownerGeneration: 2
      },
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(replaced?.interaction.activeRequests[0]?.availability).toEqual({
      available: false,
      reason: "owner_replaced"
    });
  });

  it.each([
    "response",
    "owner_result"
  ] as const)("suppresses a lingering registry permission after the %s settlement", async (settlement) => {
    const runDir = await mkdtemp(join(tmpdir(), `planweave-acp-mailbox-${settlement}-`));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = (await store.readSnapshot("permission-1")).request;
    if (settlement === "response") {
      await store.createResponse({
        version: "planweave.runner-interaction-response/v1",
        identity: request.identity,
        decision: { kind: "select", optionId: "allow" },
        respondedAt: "2026-07-11T00:00:11.000Z",
        decisionSource: "test-client",
        reason: null
      });
    } else {
      await store.createOwnerResult({
        version: "planweave.runner-interaction-owner-result/v1",
        identity: request.identity,
        outcome: "expired",
        reason: "deadline",
        recordedAt: "2026-07-11T00:00:11.000Z",
        message: "Permission request expired: deadline."
      });
    }
    const handle = activeHandle(runDir);
    activeAgentRunRegistry.register(handle);
    try {
      const result = await readRunnerRecordReadModel({
        runDir,
        metadata: mailboxMetadata,
        now: () => new Date("2026-07-11T00:00:11.000Z")
      });
      expect(result?.interaction.activeRequests).toEqual([]);
      expect(result?.interaction.active).toBe(false);
    } finally {
      await activeAgentRunRegistry.remove(handle, "test complete");
    }
  });

  it.each([
    ["heartbeat", "{broken"],
    ["heartbeat", "{}"],
    ["metadata", "{broken"],
    ["metadata", "{}"],
    ["mailbox", "{broken"],
    ["mailbox", "{}"]
  ] as const)("fails closed for invalid persisted %s JSON or schema", async (target, content) => {
    const runDir = await mkdtemp(join(tmpdir(), `planweave-acp-invalid-${target}-`));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const path =
      target === "mailbox"
        ? join(
            runDir,
            "interactions",
            Buffer.from("permission-1").toString("base64url"),
            "request.json"
          )
        : join(runDir, `${target}.json`);
    await writeFile(path, content, "utf8");
    const result = await readRunnerRecordReadModel({
      runDir,
      metadata: mailboxMetadata,
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(result?.interaction).toMatchObject({
      active: false,
      stale: true,
      activeRequests: [],
      diagnostic: {
        code: "contract_invalid",
        issues: expect.arrayContaining([expect.objectContaining({ source: target })])
      }
    });
  });

  it("leaves non-ACP record projections unchanged", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-cli-record-"));
    await expect(
      readRunnerRecordReadModel({ runDir, metadata: { runnerKind: "cli", runId: "RUN-001" } })
    ).resolves.toBeNull();
  });
});
