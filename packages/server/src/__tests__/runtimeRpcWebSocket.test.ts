import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { attachAgentHostWebSocketServer, type AgentHostWebSocketServer } from "../wsServer.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const directories: string[] = [];
const databases: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];
const transports: AgentHostWebSocketServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-rpc-ws-"));
  directories.push(directory);
  const database = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  databases.push(database);
  const coordination = createRemoteBlockCoordination(
    database.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: {
        acquire() {
          throw new Error("runtime_not_used");
        }
      },
      inputArtifacts: { async materialize() {} },
      artifactContent: {
        async readReport() {
          return new Uint8Array();
        }
      }
    },
    { serverInstanceOwnerToken: database.serverInstanceOwnerToken }
  );
  const broker = new CanvasRuntimeRpcBroker(
    database.database,
    coordination.hosts,
    coordination.mailbox,
    { requestTimeoutMs: 5_000 }
  );
  const httpServer = createServer();
  httpServers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("test_http_address_missing");
  const transport = attachAgentHostWebSocketServer({
    server: httpServer,
    hosts: coordination.hosts,
    mailbox: coordination.mailbox,
    dispatches: coordination.dispatches,
    acpEvents: coordination.acpEvents,
    interactions: coordination.interactions,
    actions: coordination.actions,
    runtimeRpc: broker,
    heartbeatIntervalMs: 30_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  transports.push(transport);
  const registration = coordination.hosts.register("Canvas Runtime Host");
  const url = `ws://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/connect`;
  return { broker, registration, transport, url };
}

async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function initialize(socket: WebSocket): Promise<void> {
  const welcome = new Promise<void>((resolve, reject) => {
    socket.once("message", (data) => {
      const event = JSON.parse(data.toString()) as { type?: unknown };
      if (event.type === "host.welcome") resolve();
      else reject(new Error("test_host_welcome_expected"));
    });
  });
  socket.send(
    JSON.stringify({
      type: "host.hello",
      protocolVersion: 1,
      lastAcknowledgedSequence: 0,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] }
    })
  );
  await welcome;
}

describe("Canvas Runtime RPC WebSocket lifecycle", () => {
  it("uses the active session and rejects pending work on supersede and revoke", async () => {
    const fixture = await setup();
    const first = await connect(fixture.url, fixture.registration.token);
    await initialize(first);
    expect(fixture.broker.isActive(fixture.registration.host.id)).toBe(true);

    const superseded = fixture.broker.request(
      fixture.registration.host.id,
      { workspaceId: "workspace-rpc", projectId: "project-rpc", canvasId: "default" },
      { operation: "availability" }
    );
    const supersededAssertion = expect(superseded).rejects.toMatchObject({
      code: "canvas_runtime_host_superseded"
    });
    const second = await connect(fixture.url, fixture.registration.token);
    await supersededAssertion;
    await initialize(second);
    expect(fixture.broker.isActive(fixture.registration.host.id)).toBe(true);

    const revoked = fixture.broker.request(
      fixture.registration.host.id,
      { workspaceId: "workspace-rpc", projectId: "project-rpc", canvasId: "default" },
      { operation: "availability" }
    );
    const revokedAssertion = expect(revoked).rejects.toMatchObject({
      code: "canvas_runtime_host_revoked"
    });
    fixture.transport.disconnectHost(fixture.registration.host.id);
    await revokedAssertion;
    expect(fixture.broker.isActive(fixture.registration.host.id)).toBe(false);
  });

  it("rejects pending work as soon as the current socket disconnects", async () => {
    const fixture = await setup();
    const socket = await connect(fixture.url, fixture.registration.token);
    await initialize(socket);
    const pending = fixture.broker.request(
      fixture.registration.host.id,
      { workspaceId: "workspace-rpc", projectId: "project-rpc", canvasId: "default" },
      { operation: "availability" }
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "canvas_runtime_host_disconnected"
    });
    socket.terminate();
    await assertion;
    expect(fixture.broker.isActive(fixture.registration.host.id)).toBe(false);
  });
});
