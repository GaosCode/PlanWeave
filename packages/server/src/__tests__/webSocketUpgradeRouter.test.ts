import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";

const routers: WebSocketUpgradeRouter[] = [];

function setup() {
  const server = createServer();
  const router = new WebSocketUpgradeRouter(server);
  routers.push(router);
  const socket = new PassThrough();
  const request = new IncomingMessage(new Socket());
  request.url = "/upgrade?token=request-secret";
  let response = "";
  socket.on("data", (chunk: Buffer) => {
    response += chunk.toString();
  });
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    server,
    router,
    socket,
    closed,
    diagnostic,
    response: () => response,
    upgrade: () => server.emit("upgrade", request, socket, Buffer.alloc(0))
  };
}

afterEach(() => {
  for (const router of routers.splice(0)) router.close();
  vi.restoreAllMocks();
});

describe("WebSocket upgrade failure ownership", () => {
  it.each([
    "void",
    "promise"
  ] as const)("preserves a normal %s handler completion", async (kind) => {
    const fixture = setup();
    fixture.router.register({
      matches: () => true,
      handle(_request, _socket, _head, upgrade) {
        upgrade.reject(401, "Unauthorized");
        if (kind === "promise") return Promise.resolve();
      }
    });
    fixture.upgrade();
    await fixture.closed;
    expect(fixture.response()).toContain("HTTP/1.1 401 Unauthorized\r\n");
    expect(fixture.diagnostic).not.toHaveBeenCalled();
  });

  it.each([
    "matches",
    "sync",
    "async"
  ] as const)("contains a %s failure and redacts diagnostics", async (kind) => {
    const fixture = setup();
    fixture.router.register({
      matches() {
        if (kind === "matches") throw new Error("token=match-secret /Users/private");
        return true;
      },
      handle() {
        const error = new Error("token=handler-secret /Users/private");
        if (kind === "async") return Promise.reject(error);
        throw error;
      }
    });
    expect(fixture.upgrade).not.toThrow();
    await fixture.closed;
    expect(fixture.response()).toBe(
      "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    expect(fixture.diagnostic.mock.calls).toEqual([
      [
        JSON.stringify({
          scope: "websocket-upgrade",
          event: "upgrade_failed",
          phase: kind === "matches" ? "matches" : "handler"
        })
      ]
    ]);
  });

  it.each([0, 2])("rejects %i matching routes with the existing 404", async (count) => {
    const fixture = setup();
    const handle = vi.fn();
    for (let index = 0; index < count; index++)
      fixture.router.register({ matches: () => true, handle });
    fixture.upgrade();
    await fixture.closed;
    expect(fixture.response()).toContain("HTTP/1.1 404 Not Found\r\n");
    expect(handle).not.toHaveBeenCalled();
    expect(fixture.diagnostic).not.toHaveBeenCalled();
  });

  it("does not send HTTP after the handler takes handshake ownership", async () => {
    const fixture = setup();
    fixture.router.register({
      matches: () => true,
      async handle(_request, socket, _head, upgrade) {
        expect(upgrade.handoff()).toBe(true);
        socket.write("HTTP/1.1 101 Switching Protocols\r\n\r\n");
        throw new Error("post-handshake-secret");
      }
    });
    fixture.upgrade();
    await fixture.closed;
    expect(fixture.response()).toBe("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    expect(fixture.diagnostic).toHaveBeenCalledOnce();
  });

  it("completes an explicit rejection once even if the handler then fails", async () => {
    const fixture = setup();
    fixture.router.register({
      matches: () => true,
      handle(_request, _socket, _head, upgrade) {
        upgrade.reject(401, "Unauthorized");
        upgrade.reject(403, "Forbidden");
        expect(upgrade.handoff()).toBe(false);
        throw new Error("after-rejection");
      }
    });
    fixture.upgrade();
    await fixture.closed;
    expect(fixture.response()).toBe(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
  });

  it.each(["sync", "async"] as const)("contains %s response write failures", async (kind) => {
    const fixture = setup();
    if (kind === "sync") {
      vi.spyOn(fixture.socket, "write").mockImplementation(() => {
        throw new Error("write-secret");
      });
    } else {
      fixture.socket._write = (_chunk, _encoding, callback) => callback(new Error("write-secret"));
    }
    expect(fixture.upgrade).not.toThrow();
    await fixture.closed;
    expect(fixture.socket.destroyed).toBe(true);
    expect(fixture.diagnostic.mock.calls).toEqual([
      [
        JSON.stringify({
          scope: "websocket-upgrade",
          event: "upgrade_failed",
          phase: "response"
        })
      ]
    ]);
  });

  it("does not invoke a handler for a client that already disconnected", async () => {
    const fixture = setup();
    const handle = vi.fn();
    fixture.router.register({ matches: () => true, handle });
    fixture.socket.destroy();
    fixture.upgrade();
    await fixture.closed;
    expect(handle).not.toHaveBeenCalled();
    expect(fixture.response()).toBe("");
  });

  it("denies handoff when the router closes while the handler is pending", async () => {
    const fixture = setup();
    let resume = () => {};
    const ready = new Promise<void>((resolve) => {
      resume = resolve;
    });
    fixture.router.register({
      matches: () => true,
      async handle(_request, _socket, _head, upgrade) {
        await ready;
        expect(upgrade.handoff()).toBe(false);
      }
    });
    fixture.upgrade();
    fixture.router.close();
    resume();
    await fixture.closed;
    expect(fixture.response()).toContain("HTTP/1.1 404 Not Found\r\n");
  });

  it("unregisters routes and closes its listener idempotently", async () => {
    const fixture = setup();
    const handle = vi.fn();
    const unregister = fixture.router.register({ matches: () => true, handle });
    unregister();
    unregister();
    fixture.upgrade();
    await fixture.closed;
    expect(fixture.response()).toContain("HTTP/1.1 404 Not Found\r\n");
    expect(handle).not.toHaveBeenCalled();
    fixture.router.close();
    fixture.router.close();
    expect(fixture.server.listenerCount("upgrade")).toBe(0);
    expect(() => fixture.router.register({ matches: () => true, handle })).toThrow(
      "websocket_upgrade_router_closed"
    );
  });
});
