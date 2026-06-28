import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultTunnelConfig, createFileTunnelConfigStore, normalizeTunnelConfig } from "../tunnel/configStore.js";

describe("MCP tunnel config store", () => {
  it("returns defaults when config is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-config-"));
    const store = createFileTunnelConfigStore(join(dir, "config", "mcp-tunnel", "config.json"));

    await expect(store.read()).resolves.toEqual(createDefaultTunnelConfig());
  });

  it("writes normalized config atomically with private permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-config-"));
    const configPath = join(dir, "config", "mcp-tunnel", "config.json");
    const store = createFileTunnelConfigStore(configPath);

    await store.write({
      version: "mcp-tunnel/v1",
      tunnelClientPath: " /bin/tunnel-client ",
      verification: {
        assetName: "asset.zip",
        assetSha256: "a".repeat(64),
        binarySha256: "b".repeat(64)
      },
      tunnelId: " tunnel_test ",
      mcpUrl: " http://localhost:8787/mcp "
    });

    expect(await store.read()).toMatchObject({
      tunnelClientPath: "/bin/tunnel-client",
      tunnelId: "tunnel_test",
      mcpUrl: "http://localhost:8787/mcp"
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      tunnelClientPath: "/bin/tunnel-client",
      tunnelId: "tunnel_test"
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("fails clearly for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-config-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "{", "utf8");
    await chmod(configPath, 0o600);
    const store = createFileTunnelConfigStore(configPath);

    await expect(store.read()).rejects.toThrow("Failed to read MCP tunnel config");
  });

  it("rejects non-loopback MCP URLs", () => {
    expect(() =>
      normalizeTunnelConfig({
        version: "mcp-tunnel/v1",
        tunnelClientPath: null,
        verification: null,
        tunnelId: null,
        mcpUrl: "http://example.com:8787/mcp"
      })
    ).toThrow("mcpUrl must use a loopback host");
  });
});
