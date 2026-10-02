import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfig } from "../config.js";

const boundary = vi.hoisted(() => ({ listen: vi.fn<(config: McpConfig) => Promise<Server>>() }));
vi.mock("../server.js", () => ({ listenPlanweaveMcpServer: boundary.listen }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const servers: Server[] = [];
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pw-local-lifecycle-"));
  vi.stubEnv("PLANWEAVE_HOME", home);
  boundary.listen.mockReset();
  vi.resetModules();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const server of servers) server.closeAllConnections();
  await Promise.allSettled(pending.splice(0));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function fixture(holdHealth = false) {
  const request = deferred<void>();
  const server = createServer((_req, res) => {
    request.resolve();
    if (!holdHealth) res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener.");
  boundary.listen.mockResolvedValue(server);
  const { LocalMcpServerManager } = await import("../tunnel/localMcpServer.js");
  const manager = new LocalMcpServerManager({ port: address.port });
  const start = () => {
    const result = manager.start();
    pending.push(result);
    return result;
  };
  return { manager, start, request, server };
}

describe("Local MCP asynchronous start ownership", () => {
  it("drains a pending listener and closes it before stop acknowledges", async () => {
    const f = await fixture();
    const gate = deferred<Server>();
    releases.push(() => gate.resolve(f.server));
    boundary.listen.mockReturnValue(gate.promise);
    const starting = f.start();
    await vi.waitFor(() => expect(boundary.listen).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = f.manager.stop().then(() => {
      stopped = true;
    });
    pending.push(stopping);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    gate.resolve(f.server);
    await stopping;
    expect((await starting).phase).toBe("stopped");
    expect(f.server.listening).toBe(false);
    expect(f.manager.getStatus().phase).toBe("stopped");
  });

  it("shares the pending listener between concurrent starts", async () => {
    const f = await fixture();
    const gate = deferred<Server>();
    releases.push(() => gate.resolve(f.server));
    boundary.listen.mockReturnValue(gate.promise);
    const first = f.start();
    const second = f.start();
    await vi.waitFor(() => expect(boundary.listen).toHaveBeenCalled());
    gate.resolve(f.server);
    await Promise.all([first, second]);
    expect(boundary.listen).toHaveBeenCalledOnce();
    await f.manager.stop();
  });

  it("cancels a real pending health request and drains the listener", async () => {
    const f = await fixture(true);
    const starting = f.start();
    await f.request.promise;
    await f.manager.stop();
    expect((await starting).phase).toBe("stopped");
    expect(f.server.listening).toBe(false);
    expect(f.manager.getStatus().phase).toBe("stopped");
  });

  it("recovers from listener failure and admits a restart only after the old stop", async () => {
    const f = await fixture();
    boundary.listen.mockRejectedValueOnce(new Error("listener-start-failed"));
    expect((await f.start()).phase).toBe("error");
    expect((await f.start()).phase).toBe("running");
    const port = f.manager.getStatus().port;
    boundary.listen.mockImplementation(
      () =>
        new Promise<Server>((resolve) => {
          f.server.listen(port, "127.0.0.1", () => resolve(f.server));
        })
    );
    const stopping = f.manager.stop();
    const repeated = f.manager.stop();
    const restarting = f.start();
    await Promise.all([stopping, repeated]);
    expect((await restarting).phase).toBe("running");
    expect(f.server.listening).toBe(true);
    await f.manager.stop();
    expect(f.server.listening).toBe(false);
  });

  it("reports a listener cleanup failure rather than acknowledging stopped", async () => {
    const f = await fixture();
    await f.start();
    vi.spyOn(f.server, "close").mockImplementationOnce(() => {
      throw new Error("close-failed");
    });
    await expect(f.manager.stop()).rejects.toThrow("close-failed");
    expect(f.manager.getStatus().phase).toBe("error");
    expect(f.server.listening).toBe(true);
    await f.manager.stop();
    expect(f.server.listening).toBe(false);
  });
  it("serves actual production health HTTP and closes its listener across restart", async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const address = portProbe.address();
    if (!address || typeof address === "string") throw new Error("Missing port probe.");
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    vi.doUnmock("../server.js");
    vi.resetModules();
    const { LocalMcpServerManager } = await import("../tunnel/localMcpServer.js");
    const manager = new LocalMcpServerManager({ port: address.port });
    try {
      const [first, duplicate] = await Promise.all([manager.start(), manager.start()]);
      expect(first.phase).toBe("running");
      expect(duplicate).toEqual(first);
      const health = `http://127.0.0.1:${address.port}/healthz`;
      expect((await fetch(health)).ok).toBe(true);
      await manager.stop();
      await expect(fetch(health)).rejects.toThrow();
      expect((await manager.start()).phase).toBe("running");
      expect((await fetch(health)).ok).toBe(true);
    } finally {
      await manager.stop();
      vi.doMock("../server.js", () => ({ listenPlanweaveMcpServer: boundary.listen }));
    }
  });
});
