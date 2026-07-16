import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AcpEventReadModel, AcpEventReadModelRegistry } from "../autoRun/acpEventReadModel.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { runnerEventCursorSchema } from "../autoRun/runnerEventReplay.js";
import { runnerIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { AcpProjectionAccumulator } from "../autoRun/acpConversationProjection.js";
import { event, identity } from "./acpEvents.helpers.js";

describe("ACP production read model", () => {
  async function createReadModel() {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-cursor-"));
    const registry = new AcpEventReadModelRegistry();
    const model = await registry.create({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    return { model, registry, runDir };
  }

  it("gives runtime consumers replay, projection, diagnostics, and live events without ACP parsing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-read-model-"));
    const registry = new AcpEventReadModelRegistry();
    const model = await registry.create({
      runDir,
      identity: identity(),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    await model.store.append({
      kind: "message",
      role: "assistant",
      messageId: "m-1",
      chunk: true,
      content: "replayed",
      redaction: { classes: [], replaced: 0 }
    });
    const replay = model.replay();
    expect(replay).toMatchObject({
      events: [expect.objectContaining({ sequence: 1 })],
      conversation: [expect.objectContaining({ content: "replayed" })],
      diagnostics: []
    });
    expect(model.replay(replay.cursor).events).toEqual([]);
    const live: number[] = [];
    const subscription = model.subscribe(1, (item) => {
      live.push(item.sequence);
    });
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
    if (!cursor.canonicalIdentity)
      throw new Error("Expected the store canonical identity on an empty replay.");
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
    const terminal = runnerEventCursorSchema.parse({
      ...initial,
      afterSequence: 7,
      terminal: true
    });
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
        version: "planweave.runner/v1",
        state: "succeeded",
        exitCode: 0,
        finishedAt: "2026-07-11T00:00:01.000Z",
        diagnostic: null,
        artifactValidated: true
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
    expect([
      first.cursor.afterSequence,
      second.cursor.afterSequence,
      third.cursor.afterSequence
    ]).toEqual([1, 2, 2]);
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
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
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
    const subscription = model.subscribe(
      0,
      () => {
        cursor = model.replay(cursor).cursor;
      },
      { keepOpenAfterTerminal: true }
    );

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
