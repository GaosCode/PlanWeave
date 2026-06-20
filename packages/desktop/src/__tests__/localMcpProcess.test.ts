import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@planweave-ai/mcp");
  vi.doUnmock("@planweave-ai/runtime");
  vi.resetModules();
});

describe("LocalMcpServerManager", () => {
  it("starts the local MCP server with persistent OAuth token storage", async () => {
    const close = vi.fn((callback: (error?: Error) => void) => callback());
    const listenPlanweaveMcpServer = vi.fn(async () => ({ close }));
    vi.doMock("@planweave-ai/mcp", () => ({ listenPlanweaveMcpServer }));
    vi.doMock("@planweave-ai/runtime", () => ({ resolvePlanweaveHome: () => "/tmp/planweave-home" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const { LocalMcpServerManager } = await import("../main/mcpTunnel/localMcpProcess");
    const manager = new LocalMcpServerManager();

    await manager.start();

    expect(listenPlanweaveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        oauth: {
          enabled: true,
          accessTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
          clientStorePath: "/tmp/planweave-home/desktop/mcp-oauth-clients.json",
          tokenStorePath: "/tmp/planweave-home/desktop/mcp-oauth-tokens.json"
        }
      })
    );

    await manager.stop();
  });
});
