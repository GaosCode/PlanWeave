import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type {
  CanvasCommandWebSocketServer,
  CanvasLiveSyncWebSocketServer
} from "./canvas/index.js";
import type { HumanObserverWebSocketServer } from "./humanObserverWs.js";
import type { CanvasPresenceWebSocketServer } from "./presenceWebSocket.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import type { AgentHostWebSocketServer } from "./wsServer.js";

async function waitForInflightRequests(
  requests: ReadonlySet<Promise<void>>,
  timeoutMs: number
): Promise<void> {
  if (requests.size === 0) return;
  const settled = Promise.allSettled([...requests]).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    settled.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) throw new Error("server_http_inflight_drain_timeout");
}

export async function drainCompositionTransports(input: {
  httpServer: HttpServer;
  requestListener?: (request: IncomingMessage, response: ServerResponse) => void;
  webSockets?: AgentHostWebSocketServer;
  humanObserverWebSockets?: HumanObserverWebSocketServer;
  workspaceMembersWebSockets?: { close(): Promise<void> };
  canvasPresenceWebSockets?: CanvasPresenceWebSocketServer;
  canvasCommandWebSockets?: CanvasCommandWebSocketServer;
  canvasLiveSyncWebSockets?: CanvasLiveSyncWebSocketServer;
  upgradeRouter?: WebSocketUpgradeRouter;
  inflightRequests: ReadonlySet<Promise<void>>;
  shutdownTimeoutMs: number;
}): Promise<void> {
  const errors: unknown[] = [];
  if (input.requestListener) input.httpServer.off("request", input.requestListener);
  for (const transport of [
    input.webSockets,
    input.humanObserverWebSockets,
    input.workspaceMembersWebSockets,
    input.canvasPresenceWebSockets,
    input.canvasCommandWebSockets,
    input.canvasLiveSyncWebSockets
  ]) {
    try {
      await transport?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  input.upgradeRouter?.close();
  try {
    await waitForInflightRequests(input.inflightRequests, input.shutdownTimeoutMs);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "distributed_server_transport_drain_failed");
  }
}

export function closeCompositionStorage(input: {
  closeLifecycle?: () => void;
  closeRuntimeRegistry(): void;
}): void {
  const errors: unknown[] = [];
  try {
    input.closeLifecycle?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    input.closeRuntimeRegistry();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "distributed_server_cleanup_failed");
}

export function containsCleanupError(error: unknown, code: string): boolean {
  if (error instanceof Error && error.message === code) return true;
  return error instanceof AggregateError
    ? error.errors.some((nested) => containsCleanupError(nested, code))
    : false;
}
