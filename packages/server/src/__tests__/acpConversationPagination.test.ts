import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acpConversationEventSchema,
  acpConversationOrderedPageSchema,
  type AcpConversationOrderedPage
} from "@planweave-ai/agent-host-protocol";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { AcpConversationService } from "../acpConversationService.js";
import { acpConversationWirePage, paginateAcpConversation } from "../acpConversationPagination.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { DurableMailbox } from "../mailbox.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { RemoteOperationRepository, type RemoteOperation } from "../remoteOperations.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";

const fixtures: { directory: string; database: SqliteDatabase }[] = [];
const timestamp = "2030-01-01T00:00:00.000Z";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function setup(historical = false) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-conversation-pagination-"));
  const path = join(directory, "server.sqlite");
  const database = await openServerDatabase(path, 5_000);
  const fixture = { directory, database };
  fixtures.push(fixture);
  if (historical) applyMigrationsThroughVersion(database, 75);
  else applyMigrations(database);
  const workspaceId = workspaceIdSchema.parse(
    new WorkspaceIdentityRepository(database).ensureWorkspaceForLegacyProject("pagination")
  );
  const operations = new RemoteOperationRepository(database, () => new Date(timestamp));
  const createOperation = (id: string) =>
    operations.create({
      workspaceId,
      projectId: "pagination",
      canvasId: "default",
      blockRef: id === "target" ? "T-001#B-001" : "T-001#B-002",
      ownershipGeneration: "generation",
      idempotencyKey: id,
      sourceFingerprint: "fingerprint",
      requiredCapabilities: ["acp.codex"]
    });
  const operation = createOperation("target");
  const otherOperation = createOperation("other");
  const insertTurn = database.prepare(`INSERT INTO acp_conversation_turns(
    turn_id,operation_id,actor_id,host_id,session_id,execution_attempt_id,request_json,
    status,created_at,expires_at) VALUES(?,?,'actor','host','session',?,?,'completed',?,?)`);
  for (const [turnId, owner] of [
    ["target-one", operation],
    ["target-two", operation],
    ["other", otherOperation]
  ] as const) {
    insertTurn.run(
      turnId,
      owner.id,
      owner.executionAttemptId,
      JSON.stringify({ kind: "prompt", turnId, text: "Continue" }),
      timestamp,
      "2030-01-02T00:00:00.000Z"
    );
  }
  const sequences = new Map<string, number>();
  const insertEvent = database.prepare(
    "INSERT INTO acp_conversation_events(turn_id,sequence,event_json) VALUES(?,?,?)"
  );
  const append = (owner: RemoteOperation, turnId: string, messageId: string) => {
    const sequence = (sequences.get(turnId) ?? 0) + 1;
    sequences.set(turnId, sequence);
    const event = acpConversationEventSchema.parse({
      protocolVersion: agentHostProtocolVersion,
      type: "acp_conversation.event",
      messageId,
      operationId: owner.id,
      turnId,
      executionAttemptId: owner.executionAttemptId,
      sessionId: "session",
      sequence,
      timestamp,
      payload: { kind: "status", status: "running", error: null }
    });
    return Number(insertEvent.run(turnId, sequence, JSON.stringify(event)).lastInsertRowid);
  };
  const seed = (count: number) =>
    inWriteTransaction(database, () => {
      for (let index = 1; index <= count; index += 1) {
        append(otherOperation, "other", `other-${index}`);
        append(operation, index % 2 ? "target-one" : "target-two", `target-${index}`);
      }
    });
  const service = (db = fixture.database) =>
    new AcpConversationService(db, {
      hosts: new AgentHostRepository(db),
      mailbox: new DurableMailbox(db),
      hostOfflineAfterMs: 60_000,
      clock: () => new Date(timestamp),
      authorize: () => {}
    });
  return { fixture, path, database, operation, otherOperation, append, seed, service };
}

function pagePlan(
  database: SqliteDatabase,
  service: AcpConversationService,
  operation: RemoteOperation,
  cursor: number
) {
  const prepare = vi.spyOn(database, "prepare");
  let sql: string | undefined;
  try {
    service.page(operation, "actor", cursor);
    sql = prepare.mock.calls
      .map(([statement]) => statement)
      .find((statement) => /\bFROM acp_conversation_events\b/i.test(statement));
  } finally {
    prepare.mockRestore();
  }
  expect(sql).toBeDefined();
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql!}`)
    .all(operation.id, cursor)
    .map((row) => String(row.detail));
}

function expectCursorRange(details: string[]) {
  expect(
    details.some((detail) => /\bSEARCH\b.*\(turn_id=\? AND (?:cursor|rowid)>\?\)/.test(detail)),
    details.join("\n")
  ).toBe(true);
}

describe("ACP conversation cursor storage and pagination", () => {
  it.each([
    1, 2, 3
  ] as const)("bounds v%i serialization work while including a priority turn once", (version) => {
    const turns: AcpConversationOrderedPage["turns"] = Array.from({ length: 128 }, (_, index) => ({
      turnId: `turn-${index}`,
      turnOrder: index + 1,
      executionAttemptId: "attempt",
      sessionId: "session",
      status: "failed",
      createdAt: timestamp,
      error: "x".repeat(16 * 1024)
    }));
    const metadata = acpConversationOrderedPageSchema.parse({
      available: true,
      reason: null,
      executionAttemptId: "attempt",
      sessionId: "session",
      turns: [],
      events: [],
      cursor: 0,
      hasMore: false
    });
    const stringify = JSON.stringify;
    let encodedBytes = 0;
    const encoding = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
      const encoded = stringify(value);
      if (encoded !== undefined) encodedBytes += Buffer.byteLength(encoded);
      return encoded;
    });
    let page: AcpConversationOrderedPage;
    try {
      page = paginateAcpConversation(metadata, turns, [], null, "turn-127", version);
    } finally {
      encoding.mockRestore();
    }
    expect(page.turns.map((turn) => turn.turnId)).toEqual([
      "turn-127",
      ...turns.slice(0, -1).map((turn) => turn.turnId)
    ]);
    expect(page).toMatchObject({ turnCursor: "turn-127", hasMoreTurns: false, hasMore: false });
    const wireBytes = Buffer.byteLength(JSON.stringify(acpConversationWirePage(page, version)));
    expect(encodedBytes).toBeLessThan(wireBytes * 4);
  });

  it("upgrades a populated v75 file and retains rows, cursor, and constraints after reopening", async () => {
    const f = await setup(true);
    f.seed(129);
    f.database
      .prepare("INSERT INTO acp_conversation_actions VALUES(?,?,?)")
      .run("existing-action", "target-one", '{"kind":"respond"}');
    const snapshot = () => ({
      turns: f.fixture.database
        .prepare("SELECT * FROM acp_conversation_turns ORDER BY turn_id")
        .all(),
      events: f.fixture.database
        .prepare("SELECT * FROM acp_conversation_events ORDER BY cursor")
        .all(),
      actions: f.fixture.database
        .prepare("SELECT * FROM acp_conversation_actions ORDER BY action_key")
        .all()
    });
    const before = snapshot();
    expect(centralSchemaVersion(f.database)).toBe(75);
    applyMigrations(f.database);
    expect(centralSchemaVersion(f.database)).toBe(latestCentralSchemaVersion);
    const upgraded = snapshot();
    expect(upgraded.turns).toMatchObject(before.turns);
    expect(upgraded.events).toEqual(before.events);
    expect(upgraded.actions).toEqual(before.actions);
    const ordered = f
      .service()
      .page(f.operation, "actor")
      .turns.map((turn) => [turn.turnId, turn.turnOrder]);
    f.database.close();
    f.fixture.database = await openServerDatabase(f.path, 5_000);
    const db = f.fixture.database;
    applyMigrations(db);
    expect(snapshot()).toEqual(upgraded);
    expect(
      f
        .service()
        .page(f.operation, "actor")
        .turns.map((turn) => [turn.turnId, turn.turnOrder])
    ).toEqual(ordered);
    expect(() =>
      db
        .prepare(
          "INSERT INTO acp_conversation_events(turn_id,sequence,event_json) VALUES('target-one',1,'{}')"
        )
        .run()
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO acp_conversation_events(turn_id,sequence,event_json) VALUES('missing',1,'{}')"
        )
        .run()
    ).toThrow(/FOREIGN KEY/);
    const page = f.service().page(f.operation, "actor", 256);
    expect(page.events.map((event) => event.messageId)).toEqual(["target-129"]);
    expect(page).toMatchObject({ cursor: 258, hasMore: false });
    expectCursorRange(pagePlan(db, f.service(), f.operation, 258));
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=76").get()?.count
    ).toBe(1);
  });

  it.each([
    0, 128, 129
  ])("pages %i interleaved target events without leaking another operation or advancing an empty cursor", async (count) => {
    const f = await setup();
    f.seed(count);
    f.append(f.otherOperation, "other", "other-after-target");
    const service = f.service();
    const first = service.page(f.operation, "actor");
    expect(first.events.map((event) => event.messageId)).toEqual(
      Array.from({ length: Math.min(count, 128) }, (_, index) => `target-${index + 1}`)
    );
    expect(first.events.map((event) => event.turnId)).toEqual(
      Array.from({ length: Math.min(count, 128) }, (_, index) =>
        index % 2 ? "target-two" : "target-one"
      )
    );
    expect(first).toMatchObject({ cursor: Math.min(count, 128) * 2, hasMore: count > 128 });
    const second = service.page(f.operation, "actor", first.cursor);
    expect(second.events.map((event) => event.messageId)).toEqual(
      count === 129 ? ["target-129"] : []
    );
    expect(second).toMatchObject({ cursor: count * 2, hasMore: false });
    const empty = service.page(f.operation, "actor", second.cursor);
    expect(empty).toMatchObject({ events: [], cursor: second.cursor, hasMore: false });
    expect(
      service.page(f.otherOperation, "actor", count * 2).events.map((event) => event.messageId)
    ).toEqual(["other-after-target"]);
  });

  it.each([
    1_000, 10_000
  ])("uses a turn and cursor range for the real page query with %i historical target events", async (history) => {
    const f = await setup();
    f.seed(history);
    const service = f.service();
    const cursor = history * 2 - 4;
    expect(
      service.page(f.operation, "actor", cursor).events.map((event) => event.messageId)
    ).toEqual([`target-${history - 1}`, `target-${history}`]);
    const tail = pagePlan(f.database, service, f.operation, cursor);
    const empty = pagePlan(f.database, service, f.operation, history * 2);
    process.stdout.write(
      `${JSON.stringify({
        node: process.version,
        sqlite: f.database.prepare("SELECT sqlite_version() AS version").get()?.version,
        history,
        cursor,
        tail,
        empty
      })}\n`
    );
    expectCursorRange(tail);
    expectCursorRange(empty);
  });
});
