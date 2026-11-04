import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { z } from "zod";
import { openAgentHostState, type AgentHostState } from "../../state/agentHostState.js";
import { openAgentHostDatabase } from "../../state/sqliteDatabase.js";

const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
const fixtureSchema = z.object({
  producerRevision: z.string().regex(/^[a-f0-9]{40}$/),
  protocolVersion: z.literal(1),
  schemaVersion: z.literal(11),
  schema: z.array(z.string()),
  cases: z.record(z.string(), z.object({ tables: z.record(z.string(), z.array(rowSchema)) }))
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function restoreLegacyAgentHostFixture(name: string) {
  const fixture = fixtureSchema.parse(
    JSON.parse(
      await readFile(new URL("../fixtures/agentHostStateV1.json", import.meta.url), "utf8")
    )
  );
  const snapshot = fixture.cases[name];
  if (!snapshot) throw new Error(`legacy_agent_host_fixture_missing:${name}`);
  const directory = await mkdtemp(join(tmpdir(), "planweave-original-host-upgrade-"));
  const path = join(directory, "host.sqlite");
  const states = new Set<AgentHostState>();
  cleanups.push(async () => {
    for (const state of states) state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const database = await openAgentHostDatabase(path, 5_000);
  try {
    database.exec(fixture.schema.join(";\n"));
    database.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      if (table === "sqlite_sequence") continue;
      for (const row of rows) {
        const columns = Object.keys(row);
        database
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`
          )
          .run(...Object.values(row));
      }
    }
    for (const row of snapshot.tables.sqlite_sequence ?? []) {
      const updated = database
        .prepare("UPDATE sqlite_sequence SET seq=? WHERE name=?")
        .run(row.seq, row.name);
      if (updated.changes === 0)
        database
          .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)")
          .run(row.name, row.seq);
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  return {
    path,
    tables: snapshot.tables,
    async open() {
      const state = await openAgentHostState(path);
      states.add(state);
      return state;
    },
    close(state: AgentHostState) {
      state.close();
      states.delete(state);
    }
  };
}
