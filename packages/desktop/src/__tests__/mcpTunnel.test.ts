import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTunnelClientBinaryStartError, resolveTunnelClientBinary } from "../main/mcpTunnel/tunnelClientBinary";
import { downloadOfficialTunnelClient, parseSha256Sums, selectTunnelClientReleaseAssets, tunnelClientPlatformAsset } from "../main/mcpTunnel/tunnelClientDownloader";
import { readTunnelClientConfig, writeTunnelClientConfig } from "../main/mcpTunnel/tunnelClientStore";

async function writeTunnelClientScript(name = "tunnel-client"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-tunnel-client-"));
  const binaryPath = join(dir, name);
  await writeFile(
    binaryPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "tunnel-client test"
  exit 0
fi
if [ "$1" = "init" ]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  health_url_file=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--health.url-file" ]; then
      health_url_file="$arg"
      break
    fi
    previous="$arg"
  done
  echo "http://127.0.0.1:12345" > "$health_url_file"
  trap "exit 0" TERM INT
  while true; do sleep 1; done
fi
exit 1
`
  );
  await chmod(binaryPath, 0o700);
  return binaryPath;
}

async function writeFailingInitTunnelClientScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-tunnel-client-"));
  const binaryPath = join(dir, "tunnel-client");
  await writeFile(
    binaryPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "tunnel-client test"
  exit 0
fi
if [ "$1" = "init" ]; then
  echo "secret-runtime-key tunnel_0123456789abcdef0123456789abcdef" >&2
  exit 2
fi
exit 1
`
  );
  await chmod(binaryPath, 0o700);
  return binaryPath;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP tunnel process helpers", () => {
  it("builds tunnel-client commands for an HTTP MCP endpoint", async () => {
    const { buildTunnelClientInitArgs, buildTunnelClientRunArgs } = await import("../main/mcpTunnel/tunnelClientProcess");

    expect(
      buildTunnelClientInitArgs({
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        mcpServerUrl: "http://127.0.0.1:8787/mcp"
      })
    ).toEqual([
      "init",
      "--sample",
      "sample_mcp_with_dcr",
      "--profile",
      "planweave-local-http",
      "--force",
      "--tunnel-id",
      "tunnel_0123456789abcdef0123456789abcdef",
      "--mcp-server-url",
      "http://127.0.0.1:8787/mcp"
    ]);
    expect(buildTunnelClientRunArgs("/tmp/planweave-health-url")).toEqual([
      "run",
      "--profile",
      "planweave-local-http",
      "--harpoon.allow-plaintext-http",
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      "/tmp/planweave-health-url"
    ]);
  });

  it("marks the tunnel running only after the health endpoint is ready", async () => {
    const { TunnelClientProcessManager } = await import("../main/mcpTunnel/tunnelClientProcess");
    const binaryPath = await writeTunnelClientScript();
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const manager = new TunnelClientProcessManager();

    const status = await manager.start({
      binaryPath,
      localMcpEndpoint: "http://127.0.0.1:8787/mcp",
      input: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeApiKey: "secret-runtime-key"
      }
    });

    expect(status.phase).toBe("running");
    expect(status.ready).toBe(true);
    expect(status.healthUrl).toBe("http://127.0.0.1:12345");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:12345/readyz");
    expect(JSON.stringify(status)).not.toContain("secret-runtime-key");

    await manager.stop();
  });

  it("polls the health endpoint until the tunnel becomes ready", async () => {
    const { TunnelClientProcessManager } = await import("../main/mcpTunnel/tunnelClientProcess");
    const binaryPath = await writeTunnelClientScript();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not ready", { status: 503 }))
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const manager = new TunnelClientProcessManager({ readyTimeoutMs: 500 });

    const status = await manager.start({
      binaryPath,
      localMcpEndpoint: "http://127.0.0.1:8787/mcp",
      input: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeApiKey: "secret-runtime-key"
      }
    });

    expect(status.phase).toBe("running");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await manager.stop();
  });

  it("keeps the tunnel in error when the health endpoint is not ready", async () => {
    const { TunnelClientProcessManager } = await import("../main/mcpTunnel/tunnelClientProcess");
    const binaryPath = await writeTunnelClientScript();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not ready", { status: 503 })));
    const manager = new TunnelClientProcessManager({ readyTimeoutMs: 50 });

    const status = await manager.start({
      binaryPath,
      localMcpEndpoint: "http://127.0.0.1:8787/mcp",
      input: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeApiKey: "secret-runtime-key"
      }
    });

    expect(status.phase).toBe("error");
    expect(status.ready).toBe(false);
    expect(status.error).toBe("tunnel-client started but /readyz is not ready.");
  });

  it("allows manually configured tunnel-client binaries when they are executable and not quarantined", async () => {
    const binaryPath = await writeTunnelClientScript();
    const actualSha256 = await sha256(binaryPath);

    const status = await resolveTunnelClientBinary(binaryPath);

    expect(status).toEqual({
      path: binaryPath,
      available: true,
      source: "manual",
      assetName: null,
      assetSha256: null,
      sha256: actualSha256,
      version: null,
      verified: false,
      error: null
    });
    expect(getTunnelClientBinaryStartError(status)).toBeNull();
  });

  it("reports macOS quarantine before launching a manually configured tunnel-client", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    const binaryPath = await writeTunnelClientScript();
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;PlanWeaveTest;", binaryPath], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const status = await resolveTunnelClientBinary(binaryPath);

    expect(status.available).toBe(false);
    expect(status.error).toBe(
      "macOS blocked tunnel-client because the downloaded file is quarantined. Allow it in Privacy & Security or remove the quarantine attribute before starting."
    );
    expect(getTunnelClientBinaryStartError(status)).toBe(status.error);
  });

  it("still blocks managed tunnel-client installs when verification metadata is incomplete", async () => {
    const binaryPath = await writeTunnelClientScript();
    const actualSha256 = await sha256(binaryPath);

    const status = await resolveTunnelClientBinary(binaryPath, {
      assetName: "tunnel-client-test-darwin-arm64.zip",
      assetSha256: "1".repeat(64),
      binarySha256: ""
    });

    expect(status).toEqual({
      path: binaryPath,
      available: true,
      source: "managed",
      assetName: "tunnel-client-test-darwin-arm64.zip",
      assetSha256: "1".repeat(64),
      sha256: actualSha256,
      version: null,
      verified: false,
      error: "Managed tunnel-client install metadata is missing the binary checksum."
    });
    expect(getTunnelClientBinaryStartError(status)).toBe("Managed tunnel-client install metadata is missing the binary checksum.");
  });

  it("verifies managed tunnel-client binaries with matching install metadata", async () => {
    const binaryPath = await writeTunnelClientScript();
    const actualSha256 = await sha256(binaryPath);

    await expect(
      resolveTunnelClientBinary(binaryPath, {
        assetName: "tunnel-client-test-darwin-arm64.zip",
        assetSha256: "1".repeat(64),
        binarySha256: actualSha256
      })
    ).resolves.toEqual({
      path: binaryPath,
      available: true,
      source: "managed",
      assetName: "tunnel-client-test-darwin-arm64.zip",
      assetSha256: "1".repeat(64),
      sha256: actualSha256,
      version: "tunnel-client test",
      verified: true,
      error: null
    });
  });

  it("does not execute tunnel-client before checksum verification passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tunnel-client-"));
    const markerPath = join(dir, "version-called");
    const binaryPath = join(dir, "tunnel-client");
    await writeFile(
      binaryPath,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "called" > "${markerPath}"
  echo "tunnel-client test"
  exit 0
fi
exit 1
`
    );
    await chmod(binaryPath, 0o700);

    const status = await resolveTunnelClientBinary(binaryPath, {
      assetName: "tunnel-client-test-darwin-arm64.zip",
      assetSha256: "1".repeat(64),
      binarySha256: "0".repeat(64)
    });

    expect(status).toMatchObject({
      path: binaryPath,
      available: true,
      source: "managed",
      assetName: "tunnel-client-test-darwin-arm64.zip",
      version: null,
      verified: false,
      error: "Managed tunnel-client binary checksum does not match."
    });
    await expect(exists(markerPath)).resolves.toBe(false);
  });

  it("accepts Windows tunnel-client.exe binary names", async () => {
    const binaryPath = await writeTunnelClientScript("tunnel-client.exe");

    await expect(resolveTunnelClientBinary(binaryPath)).resolves.toMatchObject({
      path: binaryPath,
      available: true,
      source: "manual",
      verified: false
    });
  });

  it("rejects executable binaries that are not named tunnel-client", async () => {
    const binaryPath = await writeTunnelClientScript("not-the-client");

    await expect(resolveTunnelClientBinary(binaryPath)).resolves.toEqual({
      path: binaryPath,
      available: false,
      source: "manual",
      assetName: null,
      assetSha256: null,
      sha256: null,
      version: null,
      verified: false,
      error: "Configured binary must be named tunnel-client or tunnel-client.exe."
    });
  });

  it("selects platform release zips and parses official SHA256SUMS entries", () => {
    const release = {
      tag_name: "v0.0.9",
      assets: [
        { name: "SHA256SUMS.txt", browser_download_url: "https://example.test/SHA256SUMS.txt" },
        { name: "tunnel-client-v0.0.9-windows-amd64.zip", browser_download_url: "https://example.test/windows.zip" }
      ]
    };
    const selected = selectTunnelClientReleaseAssets(release, {
      assetSuffix: "windows-amd64.zip",
      binaryName: "tunnel-client.exe"
    });

    expect(selected.platformZipAsset.name).toBe("tunnel-client-v0.0.9-windows-amd64.zip");
    expect(parseSha256Sums(`${"a".repeat(64)}  tunnel-client-v0.0.9-windows-amd64.zip\n`)).toEqual(
      new Map([["tunnel-client-v0.0.9-windows-amd64.zip", "a".repeat(64)]])
    );
  });

  it("downloads the official platform zip, verifies its checksum, and stores the extracted binary", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const platformAsset = tunnelClientPlatformAsset();
    const assetName = `tunnel-client-test-${platformAsset.assetSuffix}`;
    const binaryBytes = new TextEncoder().encode("binary-from-official-zip");
    const zipBytes = zipSync({ [platformAsset.binaryName]: binaryBytes });
    const zipHash = createHash("sha256").update(zipBytes).digest("hex");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            tag_name: "v-test",
            assets: [
              { name: "SHA256SUMS.txt", browser_download_url: "https://example.test/SHA256SUMS.txt" },
              { name: assetName, browser_download_url: "https://example.test/platform.zip" }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("SHA256SUMS.txt")) {
        return new Response(`${zipHash}  ${assetName}\n`, { status: 200 });
      }
      if (url.endsWith("platform.zip")) {
        return new Response(zipBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadOfficialTunnelClient(userDataDir);

    await expect(readFile(result.binaryPath)).resolves.toEqual(Buffer.from(binaryBytes));
    expect(result.verification).toEqual({
      assetName,
      assetSha256: zipHash,
      binarySha256: createHash("sha256").update(binaryBytes).digest("hex")
    });
  });

  it("reports a release page fallback when GitHub API rate limits release metadata", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("API rate limit exceeded", { status: 403 }))
    );

    await expect(downloadOfficialTunnelClient(userDataDir)).rejects.toThrow(
      "GitHub API rate limit blocked tunnel-client metadata. Open https://github.com/openai/tunnel-client/releases/latest and try again later."
    );
  });

  it("persists tunnel-client path and managed verification metadata", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const config = {
      tunnelClientPath: "/tmp/tunnel-client",
      verification: {
        assetName: "tunnel-client-test-darwin-arm64.zip",
        assetSha256: "1".repeat(64),
        binarySha256: "2".repeat(64)
      },
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      encryptedRuntimeApiKey: "encrypted-runtime-key"
    };

    await writeTunnelClientConfig(userDataDir, config);

    await expect(readTunnelClientConfig(userDataDir)).resolves.toEqual(config);
  });

  it("redacts runtime API keys and tunnel IDs from tunnel-client init failures", async () => {
    const { TunnelClientProcessManager } = await import("../main/mcpTunnel/tunnelClientProcess");
    const binaryPath = await writeFailingInitTunnelClientScript();
    const manager = new TunnelClientProcessManager();

    const status = await manager.start({
      binaryPath,
      localMcpEndpoint: "http://127.0.0.1:8787/mcp",
      input: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeApiKey: "secret-runtime-key"
      }
    });

    expect(status.phase).toBe("error");
    expect(status.error).toContain("[redacted-runtime-api-key]");
    expect(status.error).toContain("[redacted-tunnel-id]");
    expect(JSON.stringify(status)).not.toContain("secret-runtime-key");
    expect(status.error).not.toContain("tunnel_0123456789abcdef0123456789abcdef");
  });

  it("registers cleanup for MCP tunnel processes before app quit", async () => {
    const source = await readFile(join(process.cwd(), "packages/desktop/src/main/main.ts"), "utf8");

    expect(source).toContain("stopMcpTunnelProcesses");
    expect(source).toContain('app.on("before-quit"');
  });
});
