import { describe, expect, it } from "vitest";
import {
  CANVAS_COMMAND_MAX_BULK_UPDATES,
  CANVAS_COMMAND_MAX_LAYOUT_NODES,
  CANVAS_COMMAND_MAX_PROMPT_MARKDOWN_CHARS,
  CANVAS_COMMAND_PROTOCOL_VERSION,
  CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW
} from "../limits.js";
import {
  canvasCommandClientMessageSchema,
  canvasCommandIntentSchema,
  canvasCommandOutcomeSchema,
  canvasCommandServerMessageSchema,
  canvasCommandSubmitSchema,
  canvasJournalEntrySchema,
  canvasReconnectRequestSchema,
  canvasReconnectResponseSchema,
  canvasSnapshotContentSchema
} from "../canvasCommands.js";
import { canvasPresenceClientMessageSchema } from "../presence.js";
import {
  exampleCanvasCommandAccepted,
  exampleCanvasCommandDuplicateOperationIdReplay,
  exampleCanvasCommandRejectedAcl,
  exampleCanvasCommandStaleRevisionRejected,
  exampleCanvasCommandSubmit,
  exampleCanvasJournalEntry,
  exampleCanvasMalformedSnapshotInput,
  exampleCanvasReconnectAfterDisconnect,
  exampleCanvasReconnectRequest,
  exampleCanvasReconnectTruncatedJournal
} from "../fixtures/collaboration.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

const baseSubmit = {
  type: "canvas.command.submit" as const,
  protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
  schemaVersion: "canvas-command/v1" as const,
  projectId: "project-1",
  canvasId: "canvas-1",
  operationId: "op-1",
  expectedRevision: 0,
  intent: {
    kind: "add_task" as const,
    taskId: "task-1",
    title: "First task",
    promptMarkdown: "# Task"
  }
};

describe("OSS-004 canvas command contracts", () => {
  it("publishes the exact terminal receipt window", () => {
    expect(CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW).toBe(10_000);
  });

  it("accepts client submit intents without actor, auth, path, or revision override", () => {
    const submit = canvasCommandSubmitSchema.parse(baseSubmit);
    expect(submit.operationId).toBe("op-1");
    expect(submit.expectedRevision).toBe(0);
    expect(submit.intent.kind).toBe("add_task");
    expect(exampleCanvasCommandSubmit.intent.kind).toBe("update_task_prompt");
    expect(canvasCommandClientMessageSchema.parse(exampleCanvasReconnectRequest).type).toBe(
      "canvas.reconnect.request"
    );
  });

  it("requires one durable timestamp for every submitted layout mutation", () => {
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        intent: { kind: "update_layout", nodes: [{ nodeId: "task-1", x: 1, y: 2 }] }
      })
    ).toThrow();
    expect(
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        intent: {
          kind: "update_layout",
          nodes: [{ nodeId: "task-1", x: 1, y: 2 }],
          updatedAt: "2026-08-02T00:00:00.000Z"
        }
      }).intent
    ).toMatchObject({ updatedAt: "2026-08-02T00:00:00.000Z" });
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        intent: {
          ...baseSubmit.intent,
          layout: { nodeId: "task-1", x: 1, y: 2 }
        }
      })
    ).toThrow();
  });

  it("rejects unknown command kinds, unknown fields, and forged client trust fields", () => {
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        intent: { kind: "merge_crdt", payload: {} }
      })
    ).toThrow();
    expect(() => canvasCommandSubmitSchema.parse({ ...baseSubmit, extra: true })).toThrow();
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        actor: { kind: "human", id: "human-1" }
      })
    ).toThrow();
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        authorization: { role: "owner" }
      })
    ).toThrow();
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        projectRoot: "/tmp/plan"
      })
    ).toThrow();
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        revision: 99
      })
    ).toThrow();
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        intent: {
          kind: "update_task_prompt",
          taskId: "task-1",
          promptMarkdown: "# x",
          path: "nodes/T-001/prompt.md"
        }
      })
    ).toThrow();
    expect(() =>
      canvasCommandIntentSchema.parse({
        kind: "add_task_dependency",
        fromTaskId: "task-1",
        toTaskId: "task-1"
      })
    ).toThrow();
  });

  it("enforces bounded prompt, layout, and bulk payload limits", () => {
    expect(() =>
      canvasCommandIntentSchema.parse({
        kind: "update_task_prompt",
        taskId: "task-1",
        promptMarkdown: "x".repeat(CANVAS_COMMAND_MAX_PROMPT_MARKDOWN_CHARS + 1)
      })
    ).toThrow();
    expect(() =>
      canvasCommandIntentSchema.parse({
        kind: "update_layout",
        nodes: Array.from({ length: CANVAS_COMMAND_MAX_LAYOUT_NODES + 1 }, (_, index) => ({
          nodeId: `node-${index}`,
          x: 0,
          y: 0
        }))
      })
    ).toThrow();
    expect(() =>
      canvasCommandIntentSchema.parse({
        kind: "bulk_update_blocks",
        updates: Array.from({ length: CANVAS_COMMAND_MAX_BULK_UPDATES + 1 }, (_, index) => ({
          blockRef: `task-1#block-${index}`,
          fields: { title: `B${index}` }
        }))
      })
    ).toThrow();
    expect(() =>
      canvasCommandIntentSchema.parse({
        kind: "update_layout",
        nodes: [
          { nodeId: "n1", x: Number.NaN, y: 0 },
          { nodeId: "n2", x: 1, y: 2 }
        ]
      })
    ).toThrow();
  });

  it("models accepted outcomes, idempotent duplicate operationId, and stale CAS details", () => {
    expect(exampleCanvasCommandAccepted.idempotentReplay).toBe(false);
    expect(exampleCanvasCommandDuplicateOperationIdReplay.idempotentReplay).toBe(true);
    expect(exampleCanvasCommandDuplicateOperationIdReplay.revision).toBe(
      exampleCanvasCommandAccepted.revision
    );
    expect(exampleCanvasCommandStaleRevisionRejected.code).toBe("stale_revision");
    expect(exampleCanvasCommandStaleRevisionRejected.conflict?.authoritativeRevision).toBe(4);
    expect(exampleCanvasCommandRejectedAcl.code).toBe("forbidden");

    expect(() =>
      canvasCommandOutcomeSchema.parse({
        type: "canvas.command.rejected",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        projectId: "project-1",
        canvasId: "canvas-1",
        operationId: "op-x",
        code: "stale_revision"
      })
    ).toThrow();
    expect(() =>
      canvasCommandOutcomeSchema.parse({
        type: "canvas.command.accepted",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        scope: {
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1"
        },
        operationId: "op-x",
        revision: 5,
        previousRevision: 3,
        contentDigest: digestA,
        journalEntryId: "j-1",
        actor: { kind: "human", id: "h1" },
        acceptedAt: "2030-01-01T00:00:00.000Z",
        idempotentReplay: false
      })
    ).toThrow();
  });

  it("keeps journal entries append-only and ordered by contiguous revisions", () => {
    expect(exampleCanvasJournalEntry.revision).toBe(exampleCanvasJournalEntry.previousRevision + 1);
    expect(() =>
      canvasJournalEntrySchema.parse({
        ...exampleCanvasJournalEntry,
        revision: 10,
        previousRevision: 3
      })
    ).toThrow();
  });

  it("supports reconnect delta after disconnect and full snapshot on truncated journal", () => {
    const delta = canvasReconnectResponseSchema.parse(exampleCanvasReconnectAfterDisconnect);
    expect(delta.type).toBe("canvas.reconnect.delta");
    if (delta.type === "canvas.reconnect.delta") {
      expect(delta.entries).toHaveLength(1);
      expect(delta.headRevision).toBe(4);
    }

    const snapshot = canvasReconnectResponseSchema.parse(exampleCanvasReconnectTruncatedJournal);
    expect(snapshot.type).toBe("canvas.reconnect.snapshot");
    if (snapshot.type === "canvas.reconnect.snapshot") {
      expect(snapshot.reason).toBe("truncated_journal");
      expect(snapshot.snapshot.encoding).toBe("content_version_ref");
      expect(snapshot.snapshot.content.canonicalDigest).toBe(
        snapshot.snapshot.metadata.contentDigest
      );
    }

    expect(() =>
      canvasSnapshotContentSchema.parse(exampleCanvasMalformedSnapshotInput.snapshot)
    ).toThrow();
    expect(() =>
      canvasReconnectResponseSchema.parse(exampleCanvasMalformedSnapshotInput)
    ).toThrow();

    expect(() =>
      canvasReconnectResponseSchema.parse({
        type: "canvas.reconnect.delta",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        scope: {
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1"
        },
        afterRevision: 1,
        headRevision: 3,
        headContentDigest: digestB,
        entries: []
      })
    ).toThrow();
  });

  it("rejects v1 inline snapshots instead of treating them as v2 content references", () => {
    const snapshot = exampleCanvasReconnectTruncatedJournal;
    expect(() =>
      canvasReconnectResponseSchema.parse({
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          metadata: { ...snapshot.snapshot.metadata, schemaVersion: "canvas-snapshot/v1" }
        }
      })
    ).toThrow();
  });

  it("keeps presence messages separate from durable command and journal envelopes", () => {
    const presenceHello = {
      type: "canvas.presence.hello",
      protocolVersion: 1,
      projectId: "project-1",
      canvasId: "canvas-1"
    };
    expect(canvasPresenceClientMessageSchema.parse(presenceHello).type).toBe(
      "canvas.presence.hello"
    );
    expect(() => canvasCommandClientMessageSchema.parse(presenceHello)).toThrow();
    expect(() =>
      canvasPresenceClientMessageSchema.parse({
        ...presenceHello,
        operationId: "op-1",
        expectedRevision: 0
      })
    ).toThrow();
    expect(() =>
      canvasCommandSubmitSchema.parse({
        ...baseSubmit,
        type: "canvas.presence.update"
      })
    ).toThrow();
    expect(() =>
      canvasCommandServerMessageSchema.parse({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-1",
        sessions: []
      })
    ).toThrow();
  });

  it("rejects reconnect requests that try to override server revision or inject actor", () => {
    expect(canvasReconnectRequestSchema.parse(exampleCanvasReconnectRequest).afterRevision).toBe(3);
    expect(() =>
      canvasReconnectRequestSchema.parse({
        ...exampleCanvasReconnectRequest,
        actor: { kind: "human", id: "h1" }
      })
    ).toThrow();
    expect(() =>
      canvasReconnectRequestSchema.parse({
        ...exampleCanvasReconnectRequest,
        headRevision: 99
      })
    ).toThrow();
    expect(() =>
      canvasReconnectRequestSchema.parse({
        ...exampleCanvasReconnectRequest,
        protocolVersion: 2
      })
    ).toThrow();
  });
});
