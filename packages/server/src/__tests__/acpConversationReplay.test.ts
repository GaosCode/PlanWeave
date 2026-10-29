import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { acpConversationPageSchema } from "@planweave-ai/agent-host-protocol";
import { inWriteTransaction } from "../sqlite.js";
import { createAcpConversationFixture } from "./support/acpConversationFixture.js";

const fixtures: Awaited<ReturnType<typeof createAcpConversationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function setup() {
  let now = new Date("2030-01-01T00:00:00.000Z");
  const f = await createAcpConversationFixture({ clock: () => now });
  fixtures.push(f);
  return {
    ...f,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    }
  };
}

function storeCompactedFixture(f: Awaited<ReturnType<typeof setup>>) {
  const hash = (json: unknown) => createHash("sha256").update(String(json)).digest("hex");
  inWriteTransaction(f.db, () => {
    const turn = f.db
      .prepare("SELECT * FROM acp_conversation_turns WHERE turn_id=?")
      .get(f.prompt.turnId)!;
    const events = f.db
      .prepare("SELECT * FROM acp_conversation_events WHERE turn_id=? ORDER BY sequence")
      .all(f.prompt.turnId);
    f.db
      .prepare(`INSERT INTO acp_conversation_replay_receipts(turn_id,request_digest,final_sequence,last_cursor)
      VALUES(?,?,?,?)`)
      .run(
        f.prompt.turnId,
        hash(turn.request_json),
        turn.last_sequence,
        events.at(-1)?.cursor ?? 0
      );
    for (const event of events) {
      f.db
        .prepare("INSERT INTO acp_conversation_event_digests VALUES(?,?,?)")
        .run(f.prompt.turnId, event.sequence, hash(event.event_json));
    }
    for (const action of f.db
      .prepare("SELECT * FROM acp_conversation_actions WHERE turn_id=?")
      .all(f.prompt.turnId)) {
      f.db
        .prepare("INSERT INTO acp_conversation_action_digests VALUES(?,?,?)")
        .run(action.action_key, f.prompt.turnId, hash(action.request_json));
    }
    f.db.prepare("DELETE FROM acp_conversation_events WHERE turn_id=?").run(f.prompt.turnId);
    f.db.prepare("DELETE FROM acp_conversation_actions WHERE turn_id=?").run(f.prompt.turnId);
    f.db
      .prepare(
        "UPDATE acp_conversation_turns SET request_json='null',compacted_at=? WHERE turn_id=?"
      )
      .run(f.clock().toISOString(), f.prompt.turnId);
  });
}

describe("ACP conversation retained replay contract", () => {
  it.each([
    "completed",
    "failed",
    "cancelled"
  ] as const)("records its own %s terminal time once, independently of host event timestamps and polls", async (status) => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    f.advance(45_000);
    const terminal = {
      ...f.event(1, { kind: "status", status, error: null }),
      timestamp: "2000-01-01T00:00:00.000Z"
    };
    f.service.ingest(f.host.id, terminal);
    const expected = f.clock().toISOString();
    expect(
      f.db
        .prepare("SELECT terminal_at FROM acp_conversation_turns WHERE turn_id=?")
        .get(f.prompt.turnId)?.terminal_at
    ).toBe(expected);
    f.advance(86_400_000);
    f.service.page(f.operation, "actor");
    f.service.ingest(f.host.id, terminal);
    expect(
      f.db
        .prepare("SELECT terminal_at FROM acp_conversation_turns WHERE turn_id=?")
        .get(f.prompt.turnId)?.terminal_at
    ).toBe(expected);
  });

  it("persists an expired turn's terminal time on late ingest even without a page poll", async () => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    f.advance(16 * 60_000);
    f.service.ingest(f.host.id, f.event(1, { kind: "status", status: "running", error: null }));
    expect(
      f.db
        .prepare("SELECT status,error,terminal_at FROM acp_conversation_turns WHERE turn_id=?")
        .get(f.prompt.turnId)
    ).toMatchObject({
      status: "failed",
      error: "acp_conversation_deadline_exceeded",
      terminal_at: f.clock().toISOString()
    });
    const ended = f.clock().toISOString();
    f.advance(86_400_000);
    f.service.page(f.operation, "actor");
    expect(
      f.db
        .prepare("SELECT terminal_at FROM acp_conversation_turns WHERE turn_id=?")
        .get(f.prompt.turnId)?.terminal_at
    ).toBe(ended);
  });

  it("replays compacted prompt, respond, cancel, and event identities without resending, while preserving conflicts and the terminal sequence", async () => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    const running = f.event(1, { kind: "status", status: "running", error: null });
    f.service.ingest(f.host.id, running);
    f.service.ingest(
      f.host.id,
      f.event(2, {
        kind: "interaction",
        request: {
          kind: "permission",
          requestId: "permission-one",
          summary: "Read file",
          deadline: "2030-01-01T00:01:00.000Z",
          options: [{ optionId: "allow", label: "Allow", decision: "approve" }]
        }
      })
    );
    const respond = {
      kind: "respond" as const,
      turnId: f.prompt.turnId,
      executionAttemptId: f.prompt.executionAttemptId,
      sessionId: f.prompt.sessionId,
      requestId: "permission-one",
      decision: { kind: "permission" as const, optionId: "allow" }
    };
    const cancel = {
      kind: "cancel" as const,
      turnId: f.prompt.turnId,
      executionAttemptId: f.prompt.executionAttemptId,
      sessionId: f.prompt.sessionId
    };
    f.service.act(f.operation, "actor", respond);
    f.service.act(f.operation, "actor", cancel);
    const terminal = f.event(3, { kind: "status", status: "completed", error: null });
    f.service.ingest(f.host.id, terminal);
    const mailboxCount = f.mailbox.listAfter(f.host.id, 0).length;
    storeCompactedFixture(f);
    expect(() =>
      f.service.act(f.operation, "actor", {
        text: f.prompt.text,
        kind: f.prompt.kind,
        sessionId: f.prompt.sessionId,
        executionAttemptId: f.prompt.executionAttemptId,
        turnId: f.prompt.turnId
      })
    ).not.toThrow();
    expect(() => f.service.act(f.operation, "actor", { ...f.prompt, text: "changed" })).toThrow(
      "request_conflict"
    );
    expect(() => f.service.act(f.operation, "actor", respond)).not.toThrow();
    expect(() =>
      f.service.act(f.operation, "actor", {
        ...respond,
        decision: { kind: "permission", optionId: null }
      })
    ).toThrow("response_conflict");
    expect(() => f.service.act(f.operation, "actor", cancel)).not.toThrow();
    expect(() => f.service.ingest(f.host.id, running)).not.toThrow();
    expect(() => f.service.ingest(f.host.id, terminal)).not.toThrow();
    expect(() =>
      f.service.ingest(f.host.id, {
        ...running,
        payload: { kind: "status", status: "running", error: "changed" }
      })
    ).toThrow("event_conflict");
    expect(() =>
      f.service.ingest(f.host.id, f.event(99, { kind: "status", status: "running", error: null }))
    ).not.toThrow();
    expect(() => f.service.ingest("wrong-host", running)).toThrow("identity_mismatch");
    expect(f.mailbox.listAfter(f.host.id, 0)).toHaveLength(mailboxCount);
    expect(
      f.db
        .prepare("SELECT last_sequence,status FROM acp_conversation_turns WHERE turn_id=?")
        .get(f.prompt.turnId)
    ).toMatchObject({ last_sequence: 3, status: "completed" });
    expect(
      f.db.prepare("SELECT * FROM acp_conversation_events WHERE turn_id=?").all(f.prompt.turnId)
    ).toEqual([]);
    const page = f.service.page(f.operation, "actor");
    expect(page).toMatchObject({
      retention: { compactedTurnIds: [f.prompt.turnId] },
      events: [],
      cursor: 0,
      hasMore: false
    });
    expect(page.turns[0]?.turnId).toBe(f.prompt.turnId);
    f.db
      .prepare("DELETE FROM acp_conversation_event_digests WHERE turn_id=? AND sequence=1")
      .run(f.prompt.turnId);
    expect(() => f.service.ingest(f.host.id, running)).toThrow("replay_receipt_incomplete");
  });

  it("retains the accumulated 256-turn limit after payload compaction", async () => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    f.service.ingest(f.host.id, f.event(1, { kind: "status", status: "completed", error: null }));
    storeCompactedFixture(f);
    inWriteTransaction(f.db, () => {
      for (let index = 1; index < 256; index += 1) {
        f.db
          .prepare(`INSERT INTO acp_conversation_turns(turn_id,operation_id,actor_id,host_id,session_id,
          execution_attempt_id,request_json,status,created_at,expires_at,terminal_at)
          SELECT ?,operation_id,actor_id,host_id,session_id,execution_attempt_id,'{}',status,created_at,expires_at,terminal_at
          FROM acp_conversation_turns WHERE turn_id=?`)
          .run(`historical-${index}`, f.prompt.turnId);
      }
    });
    expect(() => f.service.act(f.operation, "actor", { ...f.prompt, turnId: "turn-257" })).toThrow(
      "turn_limit"
    );
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS count FROM acp_conversation_turns WHERE operation_id=?")
        .get(f.operation.id)?.count
    ).toBe(256);
  });

  it("keeps missing retention metadata unknown and rejects truncated pages at the legacy strict schema boundary", async () => {
    const f = await setup();
    const legacyPage = f.service.page(f.operation, "actor");
    expect(acpConversationPageSchema.parse(legacyPage)).not.toHaveProperty("retention");
    const truncated = { ...legacyPage, retention: { compactedTurnIds: ["old-turn"] } };
    expect(acpConversationPageSchema.safeParse(truncated).success).toBe(true);
    const legacySchema = acpConversationPageSchema.omit({ retention: true });
    expect(legacySchema.safeParse(legacyPage).success).toBe(true);
    expect(legacySchema.safeParse(truncated).success).toBe(false);
  });
});
