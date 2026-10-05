import { createServer } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { CanvasRuntimeRpcBroker, CanvasRuntimeRpcError } from "../../canvas/runtimeRpcBroker.js";
import { createRemoteBlockCoordination } from "../../distributedCoordination.js";
import { startPlanweaveServer } from "../../lifecycle.js";
import { attachAgentHostWebSocketServer } from "../../wsServer.js";
import { loopbackHttpTransportAdmission } from "./transportAdmission.js";

const input = z
  .object({ directory: z.string(), heartbeatIntervalMs: z.number().positive() })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const database = await startPlanweaveServer({
  dataDirectory: input.directory,
  databasePath: join(input.directory, "server.sqlite"),
  busyTimeoutMs: 5_000
});
const coordination = createRemoteBlockCoordination(
  database.database,
  {
    leaseDurationMs: 60_000,
    hostOfflineAfterMs: 60_000,
    runtimeLeases: {
      acquire() {
        throw new Error("runtime_not_used");
      },
      acquireForHost() {
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
  { requestTimeoutMs: 3_000 }
);
const registrations = ["Bad Host", "Healthy Host"].map((name) => coordination.hosts.register(name));
const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      active: registrations.map(({ host }) => broker.isActive(host.id)),
      pending: broker.pendingCount()
    })
  );
});
const transport = attachAgentHostWebSocketServer({
  server,
  hosts: coordination.hosts,
  mailbox: coordination.mailbox,
  dispatches: coordination.dispatches,
  acpEvents: coordination.acpEvents,
  interactions: coordination.interactions,
  actions: coordination.actions,
  runtimeRpc: broker,
  heartbeatIntervalMs: input.heartbeatIntervalMs,
  leaseDurationMs: 60_000,
  maxPayloadBytes: 1_024,
  shutdownTimeoutMs: 500,
  transportAdmission: loopbackHttpTransportAdmission
});
const commandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("rpc"), id: z.string(), hostId: z.string() }),
  z.object({ command: z.literal("stop") })
]);
process.on("message", (message: unknown) => {
  const command = commandSchema.parse(message);
  if (command.command === "stop") {
    void (async () => {
      await transport.close();
      broker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
      process.disconnect?.();
    })();
    return;
  }
  void broker
    .request(
      command.hostId,
      { workspaceId: "workspace-rpc", projectId: "project-rpc", canvasId: "default" },
      {
        operation: "availability",
        contentTarget: {
          revision: 1,
          content: {
            versionId: `version-${"c".repeat(64)}`,
            canonicalDigest: "c".repeat(64),
            verification: "complete"
          },
          graphFingerprint: `pkg-${"a".repeat(64)}`
        }
      }
    )
    .then(
      (result) => process.send?.({ event: "rpc", id: command.id, outcome: "success", result }),
      (error: unknown) =>
        process.send?.({
          event: "rpc",
          id: command.id,
          outcome: "error",
          code: error instanceof CanvasRuntimeRpcError ? error.code : "unexpected_error"
        })
    );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("child_http_address_missing");
process.send?.({
  event: "ready",
  origin: `http://127.0.0.1:${address.port}`,
  hosts: registrations.map(({ host, token }) => ({ hostId: host.id, token }))
});
