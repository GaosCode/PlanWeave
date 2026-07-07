import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@planweave-ai/mcp/tunnel");
  vi.doUnmock("@planweave-ai/runtime");
  vi.resetModules();
});

describe("LocalMcpServerManager", () => {
  it("starts the local MCP server with persistent OAuth token storage", async () => {
    type LocalMcpServerManagerOptions = {
      oauth?: (planweaveHome: string) => unknown;
    };
    let capturedOptions: LocalMcpServerManagerOptions | null = null;
    const start = vi.fn(async () => ({
      phase: "running",
      endpoint: "http://127.0.0.1:8787/mcp",
      host: "127.0.0.1",
      port: 8787,
      pid: process.pid,
      planweaveHome: "/tmp/planweave-home",
      planweaveHomeFromEnv: false,
      healthy: true,
      error: null
    }));
    const stop = vi.fn(async () => ({
      phase: "stopped",
      endpoint: null,
      host: "127.0.0.1",
      port: 8787,
      pid: null,
      planweaveHome: "/tmp/planweave-home",
      planweaveHomeFromEnv: false,
      healthy: false,
      error: null
    }));
    vi.doMock("@planweave-ai/mcp/tunnel", () => ({
      LocalMcpServerManager: class {
        constructor(options: LocalMcpServerManagerOptions) {
          capturedOptions = options;
        }

        start = start;
        stop = stop;
      }
    }));
    const { LocalMcpServerManager } = await import("../main/mcpTunnel/localMcpProcess");
    const manager = new LocalMcpServerManager();

    await manager.start();

    expect(capturedOptions?.oauth?.("/tmp/planweave-home")).toEqual({
      enabled: true,
      accessTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
      clientStorePath: "/tmp/planweave-home/desktop/mcp-oauth-clients.json",
      tokenStorePath: "/tmp/planweave-home/desktop/mcp-oauth-tokens.json"
    });
    expect(start).toHaveBeenCalled();

    await manager.stop();
    expect(stop).toHaveBeenCalled();
  });
});
