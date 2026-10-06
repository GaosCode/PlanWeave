import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { parseServerConfig } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import { adminToken, remoteManifest } from "./support/serverCompositionFixture.js";

const compositions: DistributedServerComposition[] = [];
const databases: SqliteDatabase[] = [];
const httpServers: HttpServer[] = [];
const directories: string[] = [];
const oldTime = "2029-01-01T00:00:00.000Z";

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function seedTerminal(
  database: SqliteDatabase,
  workspaceId: string,
  hostId: string,
  suffix: string
) {
  const operation = new RemoteOperationRepository(database, () => new Date(oldTime)).create({
    workspaceId,
    projectId: "project-retention-composition",
    canvasId: "default",
    blockRef: `T-001#B-${suffix}`,
    ownershipGeneration: `g-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    sourceFingerprint: "fingerprint",
    requiredCapabilities: ["acp.codex"]
  });
  database
    .prepare(`UPDATE remote_execution_attempts SET status='completed',host_id=?,lease_id=?,
    lease_fencing_token=1,lease_expires_at=?,state_version=1,updated_at=?,terminal_at=? WHERE execution_attempt_id=?`)
    .run(hostId, `lease-${suffix}`, oldTime, oldTime, oldTime, operation.executionAttemptId);
  database
    .prepare("UPDATE remote_operations SET state='completed',updated_at=?,terminal_at=? WHERE id=?")
    .run(oldTime, oldTime, operation.id);
  database
    .prepare(`INSERT INTO dispatches(id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
    lease_id,execution_attempt_id,lease_expires_at,created_at,finished_at) VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?)`)
    .run(
      operation.dispatchId,
      workspaceId,
      operation.projectId,
      operation.blockRef,
      hostId,
      JSON.stringify(operation.requiredCapabilities),
      `lease-${suffix}`,
      operation.executionAttemptId,
      oldTime,
      oldTime,
      oldTime
    );
}

function snapshot(database: SqliteDatabase) {
  return database
    .prepare(`SELECT operation.id,receipt.receipt_digest,
    (SELECT COUNT(*) FROM remote_operation_events event WHERE event.operation_id=operation.id) AS event_count
    FROM remote_operations operation LEFT JOIN remote_operation_retention_receipts receipt ON receipt.operation_id=operation.id
    ORDER BY operation.id`)
    .all();
}

describe("remote operation retention composition lifecycle", () => {
  it("runs retention independently, closes with consistent receipts, and resumes the remaining page after restart", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "retention-server-data"),
      trustedProjects: [],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(adminToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const clock = () => new Date("2030-01-01T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const firstHttp = createServer();
    httpServers.push(firstHttp);
    const first = await createDistributedServerComposition({
      httpServer: firstHttp,
      config,
      clock
    });
    compositions.push(first);
    const database = await openServerDatabase(config.databasePath, 5000);
    databases.push(database);
    const workspaceId = new WorkspaceIdentityRepository(database).ensureWorkspaceForLegacyProject(
      "project-retention-composition"
    );
    const hostId = new AgentHostRepository(database, () => new Date(oldTime)).register(
      "Retention Composition Host"
    ).host.id;
    for (let index = 0; index < 126; index += 1)
      seedTerminal(database, workspaceId, hostId, String(index));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(snapshot(database).filter((row) => row.receipt_digest !== null)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    const beforeClose = snapshot(database);
    expect(beforeClose.filter((row) => row.receipt_digest !== null)).toHaveLength(25);
    expect(
      beforeClose.filter((row) => row.receipt_digest !== null).every((row) => row.event_count === 0)
    ).toBe(true);
    await first.close();
    compositions.splice(compositions.indexOf(first), 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(snapshot(database)).toEqual(beforeClose);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(snapshot(database)).toEqual(beforeClose);
    const secondHttp = createServer();
    httpServers.push(secondHttp);
    const second = await createDistributedServerComposition({
      httpServer: secondHttp,
      config,
      clock
    });
    compositions.push(second);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot(database)).toEqual(beforeClose);
    await vi.advanceTimersByTimeAsync(120_000);
    const afterRestart = snapshot(database);
    expect(afterRestart.filter((row) => row.receipt_digest !== null)).toHaveLength(26);
    expect(
      afterRestart
        .filter((row) => row.receipt_digest !== null)
        .every((row) => row.event_count === 0)
    ).toBe(true);
    expect(afterRestart.filter((row) => row.receipt_digest === null)).toHaveLength(100);
    for (const receipt of beforeClose.filter((row) => row.receipt_digest !== null)) {
      expect(afterRestart.find((row) => row.id === receipt.id)).toEqual(receipt);
    }
    await second.close();
    compositions.splice(compositions.indexOf(second), 1);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
