import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizeJson } from "@planweave-ai/agent-host-protocol";
import { AcpConversationRetention } from "../acpConversationRetention.js";
import { openServerDatabase } from "../sqlite.js";
import { createAcpConversationFixture } from "./support/acpConversationFixture.js";

const day = 24 * 60 * 60 * 1_000;
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
    retention: new AcpConversationRetention(f.db, () => now),
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    }
  };
}

function seedTurns(f: Awaited<ReturnType<typeof setup>>, prefix: string, count: number) {
  for (let i = 0; i < count; i++) {
    const turnId = `${prefix}-${String(i).padStart(3, "0")}`;
    const prompt = { ...f.prompt, turnId, sessionId: `session-${prefix}` };
    f.db
      .prepare(`INSERT INTO acp_conversation_turns(
      turn_id,operation_id,actor_id,host_id,session_id,execution_attempt_id,request_json,
      status,created_at,expires_at,terminal_at,last_sequence,event_bytes)
      VALUES(?,?,?,?,?,?,?,'completed',?,?,?,1,100)`)
      .run(
        turnId,
        prefix,
        "operator-one",
        f.host.id,
        `session-${prefix}`,
        f.operation.executionAttemptId,
        canonicalizeJson(prompt),
        f.clock().toISOString(),
        f.clock().toISOString(),
        f.clock().toISOString()
      );
    f.db
      .prepare("INSERT INTO acp_conversation_events(turn_id,sequence,event_json) VALUES(?,1,?)")
      .run(
        turnId,
        canonicalizeJson({
          ...f.event(1, { kind: "status", status: "completed", error: null }, turnId),
          operationId: prefix,
          sessionId: `session-${prefix}`
        })
      );
  }
}

describe("ACP conversation payload retention", () => {
  it("compacts old v1 events using their original replay digests and keeps retained history readable", async () => {
    const f = await setup();
    seedTurns(f, f.operation.id, 21);
    f.db
      .prepare(
        "UPDATE acp_conversation_events SET event_json=json_set(event_json,'$.protocolVersion',1)"
      )
      .run();
    const turnId = `${f.operation.id}-000`;
    const event = JSON.parse(
      String(
        f.db.prepare("SELECT event_json FROM acp_conversation_events WHERE turn_id=?").get(turnId)
          ?.event_json
      )
    );
    const digest = createHash("sha256").update(canonicalizeJson(event)).digest("hex");
    f.advance(31 * day);
    expect(f.retention.compactBatch().compacted).toBe(1);
    expect(
      f.db
        .prepare(
          "SELECT event_digest FROM acp_conversation_event_digests WHERE turn_id=? AND sequence=1"
        )
        .get(turnId)?.event_digest
    ).toBe(digest);
    const page = f.service.page(f.operation, "operator-one");
    expect(page.retention?.compactedTurnIds).toEqual([turnId]);
    expect(page.events).toHaveLength(20);
    expect(page.events.every((event) => event.protocolVersion === 1)).toBe(true);
    expect(f.retention.compactBatch().compacted).toBe(0);
  });

  it("uses its own terminal age, protects the latest twenty, and writes replay evidence before removing payloads", async () => {
    const f = await setup();
    f.service.act(f.operation, "operator-one", f.prompt);
    f.service.ingest(f.host.id, f.event(1, { kind: "status", status: "running", error: null }));
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
    f.service.act(f.operation, "operator-one", respond);
    f.service.act(f.operation, "operator-one", cancel);
    const terminal = f.event(3, { kind: "status", status: "completed", error: null });
    f.service.ingest(f.host.id, terminal);
    const oldCursor = f.service.page(f.operation, "operator-one").cursor;
    f.advance(1);
    seedTurns(f, f.operation.id, 20);
    f.advance(30 * day - 1);
    expect(f.retention.compactBatch().compacted).toBe(0);
    f.advance(1);
    expect(f.retention.compactBatch().compacted).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM acp_conversation_turns").get()?.n).toBe(21);
    expect(
      f.db
        .prepare(
          "SELECT request_json,compacted_at,last_sequence FROM acp_conversation_turns WHERE turn_id=?"
        )
        .get(f.prompt.turnId)
    ).toEqual({ request_json: "null", compacted_at: f.clock().toISOString(), last_sequence: 3 });
    expect(
      f.db
        .prepare(
          "SELECT final_sequence,last_cursor FROM acp_conversation_replay_receipts WHERE turn_id=?"
        )
        .get(f.prompt.turnId)
    ).toEqual({ final_sequence: 3, last_cursor: oldCursor });
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM acp_conversation_events WHERE turn_id=?")
        .get(f.prompt.turnId)?.n
    ).toBe(0);
    const mailbox = f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_messages").get()?.n;
    expect(() => f.service.act(f.operation, "operator-one", f.prompt)).not.toThrow();
    expect(() => f.service.act(f.operation, "operator-one", respond)).not.toThrow();
    expect(() => f.service.act(f.operation, "operator-one", cancel)).not.toThrow();
    expect(() =>
      f.service.act(f.operation, "operator-one", {
        ...respond,
        decision: { kind: "permission", optionId: "different" }
      })
    ).toThrow("response_conflict");
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM acp_conversation_actions WHERE turn_id=?")
        .get(f.prompt.turnId)?.n
    ).toBe(0);
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM acp_conversation_action_digests WHERE turn_id=?")
        .get(f.prompt.turnId)?.n
    ).toBe(2);
    expect(() =>
      f.service.act(f.operation, "operator-one", { ...f.prompt, text: "Different" })
    ).toThrow("request_conflict");
    expect(() => f.service.ingest(f.host.id, terminal)).not.toThrow();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_messages").get()?.n).toBe(mailbox);
    const page = f.service.page(f.operation, "operator-one", oldCursor);
    expect(page.retention?.compactedTurnIds).toEqual([f.prompt.turnId]);
    expect(page.events).toHaveLength(20);
    expect(f.retention.compactBatch().compacted).toBe(0);
    expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("limits raw pages to twenty-five and advances past protected history to other operations", async () => {
    const f = await setup();
    seedTurns(f, "a-protected", 20);
    seedTurns(f, "b-pending", 70);
    f.advance(31 * day);
    const statements = vi.spyOn(f.db, "prepare");
    const first = f.retention.compactBatch();
    expect(first.selected).toBeLessThanOrEqual(25);
    expect(first.compacted).toBe(5);
    const second = f.retention.compactBatch();
    const sql = statements.mock.calls
      .map(([query]) => query)
      .filter((query) => query.includes("INDEXED BY acp_conversation_retention_candidates"))
      .at(-1);
    statements.mockRestore();
    expect(sql).toBeDefined();
    const plan = f.db
      .prepare(`EXPLAIN QUERY PLAN ${sql!}`)
      .all(
        new Date(f.clock().getTime() - 30 * day).toISOString(),
        "2030-01-01T00:00:00.000Z",
        "b-pending-004",
        25
      )
      .map((row) => String(row.detail));
    expect(
      plan.some((detail) =>
        /SEARCH.*acp_conversation_retention_candidates.*\(terminal_at,turn_id\)>\(\?,\?\)/.test(
          detail
        )
      ),
      plan.join("\n")
    ).toBe(true);
    expect(
      plan.some((detail) => /SCAN|TEMP B-TREE/.test(detail)),
      plan.join("\n")
    ).toBe(false);
    process.stdout.write(`${JSON.stringify({ retentionCandidatePlan: plan, first, second })}\n`);
    expect(second.selected).toBeLessThanOrEqual(25);
    expect(second.compacted).toBe(25);
    for (let pass = 0; pass < 4; pass++) f.retention.compactBatch();
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM acp_conversation_turns WHERE operation_id='b-pending' AND compacted_at IS NOT NULL"
        )
        .get()?.n
    ).toBe(50);
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM acp_conversation_turns WHERE operation_id='a-protected' AND compacted_at IS NOT NULL"
        )
        .get()?.n
    ).toBe(0);
  });

  it("protects active and restoring sessions and resumes compaction when those guards clear", async () => {
    const f = await setup();
    seedTurns(f, f.operation.id, 21);
    const candidate = `${f.operation.id}-000`;
    f.db
      .prepare(
        "UPDATE acp_conversation_turns SET status='running',terminal_at=NULL,expires_at='2031-01-01T00:00:00.000Z' WHERE turn_id=?"
      )
      .run(`${f.operation.id}-020`);
    f.advance(31 * day);
    expect(f.retention.compactBatch().compacted).toBe(0);
    f.db
      .prepare("UPDATE acp_conversation_turns SET status='completed',terminal_at=? WHERE turn_id=?")
      .run(f.clock().toISOString(), `${f.operation.id}-020`);
    f.db
      .prepare(
        "INSERT INTO acp_task_restorations(source_operation_id,host_id,session_id) VALUES(?,?,?)"
      )
      .run(f.operation.id, f.host.id, `session-${f.operation.id}`);
    expect(f.retention.compactBatch().compacted).toBe(0);
    f.db
      .prepare("DELETE FROM acp_task_restorations WHERE source_operation_id=?")
      .run(f.operation.id);
    expect(f.retention.compactBatch().compacted).toBe(1);
    expect(
      f.db.prepare("SELECT compacted_at FROM acp_conversation_turns WHERE turn_id=?").get(candidate)
        ?.compacted_at
    ).toBe(f.clock().toISOString());
  });
  it("rolls back receipts and payload deletion together and retries the same bounded page", async () => {
    const f = await setup();
    seedTurns(f, f.operation.id, 21);
    f.advance(31 * day);
    const before = f.db.prepare("SELECT * FROM acp_conversation_events ORDER BY cursor").all();
    f.db.exec(`CREATE TRIGGER reject_conversation_deletion BEFORE DELETE ON acp_conversation_events
      BEGIN SELECT RAISE(ABORT,'conversation deletion interrupted'); END`);
    expect(() => f.retention.compactBatch()).toThrow("conversation deletion interrupted");
    expect(f.db.prepare("SELECT * FROM acp_conversation_events ORDER BY cursor").all()).toEqual(
      before
    );
    expect(f.db.prepare("SELECT * FROM acp_conversation_replay_receipts").all()).toEqual([]);
    expect(f.db.prepare("SELECT * FROM acp_conversation_event_digests").all()).toEqual([]);
    f.db.exec("DROP TRIGGER reject_conversation_deletion");
    expect(f.retention.compactBatch().compacted).toBe(1);
  });

  it("persists expired active turns in batches without a page poll", async () => {
    const f = await setup();
    for (let index = 0; index < 30; index++) seedTurns(f, `expired-${index}`, 1);
    f.db.prepare("UPDATE acp_conversation_turns SET status='running',terminal_at=NULL").run();
    f.advance(day);
    expect(f.retention.compactBatch().expired).toBe(25);
    expect(
      f.db.prepare("SELECT COUNT(*) AS n FROM acp_conversation_turns WHERE status='running'").get()
        ?.n
    ).toBe(5);
    expect(f.retention.compactBatch().expired).toBe(5);
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM acp_conversation_turns WHERE status='failed' AND terminal_at=?"
        )
        .get(f.clock().toISOString())?.n
    ).toBe(30);
  });

  it.each([
    "before-commit",
    "after-commit"
  ])("recovers SQLite after a retention child is killed %s", async (boundary) => {
    const f = await setup();
    seedTurns(f, f.operation.id, 21);
    f.advance(31 * day);
    const path = join(f.directory, "server.sqlite");
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import {writeSync} from 'node:fs';
      const {openServerDatabase} = await import(${JSON.stringify(new URL("../sqlite.ts", import.meta.url).href)});
      const {AcpConversationRetention} = await import(${JSON.stringify(new URL("../acpConversationRetention.ts", import.meta.url).href)});
      const db = await openServerDatabase(${JSON.stringify(path)}, 5000);
      const prepare = db.prepare.bind(db);
      const exec = db.exec.bind(db);
      let deleting = false;
      db.prepare = sql => {
        const statement = prepare(sql);
        if (sql !== 'DELETE FROM acp_conversation_events WHERE turn_id=?') return statement;
        return {get: statement.get.bind(statement), all: statement.all.bind(statement), run(...values) {
          const result = statement.run(...values);
          deleting = true;
          return result;
        }};
      };
      db.exec = sql => {
        if (sql === 'COMMIT' && deleting) {
          if (${JSON.stringify(boundary)} === 'after-commit') exec(sql);
          writeSync(1, ${JSON.stringify(boundary)});
          process.kill(process.pid, 'SIGKILL');
        }
        exec(sql);
      };
      new AcpConversationRetention(db, () => new Date(${JSON.stringify(f.clock().toISOString())})).compactBatch();
      throw new Error('crash_boundary_not_reached');
    `
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 }
    );
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBe("SIGKILL");
    expect(child.stdout).toBe(boundary);
    const reopened = await openServerDatabase(path, 5000);
    try {
      const committed = boundary === "after-commit";
      expect(reopened.prepare("SELECT COUNT(*) AS n FROM acp_conversation_events").get()?.n).toBe(
        committed ? 20 : 21
      );
      expect(
        reopened.prepare("SELECT COUNT(*) AS n FROM acp_conversation_replay_receipts").get()?.n
      ).toBe(committed ? 1 : 0);
      expect(
        reopened.prepare("SELECT COUNT(*) AS n FROM acp_conversation_event_digests").get()?.n
      ).toBe(committed ? 1 : 0);
      expect(
        reopened
          .prepare("SELECT COUNT(*) AS n FROM acp_conversation_turns WHERE request_json='null'")
          .get()?.n
      ).toBe(committed ? 1 : 0);
      const maintenance = new AcpConversationRetention(reopened, f.clock);
      expect(maintenance.compactBatch().compacted).toBe(committed ? 0 : 1);
      expect(maintenance.compactBatch().compacted).toBe(0);
      expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      process.stdout.write(
        `${JSON.stringify({ crashBoundary: boundary, signal: child.signal, reopenedEvents: committed ? 20 : 21, retryEvents: reopened.prepare("SELECT COUNT(*) AS n FROM acp_conversation_events").get()?.n })}\n`
      );
    } finally {
      reopened.close();
    }
  });
});
