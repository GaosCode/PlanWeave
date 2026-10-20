import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { applyMigrations } from "../migrations.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";

const scope = { workspaceId: "workspace-benchmark", projectId: "project-benchmark" };
const occurredAt = "2026-10-20T00:00:00.000Z";
const warmupCount = 10;
const sampleCount = 100;
const scalingRatioLimit = 5;
const instructionSchema = z.object({
  addr: z.number(),
  opcode: z.string(),
  p1: z.number(),
  p2: z.number()
});
type Instruction = z.infer<typeof instructionSchema>;
type Execution = { sql: string; values: unknown[]; changes?: number };

function traceDatabase(database: SqliteDatabase, executions: Execution[]): SqliteDatabase {
  return {
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run(...values) {
          const result = statement.run(...values);
          executions.push({ sql, values, changes: result.changes });
          return result;
        },
        get(...values) {
          executions.push({ sql, values });
          return statement.get(...values);
        },
        all(...values) {
          executions.push({ sql, values });
          return statement.all(...values);
        }
      };
    }
  };
}

// Inspect the compiled program for the SQL that actually ran, including its bound values.
// A persistent event-index traversal must exhaust a positive LIMIT before its back edge.
// Ephemeral row sets contain only those bounded candidates; primary-key seeks do not scan.
function eventTraversalBudget(
  database: SqliteDatabase,
  execution: Execution
): { rows: number; instructions: Instruction[] } {
  const roots = new Set(
    database
      .prepare("SELECT rootpage FROM sqlite_schema WHERE tbl_name='human_observer_events'")
      .all()
      .map((row) => Number(row.rootpage))
  );
  const compiled = z
    .array(instructionSchema)
    .parse(database.prepare(`EXPLAIN ${execution.sql}`).all(...execution.values));
  const nextProgram = compiled.findIndex(
    (instruction, index) => index > 0 && instruction.addr === 0
  );
  const instructions = nextProgram === -1 ? compiled : compiled.slice(0, nextProgram);
  const persistentCursors = new Set(
    instructions
      .filter((instruction) => instruction.opcode === "OpenRead" && roots.has(instruction.p2))
      .map((instruction) => instruction.p1)
  );
  let rows = 0;
  for (const instruction of instructions) {
    if (!["Next", "Prev"].includes(instruction.opcode) || !persistentCursors.has(instruction.p1))
      continue;
    const loop = instructions.filter(
      (candidate) => candidate.addr >= instruction.p2 && candidate.addr < instruction.addr
    );
    const exit = loop.find(
      (candidate) => candidate.opcode === "DecrJumpZero" && candidate.p2 > instruction.addr
    );
    if (!exit) return { rows: Number.POSITIVE_INFINITY, instructions };
    const initialization = instructions.find(
      (candidate) =>
        candidate.addr < instruction.p2 &&
        candidate.p2 === exit.p1 &&
        ["Integer", "Variable"].includes(candidate.opcode)
    );
    if (!initialization) return { rows: Number.POSITIVE_INFINITY, instructions };
    const bound =
      initialization.opcode === "Variable"
        ? Number(execution.values[initialization.p1 - 1])
        : initialization.p1;
    if (!Number.isSafeInteger(bound) || bound < 1) {
      return { rows: Number.POSITIVE_INFINITY, instructions };
    }
    rows += bound;
  }
  return { rows, instructions };
}

async function benchmark(cap: number) {
  const database = await openServerDatabase(":memory:", 5_000);
  try {
    applyMigrationsThroughVersion(database, 74);
    database
      .prepare(`WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<?
      ) INSERT INTO human_observer_events(
        workspace_id,project_id,previous_cursor,event_json,occurred_at
      ) SELECT ?,?,n-1,'{"kind":"membership"}',? FROM rows`)
      .run(cap, scope.workspaceId, scope.projectId, occurredAt);
    const migrationStart = performance.now();
    applyMigrations(database);
    const migrationMs = performance.now() - migrationStart;
    expect(database.prepare("SELECT retained_count FROM human_observer_retention").all()).toEqual([
      { retained_count: cap }
    ]);
    const executions: Execution[] = [];
    const traced = traceDatabase(database, executions);
    const journal = new HumanObserverJournal(traced, cap);
    const samples: number[] = [];
    const work: number[] = [];
    let productionDelete: Execution | undefined;
    let previous = cap;
    for (let index = 0; index < warmupCount + sampleCount; index++) {
      executions.length = 0;
      const before = Number(database.prepare("SELECT total_changes() AS count").get()?.count);
      const start = performance.now();
      const event = inWriteTransaction(traced, () =>
        journal.appendInCallerTransaction(scope, { kind: "membership" }, occurredAt)
      );
      const elapsed = performance.now() - start;
      expect(event.previousCursor).toBe(previous);
      previous = event.cursor;
      const deletion = executions.find((execution) => /^\s*DELETE\b/i.test(execution.sql));
      expect(deletion?.changes).toBe(1);
      productionDelete = deletion;
      if (index >= warmupCount) {
        samples.push(elapsed);
        work.push(
          Number(database.prepare("SELECT total_changes() AS count").get()?.count) - before
        );
      }
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    if (!productionDelete) throw new Error("expected_production_retention_delete");
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${productionDelete.sql}`)
      .all(...productionDelete.values);
    const traversal = eventTraversalBudget(database, productionDelete);
    samples.sort((a, b) => a - b);
    const elapsedMs = samples.reduce((total, sample) => total + sample, 0);
    const result = {
      cap,
      samples: samples.length,
      warmup: warmupCount,
      migrationMs,
      medianMs: samples[sampleCount / 2]!,
      p95Ms: samples[Math.floor(sampleCount * 0.95)]!,
      transactionsPerSecond: (sampleCount * 1_000) / elapsedMs,
      logicalChangesPerAppend: [...new Set(work)],
      eventTraversalRowBudget: Number.isFinite(traversal.rows) ? traversal.rows : "unbounded",
      sqlite: database.prepare("SELECT sqlite_version() AS version").get(),
      journalMode: database.prepare("PRAGMA journal_mode").get(),
      productionDelete,
      plan,
      instructions: traversal.instructions,
      latencySamplesMs: samples
    };
    process.stdout.write(`OBSERVER_RETENTION_PERFORMANCE ${JSON.stringify(result)}\n`);
    // This budget rejects window enumeration even if a fast machine masks its latency.
    expect
      .soft(traversal.rows, "event-index candidates per actual overflow=1")
      .toBeLessThanOrEqual(1);
    expect
      .soft(plan.some((row) => /SEARCH .*INTEGER PRIMARY KEY/.test(String(row.detail))))
      .toBe(true);
    expect(plan.some((row) => /SCAN .*human_observer_events/.test(String(row.detail)))).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM human_observer_events").get()).toEqual({
      count: cap
    });
    expect(database.prepare("SELECT retained_count FROM human_observer_retention").all()).toEqual([
      { retained_count: cap }
    ]);
    expect(journal.head(scope)).toBe(cap + warmupCount + sampleCount);
    const replay = journal.replay(scope, warmupCount + sampleCount, {
      maxEvents: cap,
      maxBytes: 100_000_000
    });
    expect(replay.kind).toBe("events");
    if (replay.kind === "events") expect(replay.events).toHaveLength(cap);
    return result;
  } finally {
    database.close();
  }
}

describe("HumanObserverJournal production retention performance", () => {
  it("bounds steady-state overflow work across 1k, 10k and 100k migrated windows", async () => {
    process.stdout.write(
      `OBSERVER_RETENTION_ENVIRONMENT ${JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model
      })}\n`
    );
    const results = [];
    for (const cap of [1_000, 10_000, 100_000]) results.push(await benchmark(cap));
    expect(results[2]!.medianMs / results[0]!.medianMs).toBeLessThan(scalingRatioLimit);
    expect(results[2]!.logicalChangesPerAppend).toEqual(results[0]!.logicalChangesPerAppend);
  }, 60_000);
});
