import { createServer, type Server as HttpServer } from "node:http";
import {
  DEFAULT_HOST_EVENT_MAX_PAYLOAD_BYTES,
  HOST_EVENT_MAX_PAYLOAD_BYTES_HEADER,
  HOST_EVENT_PAYLOAD_BUDGET_VERSION_HEADER
} from "@planweave-ai/agent-host-protocol";
import { WebSocket, WebSocketServer } from "ws";

export function attachHostEventPayloadBudget(server: WebSocketServer): void {
  server.on("headers", (headers, request) => {
    if (request.headers[HOST_EVENT_PAYLOAD_BUDGET_VERSION_HEADER] === "1")
      headers.push(
        `${HOST_EVENT_MAX_PAYLOAD_BYTES_HEADER}: ${DEFAULT_HOST_EVENT_MAX_PAYLOAD_BYTES}`
      );
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function listen(server: HttpServer, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_host_transport_port");
  return address.port;
}

export class HostTransportSocketHarness {
  readonly httpServer = createServer();
  readonly webSocketServer = new WebSocketServer({ server: this.httpServer });
  readonly sockets = new Set<WebSocket>();
  private listeningPort = 0;

  static async open(port = 0): Promise<HostTransportSocketHarness> {
    const harness = new HostTransportSocketHarness();
    attachHostEventPayloadBudget(harness.webSocketServer);
    harness.listeningPort = await listen(harness.httpServer, port);
    harness.webSocketServer.on("connection", (socket) => {
      harness.sockets.add(socket);
      socket.once("close", () => harness.sockets.delete(socket));
    });
    return harness;
  }

  get port(): number {
    return this.listeningPort;
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(code = 1001, reason = "test server shutdown"): Promise<void> {
    await Promise.all(
      [...this.sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            socket.once("close", () => resolve());
            socket.close(code, reason);
          })
      )
    );
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
