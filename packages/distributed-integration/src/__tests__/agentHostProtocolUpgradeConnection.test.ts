import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  agentHostProtocolVersion,
  CANVAS_RUNTIME_CAPABILITY,
  executeBlockCommandSchema
} from "@planweave-ai/agent-host-protocol";
import { startPlanweaveServer } from "../../../server/src/lifecycle.js";
import { createRemoteBlockCoordination } from "../../../server/src/distributedCoordination.js";
import { attachAgentHostWebSocketServer } from "../../../server/src/wsServer.js";
import { RemoteRuntimePortRegistry } from "../../../server/src/remoteRuntimeLocator.js";
import { loopbackHttpTransportAdmission } from "../../../server/src/__tests__/support/transportAdmission.js";
import { exactHostRuntimeRouteFixture } from "../../../server/src/__tests__/support/exactHostRuntimeRoute.js";
import { RemoteAcpConversationService } from "../../../agent-host/src/execution/remoteAcpConversationService.js";
import { CanvasRuntimeService } from "../../../agent-host/src/runtime/canvasRuntimeService.js";
import { AgentHostClient } from "../../../agent-host/src/transport/agentHostClient.js";
import {
  createProtocolUpgradeFixture,
  upgradePrompt
} from "../../../agent-host/src/__tests__/support/protocolUpgradeFixture.js";
import { remoteRunnerEventV2Request } from "../../../agent-host/src/__tests__/support/remoteRunnerEventCapabilityTestValues.js";
import { restoreLegacyAgentHostFixture } from "../../../agent-host/src/__tests__/support/legacyAgentHostFixture.js";
import { openAgentHostDatabase } from "../../../agent-host/src/state/sqliteDatabase.js";
import {
  artifactTransfer,
  cancel,
  contentTransfer,
  resolverWith,
  scope,
  unusedWorkspace
} from "../../../agent-host/src/__tests__/support/canvasRuntimeServiceFixture.js";

it.each([
  {
    name: "recovers lost v1 ACK confirmations across global sequence gaps",
    wireVersion: 1,
    received: 2,
    confirmed: 2,
    succeeds: true
  },
  {
    name: "replays current work missing from an older Host database",
    wireVersion: 2,
    received: 0,
    confirmed: 2,
    succeeds: true
  },
  {
    name: "resumes from the intersection of Server confirmations and Host receipts",
    wireVersion: 1,
    received: 1,
    confirmed: 2,
    succeeds: false
  },
  {
    name: "does not skip legacy commands the Server has not confirmed",
    wireVersion: 1,
    received: 2,
    confirmed: 0,
    succeeds: false
  },
  {
    name: "does not skip confirmed legacy work absent from the Host database",
    wireVersion: 1,
    received: 0,
    confirmed: 2,
    succeeds: false
  }
])("$name", async ({ wireVersion, received, confirmed, succeeds }) => {
  const directory = await mkdtemp(join(tmpdir(), "planweave-upgrade-mailbox-"));
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: exactHostRuntimeRouteFixture(new RemoteRuntimePortRegistry()),
      inputArtifacts: { materialize: async () => {} },
      artifactContent: { readReport: async () => new Uint8Array() }
    },
    { serverInstanceOwnerToken: server.serverInstanceOwnerToken }
  );
  const host = coordination.hosts.register("Upgrade Host");
  const other = coordination.hosts.register("Other Host");
  const f = await createProtocolUpgradeFixture();
  if (wireVersion === 1) {
    const oldTurn = upgradePrompt();
    f.initial.conversations.accept(oldTurn);
    f.initial.conversations.start(oldTurn.turnId);
  }
  const old = [0, 1].map((index) => {
    const message = coordination.mailbox.enqueue(host.host.id, cancel(`old-${index}`, "none"));
    coordination.mailbox.enqueue(other.host.id, cancel(`other-${index}`, "none"));
    const accepted =
      index < received
        ? f.initial.receive({
            type: "mailbox.message",
            protocolVersion: agentHostProtocolVersion,
            sequence: message.sequence,
            previousSequence: message.previousSequence,
            messageId: message.messageId,
            command: message.command
          })
        : undefined;
    if (index < confirmed)
      coordination.mailbox.acknowledge(
        host.host.id,
        accepted?.acknowledgement.messageId ?? `accepted-${index}`,
        message.sequence
      );
    return message;
  });
  server.database
    .prepare(
      "UPDATE mailbox_messages SET command_json=json_set(command_json,'$.protocolVersion',?) WHERE host_id=?"
    )
    .run(wireVersion, host.host.id);
  await f.archiveDatabase(11, wireVersion);
  const state = await f.reopen();
  expect(state.lastAcknowledgedSequence()).toBe(0);
  const workspace = unusedWorkspace();
  const resolve = vi.fn(async () => ({ scope, project: workspace, canvas: workspace }));
  const canvasRuntime = new CanvasRuntimeService({
    resolver: resolverWith(resolve),
    receipts: state.canvasRuntime,
    capabilities: [CANVAS_RUNTIME_CAPABILITY],
    artifactTransfer,
    contentTransfer
  });
  const handle = vi.spyOn(canvasRuntime, "handle");
  const converse = vi.fn(async () => {
    throw new Error("old_turn_must_not_execute");
  });
  const conversations =
    wireVersion === 1
      ? new RemoteAcpConversationService(state.conversations, { converse })
      : undefined;
  const current = cancel("new-cancel", "none");
  if (!succeeds) coordination.mailbox.enqueue(host.host.id, current);
  const http = createServer();
  const transport = attachAgentHostWebSocketServer({
    server: http,
    ...coordination,
    heartbeatIntervalMs: 30_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("expected_server_address");
  const errors: string[] = [];
  const execute = vi.fn(async () => {
    throw new Error("unexpected_execution");
  });
  const client = new AgentHostClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    hostId: host.host.id,
    token: host.token,
    capabilities: [CANVAS_RUNTIME_CAPABILITY],
    capacity: 1,
    readiness: { workspaceMappings: [], acpProfiles: [] },
    request: remoteRunnerEventV2Request,
    state,
    executor: { execute },
    canvasRuntime,
    conversations,
    allowInsecureTransport: true,
    onProtocolError: (event) => errors.push(event.code)
  });
  try {
    await client.start();
    if (succeeds) {
      await vi.waitFor(() => expect(state.lastAcknowledgedSequence()).toBe(old[1].sequence));
      if (wireVersion === 1) {
        expect(handle).not.toHaveBeenCalled();
        await client.stop();
        await client.start();
        await vi.waitFor(() => expect(client.status().state).toBe("connected"));
      }
      const latest = coordination.mailbox.enqueue(host.host.id, current);
      coordination.mailbox.publish(latest);
      await vi.waitFor(() => expect(handle).toHaveBeenCalledWith(current));
      await vi.waitFor(() => expect(state.lastAcknowledgedSequence()).toBe(latest.sequence));
      expect(coordination.hosts.getRequired(host.host.id).lastAcknowledgedSequence).toBe(
        latest.sequence
      );
      expect(client.status().state).toBe("connected");
      expect(errors).toEqual([]);
      expect(handle.mock.calls.map(([command]) => command.requestId)).toEqual([
        ...["old-0", "old-1"].slice(received),
        current.requestId
      ]);
      expect(converse).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(errors).toContain("stored_command_protocol_incompatible"));
      expect(handle).not.toHaveBeenCalled();
      expect(state.lastAcknowledgedSequence()).toBe(
        wireVersion === 1 && confirmed > 0 && received > 0 ? old[received - 1].sequence : 0
      );
      expect(coordination.hosts.getRequired(host.host.id).lastAcknowledgedSequence).toBe(
        confirmed === 0 ? 0 : old[1].sequence
      );
    }
  } finally {
    await client.stop();
    await transport.close();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve()))
    );
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reconnects and accepts current work after confirming and compacting an original v1 terminal execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "planweave-original-v1-connection-"));
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: exactHostRuntimeRouteFixture(new RemoteRuntimePortRegistry()),
      inputArtifacts: { materialize: async () => {} },
      artifactContent: { readReport: async () => new Uint8Array() }
    },
    { serverInstanceOwnerToken: server.serverInstanceOwnerToken }
  );
  const host = coordination.hosts.register("Original v1 Host");
  const fixture = await restoreLegacyAgentHostFixture("completedMailboxUnconfirmed");
  const oldCommand = fixture.tables.agent_host_inbox?.[0];
  const oldAck = fixture.tables.agent_host_outbox?.find(
    (row) => JSON.parse(String(row.event_json)).type === "mailbox.ack"
  );
  if (!oldCommand || !oldAck) throw new Error("expected_original_v1_delivery");
  const queued = coordination.mailbox.enqueue(
    host.host.id,
    executeBlockCommandSchema.parse({
      ...JSON.parse(String(oldCommand.command_json)),
      protocolVersion: agentHostProtocolVersion
    })
  );
  expect(queued.sequence).toBe(oldCommand.sequence);
  server.database
    .prepare("UPDATE mailbox_messages SET message_id=?,command_json=? WHERE sequence=?")
    .run(oldCommand.message_id, oldCommand.command_json, queued.sequence);
  coordination.mailbox.acknowledge(host.host.id, String(oldAck.message_id), queued.sequence);
  const http = createServer();
  const transport = attachAgentHostWebSocketServer({
    server: http,
    ...coordination,
    heartbeatIntervalMs: 30_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("expected_server_address");
  const errors: string[] = [];
  const execute = vi.fn(async () => {
    throw new Error("old_execution_must_not_restart");
  });
  const connect = (state: Awaited<ReturnType<typeof fixture.open>>) => {
    const workspace = unusedWorkspace();
    const canvasRuntime = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({ scope, project: workspace, canvas: workspace })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    const handle = vi.spyOn(canvasRuntime, "handle");
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: host.host.id,
      token: host.token,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [] },
      request: remoteRunnerEventV2Request,
      state,
      executor: { execute },
      canvasRuntime,
      allowInsecureTransport: true,
      onProtocolError: (event) => errors.push(event.code)
    });
    return { client, handle };
  };
  let state = await fixture.open();
  let connection = connect(state);
  const database = await openAgentHostDatabase(fixture.path, 5_000);
  try {
    expect(state.lastAcknowledgedSequence()).toBe(0);
    expect(state.mailboxAcknowledgementRecoverySequence()).toBe(queued.sequence);
    await connection.client.start();
    await vi.waitFor(() => expect(connection.client.status().state).toBe("connected"));
    expect(state.lastAcknowledgedSequence()).toBe(queued.sequence);
    expect(state.executionEvidence(queued.sequence)).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT command_digest,protocol_version FROM agent_host_terminal_execution_receipts"
        )
        .get()
    ).toEqual({ command_digest: oldCommand.command_digest, protocol_version: 1 });
    expect(connection.handle).not.toHaveBeenCalled();
    await connection.client.stop();
    fixture.close(state);
    state = await fixture.open();
    connection = connect(state);
    await connection.client.start();
    await vi.waitFor(() => expect(connection.client.status().state).toBe("connected"));
    const command = cancel("current-after-original-v1", "none");
    const current = coordination.mailbox.enqueue(host.host.id, command);
    coordination.mailbox.publish(current);
    await vi.waitFor(() => expect(connection.handle).toHaveBeenCalledExactlyOnceWith(command));
    await vi.waitFor(() => expect(state.lastAcknowledgedSequence()).toBe(current.sequence));
    expect(coordination.hosts.getRequired(host.host.id).lastAcknowledgedSequence).toBe(
      current.sequence
    );
    expect(execute).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    await connection.client.stop();
    database.close();
    await transport.close();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve()))
    );
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
