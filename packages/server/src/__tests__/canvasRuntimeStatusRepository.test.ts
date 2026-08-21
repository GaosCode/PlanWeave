import { afterEach, describe, expect, it } from "vitest";
import { CanvasRuntimeStatusRepository } from "../canvas/runtimeStatusRepository.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;
const fingerprint = `pkg-${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function status(capturedAt: string) {
  return {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope,
    packageFingerprint: fingerprint,
    capturedAt,
    tasks: [],
    blocks: []
  };
}

async function repository() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  return new CanvasRuntimeStatusRepository(database, () => new Date("2026-08-21T00:00:00.000Z"));
}

describe("CanvasRuntimeStatusRepository", () => {
  it("initializes idempotently but refuses a different legacy snapshot", async () => {
    const statuses = await repository();
    const initial = status("2026-08-20T00:00:00.000Z");

    expect(statuses.initialize(initial)).toEqual(initial);
    expect(statuses.initialize(initial)).toEqual(initial);
    expect(() => statuses.initialize(status("2026-08-21T00:00:00.000Z"))).toThrow(
      "canvas_runtime_status_already_initialized"
    );
  });

  it("allows an execution result to replace the authoritative projection", async () => {
    const statuses = await repository();
    statuses.initialize(status("2026-08-20T00:00:00.000Z"));

    const refreshed = status("2026-08-21T00:00:00.000Z");
    expect(statuses.replaceFromExecution(refreshed)).toEqual(refreshed);
    expect(statuses.read(scope)).toEqual(refreshed);
  });
});
