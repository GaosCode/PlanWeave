import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAcpSessionNotification } from "../autoRun/acpEventNormalization.js";
import {
  AcpEventStore,
  AcpEventStoreLimitError,
  AcpEventStoreOpenError
} from "../autoRun/acpEventStore.js";
import {
  createDefaultAcpEventRetentionPolicy,
  DefaultAcpEventRetentionPolicy
} from "../autoRun/acpEventRetentionPolicy.js";
import { AcpEventReadModel } from "../autoRun/acpEventReadModel.js";
import {
  encodeNormalizedRunnerEvent,
  RUNNER_EVENT_MAX_ENCODED_BYTES,
  RUNNER_EVENT_MAX_MESSAGE_BYTES,
  type NormalizedRunnerEvent
} from "../autoRun/normalizedEventContract.js";
import { replayNormalizedRunnerEvents } from "../autoRun/runnerEventReplay.js";
import { runnerIdentitySchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { projectAcpConversation } from "../autoRun/acpConversationProjection.js";
import { writeAcpConversationProjection } from "../autoRun/acpConversationPersistence.js";
import { event, identity, projectionEvent } from "./acpEvents.helpers.js";

const finalEvidenceSlotCount = 3;
const finalEvidenceReserveBytes = RUNNER_EVENT_MAX_ENCODED_BYTES * finalEvidenceSlotCount;

const acpRunner = () =>
  runnerIdentitySchema.parse({
    version: "planweave.runner/v1",
    runnerKind: "acp",
    agentId: "codex"
  });

function ordinaryMessage(messageId: string, content = "x"): NormalizedRunnerEvent["body"] {
  return {
    kind: "message",
    role: "assistant",
    messageId,
    chunk: false,
    content,
    redaction: { classes: [], replaced: 0 }
  };
}

function lifecycleBody(message: string): NormalizedRunnerEvent["body"] {
  return { kind: "lifecycle", state: "running", message };
}

function artifactBody(relativePath = "report.md"): NormalizedRunnerEvent["body"] {
  return {
    kind: "artifact",
    artifact: {
      version: "planweave.runner/v1",
      kind: "implementation",
      relativePath,
      sha256: "a".repeat(64),
      sizeBytes: 12,
      mediaType: "text/markdown"
    }
  };
}

function terminalBody(diagnostic: string | null = null): NormalizedRunnerEvent["body"] {
  return {
    kind: "terminal",
    outcome: {
      version: "planweave.runner/v1",
      state: "succeeded",
      exitCode: 0,
      finishedAt: "2026-07-11T00:00:01.000Z",
      diagnostic,
      artifactValidated: true
    }
  };
}

function maximumRunnerIdentity() {
  const taskId = "T".repeat(256);
  const blockId = "B".repeat(256);
  const runId = "R".repeat(256);
  return runnerRunIdentitySchema.parse({
    projectId: "P".repeat(256),
    canvasId: "C".repeat(256),
    taskId,
    blockId,
    claimRef: `${taskId}#${blockId}`,
    runId,
    runOwner: "executor",
    runSessionId: "S".repeat(256),
    desktopRunId: "D".repeat(256),
    executorRunId: runId
  });
}

function retentionBoundaryCount(events: readonly NormalizedRunnerEvent[]): number {
  return events.filter((e) => e.body.kind === "diagnostic" && e.body.code === "retention_boundary")
    .length;
}

describe("ACP event normalization", () => {
  it("preserves message, tool, plan, and usage semantics while redacting", () => {
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "Authorization: Bearer abc.def.ghi" }
        }
      })
    ).toMatchObject({
      kind: "message",
      role: "assistant",
      messageId: "message-1",
      content: "[REDACTED:CREDENTIAL]"
    });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "README.md" },
          rawOutput: "initial"
        }
      })
    ).toMatchObject({
      kind: "tool_call",
      callId: "tool-1",
      title: "Read",
      toolKind: "read",
      status: "in_progress",
      rawInput: { content: '{"path":"README.md"}' },
      rawOutput: { content: "initial" }
    });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "message-2",
          content: { type: "text", text: "hello" }
        }
      })
    ).toMatchObject({ kind: "message", role: "user", messageId: "message-2" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          title: "Read complete",
          kind: "read",
          status: "completed",
          content: null,
          rawOutput: { bytes: 42 }
        }
      })
    ).toMatchObject({
      kind: "tool_update",
      callId: "tool-1",
      title: "Read complete",
      toolKind: "read",
      status: "completed",
      content: null,
      rawOutput: { content: '{"bytes":42}' }
    });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "finish", priority: "high", status: "in_progress" }]
        }
      })
    ).toMatchObject({ kind: "plan_update" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "markdown", planId: "plan-1", content: "# Plan" }
        }
      })
    ).toMatchObject({ kind: "plan_update" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan_removed",
          planId: "private-plan-id"
        }
      })
    ).toMatchObject({ kind: "plan_update", content: "Plan removed." });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "usage_update",
          used: 10,
          size: 100
        }
      })
    ).toMatchObject({ kind: "usage_update", usedTokens: 10, contextWindowTokens: 100 });
  });

  it("ignores provider-only status while preserving authoritative configuration updates", () => {
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { codex: { threadStatus: { type: "active", activeFlags: [] } } }
        }
      })
    ).toBeNull();
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "thought-1",
          content: { type: "text", text: "private reasoning" }
        }
      })
    ).toBeNull();
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "x".repeat(1_024),
          content: { type: "image", data: "private-image", mimeType: "image/png" }
        }
      })
    ).toBeNull();
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: []
        }
      })
    ).toBeNull();
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "code"
        }
      })
    ).toEqual({ kind: "session_mode_update", currentModeId: "code" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: []
        }
      })
    ).toEqual({ kind: "session_config_options_update", configOptions: [] });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "provider_future_update"
        }
      })
    ).toMatchObject({ kind: "diagnostic", code: "corrupt_line" });
  });
});

describe("ACP event store and projection", () => {
  it("coalesces same-message chunks across non-projected events", () => {
    const redaction = { classes: [], replaced: 0 } as const;
    const conversation = projectAcpConversation([
      projectionEvent(1, {
        kind: "message",
        role: "assistant",
        messageId: "message-1",
        chunk: true,
        content: "你",
        redaction
      }),
      projectionEvent(2, {
        kind: "usage_update",
        usedTokens: 1,
        contextWindowTokens: 100,
        cost: null
      }),
      projectionEvent(3, { kind: "lifecycle", state: "running", message: "still running" }),
      projectionEvent(4, {
        kind: "diagnostic",
        code: "protocol_error",
        message: "non-conversation detail"
      }),
      projectionEvent(5, {
        kind: "message",
        role: "assistant",
        messageId: "message-1",
        chunk: true,
        content: "好",
        redaction
      })
    ]);

    expect(conversation).toEqual([
      expect.objectContaining({ sequence: 1, kind: "message", content: "你好" })
    ]);
  });

  it("preserves tool boundaries and does not merge different message ids", () => {
    const redaction = { classes: [], replaced: 0 } as const;
    const conversation = projectAcpConversation([
      projectionEvent(1, {
        kind: "message",
        role: "assistant",
        messageId: "message-1",
        chunk: true,
        content: "before",
        redaction
      }),
      projectionEvent(2, {
        kind: "tool_call",
        callId: "tool-1",
        status: "in_progress",
        title: "Read",
        content: null
      }),
      projectionEvent(3, {
        kind: "tool_update",
        callId: "tool-1",
        status: "completed",
        content: null
      }),
      projectionEvent(4, {
        kind: "message",
        role: "assistant",
        messageId: "message-1",
        chunk: true,
        content: "after",
        redaction
      }),
      projectionEvent(5, {
        kind: "message",
        role: "assistant",
        messageId: "message-2",
        chunk: true,
        content: "next",
        redaction
      })
    ]);

    expect(conversation.map((item) => [item.sequence, item.kind, item.content])).toEqual([
      [1, "message", "before"],
      [2, "tool_call", "Read"],
      [3, "tool_update", "completed"],
      [4, "message", "after"],
      [5, "message", "next"]
    ]);
  });

  it("merges only contiguous anonymous chunks with the same role", () => {
    const redaction = { classes: [], replaced: 0 } as const;
    const conversation = projectAcpConversation([
      projectionEvent(1, {
        kind: "message",
        role: "assistant",
        messageId: null,
        chunk: true,
        content: "a",
        redaction
      }),
      projectionEvent(2, {
        kind: "usage_update",
        usedTokens: 1,
        contextWindowTokens: 100,
        cost: null
      }),
      projectionEvent(3, {
        kind: "message",
        role: "assistant",
        messageId: null,
        chunk: true,
        content: "b",
        redaction
      }),
      projectionEvent(4, {
        kind: "message",
        role: "assistant",
        messageId: "known",
        chunk: true,
        content: "c",
        redaction
      }),
      projectionEvent(5, {
        kind: "message",
        role: "user",
        messageId: null,
        chunk: true,
        content: "d",
        redaction
      })
    ]);

    expect(conversation.map((item) => item.content)).toEqual(["ab", "c", "d"]);
  });

  it("separates redacted protocol and normalized logs and rebuilds conversation", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-events-"));
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    expect(await store.open()).toEqual([]);
    await store.appendProtocol("agent_to_client", { token: "raw-secret-value" });
    await store.append(
      {
        kind: "message",
        role: "assistant",
        messageId: "message-1",
        chunk: true,
        content: "hello",
        redaction: { classes: [], replaced: 0 }
      },
      { sessionId: "session-1" }
    );
    await store.drain();
    const protocol = await readFile(join(runDir, "protocol.ndjson"), "utf8");
    const normalized = await readFile(join(runDir, "events.ndjson"), "utf8");
    const conversation = JSON.parse(await readFile(join(runDir, "conversation.json"), "utf8")) as {
      items: Array<{ content: string }>;
    };
    expect(protocol).toContain("[REDACTED:CREDENTIAL]");
    expect(protocol).not.toContain("raw-secret-value");
    expect(normalized).toContain('"kind":"message"');
    expect(conversation.items).toEqual([expect.objectContaining({ content: "hello" })]);
  });

  it("flushes the final conversation projection when a terminal event commits", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-terminal-projection-"));
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    await store.open();
    await store.append({
      kind: "message",
      role: "assistant",
      messageId: "message-1",
      chunk: true,
      content: "finished",
      redaction: { classes: [], replaced: 0 }
    });
    await store.append({
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "succeeded",
        exitCode: 0,
        finishedAt: "2026-07-11T00:00:01.000Z",
        diagnostic: null,
        artifactValidated: true
      }
    });

    const conversation = JSON.parse(await readFile(join(runDir, "conversation.json"), "utf8")) as {
      items: Array<{ content: string }>;
    };
    expect(conversation.items).toEqual([expect.objectContaining({ content: "finished" })]);
  });

  it("treats the normalized log as committed when conversation projection fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-projection-failure-"));
    let projectionAttempts = 0;
    const projectedSequences: number[][] = [];
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      }),
      writeConversationProjection: async (targetRunDir, events) => {
        projectionAttempts += 1;
        projectedSequences.push(events.map((item) => item.sequence));
        if (projectionAttempts === 1) throw new Error("scripted projection failure");
        await writeAcpConversationProjection(targetRunDir, events);
      }
    });
    await store.open();
    await store.append({
      kind: "message",
      role: "assistant",
      messageId: "message-1",
      chunk: true,
      content: "finished after retry",
      redaction: { classes: [], replaced: 0 }
    });
    await expect(
      store.append({
        kind: "terminal",
        outcome: {
          version: "planweave.runner/v1",
          state: "succeeded",
          exitCode: 0,
          finishedAt: "2026-07-11T00:00:01.000Z",
          diagnostic: null,
          artifactValidated: true
        }
      })
    ).resolves.toBeUndefined();
    expect(projectionAttempts).toBe(1);
    await expect(store.drain()).resolves.toBeUndefined();
    expect(projectionAttempts).toBe(2);
    expect(await readFile(store.eventsPath, "utf8")).toContain('"sequence":1');
    expect(await readFile(store.eventsPath, "utf8")).toContain('"sequence":2');
    expect(store.snapshot().diagnostics).toContainEqual(
      expect.objectContaining({
        code: "conversation_projection_failed",
        message: expect.not.stringContaining("scripted projection failure")
      })
    );
    expect(new AcpEventReadModel(store).replay().diagnostics).toContainEqual(
      expect.objectContaining({ code: "conversation_projection_failed" })
    );
    expect(projectedSequences).toEqual([
      [1, 2],
      [1, 2, 3]
    ]);
    expect(store.snapshot().events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(
      store
        .snapshot()
        .events.filter(
          (item) =>
            item.body.kind === "diagnostic" && item.body.code === "conversation_projection_failed"
        )
    ).toHaveLength(1);
    expect(store.snapshot().events.some((item) => item.body.kind === "terminal")).toBe(true);
    const conversation = JSON.parse(await readFile(join(runDir, "conversation.json"), "utf8")) as {
      items: Array<{ content: string }>;
    };
    expect(conversation.items).toEqual([
      expect.objectContaining({ content: "finished after retry" })
    ]);
    const reopened = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    await reopened.open();
    expect(reopened.snapshot().events).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          kind: "diagnostic",
          code: "conversation_projection_failed"
        })
      })
    );
  });

  it("reconciles a full normalized append that throws after writing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-full-write-throw-"));
    let throwAfterWrite = true;
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      }),
      appendText: async (...args) => {
        await appendFile(...args);
        if (throwAfterWrite) {
          throwAfterWrite = false;
          throw new Error("write completed before transport error");
        }
      }
    });
    await store.open();
    await expect(store.append(event(1).body)).resolves.toBeUndefined();
    expect(store.snapshot().events).toHaveLength(1);
    await expect(store.append(event(2).body)).resolves.toBeUndefined();
    expect(store.snapshot().events.at(-1)?.sequence).toBe(2);
  });

  it("poisons a partial normalized append and forbids unsafe retry", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-partial-write-"));
    let partial = true;
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      }),
      appendText: async (path, data, options) => {
        if (!partial) return appendFile(path, data, options);
        partial = false;
        const text = String(data);
        await appendFile(path, text.slice(0, Math.floor(text.length / 2)), options);
        throw new Error("partial append failure");
      }
    });
    await store.open();
    await expect(store.append(event(1).body)).rejects.toThrow("retry is unsafe");
    await expect(store.append(event(1).body)).rejects.toThrow("retry is unsafe");
    expect(store.snapshot().diagnostics).toContainEqual(
      expect.objectContaining({
        code: "corrupt_line"
      })
    );
  });

  it("hard-rejects an ordinary drop when a legacy hard-full log cannot persist its boundary", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-hard-count-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      Array.from({ length: 6 }, (_, index) => encodeNormalizedRunnerEvent(event(index + 1))).join(
        ""
      ),
      "utf8"
    );
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 6,
      reserveEvents: 3,
      maxBytes: 1_000_000,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();
    await expect(store.append(ordinaryMessage("overflow"))).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ code: "retention_truncation" })
    });
    expect(store.snapshot().events).toHaveLength(6);
    expect(retentionBoundaryCount(store.snapshot().events)).toBe(0);
    const disk = await readFile(store.eventsPath, "utf8");
    expect(disk.trim().split("\n").length).toBe(6);
  });

  it("persists boundary, artifact, and terminal inside the combined reserve", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-artifact-terminal-"));
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 6,
      reserveEvents: 3,
      maxBytes: 1_000_000,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();
    for (let i = 0; i < 3; i += 1) {
      await store.append(ordinaryMessage(`m${i}`));
    }
    await store.append(ordinaryMessage("overflow"));
    await store.append(artifactBody());
    await store.append(terminalBody());
    expect(store.snapshot().events.map((e) => e.body.kind)).toEqual([
      "message",
      "message",
      "message",
      "diagnostic",
      "artifact",
      "terminal"
    ]);
    expect(retentionBoundaryCount(store.snapshot().events)).toBe(1);
  });

  it("persists maximum-schema final evidence with a maximum runner identity", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-max-final-evidence-"));
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: finalEvidenceSlotCount,
      reserveEvents: finalEvidenceSlotCount,
      maxBytes: finalEvidenceReserveBytes,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: maximumRunnerIdentity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();

    await store.append(ordinaryMessage("dropped"));
    await store.append(artifactBody("a".repeat(1_024)));
    await store.append(terminalBody("x".repeat(8_192)));

    expect(store.snapshot().events.map((persistedEvent) => persistedEvent.body.kind)).toEqual([
      "diagnostic",
      "artifact",
      "terminal"
    ]);
    expect((await store.sizes()).eventBytes).toBeLessThanOrEqual(finalEvidenceReserveBytes);
  });

  it("protects terminal count budget from late lifecycle after artifact", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-artifact-terminal-fit-"));
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 6,
      reserveEvents: 3,
      maxBytes: 1_000_000,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();
    for (let i = 0; i < 3; i += 1) {
      await store.append(ordinaryMessage(`m${i}`));
    }
    await store.append(ordinaryMessage("overflow"));
    await store.append(artifactBody());
    await expect(store.append(lifecycleBody("late-control"))).rejects.toBeInstanceOf(
      AcpEventStoreLimitError
    );
    await store.append(terminalBody());
    expect(store.snapshot().events.map((e) => e.body.kind)).toEqual([
      "message",
      "message",
      "message",
      "diagnostic",
      "artifact",
      "terminal"
    ]);
  });

  it("triggers ordinary soft boundary by event count without growing after drop", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-soft-count-"));
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 10,
      reserveEvents: 3,
      maxBytes: 1_000_000,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();
    // ordinary soft = 7
    for (let i = 0; i < 7; i += 1) {
      await store.append(ordinaryMessage(`m${i}`));
    }
    expect(store.snapshot().events).toHaveLength(7);
    await store.append(ordinaryMessage("overflow"));
    const afterBoundary = store.snapshot();
    expect(afterBoundary.events).toHaveLength(8);
    expect(retentionBoundaryCount(afterBoundary.events)).toBe(1);
    const lengthBeforeDrops = afterBoundary.events.length;
    for (let i = 0; i < 3; i += 1) {
      await expect(store.append(ordinaryMessage(`drop-${i}`))).resolves.toBeUndefined();
    }
    expect(store.snapshot().events).toHaveLength(lengthBeforeDrops);
    expect(retentionBoundaryCount(store.snapshot().events)).toBe(1);

    // Non-final control cannot consume the artifact/terminal pair that remains in reserve.
    await expect(store.append(lifecycleBody("after-boundary"))).rejects.toBeInstanceOf(
      AcpEventStoreLimitError
    );
  });

  it("triggers ordinary soft boundary by event bytes independently of count", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-soft-bytes-"));
    const ordinaryByteHeadroom = 1_600;
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 1_000,
      reserveEvents: 3,
      maxBytes: finalEvidenceReserveBytes + ordinaryByteHeadroom,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();
    // One encoded message is a few hundred bytes, so the small headroom is bytes-driven.
    let wrote = 0;
    for (let i = 0; i < 20; i += 1) {
      await store.append(ordinaryMessage(`m${i}`, "y".repeat(40)));
      wrote = store.snapshot().events.filter((e) => e.body.kind === "message").length;
      if (retentionBoundaryCount(store.snapshot().events) === 1) break;
    }
    expect(retentionBoundaryCount(store.snapshot().events)).toBe(1);
    expect(wrote).toBeGreaterThan(0);
    const lengthAtBoundary = store.snapshot().events.length;
    await store.append(ordinaryMessage("after-soft-bytes", "z".repeat(40)));
    expect(store.snapshot().events).toHaveLength(lengthAtBoundary);
  });

  it("writes a single protocol soft boundary and stops growing ordinary protocol", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-protocol-soft-"));
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 100,
      reserveEvents: 3,
      maxBytes: 1_000_000,
      reserveBytes: finalEvidenceReserveBytes,
      protocolReserveBytes: 256
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy,
      maxProtocolBytes: 2_048
    });
    await store.open();
    await store.append(ordinaryMessage("seed"));
    await store.appendProtocol("agent_to_client", { p: "X".repeat(2_000) });
    expect(retentionBoundaryCount(store.snapshot().events)).toBe(1);
    const eventsAfterBoundary = store.snapshot().events.length;
    const protocolSizeAfter = (await store.sizes()).protocolBytes;
    for (let i = 0; i < 3; i += 1) {
      await store.appendProtocol("client_to_agent", { x: i, pad: "y".repeat(100) });
    }
    expect(store.snapshot().events).toHaveLength(eventsAfterBoundary);
    expect(retentionBoundaryCount(store.snapshot().events)).toBe(1);
    expect((await store.sizes()).protocolBytes).toBe(protocolSizeAfter);

    const reopened = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy,
      maxProtocolBytes: 2_048
    });
    await reopened.open();
    await reopened.appendProtocol("client_to_agent", { small: true });
    expect((await reopened.sizes()).protocolBytes).toBe(protocolSizeAfter);
    expect(retentionBoundaryCount(reopened.snapshot().events)).toBe(1);
  });

  it("protects terminal byte budget from a late control after artifact", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-terminal-byte-reserve-"));
    const maxBytes = finalEvidenceReserveBytes + 3_000;
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 100,
      reserveEvents: 3,
      maxBytes,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();
    for (let i = 0; i < 3; i += 1) {
      await store.append(ordinaryMessage(`m${i}`));
    }
    await store.append(ordinaryMessage("overflow"));
    await store.append(artifactBody());
    let lateControlError: unknown;
    for (let index = 0; index < 20; index += 1) {
      try {
        await store.append(lifecycleBody("x".repeat(RUNNER_EVENT_MAX_MESSAGE_BYTES)));
      } catch (error) {
        lateControlError = error;
        break;
      }
    }
    expect(lateControlError).toBeInstanceOf(AcpEventStoreLimitError);
    await store.append(terminalBody());
    expect(store.snapshot().events.at(-1)?.body.kind).toBe("terminal");
    expect((await store.sizes()).eventBytes).toBeLessThanOrEqual(maxBytes);
  });

  it("inherits maxEvents/maxEventBytes into the default policy when policy is not injected", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-options-policy-"));
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      maxEvents: 5,
      maxEventBytes: 1_100_000
    });
    await store.open();
    await store.append(lifecycleBody("L0"));
    await store.append(lifecycleBody("L1"));
    await expect(store.append(lifecycleBody("L2"))).rejects.toBeInstanceOf(AcpEventStoreLimitError);
    expect(store.snapshot().events).toHaveLength(2);
  });

  it("keeps live and reopen retention diagnostics equivalent for store and read model", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-diag-parity-"));
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 10,
      reserveEvents: 3,
      maxBytes: 1_000_000,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await store.open();
    for (let i = 0; i < 9; i += 1) {
      await store.append(ordinaryMessage(`m${i}`));
    }
    const liveDiagnostics = store.diagnosticsSnapshot();
    expect(liveDiagnostics.map((d) => d.code)).toContain("retention_boundary");
    const liveReadModel = new AcpEventReadModel(store).replay();
    expect(liveReadModel.diagnostics.map((d) => d.code)).toContain("retention_boundary");
    expect(liveReadModel.cursor.afterSequence).toBe(store.snapshot().events.at(-1)?.sequence);

    const reopened = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy
    });
    await reopened.open();
    const reopenDiagnostics = reopened.diagnosticsSnapshot();
    expect(reopenDiagnostics.map((d) => d.code)).toEqual(liveDiagnostics.map((d) => d.code));
    const reopenReadModel = new AcpEventReadModel(reopened).replay();
    expect(reopenReadModel.diagnostics.map((d) => d.code)).toEqual(
      liveReadModel.diagnostics.map((d) => d.code)
    );
    expect(reopenReadModel.cursor.afterSequence).toBe(liveReadModel.cursor.afterSequence);
    expect(reopened.snapshot().events.map((e) => e.sequence)).toEqual(
      store.snapshot().events.map((e) => e.sequence)
    );
  });

  it("does not mark boundary committed when durable boundary append fails (ENOSPC)", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-boundary-enospc-"));
    // ordinary soft=1 (maxEvents=4, reserve=3)
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 4,
      reserveEvents: 3,
      maxBytes: 1_000_000,
      reserveBytes: finalEvidenceReserveBytes
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: acpRunner(),
      retentionPolicy: policy,
      appendText: async (path, data, options) => {
        if (String(data).includes("retention_boundary")) {
          const err: NodeJS.ErrnoException = new Error("ENOSPC");
          err.code = "ENOSPC";
          throw err;
        }
        return appendFile(path, data, options);
      }
    });
    await store.open();
    await expect(store.append(ordinaryMessage("m1"))).resolves.toBeUndefined();
    expect(store.snapshot().events.at(-1)?.sequence).toBe(1);
    await expect(store.append(ordinaryMessage("m2"))).rejects.toThrow(/ENOSPC/);
    // Must not enter dropped/observed pseudo-success: next ordinary also fails, disk has no boundary.
    await expect(store.append(ordinaryMessage("m3"))).rejects.toThrow(/ENOSPC/);
    expect(store.snapshot().events).toHaveLength(1);
    expect(store.diagnosticsSnapshot().map((d) => d.code)).not.toContain("retention_boundary");
    const disk = await readFile(store.eventsPath, "utf8");
    expect(disk).not.toContain("retention_boundary");
    expect(disk.trim().split("\n")).toHaveLength(1);
  });

  it("real appendText ENOSPC (I/O) is not swallowed by retention policy and fails closed", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-enospc-"));
    const policy = createDefaultAcpEventRetentionPolicy({
      maxEvents: 10_000,
      maxBytes: 2 * 1024 * 1024
    });
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      retentionPolicy: policy,
      appendText: async () => {
        const err: NodeJS.ErrnoException = new Error("ENOSPC");
        err.code = "ENOSPC";
        throw err;
      },
      runner: acpRunner()
    });
    await store.open();
    await expect(store.append(ordinaryMessage("hi"))).rejects.toThrow(/ENOSPC/);
    await expect(store.append(ordinaryMessage("hi-2"))).rejects.toThrow(/ENOSPC/);
  });

  it("policy unit: projected hard budget and artifact terminal pair are authoritative", () => {
    const policy = new DefaultAcpEventRetentionPolicy({
      maxEvents: 6,
      reserveEvents: 3,
      maxBytes: finalEvidenceReserveBytes,
      reserveBytes: finalEvidenceReserveBytes
    });
    const baseBudget = {
      eventCount: 5,
      byteCount: 100,
      ordinaryEventCount: 4,
      ordinaryByteCount: 80,
      boundaryWritten: false,
      hasArtifact: false,
      hasTerminal: false
    };
    expect(policy.decideEventAdmission(ordinaryMessage("x"), 50, baseBudget).action).toBe(
      "drop_ordinary"
    );
    expect(policy.decideEventAdmission(artifactBody(), 50, baseBudget).action).toBe("hard_reject");
    expect(policy.decideEventAdmission(terminalBody(), 50, baseBudget).action).toBe("persist");
    expect(
      policy.decideBoundaryAdmission(50, {
        eventCount: 6,
        byteCount: 100,
        ordinaryEventCount: 4,
        ordinaryByteCount: 80,
        boundaryWritten: false,
        hasArtifact: false,
        hasTerminal: false
      }).action
    ).toBe("skip");
    expect(
      policy.decideBoundaryAdmission(50, {
        eventCount: 3,
        byteCount: 100,
        ordinaryEventCount: 3,
        ordinaryByteCount: 80,
        boundaryWritten: false,
        hasArtifact: false,
        hasTerminal: false
      }).action
    ).toBe("persist");
  });

  it("fails fast when a small policy cannot reserve boundary, artifact, and terminal", () => {
    expect(
      () =>
        new DefaultAcpEventRetentionPolicy({
          maxEvents: 6,
          reserveEvents: 2,
          maxBytes: finalEvidenceReserveBytes,
          reserveBytes: finalEvidenceReserveBytes
        })
    ).toThrow(/boundary, artifact, and terminal slots/);
    expect(
      () =>
        new DefaultAcpEventRetentionPolicy({
          maxEvents: 6,
          reserveEvents: 3,
          maxBytes: 1_000,
          reserveBytes: 2
        })
    ).toThrow(/boundary, artifact, and terminal bytes/);
    expect(() =>
      createDefaultAcpEventRetentionPolicy({
        maxEvents: 6,
        maxBytes: 1_000
      })
    ).toThrow(/normalized event line contract/);
    expect(() =>
      createDefaultAcpEventRetentionPolicy({
        maxEvents: 3,
        reserveEvents: 3,
        maxBytes: 2_400,
        reserveBytes: 2_400
      })
    ).toThrow(/normalized event line contract/);
    const defaultPolicy = createDefaultAcpEventRetentionPolicy();
    expect(Math.floor(defaultPolicy.reserveBytes / finalEvidenceSlotCount)).toBeGreaterThanOrEqual(
      RUNNER_EVENT_MAX_ENCODED_BYTES
    );
  });

  it.each([
    ["partial", (line: string) => `${line}{\"partial\"`],
    ["corrupt", (line: string) => `${line}not-json\n`],
    [
      "identity drift",
      (line: string) => `${line}${encodeNormalizedRunnerEvent(event(2, "RUN-002"))}`
    ],
    ["sequence gap", (line: string) => `${line}${encodeNormalizedRunnerEvent(event(3))}`]
  ])("fails closed before append when reopening a %s log", async (_name, corrupt) => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-reopen-"));
    const path = join(runDir, "events.ndjson");
    await writeFile(path, corrupt(encodeNormalizedRunnerEvent(event(1))), "utf8");
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    await expect(store.open()).rejects.toBeInstanceOf(AcpEventStoreOpenError);
    await expect(store.append(event(2).body)).rejects.toThrow("must be opened");
    expect(await readFile(path, "utf8")).toBe(corrupt(encodeNormalizedRunnerEvent(event(1))));
  });
});

describe("ACP replay diagnostics", () => {
  it("reports corrupt, partial, oversized, gaps, and duplicates without fallback success", () => {
    const first = encodeNormalizedRunnerEvent(event(1)).trimEnd();
    const third = encodeNormalizedRunnerEvent(event(3)).trimEnd();
    const duplicate = encodeNormalizedRunnerEvent(event(3)).trimEnd();
    const oversized = "x".repeat(256 * 1_024 + 1);
    const replay = replayNormalizedRunnerEvents({
      runId: "RUN-001",
      content: `${first}\nnot-json\n${third}\n${duplicate}\n${oversized}\n{\"partial\"`
    });
    expect(replay.events.map((item) => item.sequence)).toEqual([1, 3]);
    expect(replay.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "corrupt_line",
        "sequence_gap",
        "duplicate_sequence",
        "line_limit_exceeded",
        "partial_line"
      ])
    );
  });
});
