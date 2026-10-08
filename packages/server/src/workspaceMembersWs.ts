import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { workspaceMembersInvalidatedSchema } from "@planweave-ai/collaboration-protocol/connection";
import { humanDeviceTokenSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { isAllowedClientOrigin } from "./clientOrigin.js";
import { humanTransportAllowed } from "./identity/http.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";

/** Workspace credentials admit only invalidation of their own current member directory. */
export function attachWorkspaceMembersWebSocketServer(options: {
  upgradeRouter: WebSocketUpgradeRouter;
  workspaceIdentity: WorkspaceIdentityRepository;
  transportAdmission: TransportAdmissionPolicy;
  allowedClientOrigins?: readonly string[];
}) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const reject = (socket: Duplex, status: number) => {
    socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const unregister = options.upgradeRouter.register({
    matches: (request) => request.url === "/api/v1/workspace-connection/members/observe",
    handle(request, socket, head) {
      if (
        !humanTransportAllowed(request.socket, options.transportAdmission) ||
        !isAllowedClientOrigin(request.headers, options.allowedClientOrigins)
      ) {
        reject(socket, 403);
        return;
      }
      const authorization = request.headers.authorization;
      const token =
        typeof authorization === "string"
          ? humanDeviceTokenSchema.safeParse(/^Bearer (.+)$/.exec(authorization)?.[1])
          : null;
      const self = token?.success
        ? options.workspaceIdentity.readWorkspaceConnectionSelf(token.data)
        : undefined;
      if (!self || !token?.success) {
        reject(socket, 401);
        return;
      }
      server.handleUpgrade(request, socket, head, (client) => {
        const notify = () => {
          const current = options.workspaceIdentity.readWorkspaceConnectionSelf(token.data);
          if (!current || current.workspaceId !== self.workspaceId) {
            client.close(4001, "workspace authorization expired");
            return;
          }
          if (client.readyState !== WebSocket.OPEN) return;
          if (client.bufferedAmount > 1024) {
            client.close(4000, "workspace invalidation backpressure");
            return;
          }
          client.send(
            JSON.stringify(
              workspaceMembersInvalidatedSchema.parse({
                type: "workspace.members.invalidated",
                schemaVersion: "workspace-setup/v1",
                workspaceId: self.workspaceId
              })
            ),
            (error) => {
              if (error) client.terminate();
            }
          );
        };
        const release = options.workspaceIdentity.subscribeMembers(self.workspaceId, notify);
        client.on("close", release);
        client.on("error", () => client.terminate());
        client.on("message", () => client.close(4000, "read only channel"));
        // Every admitted connection revalidates HTTP authority, including changes missed offline.
        notify();
      });
    }
  });
  return {
    async close(): Promise<void> {
      unregister();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}
