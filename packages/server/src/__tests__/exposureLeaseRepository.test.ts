import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteExposureLeaseStore } from "../exposure/exposureLeaseRepository.js";
import type { TailscaleServeLease } from "../exposure/types.js";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function lease(overrides: Partial<TailscaleServeLease> = {}): TailscaleServeLease {
  return {
    leaseId: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    nodeIdentitySha256: "c".repeat(64),
    advertisedOrigin: "https://planweave.example.ts.net",
    httpsPort: 443,
    path: "/",
    backendOrigin: "http://127.0.0.1:7443",
    serveConfigSha256: "d".repeat(64),
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides
  };
}

describe("SQLite exposure lease store", () => {
  it("migrates and persists the single exact Tailscale exposure lease", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    expect(latestCentralSchemaVersion).toBe(52);

    const store = new SqliteExposureLeaseStore(database);
    expect(store.load()).toBeNull();
    expect(store.insertIfAbsent(lease())).toBe(true);
    expect(store.load()).toEqual(lease());

    const replacement = lease({
      leaseId: "e".repeat(64),
      serveConfigSha256: "f".repeat(64),
      createdAt: "2026-08-03T00:01:00.000Z"
    });
    expect(store.insertIfAbsent(replacement)).toBe(false);
    expect(store.load()).toEqual(lease());
    expect(store.replaceExact(lease(), replacement)).toBe(true);
    expect(store.load()).toEqual(replacement);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM server_exposure_leases").get()?.count
    ).toBe(1);
  });

  it("deletes only the exact persisted lease", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const store = new SqliteExposureLeaseStore(database);
    const owned = lease();
    expect(store.insertIfAbsent(owned)).toBe(true);

    expect(store.deleteExact({ ...owned, serveConfigSha256: "e".repeat(64) })).toBe(false);
    expect(store.load()).toEqual(owned);
    expect(store.deleteExact(owned)).toBe(true);
    expect(store.load()).toBeNull();
  });

  it("uses compare-and-swap across two SQLite connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-exposure-cas-"));
    directories.push(directory);
    const path = join(directory, "server.sqlite");
    const firstDatabase = await openServerDatabase(path, 5_000);
    const secondDatabase = await openServerDatabase(path, 5_000);
    databases.push(firstDatabase, secondDatabase);
    applyMigrations(firstDatabase);
    const first = new SqliteExposureLeaseStore(firstDatabase);
    const second = new SqliteExposureLeaseStore(secondDatabase);
    const winner = lease();
    const loser = lease({ leaseId: "e".repeat(64), createdAt: "2026-08-03T00:01:00.000Z" });

    const insertResults = await Promise.all([
      Promise.resolve().then(() => first.insertIfAbsent(winner)),
      Promise.resolve().then(() => second.insertIfAbsent(loser))
    ]);
    expect(insertResults.sort()).toEqual([false, true]);
    expect(second.load()).toEqual(winner);
    const otherReplacement = lease({
      leaseId: "f".repeat(64),
      createdAt: "2026-08-03T00:02:00.000Z"
    });
    const replaceResults = await Promise.all([
      Promise.resolve().then(() => first.replaceExact(winner, loser)),
      Promise.resolve().then(() => second.replaceExact(winner, otherReplacement))
    ]);
    expect(replaceResults.sort()).toEqual([false, true]);
    expect([loser, otherReplacement]).toContainEqual(first.load());
  });
});
