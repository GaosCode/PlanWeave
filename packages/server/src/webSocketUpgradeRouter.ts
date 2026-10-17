import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

export type WebSocketUpgradeHandler = {
  matches(request: IncomingMessage): boolean;
  handle(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    upgrade: WebSocketUpgradeContext
  ): void | Promise<void>;
};

export type WebSocketUpgradeContext = {
  reject(status: number, message: string): void;
  /** Transfer ownership before attempting a handshake; HTTP rejection is no longer safe. */
  handoff(): boolean;
};

type FailurePhase = "matches" | "handler" | "response" | "socket";

function logFailure(phase: FailurePhase): void {
  console.error(JSON.stringify({ scope: "websocket-upgrade", event: "upgrade_failed", phase }));
}

export class WebSocketUpgradeRouter {
  private readonly handlers = new Set<WebSocketUpgradeHandler>();
  private closed = false;
  private readonly listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let state: "pending" | "handed_off" | "rejected" = "pending";
    const writable = () => !socket.destroyed && socket.writable && !socket.writableEnded;
    const onError = () => {
      logFailure("socket");
      socket.destroy();
    };
    socket.on("error", onError);
    socket.once("close", () => socket.off("error", onError));
    const upgrade: WebSocketUpgradeContext = {
      reject(status, message) {
        if (state !== "pending") return;
        state = "rejected";
        try {
          if (writable()) {
            socket.write(
              `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
              (error) => {
                if (error) {
                  logFailure("response");
                  socket.destroy();
                }
              }
            );
          }
        } catch {
          logFailure("response");
        } finally {
          socket.destroy();
        }
      },
      handoff: () => {
        if (state !== "pending") return false;
        if (this.closed || !writable()) {
          upgrade.reject(404, "Not Found");
          return false;
        }
        state = "handed_off";
        return true;
      }
    };
    const fail = (phase: FailurePhase) => {
      logFailure(phase);
      if (state === "pending") upgrade.reject(500, "Internal Server Error");
      else socket.destroy();
    };
    let phase: FailurePhase = "matches";
    try {
      if (this.closed || !writable()) {
        upgrade.reject(404, "Not Found");
        return;
      }
      const matches = [...this.handlers].filter((handler) => handler.matches(request));
      const handler = matches.length === 1 ? matches[0] : undefined;
      if (!handler) {
        upgrade.reject(404, "Not Found");
        return;
      }
      phase = "handler";
      void Promise.resolve(handler.handle(request, socket, head, upgrade)).catch(() =>
        fail("handler")
      );
    } catch {
      fail(phase);
    }
  };

  constructor(private readonly server: HttpServer) {
    server.on("upgrade", this.listener);
  }

  register(handler: WebSocketUpgradeHandler): () => void {
    if (this.closed) throw new Error("websocket_upgrade_router_closed");
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.off("upgrade", this.listener);
    this.handlers.clear();
  }
}
