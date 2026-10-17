import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ServerConfig } from "../config.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const readinessPath = "/readyz/ws";

function validWebSocketKey(value: string | string[] | undefined): value is string {
  if (!value || Array.isArray(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 16 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function connectionRequestsUpgrade(request: IncomingMessage): boolean {
  const connection = request.headers.connection;
  return (
    request.method === "GET" &&
    request.headers.upgrade?.toLowerCase() === "websocket" &&
    typeof connection === "string" &&
    connection.split(",").some((token) => token.trim().toLowerCase() === "upgrade") &&
    request.headers["sec-websocket-version"] === "13" &&
    validWebSocketKey(request.headers["sec-websocket-key"])
  );
}

export function attachReverseProxyWebSocketReadiness(options: {
  config: ServerConfig;
  upgradeRouter: WebSocketUpgradeRouter;
  transportAdmission: TransportAdmissionPolicy;
}): void {
  if (options.config.transport.mode !== "reverse_proxy_https") return;
  const advertisedOrigin = new URL(options.config.transport.advertisedOrigin).origin;
  options.upgradeRouter.register({
    matches: (request) => request.url === readinessPath,
    handle: (request, socket, _head, upgrade) => {
      if (!options.transportAdmission.allowsNetworkTransport(request.socket)) {
        upgrade.reject(426, "Upgrade Required");
        return;
      }
      if (request.headers.origin !== advertisedOrigin) {
        upgrade.reject(403, "Forbidden");
        return;
      }
      if (!connectionRequestsUpgrade(request)) {
        upgrade.reject(400, "Bad Request");
        return;
      }
      const key = request.headers["sec-websocket-key"];
      if (!validWebSocketKey(key)) {
        upgrade.reject(400, "Bad Request");
        return;
      }
      const accept = createHash("sha1").update(`${key}${webSocketGuid}`).digest("base64");
      if (!upgrade.handoff()) return;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    }
  });
}
