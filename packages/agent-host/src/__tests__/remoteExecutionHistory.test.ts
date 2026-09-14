import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exampleExecuteDelivery } from "@planweave-ai/agent-host-protocol";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { digestJson } from "../state/agentHostStateMigrations.js";
import { openAgentHostDatabase, type SqliteDatabase } from "../state/sqliteDatabase.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const identity = {
  dispatchId: exampleExecuteDelivery.command.dispatchId,
  leaseId: exampleExecuteDelivery.command.leaseId,
  executionAttemptId: exampleExecuteDelivery.command.executionAttemptId
};
const permission = {
  kind: "permission_request",
  identity,
  request: {
    requestId: "old-request",
    sessionId: "old-session",
    toolCallId: "old-tool",
    summary: "Old request",
    options: [
      { optionId: "always", label: "Always allow", decision: "approve" },
      { optionId: "once", label: "Allow once", decision: "approve" }
    ]
  },
  deadline: "2030-01-01T00:00:00.000Z"
};

async function fixture(limits: Parameters<typeof openAgentHostState>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-permission-history-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const state = await openAgentHostState(path, 5_000, limits);
  states.push(state);
  state.receive(exampleExecuteDelivery);
  const legacyPath = join(directory, "legacy.sqlite");
  const legacy = await openAgentHostDatabase(legacyPath, 5_000);
  databases.push(legacy);
  // Model the old table directly; the current writer must not create this fixture.
  legacy.exec(`CREATE TABLE agent_host_remote_execution_outbox (
    sequence INTEGER PRIMARY KEY,
    dispatch_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    execution_attempt_id TEXT NOT NULL,
    record_kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const insert = (serialized: string, recordId = "old-request") =>
    legacy
      .prepare(
        "INSERT INTO agent_host_remote_execution_outbox (dispatch_id,lease_id,execution_attempt_id,record_kind,record_id,record_json,created_at) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        identity.dispatchId,
        identity.leaseId,
        identity.executionAttemptId,
        "permission_request",
        recordId,
        serialized,
        "2026-01-01T00:00:00.000Z"
      );
  const inspected = await openAgentHostDatabase(path, 5_000);
  databases.push(inspected);
  return { state, legacyPath, legacy, insert, path, inspected };
}

describe("historical permission record import", () => {
  it("retains original JSON bytes and digests across first import, restart and replay", async () => {
    const { state, legacyPath, legacy, insert, path, inspected } = await fixture();
    const eventsBeforeImport = state.pendingEvents();
    const serialized = JSON.stringify(
      {
        deadline: permission.deadline,
        request: permission.request,
        identity,
        kind: permission.kind
      },
      null,
      2
    );
    insert(serialized);
    const rawHash = createHash("sha256").update(serialized).digest("hex");
    const requestDigest = digestJson(permission.request);
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).resolves.toEqual({
      imported: 1,
      replayed: 0,
      sourcePresent: true
    });
    expect(state.records(identity)).toEqual([permission]);
    const row = inspected
      .prepare("SELECT record_json FROM agent_host_remote_execution_outbox")
      .get();
    expect(row?.record_json).toBe(serialized);
    expect(createHash("sha256").update(String(row?.record_json)).digest("hex")).toBe(rawHash);
    expect(digestJson(state.records(identity)[0])).toBe(digestJson(permission));
    expect(digestJson(JSON.parse(String(row?.record_json)).request)).toBe(requestDigest);
    state.close();
    states.splice(states.indexOf(state), 1);
    const reopened = await openAgentHostState(path);
    states.push(reopened);
    await expect(reopened.importLegacyRemoteExecutionStore(legacyPath)).resolves.toEqual({
      imported: 0,
      replayed: 1,
      sourcePresent: true
    });
    expect(reopened.records(identity)).toEqual([permission]);
    expect(
      legacy.prepare("SELECT record_json FROM agent_host_remote_execution_outbox").get()
        ?.record_json
    ).toBe(serialized);
    expect(reopened.pendingEvents()).toEqual(eventsBeforeImport);
  });

  it("rejects tampered duplicate records without overwriting imported history", async () => {
    const { state, legacyPath, legacy, insert } = await fixture();
    insert(JSON.stringify(permission));
    await state.importLegacyRemoteExecutionStore(legacyPath);
    legacy
      .prepare("UPDATE agent_host_remote_execution_outbox SET record_json=?")
      .run(
        JSON.stringify({ ...permission, request: { ...permission.request, summary: "Changed" } })
      );
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).rejects.toThrow(
      "remote_execution_outbox_conflict"
    );
    expect(state.records(identity)).toEqual([permission]);
  });

  it("keeps legacy validation strict rather than inventing permission kinds", async () => {
    const { state, legacyPath, insert } = await fixture();
    insert(
      JSON.stringify({
        ...permission,
        request: {
          ...permission.request,
          options: [{ optionId: "unknown", label: "Unknown", decision: "allow" }]
        }
      })
    );
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).rejects.toThrow();
    expect(state.records(identity)).toEqual([]);
  });

  it.each(["missing-dispatch", "stale-lease"])("rejects %s history", async (invalid) => {
    const { state, legacyPath, insert } = await fixture();
    const changedIdentity =
      invalid === "missing-dispatch"
        ? { ...identity, dispatchId: "missing" }
        : { ...identity, leaseId: "stale" };
    insert(JSON.stringify({ ...permission, identity: changedIdentity }));
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).rejects.toThrow(
      invalid === "missing-dispatch"
        ? "remote_execution_not_authoritative"
        : "remote_execution_stale_lease"
    );
    expect(state.records(identity)).toEqual([]);
  });

  it("counts original serialized bytes against the import budget", async () => {
    const { state, legacyPath, insert } = await fixture({ maxRemoteRecordBytes: 128 });
    insert(JSON.stringify(permission, null, 2));
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).rejects.toThrow(
      "remote_execution_record_too_large"
    );
    expect(state.records(identity)).toEqual([]);
  });

  it("rolls back the entire import if the record count budget is exceeded", async () => {
    const { state, legacyPath, insert } = await fixture({ maxRemoteRecordsPerExecution: 1 });
    insert(JSON.stringify(permission));
    insert(
      JSON.stringify({ ...permission, request: { ...permission.request, requestId: "second" } }),
      "second"
    );
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).rejects.toThrow(
      "remote_execution_record_retention_limit_exceeded"
    );
    expect(state.records(identity)).toEqual([]);
  });
});
