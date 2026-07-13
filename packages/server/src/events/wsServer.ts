import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket as WsWebSocket, type WebSocket as WsWebSocketType } from "ws";
import type { EventPublisher } from "./publisher.js";
import { dequeueEvent } from "./subscriber.js";
import type { Authenticator, EventEnvelopeV1, WebSocketEventV1 } from "./types.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_MISS_LIMIT,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_RESYNC_REQUIRED,
  WS_CLOSE_UNAUTHENTICATED,
} from "./types.js";

// EventWebSocketServer — the realtime listener for durable domain events.
//
// Mounted on a dedicated `node:http` listener per ADR-002 (kept separate from the
// existing /healthz and /readyz listener in `lifecycle.ts`).
//
// WebSocket path: `/events`.
// HTTP wire format: every WS message is a `WebSocketEventV1` (kind: "event" wrapping an
// `EventEnvelopeV1`). The wire carries ONLY invalidations — clients fetch authoritative
// state via the HTTP snapshot/events-replay APIs.
//
// Lifecycle:
//   1. Client opens a WebSocket upgrade on `/events` with an Authorization header (CLI /
//      Electron main-process) or a single-use WebSocket ticket (browser, per ADR-002).
//   2. We hand the upgrade to the configured `Authenticator` (pluggable — A3 will provide
//      the production impl). On success we get a `SubscriberIdentity`.
//   3. We attach a `Subscriber` to the `EventPublisher` and bind the WebSocket to it.
//   4. The publisher's poll loop enqueues events; the wsServer drains the queue onto the
//      socket on every `drain` and on a 30s tick.
//   5. Heartbeat: wsServer pings every 30s; a client that misses 2 pongs is closed 1001.
//   6. Slow consumer: when the publisher marks a subscriber for close with 4408, the
//      wsServer sends the close frame and tears down the socket. The client resyncs via
//      `GET /api/v1/projects/{projectId}/events?afterEventId=...` + the snapshot API.

export type EventWebSocketServerOptions = {
  publisher: EventPublisher;
  authenticator: Authenticator;
  /** Attach upgrades to an existing application server when provided. */
  httpServer?: Server;
  // Override the WS path (default `/events`).
  wsPath?: string;
  // Heartbeat tuning — defaults match A4 spec.
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
};

export type EventWebSocketServer = {
  httpServer: Server;
  wss: WebSocketServer;
  // Port the underlying HTTP listener is bound to (0 means ephemeral; resolved at start).
  address(): { port: number; host: string } | null;
  start(): Promise<void>;
  close(): Promise<void>;
  // Number of currently-open WebSocket connections.
  connectionCount(): number;
};

const DEFAULT_WS_PATH = "/events";

export function createEventWebSocketServer(options: EventWebSocketServerOptions): EventWebSocketServer {
  const wsPath = options.wsPath ?? DEFAULT_WS_PATH;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatMissLimit = options.heartbeatMissLimit ?? DEFAULT_HEARTBEAT_MISS_LIMIT;

  const ownsHttpServer = options.httpServer === undefined;
  const httpServer = options.httpServer ?? createServer((request: IncomingMessage, response: ServerResponse) => {
    // The dedicated listener is for WebSocket upgrades only. Anything else gets a 404
    // with the standard ApiError envelope.
    const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    if (path === "/healthz" || path === "/readyz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: request.headers["x-request-id"]?.toString() ?? "", retryable: false } }));
  });

  const wss = new WebSocketServer({ noServer: true, path: wsPath });

  // Per-connection state tracked in a side map (keyed by the WebSocket instance).
  // We use this to:
  //   - run the heartbeat (ping/pong) loop and detect dead clients
  //   - drain the subscriber queue to the socket on every drain
  //   - tear down cleanly on close
  type ConnectionState = { subscriber: ReturnType<EventPublisher["attach"]>; socket: WsWebSocketType; missedPongs: number; lastPongAt: number; drainTimer: ReturnType<typeof setInterval> | null; pingTimer: ReturnType<typeof setInterval> | null; closed: boolean };
  const connections = new WeakMap<WsWebSocketType, ConnectionState>();
  let liveConnections = 0;

  function authenticateUpgrade(request: IncomingMessage): ReturnType<Authenticator> {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) headers[key] = value;
    return options.authenticator({ headers, url: request.url });
  }

  function sendEnvelope(socket: WsWebSocketType, envelope: EventEnvelopeV1): boolean {
    if (socket.readyState !== WsWebSocket.OPEN) return false;
    const message: WebSocketEventV1 = { kind: "event", event: envelope };
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function closeSocket(socket: WsWebSocketType, code: number, reason: string): void {
    if (socket.readyState === WsWebSocket.CLOSED || socket.readyState === WsWebSocket.CLOSING) return;
    try {
      socket.close(code, reason);
    } catch {
      // best-effort
    }
  }

  function teardownConnection(state: ConnectionState, reasonCode: number, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    if (state.drainTimer) clearInterval(state.drainTimer);
    if (state.pingTimer) clearInterval(state.pingTimer);
    // Detach from the publisher.
    options.publisher.detach(state.subscriber, { code: reasonCode, reason: reason as never });
    liveConnections = Math.max(0, liveConnections - 1);
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    if (path !== wsPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    void authenticateUpgrade(request).then((result) => {
      if (!result.ok) {
        // Reject the upgrade with a 401/403 so unauthenticated/forbidden clients never
        // get a WebSocket session. The custom close codes (WS_CLOSE_UNAUTHENTICATED=4401,
        // WS_CLOSE_FORBIDDEN=4403) are documented as the contract-equivalent values for
        // callers that bypass the HTTP-level reject (e.g. some browsers/CLI shims that
        // ignore HTTP 401/403 on upgrade). We do NOT log secrets.
        if (result.reason === "unauthenticated") {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\nWWW-Authenticate: Bearer\r\n\r\n");
        } else {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        const afterEventId = url.searchParams.get("afterEventId") ?? "0";
        if (!/^\d+$/.test(afterEventId)) {
          closeSocket(ws, WS_CLOSE_RESYNC_REQUIRED, "invalid_cursor");
          return;
        }
        const subscriber = options.publisher.attach({ identity: result.identity, initialLastSeenEventId: afterEventId });
        const state: ConnectionState = { subscriber, socket: ws, missedPongs: 0, lastPongAt: Date.now(), drainTimer: null, pingTimer: null, closed: false };
        connections.set(ws, state);
        liveConnections += 1;
        // Drain the queue every 50ms — bounded to a low interval so tests don't have
        // to wait long for delivery. The 50ms is independent of the publisher's poll
        // interval; the publisher enqueues, the wsServer drains.
        state.drainTimer = setInterval(() => {
          if (state.closed) return;
          // Check for publisher-side close (e.g. slow consumer marked us 4408).
          if (subscriber.closed) {
            const reason = subscriber.closeReason;
            closeSocket(ws, reason?.code ?? WS_CLOSE_GOING_AWAY, reason?.reason ?? "going_away");
            teardownConnection(state, reason?.code ?? WS_CLOSE_GOING_AWAY, reason?.reason ?? "going_away");
            return;
          }
          // Drain at most 100 events per tick to keep CPU bounded.
          let drained = 0;
          while (drained < 100) {
            const event = dequeueEvent(subscriber);
            if (!event) break;
            if (sendEnvelope(ws, event)) {
              options.publisher.acknowledgeDelivery(subscriber, event.eventId);
              drained += 1;
            } else {
              // Re-queue and try later.
              subscriber.queue.unshift(event);
              break;
            }
          }
        }, 50);
        // Heartbeat: ping every heartbeatIntervalMs; count missed pongs.
        state.pingTimer = setInterval(() => {
          if (state.closed) return;
          if (ws.readyState !== WsWebSocket.OPEN) return;
          if (state.missedPongs >= heartbeatMissLimit) {
            closeSocket(ws, WS_CLOSE_GOING_AWAY, "going_away");
            teardownConnection(state, WS_CLOSE_GOING_AWAY, "going_away");
            return;
          }
          state.missedPongs += 1;
          try {
            ws.ping();
          } catch {
            // ignore
          }
        }, heartbeatIntervalMs);
        ws.on("pong", () => {
          state.missedPongs = 0;
          state.lastPongAt = Date.now();
          options.publisher.heartbeat(subscriber);
        });
        ws.on("close", (code, reason) => {
          teardownConnection(state, code ?? WS_CLOSE_GOING_AWAY, reason.toString("utf8") || "going_away");
        });
        ws.on("error", () => {
          // Best-effort teardown — the `close` handler will also fire.
        });
      });
    }).catch(() => {
      try {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
      } catch {
        // ignore
      }
    });
  });

  return {
    httpServer,
    wss,
    address() {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") {
        const a = addr as AddressInfo;
        return { port: a.port, host: a.address };
      }
      return null;
    },
    async start() {
      if (httpServer.listening) return;
      if (!ownsHttpServer) return;
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
    },
    async close() {
      for (const ws of wss.clients) {
        try {
          ws.close(WS_CLOSE_GOING_AWAY, "going_away");
        } catch {
          // ignore
        }
      }
      if (ownsHttpServer) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      } else {
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
    connectionCount() {
      return liveConnections;
    },
  };
}

export const WS_PATH = DEFAULT_WS_PATH;
