import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exampleExecuteDelivery } from "@planweave-ai/agent-host-protocol";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { digestJson } from "../state/agentHostStateMigrations.js";
import { serializeHistoricalAgentHostEvent } from "../protocol.js";
import { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-permission-history-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const state = await openAgentHostState(path);
  states.push(state);
  return { directory, path, state };
}
function executeMessage() {
  return {
    ...exampleExecuteDelivery,
    command: { ...exampleExecuteDelivery.command, leaseExpiresAt: "2030-01-01T00:00:00.000Z" }
  };
}
function identity() {
  const { dispatchId, leaseId, executionAttemptId } = exampleExecuteDelivery.command;
  return { dispatchId, leaseId, executionAttemptId };
}
describe("historical permission persistence", () => {
  it("imports genuine old permission SQLite bytes without converting authorization scope", async () => {
    const { directory, path, state } = await setup();
    state.receive(executeMessage());
    const legacyPath = join(directory, "old-permissions.sqlite");
    const legacy = await openAgentHostDatabase(legacyPath, 5_000);
    legacy.exec(`CREATE TABLE agent_host_remote_execution_outbox (
      sequence INTEGER PRIMARY KEY, record_json TEXT NOT NULL
    )`);
    const record = {
      kind: "permission_request",
      identity: identity(),
      deadline: "2030-01-01T00:00:00.000Z",
      request: {
        requestId: "old-permission",
        sessionId: "old-session",
        toolCallId: "old-tool",
        summary: "Old permission",
        options: [{ optionId: "old-id", label: "Allow", decision: "approve" }]
      }
    };
    const originalJson = JSON.stringify(record, null, 2);
    legacy.prepare("INSERT INTO agent_host_remote_execution_outbox VALUES(1,?)").run(originalJson);
    legacy.close();
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).resolves.toEqual({
      imported: 1,
      replayed: 0,
      sourcePresent: true
    });
    await expect(state.importLegacyRemoteExecutionStore(legacyPath)).resolves.toEqual({
      imported: 0,
      replayed: 1,
      sourcePresent: true
    });
    expect(state.records(identity())).toEqual([record]);
    const inspected = await openAgentHostDatabase(path, 5_000);
    expect(
      inspected.prepare("SELECT record_json FROM agent_host_remote_execution_outbox").get()
    ).toEqual({ record_json: originalJson });
    inspected.close();
    states.splice(states.indexOf(state), 1);
    state.close();
    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.records(identity())).toEqual([record]);
    await expect(reopened.importLegacyRemoteExecutionStore(legacyPath)).resolves.toMatchObject({
      imported: 0,
      replayed: 1
    });
    expect(() => reopened.append(JSON.parse(originalJson))).toThrow();
  });

  it("reads old permission outbox and settlement after restart without rewriting their fingerprints", async () => {
    const { state, path } = await setup();
    state.receive(executeMessage());
    state.startExecution(1);
    state.recordSessionEvidence(1, {
      sessionId: "old-session",
      capabilitySnapshot: acpCapabilitySnapshotTestValue(),
      recoveryId: "old-recovery"
    });
    const originalRequest = {
      type: "interaction.permission_requested",
      protocolVersion: 1,
      messageId: "old-event-id",
      ...identity(),
      acpSessionId: "old-session",
      actionId: "old-action",
      expiresAt: "2030-01-01T00:00:00.000Z",
      title: "Old request",
      description: "No original scopes"
    };
    const originalResponse = {
      type: "interaction.permission_response",
      ...identity(),
      acpSessionId: "old-session",
      actionId: "old-action",
      decision: "allow_once"
    };
    const eventJson = JSON.stringify(originalRequest);
    const responseJson = JSON.stringify(originalResponse);
    const responseDigest = digestJson(originalResponse);
    states.splice(states.indexOf(state), 1);
    state.close();
    const database = await openAgentHostDatabase(path, 5_000);
    database
      .prepare(
        `INSERT INTO agent_host_outbox(message_id,event_key,event_json,created_at) VALUES(?,?,?,?)`
      )
      .run("old-event-id", "old-event-key", eventJson, "2026-07-23T00:00:00.000Z");
    database
      .prepare(`INSERT INTO agent_host_execution_actions(
      inbox_sequence,lease_id,session_id,action_id,action_kind,deadline,request_digest,response_digest,response_json,settled_at,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        1,
        identity().leaseId,
        "old-session",
        "old-action",
        "permission",
        "2030-01-01T00:00:00.000Z",
        digestJson(originalRequest),
        responseDigest,
        responseJson,
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.000Z"
      );
    database.close();
    const reopened = await openAgentHostState(path);
    states.push(reopened);
    const event = reopened.pendingEvents().find((entry) => entry.messageId === "old-event-id");
    expect(event).toEqual(originalRequest);
    expect(JSON.parse(serializeHistoricalAgentHostEvent(event))).toEqual(originalRequest);
    expect(
      reopened.interactionSettlementByIdentity({
        ...identity(),
        acpSessionId: "old-session",
        actionId: "old-action"
      })
    ).toEqual(originalResponse);
    await expect(
      new DurableAcpInteractionRelay(reopened).requestPermission(
        identity(),
        {
          requestId: "old-action",
          sessionId: "old-session",
          toolCallId: "old-tool",
          summary: "Current request",
          options: [{ optionId: "current-option", label: "Allow once", kind: "allow_once" }]
        },
        { signal: new AbortController().signal, deadline: new Date("2030-01-01T00:00:00.000Z") }
      )
    ).rejects.toThrow("legacy_permission_selection_unsupported");
    const inspected = await openAgentHostDatabase(path, 5_000);
    expect(
      inspected
        .prepare("SELECT event_json FROM agent_host_outbox WHERE message_id='old-event-id'")
        .get()
    ).toEqual({ event_json: eventJson });
    expect(
      inspected
        .prepare(
          "SELECT response_json,response_digest FROM agent_host_execution_actions WHERE action_id='old-action'"
        )
        .get()
    ).toEqual({ response_json: responseJson, response_digest: responseDigest });
    inspected.close();
  });
});
