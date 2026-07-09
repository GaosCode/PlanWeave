import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileTunnelConfigStore } from "../tunnel/configStore.js";
import { getTunnelStatusReport, resolveRuntimeApiKey } from "../tunnel/status.js";

describe("MCP tunnel status", () => {
  it("resolves Runtime API key from env without exposing the value in status", () => {
    expect(
      resolveRuntimeApiKey({
        OPENAI_RUNTIME_API_KEY: " openai-key ",
        CONTROL_PLANE_API_KEY: "control-key"
      })
    ).toEqual({
      available: true,
      source: "OPENAI_RUNTIME_API_KEY",
      value: "openai-key"
    });
  });

  it("reports missing config pieces without starting processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-status-"));
    const report = await getTunnelStatusReport(
      createFileTunnelConfigStore(join(dir, "config.json")),
      {}
    );

    expect(report.configured).toBe(false);
    expect(report.binary.available).toBe(false);
    expect(report.runtimeApiKey).toEqual({ available: false, source: null });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "binary_configured", status: "failed" }),
        expect.objectContaining({ check: "runtime_api_key_available", status: "failed" }),
        expect.objectContaining({ check: "mcp_url_loopback", status: "passed" })
      ])
    );
  });

  it("does not report configured when a managed binary checksum fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-mcp-status-checksum-"));
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binaryPath, 0o700);
    const store = createFileTunnelConfigStore(join(dir, "config.json"));
    await store.write({
      version: "mcp-tunnel/v1",
      tunnelClientPath: binaryPath,
      verification: {
        assetName: "tunnel-client-test-linux-amd64.zip",
        assetSha256: "1".repeat(64),
        binarySha256: "0".repeat(64)
      },
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:8787/mcp"
    });

    const report = await getTunnelStatusReport(store, { OPENAI_RUNTIME_API_KEY: "runtime-key" });

    expect(report.binary.available).toBe(true);
    expect(report.binary.verified).toBe(false);
    expect(report.configured).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "binary_checksum", status: "failed" })
      ])
    );
  });
});
