import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_TASK_RESTORE_CAPABILITY,
  ACP_CONVERSATION_CAPABILITY,
  acpConversationEventPageBytes,
  canonicalizeJson,
  type AcpConversationAction,
  type AcpConversationPage
} from "@planweave-ai/agent-host-protocol";
import { ACP_CONVERSATION_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { OperatorControlClient } from "../../../desktop/src/main/operatorControl/OperatorControlClient.js";
import { CollaborationHttpTransport } from "../../../desktop/src/main/collaboration/collaborationHttpTransport.js";
import { CollaborationRemoteOperationsClient } from "../../../desktop/src/main/collaboration/CollaborationRemoteOperationsClient.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import { acpConversationWirePage } from "../acpConversationPagination.js";
import { createAcpConversationFixture } from "./support/acpConversationFixture.js";

const fixtures: Awaited<ReturnType<typeof createAcpConversationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup(options?: Parameters<typeof createAcpConversationFixture>[0]) {
  const f = await createAcpConversationFixture(options);
  fixtures.push(f);
  return f;
}
function runner(content: string) {
  return {
    kind: "runner",
    fragment: {
      kind: "runner_body",
      body: {
        kind: "message",
        role: "assistant",
        messageId: "reply",
        chunk: false,
        content,
        redaction: { classes: [], replaced: 0 }
      }
    }
  };
}
function clients(f: Awaited<ReturnType<typeof setup>>) {
  const pages: AcpConversationPage[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const page =
      init?.method === "POST"
        ? f.service.act(f.operation, "actor", JSON.parse(String(init.body)))
        : f.service.page(
            f.operation,
            "actor",
            Number(url.searchParams.get("afterCursor") ?? 0),
            url.searchParams.get("afterTurnId")
          );
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      ACP_CONVERSATION_RESPONSE_MAX_BYTES
    );
    pages.push(page);
    return new Response(JSON.stringify(page), {
      status: init?.method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" }
    });
  };
  const owner = new OperatorControlClient({
    profile: {
      profileId: "budget",
      displayName: "Budget",
      serverBaseUrl: "http://127.0.0.1/",
      allowInsecureTransport: true
    },
    credential: {
      getOperatorToken: () => "operator_test_abcdefghijklmnopqrstuvwxyz_1234",
      getHumanIdentityToken: () => `pw_hid_${"a".repeat(43)}`
    },
    request
  });
  const transport = new CollaborationHttpTransport({
    serverBaseUrl: "http://127.0.0.1/",
    credential: { getDeviceToken: () => "device-budget" },
    request
  });
  const workspace = new CollaborationRemoteOperationsClient(f.operation.projectId, transport);
  return {
    pages,
    owner: (cursor: number, turnCursor: string | null, action?: AcpConversationAction) =>
      owner.acpConversation(f.operation.id, cursor, "human-budget", action, turnCursor),
    workspace: (cursor: number, turnCursor: string | null, action?: AcpConversationAction) =>
      workspace.acpConversation(f.operation.id, cursor, action, turnCursor),
    dispose() {
      owner.dispose();
      transport.dispose();
    }
  };
}

describe("ACP conversation complete JSON wire budget", () => {
  it.each([
    128, 4000
  ])("rejects a legacy restore before external dispatch when identity/retention growth exceeds %i spare bytes", async (spare) => {
    let restores = 0;
    const f = await setup({
      restoreTask: async () => {
        restores++;
        throw new Error("must_not_restore");
      }
    });
    f.hosts.reportOnline(
      f.host.id,
      ["acp.codex", ACP_CONVERSATION_CAPABILITY, ACP_TASK_RESTORE_CAPABILITY],
      2
    );
    for (let index = 0; index < 10; index++) {
      const turnId = `restore-growth-${index}-${"x".repeat(220)}`;
      f.service.act(f.operation, "actor", { ...f.prompt, turnId });
      f.service.ingest(
        f.host.id,
        f.event(1, { kind: "status", status: "failed", error: "\u0001".repeat(63 * 1024) }, turnId)
      );
    }
    const metadata = f.service.page(f.operation, "actor");
    const used = Buffer.byteLength(
      JSON.stringify(acpConversationWirePage({ ...metadata, events: [] }, 1))
    );
    const room = ACP_CONVERSATION_RESPONSE_MAX_BYTES - used;
    const tail = "restore-growth-tail";
    f.service.act(f.operation, "actor", { ...f.prompt, turnId: tail });
    f.service.ingest(f.host.id, f.event(1, { kind: "status", status: "failed", error: "x" }, tail));
    const extra =
      Buffer.byteLength(
        JSON.stringify(
          acpConversationWirePage({ ...f.service.page(f.operation, "actor"), events: [] }, 1)
        )
      ) -
      used -
      1;
    const bytes = room - extra - spare;
    f.db
      .prepare("UPDATE acp_conversation_turns SET error=? WHERE turn_id=?")
      .run("\u0001".repeat(Math.floor(bytes / 6)) + "x".repeat(bytes % 6), tail);
    f.db.prepare("DELETE FROM acp_conversation_events").run();
    expect(() => f.service.page(f.operation, "actor", 0, null, undefined, 1)).not.toThrow();
    await expect(
      f.service.restore(
        { ...f.operation, state: "cancelled" },
        "actor",
        {
          kind: "restore_task",
          turnId: f.prompt.turnId,
          executionAttemptId: f.prompt.executionAttemptId,
          sessionId: f.prompt.sessionId
        },
        1
      )
    ).rejects.toThrow("acp_conversation_client_upgrade_required");
    expect(restores).toBe(0);
    expect(f.db.prepare("SELECT * FROM acp_task_restorations").all()).toEqual([]);
  });

  it("acknowledges an exact legacy oversized replay without readmission, while rejecting conflicts and new oversized events", async () => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    const legacy = f.event(1, {
      kind: "interaction",
      request: {
        kind: "elicitation",
        requestId: "legacy",
        message: "Retained legacy schema",
        deadline: "2030-01-01T00:01:00.000Z",
        requestedSchema: { description: "x".repeat(ACP_CONVERSATION_RESPONSE_MAX_BYTES) }
      }
    });
    const json = canonicalizeJson(legacy);
    f.db
      .prepare("INSERT INTO acp_conversation_events(turn_id,sequence,event_json) VALUES(?,?,?)")
      .run(legacy.turnId, legacy.sequence, json);
    f.db
      .prepare(
        "UPDATE acp_conversation_turns SET last_sequence=1,event_bytes=?,status='running' WHERE turn_id=?"
      )
      .run(Buffer.byteLength(json), legacy.turnId);
    const before = f.db.prepare("SELECT cursor,event_json FROM acp_conversation_events").all();
    expect(() => f.service.ingest(f.host.id, legacy)).not.toThrow();
    expect(() => f.service.ingest(f.host.id, { ...legacy, messageId: "changed" })).toThrow(
      "acp_conversation_event_conflict"
    );
    expect(() => f.service.ingest(f.host.id, { ...legacy, sequence: 2, messageId: "new" })).toThrow(
      "acp_conversation_event_too_large"
    );
    expect(f.db.prepare("SELECT cursor,event_json FROM acp_conversation_events").all()).toEqual(
      before
    );
    const first = f.service.page(f.operation, "actor");
    expect(first).toMatchObject({
      events: [],
      cursor: 0,
      hasMore: true,
      hasMoreTurns: false,
      turnCursor: legacy.turnId
    });
    expect(() => f.service.page(f.operation, "actor", first.cursor, first.turnCursor)).toThrow(
      "acp_conversation_page_item_too_large"
    );
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("reads real service GET and accepted POST pages through the actual %s client exactly once", async (surface) => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    const expected = Array.from({ length: 80 }, (_, index) =>
      f.event(index + 1, runner("x".repeat(60 * 1024)))
    );
    for (const event of expected) f.service.ingest(f.host.id, event);
    const terminal = f.event(81, { kind: "status", status: "completed", error: null });
    f.service.ingest(f.host.id, terminal);
    expected.push(terminal);
    const c = clients(f);
    try {
      for (const method of ["GET", "POST"] as const) {
        let cursor = 0;
        let turnCursor: string | null = null;
        const received = [];
        let page: AcpConversationPage;
        const action = method === "POST" ? { ...f.prompt, turnId: "turn-next" } : undefined;
        do {
          page = await c[surface](cursor, turnCursor, received.length === 0 ? action : undefined);
          expect(page.cursor > cursor || page.turnCursor !== turnCursor || !page.hasMore).toBe(
            true
          );
          if (page.events.length) expect(page.cursor).toBeGreaterThan(cursor);
          if (action && received.length === 0)
            expect(page.turns.some((turn) => turn.turnId === action.turnId)).toBe(true);
          received.push(...page.events);
          cursor = page.cursor;
          turnCursor = page.turnCursor;
        } while (page.hasMore);
        expect(received).toEqual(expected);
        expect(new Set(received.map((event) => event.messageId)).size).toBe(expected.length);
        expect(page.hasMore).toBe(false);
        const empty = await c[surface](cursor, turnCursor);
        expect(empty).toMatchObject({ cursor, events: [], hasMore: false });
      }
      expect(c.pages.length).toBeGreaterThanOrEqual(6);
      expect(
        f.mailbox
          .listAfter(f.host.id, 0)
          .filter((message) => message.command.type === "acp_conversation.prompt")
      ).toHaveLength(2);
    } finally {
      c.dispose();
    }
  });

  it("pages maximal JSON-escaped metadata with an active POST turn and resumes after compaction without losing identities", async () => {
    const f = await setup();
    const error = "\u0001".repeat(64 * 1024);
    const expectedIds = [];
    for (let index = 0; index < 24; index++) {
      const turnId = `meta-${String(24 - index).padStart(2, "0")}`;
      expectedIds.push(turnId);
      f.service.act(f.operation, "actor", { ...f.prompt, turnId });
      f.service.ingest(f.host.id, f.event(1, { kind: "status", status: "failed", error }, turnId));
    }
    const next = { ...f.prompt, turnId: "meta-active" };
    const accepted = f.service.act(f.operation, "actor", next);
    expect(accepted.turns.find((turn) => turn.turnId === next.turnId)?.status).toBe("queued");
    let cursor = accepted.cursor;
    let turnCursor = accepted.turnCursor;
    const turns = new Map(accepted.turns.map((turn) => [turn.turnId, turn]));
    let page = accepted;
    let count = 1;
    expect(page.hasMoreTurns).toBe(true);
    while (page.hasMore) {
      const previous = turnCursor;
      page = f.service.page(f.operation, "actor", cursor, turnCursor);
      expect(page.cursor > cursor || page.turnCursor !== previous).toBe(true);
      for (const turn of page.turns) turns.set(turn.turnId, turn);
      cursor = page.cursor;
      turnCursor = page.turnCursor;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        ACP_CONVERSATION_RESPONSE_MAX_BYTES
      );
      expect(++count).toBeLessThan(20);
    }
    expect([...turns.keys()].sort()).toEqual([...expectedIds, next.turnId].sort());
    expect(expectedIds.every((id) => turns.get(id)?.error === error)).toBe(true);
    f.db
      .prepare("UPDATE acp_conversation_turns SET compacted_at=? WHERE turn_id=?")
      .run(f.clock().toISOString(), expectedIds[0]);
    const delta = f.service.page(f.operation, "actor", cursor);
    expect(delta.retention?.compactedTurnIds).toEqual([expectedIds[0]]);
    expect(delta.events).toEqual([]);
    expect(() => f.service.page(f.operation, "actor", cursor, "missing-cursor")).toThrow(
      "acp_conversation_turn_cursor_invalid"
    );
    expect(f.service.page(f.operation, "actor", cursor, expectedIds[0]).turnCursor).not.toBeNull();
  });

  it("measures Unicode and JSON escaping at the single-event boundary and rejects atomically without a sequence gap", async () => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    const payload = {
      kind: "interaction",
      request: {
        kind: "elicitation",
        requestId: "large-schema",
        message: '中文🙂\\"',
        deadline: "2030-01-01T00:01:00.000Z",
        requestedSchema: { description: "" }
      }
    };
    const empty = f.event(1, payload);
    const room = ACP_CONVERSATION_RESPONSE_MAX_BYTES - acpConversationEventPageBytes(empty);
    const exact = f.event(1, {
      ...payload,
      request: {
        ...payload.request,
        requestedSchema: { description: "x".repeat(room - 6) + "\u0001" }
      }
    });
    expect(acpConversationEventPageBytes(exact)).toBe(ACP_CONVERSATION_RESPONSE_MAX_BYTES);
    const tooLarge = f.event(1, {
      ...payload,
      request: {
        ...payload.request,
        requestedSchema: { description: "x".repeat(room - 5) + "\u0001" }
      }
    });
    expect(() => f.service.ingest(f.host.id, tooLarge)).toThrow("acp_conversation_event_too_large");
    expect(
      f.db
        .prepare("SELECT last_sequence FROM acp_conversation_turns WHERE turn_id=?")
        .get(f.prompt.turnId)?.last_sequence
    ).toBe(0);
    f.service.ingest(f.host.id, exact);
    f.service.ingest(f.host.id, f.event(2, { kind: "status", status: "completed", error: null }));
    const first = f.service.page(f.operation, "actor");
    const eventPage = first.events.length
      ? first
      : f.service.page(f.operation, "actor", first.cursor, first.turnCursor);
    expect(eventPage.events[0]).toEqual(exact);
    expect(Buffer.byteLength(JSON.stringify(eventPage))).toBeLessThanOrEqual(
      ACP_CONVERSATION_RESPONSE_MAX_BYTES
    );
  });

  it("returns a bounded restore response after durable dispatch even with paginated terminal metadata", async () => {
    const f = await setup({
      restoreTask: async (operation) => ({
        operation: new RemoteOperationRepository(f.db, f.clock).create({
          workspaceId: operation.workspaceId,
          projectId: operation.projectId,
          canvasId: operation.canvasId,
          blockRef: operation.blockRef,
          ownershipGeneration: operation.ownershipGeneration,
          idempotencyKey: "restore-budget",
          sourceFingerprint: operation.sourceFingerprint,
          requiredCapabilities: operation.requiredCapabilities
        })
      })
    });
    f.hosts.reportOnline(
      f.host.id,
      ["acp.codex", ACP_CONVERSATION_CAPABILITY, ACP_TASK_RESTORE_CAPABILITY],
      2
    );
    for (let index = 0; index < 12; index++) {
      const turnId = `restore-${index}`;
      f.service.act(f.operation, "actor", { ...f.prompt, turnId });
      f.service.ingest(
        f.host.id,
        f.event(1, { kind: "status", status: "failed", error: "\u0001".repeat(64 * 1024) }, turnId)
      );
    }
    const stopped = { ...f.operation, state: "cancelled" as const };
    const page = await f.service.restore(stopped, "actor", {
      kind: "restore_task",
      turnId: "restore-request",
      executionAttemptId: f.prompt.executionAttemptId,
      sessionId: f.prompt.sessionId
    });
    expect(page).toMatchObject({
      restoredOperationId: expect.any(String),
      canRestoreTask: false,
      hasMoreTurns: true
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      ACP_CONVERSATION_RESPONSE_MAX_BYTES
    );
    expect(
      f.db
        .prepare(
          "SELECT restored_operation_id FROM acp_task_restorations WHERE source_operation_id=?"
        )
        .get(stopped.id)?.restored_operation_id
    ).toBe(page.restoredOperationId);
  });
});
