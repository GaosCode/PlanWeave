import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeAcpSessionNotification } from "../autoRun/acpEventNormalization.js";
import { AcpEventPublisher } from "../autoRun/acpEventPublisher.js";
import { AcpEventStore, AcpEventStoreLimitError, AcpEventStoreOpenError } from "../autoRun/acpEventStore.js";
import { AcpEventReadModel, AcpEventReadModelRegistry } from "../autoRun/acpEventReadModel.js";
import { encodeNormalizedRunnerEvent, normalizedRunnerEventSchema, type NormalizedRunnerEvent } from "../autoRun/normalizedEventContract.js";
import { replayNormalizedRunnerEvents, runnerEventCursorSchema } from "../autoRun/runnerEventReplay.js";
import { runnerIdentitySchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { AcpProjectionAccumulator, projectAcpConversation } from "../autoRun/acpConversationProjection.js";
import { writeAcpConversationProjection } from "../autoRun/acpConversationPersistence.js";

function identity(runId = "RUN-001") {
  return runnerRunIdentitySchema.parse({
    projectId: "project-1", canvasId: "default", taskId: "T-004", blockId: "B-001",
    claimRef: "T-004#B-001", runId, runOwner: "executor", runSessionId: null,
    desktopRunId: null, executorRunId: runId
  });
}

function event(sequence: number, runId = "RUN-001"): NormalizedRunnerEvent {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1", sequence, timestamp: "2026-07-11T00:00:00.000Z",
    identity: identity(runId), runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body: { kind: "lifecycle", state: "running", message: `event ${sequence}` }
  });
}

function projectionEvent(sequence: number, body: NormalizedRunnerEvent["body"]): NormalizedRunnerEvent {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1", sequence,
    timestamp: `2026-07-11T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    identity: identity(),
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body
  });
}

describe("ACP event normalization", () => {
  it("preserves message, tool, plan, and usage semantics while redacting", () => {
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "agent_message_chunk", messageId: "message-1",
      content: { type: "text", text: "Authorization: Bearer abc.def.ghi" }
    } })).toMatchObject({ kind: "message", role: "assistant", messageId: "message-1", content: "[REDACTED:CREDENTIAL]" });
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read", status: "in_progress",
      rawInput: { path: "README.md" }, rawOutput: "initial"
    } })).toMatchObject({
      kind: "tool_call", callId: "tool-1", title: "Read", toolKind: "read", status: "in_progress",
      rawInput: { content: "{\"path\":\"README.md\"}" }, rawOutput: { content: "initial" }
    });
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "user_message_chunk", messageId: "message-2",
      content: { type: "text", text: "hello" }
    } })).toMatchObject({ kind: "message", role: "user", messageId: "message-2" });
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read complete", kind: "read",
      status: "completed", content: null, rawOutput: { bytes: 42 }
    } })).toMatchObject({
      kind: "tool_update", callId: "tool-1", title: "Read complete", toolKind: "read",
      status: "completed", content: null, rawOutput: { content: "{\"bytes\":42}" }
    });
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "plan", entries: [
        { content: "finish", priority: "high", status: "in_progress" }
      ]
    } })).toMatchObject({ kind: "plan_update" });
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "plan_update",
      plan: { type: "markdown", planId: "plan-1", content: "# Plan" }
    } })).toMatchObject({ kind: "plan_update" });
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "plan_removed", planId: "private-plan-id"
    } })).toMatchObject({ kind: "plan_update", content: "Plan removed." });
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "usage_update", used: 10, size: 100
    } })).toMatchObject({ kind: "usage_update", usedTokens: 10, contextWindowTokens: 100 });
  });

  it("ignores known provider-only status and thought updates without exposing them", () => {
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "session_info_update",
      _meta: { codex: { threadStatus: { type: "active", activeFlags: [] } } }
    } })).toBeNull();
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "agent_thought_chunk", messageId: "thought-1",
      content: { type: "text", text: "private reasoning" }
    } })).toBeNull();
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "agent_thought_chunk", messageId: "x".repeat(1_024),
      content: { type: "image", data: "private-image", mimeType: "image/png" }
    } })).toBeNull();
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "available_commands_update", availableCommands: []
    } })).toBeNull();
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "current_mode_update", currentModeId: "code"
    } })).toBeNull();
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "config_option_update", configOptions: []
    } })).toBeNull();
    expect(normalizeAcpSessionNotification({ sessionId: "session-1", update: {
      sessionUpdate: "provider_future_update"
    } })).toMatchObject({ kind: "diagnostic", code: "corrupt_line" });
  });
});

describe("ACP event store and projection", () => {
  it("coalesces same-message chunks across non-projected events", () => {
    const redaction = { classes: [], replaced: 0 } as const;
    const conversation = projectAcpConversation([
      projectionEvent(1, { kind: "message", role: "assistant", messageId: "message-1", chunk: true, content: "你", redaction }),
      projectionEvent(2, { kind: "usage_update", usedTokens: 1, contextWindowTokens: 100, cost: null }),
      projectionEvent(3, { kind: "lifecycle", state: "running", message: "still running" }),
      projectionEvent(4, { kind: "diagnostic", code: "protocol_error", message: "non-conversation detail" }),
      projectionEvent(5, { kind: "message", role: "assistant", messageId: "message-1", chunk: true, content: "好", redaction })
    ]);

    expect(conversation).toEqual([
      expect.objectContaining({ sequence: 1, kind: "message", content: "你好" })
    ]);
  });

  it("preserves tool boundaries and does not merge different message ids", () => {
    const redaction = { classes: [], replaced: 0 } as const;
    const conversation = projectAcpConversation([
      projectionEvent(1, { kind: "message", role: "assistant", messageId: "message-1", chunk: true, content: "before", redaction }),
      projectionEvent(2, { kind: "tool_call", callId: "tool-1", status: "in_progress", title: "Read", content: null }),
      projectionEvent(3, { kind: "tool_update", callId: "tool-1", status: "completed", content: null }),
      projectionEvent(4, { kind: "message", role: "assistant", messageId: "message-1", chunk: true, content: "after", redaction }),
      projectionEvent(5, { kind: "message", role: "assistant", messageId: "message-2", chunk: true, content: "next", redaction })
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
      projectionEvent(1, { kind: "message", role: "assistant", messageId: null, chunk: true, content: "a", redaction }),
      projectionEvent(2, { kind: "usage_update", usedTokens: 1, contextWindowTokens: 100, cost: null }),
      projectionEvent(3, { kind: "message", role: "assistant", messageId: null, chunk: true, content: "b", redaction }),
      projectionEvent(4, { kind: "message", role: "assistant", messageId: "known", chunk: true, content: "c", redaction }),
      projectionEvent(5, { kind: "message", role: "user", messageId: null, chunk: true, content: "d", redaction })
    ]);

    expect(conversation.map((item) => item.content)).toEqual(["ab", "c", "d"]);
  });

  it("separates redacted protocol and normalized logs and rebuilds conversation", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-events-"));
    const store = new AcpEventStore({
      runDir, identity: identity(),
      runner: runnerIdentitySchema.parse({ version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" })
    });
    expect(await store.open()).toEqual([]);
    await store.appendProtocol("agent_to_client", { token: "raw-secret-value" });
    await store.append({ kind: "message", role: "assistant", messageId: "message-1", chunk: true, content: "hello", redaction: { classes: [], replaced: 0 } }, { sessionId: "session-1" });
    await store.drain();
    const protocol = await readFile(join(runDir, "protocol.ndjson"), "utf8");
    const normalized = await readFile(join(runDir, "events.ndjson"), "utf8");
    const conversation = JSON.parse(await readFile(join(runDir, "conversation.json"), "utf8")) as { items: Array<{ content: string }> };
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
        version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex"
      })
    });
    await store.open();
    await store.append({
      kind: "message", role: "assistant", messageId: "message-1", chunk: true,
      content: "finished", redaction: { classes: [], replaced: 0 }
    });
    await store.append({
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1", state: "succeeded", exitCode: 0,
        finishedAt: "2026-07-11T00:00:01.000Z", diagnostic: null, artifactValidated: true
      }
    });

    const conversation = JSON.parse(
      await readFile(join(runDir, "conversation.json"), "utf8")
    ) as { items: Array<{ content: string }> };
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
      kind: "message", role: "assistant", messageId: "message-1", chunk: true,
      content: "finished after retry", redaction: { classes: [], replaced: 0 }
    });
    await expect(store.append({
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1", state: "succeeded", exitCode: 0,
        finishedAt: "2026-07-11T00:00:01.000Z", diagnostic: null, artifactValidated: true
      }
    })).resolves.toMatchObject({ sequence: 2 });
    expect(projectionAttempts).toBe(1);
    await expect(store.drain()).resolves.toBeUndefined();
    expect(projectionAttempts).toBe(2);
    expect(await readFile(store.eventsPath, "utf8")).toContain('"sequence":1');
    expect(store.snapshot().diagnostics).toContainEqual(expect.objectContaining({
      code: "conversation_projection_failed",
      message: expect.not.stringContaining("scripted projection failure")
    }));
    expect(new AcpEventReadModel(store).replay().diagnostics).toContainEqual(
      expect.objectContaining({ code: "conversation_projection_failed" })
    );
    expect(projectedSequences).toEqual([[1, 2], [1, 2, 3]]);
    expect(store.snapshot().events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(store.snapshot().events.filter((item) =>
      item.body.kind === "diagnostic" && item.body.code === "conversation_projection_failed"
    )).toHaveLength(1);
    expect(store.snapshot().events.some((item) => item.body.kind === "terminal")).toBe(true);
    const conversation = JSON.parse(
      await readFile(join(runDir, "conversation.json"), "utf8")
    ) as { items: Array<{ content: string }> };
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
    expect(reopened.snapshot().events).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({
        kind: "diagnostic",
        code: "conversation_projection_failed"
      })
    }));
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
    await expect(store.append(event(1).body)).resolves.toMatchObject({ sequence: 1 });
    expect(store.snapshot().events).toHaveLength(1);
    await expect(store.append(event(2).body)).resolves.toMatchObject({ sequence: 2 });
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
    expect(store.snapshot().diagnostics).toContainEqual(expect.objectContaining({
      code: "corrupt_line"
    }));
  });

  it("fails closed with structured retention diagnostics for raw and normalized limits", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-limits-"));
    const store = new AcpEventStore({
      runDir, identity: identity(), maxProtocolBytes: 8, maxEventBytes: 8,
      runner: runnerIdentitySchema.parse({ version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" })
    });
    await store.open();
    await expect(store.appendProtocol("agent_to_client", { value: "too large" })).rejects.toMatchObject({
      diagnostic: { code: "retention_truncation" }
    });
    await expect(store.append(event(1).body)).rejects.toBeInstanceOf(AcpEventStoreLimitError);
  });

  it.each([
    ["partial", (line: string) => `${line}{\"partial\"`],
    ["corrupt", (line: string) => `${line}not-json\n`],
    ["identity drift", (line: string) => `${line}${encodeNormalizedRunnerEvent(event(2, "RUN-002"))}`],
    ["sequence gap", (line: string) => `${line}${encodeNormalizedRunnerEvent(event(3))}`]
  ])("fails closed before append when reopening a %s log", async (_name, corrupt) => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-reopen-"));
    const path = join(runDir, "events.ndjson");
    await writeFile(path, corrupt(encodeNormalizedRunnerEvent(event(1))), "utf8");
    const store = new AcpEventStore({
      runDir, identity: identity(),
      runner: runnerIdentitySchema.parse({ version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" })
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
    expect(replay.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "corrupt_line", "sequence_gap", "duplicate_sequence", "line_limit_exceeded", "partial_line"
    ]));
  });
});

describe("ACP event publisher", () => {
  it("atomically replays then delivers live events once and tears down at terminal", async () => {
    const publisher = new AcpEventPublisher();
    publisher.seed([event(1)]);
    const received: number[] = [];
    const subscription = publisher.subscribe(0, async (item) => { received.push(item.sequence); });
    publisher.publish(event(1));
    publisher.publish(event(2));
    publisher.publish(normalizedRunnerEventSchema.parse({ ...event(3), body: { kind: "terminal", outcome: {
      version: "planweave.runner/v1", state: "succeeded", exitCode: 0,
      finishedAt: "2026-07-11T00:00:01.000Z", diagnostic: null, artifactValidated: true
    } } }));
    await subscription.closed;
    expect(received).toEqual([1, 2, 3]);
    expect(publisher.subscriberCount).toBe(0);
  });

  it("isolates concurrent runs and unsubscribes bounded slow subscribers", async () => {
    const diagnostics: string[] = [];
    const first = new AcpEventPublisher(1, (code) => diagnostics.push(code));
    const second = new AcpEventPublisher();
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const subscription = first.subscribe(0, () => blocked);
    const other: string[] = [];
    second.subscribe(0, (item) => { other.push(item.identity.runId); });
    first.publish(event(1));
    first.publish(event(2));
    second.publish(event(1, "RUN-002"));
    release();
    await subscription.closed;
    expect(first.subscriberCount).toBe(0);
    expect(other).toEqual(["RUN-002"]);
    expect(diagnostics).toEqual(["subscriber_backpressure"]);
  });

  it("supports explicit unsubscribe", async () => {
    const publisher = new AcpEventPublisher();
    const subscription = publisher.subscribe(0, () => undefined);
    subscription.unsubscribe();
    await subscription.closed;
    expect(publisher.subscriberCount).toBe(0);
  });

  it("replays a seeded terminal and closes without retaining the subscriber", async () => {
    const terminal = normalizedRunnerEventSchema.parse({ ...event(2), body: { kind: "terminal", outcome: {
      version: "planweave.runner/v1", state: "succeeded", exitCode: 0,
      finishedAt: "2026-07-11T00:00:01.000Z", diagnostic: null, artifactValidated: true
    } } });
    const publisher = new AcpEventPublisher();
    publisher.seed([event(1), terminal]);
    const received: number[] = [];
    const subscription = publisher.subscribe(0, (item) => { received.push(item.sequence); });
    await subscription.closed;
    expect(received).toEqual([1, 2]);
    expect(publisher.subscriberCount).toBe(0);
  });

  it("keeps an explicit conversation subscriber open after executor terminal", async () => {
    const terminal = normalizedRunnerEventSchema.parse({ ...event(2), body: { kind: "terminal", outcome: {
      version: "planweave.runner/v1", state: "succeeded", exitCode: 0,
      finishedAt: "2026-07-11T00:00:01.000Z", diagnostic: null, artifactValidated: true
    } } });
    const publisher = new AcpEventPublisher();
    publisher.seed([event(1), terminal]);
    const received: number[] = [];
    const subscription = publisher.subscribe(2, (item) => { received.push(item.sequence); }, {
      keepOpenAfterTerminal: true
    });

    publisher.publish(event(3));
    await Promise.resolve();
    subscription.unsubscribe();
    await subscription.closed;

    expect(received).toEqual([3]);
    expect(publisher.subscriberCount).toBe(0);
  });

  it("captures subscriber rejection, closes it, and avoids an unhandled chain", async () => {
    const diagnostics: string[] = [];
    const publisher = new AcpEventPublisher(10, (code) => { diagnostics.push(code); });
    const subscription = publisher.subscribe(0, async () => { throw new Error("consumer failed"); });
    publisher.publish(event(1));
    await subscription.closed;
    await publisher.drainDiagnostics();
    expect(diagnostics).toEqual(["subscriber_callback_failed"]);
    expect(publisher.subscriberCount).toBe(0);
  });

  it("isolates a diagnostic sink failure and reports later subscriber failures", async () => {
    let attempts = 0;
    const publisher = new AcpEventPublisher(10, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("diagnostic sink unavailable");
    });
    const first = publisher.subscribe(0, async () => {
      throw new Error("first subscriber failed");
    });
    publisher.publish(event(1));
    await first.closed;
    await publisher.drainDiagnostics();

    const second = publisher.subscribe(1, async () => {
      throw new Error("second subscriber failed");
    });
    publisher.publish(event(2));
    await second.closed;
    await publisher.drainDiagnostics();

    expect(attempts).toBe(2);
    expect(publisher.diagnostics).toContainEqual(expect.objectContaining({
      code: "diagnostic_sink_failed"
    }));
  });

  it("keeps healthy subscribers and later events flowing after one subscriber fails", async () => {
    const publisher = new AcpEventPublisher();
    const failed = publisher.subscribe(0, async () => {
      throw new Error("subscriber-local failure");
    });
    const received: number[] = [];
    const healthy = publisher.subscribe(0, (item) => {
      received.push(item.sequence);
    });
    publisher.publish(event(1));
    await failed.closed;
    publisher.publish(event(2));
    healthy.unsubscribe();
    await healthy.closed;
    await publisher.drainDiagnostics();
    expect(received).toEqual([1, 2]);
    expect(publisher.diagnostics).toContainEqual(expect.objectContaining({
      code: "subscriber_callback_failed"
    }));
  });

  it("persists backpressure diagnostics through the store sink", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-backpressure-"));
    const publisher = new AcpEventPublisher(1);
    const store = new AcpEventStore({
      runDir, identity: identity(), publisher,
      runner: runnerIdentitySchema.parse({ version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" })
    });
    await store.open();
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const subscription = publisher.subscribe(0, () => blocked);
    await store.append(event(1).body);
    await store.append(event(2).body);
    release();
    await subscription.closed;
    await store.drain();
    expect(await readFile(store.eventsPath, "utf8")).toContain("subscriber_backpressure");
  });

  it("keeps the run healthy when one subscriber diagnostic cannot be persisted", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-diagnostic-sink-failure-"));
    let failDiagnostic = true;
    const publisher = new AcpEventPublisher();
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      publisher,
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      }),
      appendText: async (path, data, options) => {
        if (failDiagnostic && String(data).includes("subscriber_callback_failed")) {
          failDiagnostic = false;
          throw new Error("diagnostic append unavailable");
        }
        await appendFile(path, data, options);
      }
    });
    await store.open();
    const failed = publisher.subscribe(0, async () => {
      throw new Error("subscriber-local failure");
    });
    await store.append(event(1).body);
    await failed.closed;
    await expect(store.drain()).resolves.toBeUndefined();
    expect(store.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "subscriber_callback_failed" }),
      expect.objectContaining({ code: "publisher_failed" })
    ]));

    const laterFailure = publisher.subscribe(1, async () => {
      throw new Error("later subscriber-local failure");
    });
    await store.append(event(2).body);
    await laterFailure.closed;
    await expect(store.drain()).resolves.toBeUndefined();
    expect(await readFile(store.eventsPath, "utf8")).toContain("subscriber_callback_failed");
  });
});

describe("ACP production read model", () => {
  async function createReadModel() {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-cursor-"));
    const registry = new AcpEventReadModelRegistry();
    const model = await registry.create({
      runDir, identity: identity(),
      runner: runnerIdentitySchema.parse({ version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" })
    });
    return { model, registry, runDir };
  }

  it("gives runtime consumers replay, projection, diagnostics, and live events without ACP parsing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-read-model-"));
    const registry = new AcpEventReadModelRegistry();
    const model = await registry.create({
      runDir, identity: identity(),
      runner: runnerIdentitySchema.parse({ version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" })
    });
    await model.store.append({ kind: "message", role: "assistant", messageId: "m-1", chunk: true, content: "replayed", redaction: { classes: [], replaced: 0 } });
    const replay = model.replay();
    expect(replay).toMatchObject({
      events: [expect.objectContaining({ sequence: 1 })],
      conversation: [expect.objectContaining({ content: "replayed" })],
      diagnostics: []
    });
    expect(model.replay(replay.cursor).events).toEqual([]);
    const live: number[] = [];
    const subscription = model.subscribe(1, (item) => { live.push(item.sequence); });
    await model.store.append(event(2).body);
    subscription.unsubscribe();
    await subscription.closed;
    expect(live).toEqual([2]);
    expect(registry.get(runDir)).toBe(model);
  });

  it("rejects a cursor with foreign canonical identity", async () => {
    const { model } = await createReadModel();
    await model.store.append(event(1).body);
    const cursor = model.replay().cursor;
    if (!cursor.canonicalIdentity) throw new Error("Expected a canonical cursor identity.");
    const foreign = runnerEventCursorSchema.parse({
      ...cursor,
      canonicalIdentity: {
        ...cursor.canonicalIdentity,
        identity: { ...cursor.canonicalIdentity.identity, projectId: "foreign-project" }
      }
    });
    expect(() => model.replay(foreign)).toThrow("canonical identity does not match");
  });

  it("rejects a foreign canonical cursor before the first event", async () => {
    const { model } = await createReadModel();
    const cursor = model.replay().cursor;
    if (!cursor.canonicalIdentity) throw new Error("Expected the store canonical identity on an empty replay.");
    const foreign = runnerEventCursorSchema.parse({
      ...cursor,
      canonicalIdentity: {
        ...cursor.canonicalIdentity,
        runner: { ...cursor.canonicalIdentity.runner, agentId: "claude-code" }
      }
    });
    expect(() => model.replay(foreign)).toThrow("canonical identity does not match");
  });

  it("keeps an empty-store matching future cursor stable", async () => {
    const { model } = await createReadModel();
    const initial = model.replay();
    expect(initial.events).toEqual([]);
    expect(initial.cursor).toMatchObject({ afterSequence: 0, terminal: false });
    expect(initial.cursor.canonicalIdentity).toEqual(model.store.canonicalIdentity());
    const future = runnerEventCursorSchema.parse({ ...initial.cursor, afterSequence: 999 });
    const replay = model.replay(future);
    expect(replay.events).toEqual([]);
    expect(replay.cursor).toEqual(future);
  });

  it("keeps an empty-store matching terminal cursor stable", async () => {
    const { model } = await createReadModel();
    const initial = model.replay().cursor;
    const terminal = runnerEventCursorSchema.parse({ ...initial, afterSequence: 7, terminal: true });
    const first = model.replay(terminal);
    const second = model.replay(first.cursor);
    expect(first.events).toEqual([]);
    expect(first.cursor).toEqual(terminal);
    expect(second.events).toEqual([]);
    expect(second.cursor).toEqual(terminal);
  });

  it("preserves a future cursor high-water mark", async () => {
    const { model } = await createReadModel();
    await model.store.append(event(1).body);
    const current = model.replay().cursor;
    const future = { ...current, afterSequence: 999 };
    const replay = model.replay(future);
    expect(replay.events).toEqual([]);
    expect(replay.cursor.afterSequence).toBe(999);
  });

  it("keeps terminal cursors stable and monotonic", async () => {
    const { model } = await createReadModel();
    await model.store.append(event(1).body);
    await model.store.append({
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1", state: "succeeded", exitCode: 0,
        finishedAt: "2026-07-11T00:00:01.000Z", diagnostic: null, artifactValidated: true
      }
    });
    const terminal = model.replay();
    expect(terminal.cursor).toMatchObject({ afterSequence: 2, terminal: true });
    const next = model.replay(terminal.cursor);
    expect(next.events).toEqual([]);
    expect(next.cursor).toEqual(terminal.cursor);
    const future = model.replay({ ...terminal.cursor, afterSequence: 999 });
    expect(future.cursor).toMatchObject({ afterSequence: 999, terminal: true });
  });

  it("delivers continuous cursor replays monotonically without duplicates", async () => {
    const { model } = await createReadModel();
    await model.store.append(event(1).body);
    const first = model.replay();
    await model.store.append(event(2).body);
    const second = model.replay(first.cursor);
    const third = model.replay(second.cursor);
    expect(first.events.map((item) => item.sequence)).toEqual([1]);
    expect(second.events.map((item) => item.sequence)).toEqual([2]);
    expect(third.events).toEqual([]);
    expect([first.cursor.afterSequence, second.cursor.afterSequence, third.cursor.afterSequence]).toEqual([1, 2, 2]);
  });
});

describe("ACP incremental read projection", () => {
  it("processes live events linearly without reparsing the normalized log", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-linear-read-"));
    const projectionSizes: number[] = [];
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex"
      }),
      writeConversationProjection: async (_runDir, events) => {
        projectionSizes.push(events.length);
      }
    });
    await store.open();
    const model = new AcpEventReadModel(store);
    const parseSpy = vi.spyOn(store, "normalizedContent");
    const appendSpy = vi.spyOn(AcpProjectionAccumulator.prototype, "append");
    let cursor = runnerEventCursorSchema.parse({
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: 0,
      canonicalIdentity: null,
      terminal: false
    });
    const subscription = model.subscribe(0, () => {
      cursor = model.replay(cursor).cursor;
    }, { keepOpenAfterTerminal: true });

    for (let sequence = 1; sequence <= 200; sequence += 1) {
      await store.append(event(sequence).body, { sessionId: "session-1" });
    }
    await vi.waitFor(() => expect(cursor.afterSequence).toBe(200));
    subscription.unsubscribe();
    await subscription.closed;
    expect(projectionSizes).toEqual([]);
    await store.drain();

    expect(parseSpy).not.toHaveBeenCalled();
    expect(appendSpy.mock.calls.length).toBeLessThanOrEqual(400);
    expect(projectionSizes).toEqual([200]);
  });
});
