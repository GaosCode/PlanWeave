import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTunnelClientBinaryStartError,
  resolveTunnelClientBinary,
  resolveTunnelClientBinaryStartTarget,
  type TunnelClientBinaryStartTarget
} from "../main/mcpTunnel/tunnelClientBinary";
import {
  downloadOfficialTunnelClient,
  parseSha256Sums,
  selectTunnelClientReleaseAssets,
  tunnelClientPlatformAsset
} from "../main/mcpTunnel/tunnelClientDownloader";
import {
  mcpTunnelConfigPath,
  mcpTunnelConfigStorePaths,
  mcpTunnelLegacyConfigPath,
  readTunnelClientConfig,
  writeTunnelClientConfig
} from "../main/mcpTunnel/tunnelClientStore";

const tempRoots: string[] = [];
const originalPlanweaveHome = process.env.PLANWEAVE_HOME;

async function useTempPlanweaveHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
  tempRoots.push(home);
  process.env.PLANWEAVE_HOME = home;
  return home;
}

const electronMock = vi.hoisted(() => ({
  app: {
    getPath: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: {
    handle: vi.fn()
  },
  safeStorage: {
    decryptString: vi.fn((value: Buffer) =>
      Buffer.from(value.toString(), "base64").toString("utf8")
    ),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    isEncryptionAvailable: vi.fn(() => true)
  }
}));

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  ipcMain: electronMock.ipcMain,
  safeStorage: electronMock.safeStorage
}));

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

async function writeMarkerTunnelClientScript(markerPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-tunnel-client-"));
  const binaryPath = join(dir, "tunnel-client");
  await writeFile(
    binaryPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "tunnel-client test"
  exit 0
fi
if [ "$1" = "init" ] || [ "$1" = "run" ]; then
  echo "$1" >> "${markerPath}"
  exit 0
fi
exit 1
`
  );
  await chmod(binaryPath, 0o700);
  return binaryPath;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  if (originalPlanweaveHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = originalPlanweaveHome;
  }
  vi.doUnmock("../main/mcpTunnel/localMcpProcess");
  vi.doUnmock("../main/mcpTunnel/tunnelClientProcess");
  vi.doUnmock("../main/mcpTunnel/tunnelClientBinary");
  vi.doUnmock("../main/mcpTunnel/tunnelClientDownloader");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP tunnel process helpers", () => {
  it("builds tunnel-client commands for an HTTP MCP endpoint", async () => {
    const { buildTunnelClientInitArgs, buildTunnelClientRunArgs } = await import(
      "../main/mcpTunnel/tunnelClientProcess"
    );

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
    const binary = await resolveTunnelClientBinaryStartTarget(binaryPath);
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const manager = new TunnelClientProcessManager();

    const status = await manager.start({
      binary,
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
    const binary = await resolveTunnelClientBinaryStartTarget(binaryPath);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not ready", { status: 503 }))
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const manager = new TunnelClientProcessManager({ readyTimeoutMs: 500 });

    const status = await manager.start({
      binary,
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
    const binary = await resolveTunnelClientBinaryStartTarget(binaryPath);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not ready", { status: 503 })));
    const manager = new TunnelClientProcessManager({ readyTimeoutMs: 50 });

    const status = await manager.start({
      binary,
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

  it("does not start an unverified managed tunnel-client binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tunnel-client-"));
    const markerPath = join(dir, "started");
    const binaryPath = await writeMarkerTunnelClientScript(markerPath);
    await expect(
      resolveTunnelClientBinaryStartTarget(binaryPath, {
        assetName: "tunnel-client-test-darwin-arm64.zip",
        assetSha256: "1".repeat(64),
        binarySha256: ""
      })
    ).rejects.toThrow("Managed tunnel-client install metadata is missing the binary checksum.");
    await expect(exists(markerPath)).resolves.toBe(false);
  });

  it("does not start when the resolved tunnel-client binary is unavailable", async () => {
    await expect(
      resolveTunnelClientBinaryStartTarget(
        join(tmpdir(), "planweave-missing-tunnel-client", "tunnel-client")
      )
    ).rejects.toThrow("Tunnel client binary is missing or not executable.");
  });

  it("does not start an untrusted structural tunnel-client descriptor", async () => {
    const { TunnelClientProcessManager } = await import("../main/mcpTunnel/tunnelClientProcess");
    const dir = await mkdtemp(join(tmpdir(), "planweave-tunnel-client-"));
    const markerPath = join(dir, "started");
    const binaryPath = await writeMarkerTunnelClientScript(markerPath);
    const untrustedBinary = (await resolveTunnelClientBinary(
      binaryPath
    )) as unknown as TunnelClientBinaryStartTarget;
    const manager = new TunnelClientProcessManager();

    const status = await manager.start({
      binary: untrustedBinary,
      localMcpEndpoint: "http://127.0.0.1:8787/mcp",
      input: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeApiKey: "secret-runtime-key"
      }
    });

    expect(status.phase).toBe("error");
    expect(status.error).toBe("Tunnel client binary start target is not trusted.");
    await expect(exists(markerPath)).resolves.toBe(false);
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

  it("derives a constrained executable target from resolved tunnel-client binaries", async () => {
    const binaryPath = await writeTunnelClientScript();

    await expect(resolveTunnelClientBinaryStartTarget(binaryPath)).resolves.toMatchObject({
      path: binaryPath,
      available: true,
      source: "manual",
      executableDir: dirname(binaryPath),
      executableName: "tunnel-client"
    });
  });

  it("reports macOS quarantine before launching a manually configured tunnel-client", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    const binaryPath = await writeTunnelClientScript();
    await new Promise<void>((resolve, reject) => {
      execFile(
        "/usr/bin/xattr",
        ["-w", "com.apple.quarantine", "0081;00000000;PlanWeaveTest;", binaryPath],
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
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
    expect(getTunnelClientBinaryStartError(status)).toBe(
      "Managed tunnel-client install metadata is missing the binary checksum."
    );
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
      version: null,
      verified: true,
      error: null
    });
  });

  it("does not execute tunnel-client while resolving a matching managed checksum", async () => {
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
if [ "$1" = "init" ] || [ "$1" = "run" ]; then
  exit 0
fi
exit 1
`
    );
    await chmod(binaryPath, 0o700);
    const actualSha256 = await sha256(binaryPath);

    const status = await resolveTunnelClientBinary(binaryPath, {
      assetName: "tunnel-client-test-darwin-arm64.zip",
      assetSha256: "1".repeat(64),
      binarySha256: actualSha256
    });

    expect(status).toMatchObject({
      path: binaryPath,
      available: true,
      source: "managed",
      verified: true,
      version: null,
      error: null
    });
    await expect(exists(markerPath)).resolves.toBe(false);

    await expect(
      resolveTunnelClientBinaryStartTarget(binaryPath, {
        assetName: "tunnel-client-test-darwin-arm64.zip",
        assetSha256: "1".repeat(64),
        binarySha256: actualSha256
      })
    ).resolves.toMatchObject({
      path: binaryPath,
      available: true,
      source: "managed"
    });
    await expect(exists(markerPath)).resolves.toBe(false);
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

  it("rejects tunnel-client directories that cannot be safely prepended to PATH", async () => {
    const binaryPath = join(tmpdir(), `planweave${delimiter}tunnel-client`, "tunnel-client");

    await expect(resolveTunnelClientBinary(binaryPath)).resolves.toMatchObject({
      path: binaryPath,
      available: false,
      source: "manual",
      error: "Tunnel client binary directory cannot contain the system PATH delimiter."
    });
  });

  it("selects platform release zips and parses official SHA256SUMS entries", () => {
    const release = {
      tag_name: "v0.0.9",
      assets: [
        { name: "SHA256SUMS.txt", browser_download_url: "https://example.test/SHA256SUMS.txt" },
        {
          name: "tunnel-client-v0.0.9-windows-amd64.zip",
          browser_download_url: "https://example.test/windows.zip"
        }
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
    expect(parseSha256Sums(`${"B".repeat(64)}  *tunnel-client-v0.0.9-darwin-arm64.zip\n`)).toEqual(
      new Map([["tunnel-client-v0.0.9-darwin-arm64.zip", "b".repeat(64)]])
    );
    expect(parseSha256Sums(`${" ".repeat(10000)}not-a-checksum\n`)).toEqual(new Map());
  });

  it("downloads the official platform zip, verifies its checksum, and stores the extracted binary", async () => {
    const planweaveHome = await useTempPlanweaveHome();
    const platformAsset = tunnelClientPlatformAsset();
    const assetName = `tunnel-client-test-${platformAsset.assetSuffix}`;
    const binaryBytes = new TextEncoder().encode("binary-from-official-zip");
    const zipBytes = zipSync({ [platformAsset.binaryName]: binaryBytes });
    const zipHash = createHash("sha256").update(zipBytes).digest("hex");
    const fetchMock = vi.fn(async (url: string) => {
      if (new URL(url).hostname === "api.github.com") {
        return new Response(
          JSON.stringify({
            tag_name: "v-test",
            assets: [
              {
                name: "SHA256SUMS.txt",
                browser_download_url: "https://example.test/SHA256SUMS.txt"
              },
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

    const result = await downloadOfficialTunnelClient();

    await expect(readFile(result.binaryPath)).resolves.toEqual(Buffer.from(binaryBytes));
    expect(result.binaryPath).toContain(
      join(planweaveHome, "desktop", "mcp-tunnel", "downloads", "tunnel-client")
    );
    expect(result.verification).toEqual({
      assetName,
      assetSha256: zipHash,
      binarySha256: createHash("sha256").update(binaryBytes).digest("hex")
    });
  });

  it("reports a release page fallback when GitHub API rate limits release metadata", async () => {
    await useTempPlanweaveHome();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("API rate limit exceeded", { status: 403 }))
    );

    await expect(downloadOfficialTunnelClient()).rejects.toThrow(
      "GitHub API rate limit blocked tunnel-client metadata. Open https://github.com/openai/tunnel-client/releases/latest and try again later."
    );
  });

  it("persists tunnel-client path and managed verification metadata", async () => {
    const planweaveHome = await useTempPlanweaveHome();
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const config = {
      tunnelClientPath: "/tmp/tunnel-client",
      verification: {
        assetName: "tunnel-client-test-darwin-arm64.zip",
        assetSha256: "1".repeat(64),
        binarySha256: "2".repeat(64)
      },
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      encryptedRuntimeApiKey: "encrypted-runtime-key",
      autoStart: true
    };

    await writeTunnelClientConfig(config);

    await expect(readTunnelClientConfig()).resolves.toEqual(config);
    await expect(exists(mcpTunnelConfigPath())).resolves.toBe(true);
    await expect(exists(mcpTunnelLegacyConfigPath(userDataDir))).resolves.toBe(false);
    expect(mcpTunnelConfigPath()).toBe(join(planweaveHome, "desktop", "mcp-tunnel", "config.json"));
  });

  it("writes tunnel client config with 0o600 permissions on POSIX", async () => {
    await useTempPlanweaveHome();
    await writeTunnelClientConfig({
      tunnelClientPath: "/tmp/tunnel-client",
      verification: null,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      encryptedRuntimeApiKey: "encrypted-runtime-key",
      autoStart: false
    });

    if (process.platform === "win32") {
      return;
    }

    const written = await stat(mcpTunnelConfigPath());
    expect(written.mode & 0o777).toBe(0o600);
  });

  it("migrates legacy userData tunnel config to PlanWeave Home while keeping the legacy file", async () => {
    const planweaveHome = await useTempPlanweaveHome();
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const legacyPath = mcpTunnelLegacyConfigPath(userDataDir);
    const legacyConfig = {
      tunnelClientPath: "/tmp/legacy-tunnel-client",
      verification: {
        assetName: "tunnel-client-test-darwin-arm64.zip",
        assetSha256: "1".repeat(64),
        binarySha256: "2".repeat(64)
      },
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      encryptedRuntimeApiKey: "encrypted-runtime-key",
      autoStart: true
    };
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);

    await expect(readTunnelClientConfig(mcpTunnelConfigStorePaths(userDataDir))).resolves.toEqual(
      legacyConfig
    );

    await expect(readTunnelClientConfig()).resolves.toEqual(legacyConfig);
    await expect(exists(legacyPath)).resolves.toBe(true);
    await expect(readFile(mcpTunnelConfigPath(), "utf8")).resolves.toContain(
      "/tmp/legacy-tunnel-client"
    );
    expect(mcpTunnelConfigPath()).toBe(join(planweaveHome, "desktop", "mcp-tunnel", "config.json"));
  });

  it("prefers the PlanWeave Home tunnel config over a legacy userData config", async () => {
    await useTempPlanweaveHome();
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const currentConfig = {
      tunnelClientPath: "/tmp/current-tunnel-client",
      verification: null,
      tunnelId: "tunnel_current",
      encryptedRuntimeApiKey: "current-encrypted-runtime-key",
      autoStart: false
    };
    await writeTunnelClientConfig(currentConfig);
    await mkdir(dirname(mcpTunnelLegacyConfigPath(userDataDir)), { recursive: true });
    await writeFile(mcpTunnelLegacyConfigPath(userDataDir), "{");

    await expect(readTunnelClientConfig(mcpTunnelConfigStorePaths(userDataDir))).resolves.toEqual(
      currentConfig
    );
  });

  it("does not silently swallow invalid tunnel config JSON", async () => {
    await useTempPlanweaveHome();
    await mkdir(dirname(mcpTunnelConfigPath()), { recursive: true });
    await writeFile(mcpTunnelConfigPath(), "{");

    await expect(readTunnelClientConfig()).rejects.toThrow("Invalid MCP tunnel config JSON");
  });

  it("keeps PLANWEAVE_HOME isolated for tunnel config reads", async () => {
    const firstHome = await useTempPlanweaveHome();
    await writeTunnelClientConfig({
      tunnelClientPath: "/tmp/first-tunnel-client",
      verification: null,
      tunnelId: "tunnel_first",
      encryptedRuntimeApiKey: "first-encrypted-runtime-key",
      autoStart: false
    });
    const secondHome = await mkdtemp(join(tmpdir(), "planweave-home-"));
    tempRoots.push(secondHome);
    process.env.PLANWEAVE_HOME = secondHome;

    await expect(readTunnelClientConfig()).resolves.toEqual({
      tunnelClientPath: null,
      verification: null,
      tunnelId: null,
      encryptedRuntimeApiKey: null,
      autoStart: false
    });
    await expect(
      readFile(join(firstHome, "desktop", "mcp-tunnel", "config.json"), "utf8")
    ).resolves.toContain("/tmp/first-tunnel-client");
  });

  it("redacts runtime API keys and tunnel IDs from tunnel-client init failures", async () => {
    const { TunnelClientProcessManager } = await import("../main/mcpTunnel/tunnelClientProcess");
    const binaryPath = await writeFailingInitTunnelClientScript();
    const binary = await resolveTunnelClientBinaryStartTarget(binaryPath);
    const manager = new TunnelClientProcessManager();

    const status = await manager.start({
      binary,
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

  it("uses a session-only runtime API key when safeStorage is unavailable", async () => {
    vi.resetModules();
    const planweaveHome = await useTempPlanweaveHome();
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const tunnelStart = vi.fn(
      async (options: { input: { tunnelId: string; runtimeApiKey: string } }) => ({
        phase: "running",
        profile: "planweave-local-http",
        tunnelId: options.input.tunnelId,
        pid: 123,
        healthUrl: "http://127.0.0.1:12345",
        ready: true,
        error: null
      })
    );

    electronMock.app.getPath.mockReturnValue(userDataDir);
    electronMock.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await writeTunnelClientConfig({
      tunnelClientPath: null,
      verification: null,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      encryptedRuntimeApiKey: "old-encrypted-runtime-key",
      autoStart: true
    });
    vi.doMock("../main/mcpTunnel/localMcpProcess", () => ({
      LocalMcpServerManager: class {
        getStatus = vi.fn(() => ({
          phase: "running",
          endpoint: "http://127.0.0.1:8787/mcp",
          host: "127.0.0.1",
          port: 8787,
          pid: process.pid,
          planweaveHome,
          planweaveHomeFromEnv: true,
          healthy: true,
          error: null
        }));
        start = vi.fn();
        stop = vi.fn();
      }
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientProcess", () => ({
      TunnelClientProcessManager: class {
        getStatus = vi.fn(() => ({
          phase: "stopped",
          profile: "planweave-local-http",
          tunnelId: null,
          pid: null,
          healthUrl: null,
          ready: false,
          error: null
        }));
        start = tunnelStart;
        stop = vi.fn();
      }
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientBinary", () => ({
      resolveTunnelClientBinary: vi.fn(async () => ({
        path: "/usr/local/bin/tunnel-client",
        available: true,
        source: "manual",
        assetName: null,
        assetSha256: null,
        sha256: "0".repeat(64),
        version: null,
        verified: false,
        error: null
      })),
      resolveTunnelClientBinaryStartTarget: vi.fn(async () => ({
        path: "/usr/local/bin/tunnel-client",
        available: true,
        source: "manual",
        executableDir: "/usr/local/bin",
        executableName: "tunnel-client"
      })),
      tunnelClientDownloadUrl: "https://github.com/openai/tunnel-client/releases/latest"
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientDownloader", () => ({
      downloadOfficialTunnelClient: vi.fn()
    }));

    const { getMcpTunnelStatus, setTunnelAutoStart, startTunnel } = await import(
      "../main/mcpTunnel/mcpTunnelHandlers"
    );

    const firstStatus = await startTunnel({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "secret-runtime-key"
    });

    expect(tunnelStart).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
          runtimeApiKey: "secret-runtime-key"
        }
      })
    );
    await expect(readTunnelClientConfig()).resolves.toMatchObject({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      encryptedRuntimeApiKey: null,
      autoStart: false
    });
    await expect(readFile(mcpTunnelConfigPath(), "utf8")).resolves.not.toContain(
      "secret-runtime-key"
    );
    await expect(readFile(mcpTunnelConfigPath(), "utf8")).resolves.not.toContain(
      "old-encrypted-runtime-key"
    );
    expect(firstStatus.config).toMatchObject({
      hasRuntimeApiKey: true,
      runtimeApiKeyPersistence: "session-only",
      runtimeApiKeyStorage: "unavailable"
    });

    await startTunnel({});

    expect(tunnelStart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: {
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
          runtimeApiKey: "secret-runtime-key"
        }
      })
    );
    await expect(getMcpTunnelStatus()).resolves.toMatchObject({
      config: {
        hasRuntimeApiKey: true,
        runtimeApiKeyPersistence: "session-only",
        runtimeApiKeyStorage: "unavailable"
      }
    });
    await expect(setTunnelAutoStart(true)).rejects.toThrow(
      "Auto-start requires a runtime API key that can be restored from secure storage."
    );
  });

  it("treats an in-memory persisted runtime API key as session-only when safeStorage becomes unavailable", async () => {
    vi.resetModules();
    const planweaveHome = await useTempPlanweaveHome();
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const tunnelStart = vi.fn();

    electronMock.app.getPath.mockReturnValue(userDataDir);
    electronMock.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    electronMock.safeStorage.decryptString.mockImplementation((value: Buffer) =>
      value.toString("utf8")
    );
    await writeTunnelClientConfig({
      tunnelClientPath: null,
      verification: null,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      encryptedRuntimeApiKey: Buffer.from("persisted-runtime-key", "utf8").toString("base64"),
      autoStart: true
    });
    vi.doMock("../main/mcpTunnel/localMcpProcess", () => ({
      LocalMcpServerManager: class {
        getStatus = vi.fn(() => ({
          phase: "running",
          endpoint: "http://127.0.0.1:8787/mcp",
          host: "127.0.0.1",
          port: 8787,
          pid: process.pid,
          planweaveHome,
          planweaveHomeFromEnv: true,
          healthy: true,
          error: null
        }));
        start = tunnelStart;
        stop = vi.fn();
      }
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientProcess", () => ({
      TunnelClientProcessManager: class {
        getStatus = vi.fn(() => ({
          phase: "stopped",
          profile: "planweave-local-http",
          tunnelId: null,
          pid: null,
          healthUrl: null,
          ready: false,
          error: null
        }));
        start = vi.fn();
        stop = vi.fn();
      }
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientBinary", () => ({
      resolveTunnelClientBinary: vi.fn(async () => ({
        path: "/usr/local/bin/tunnel-client",
        available: true,
        source: "manual",
        assetName: null,
        assetSha256: null,
        sha256: "0".repeat(64),
        version: null,
        verified: false,
        error: null
      })),
      resolveTunnelClientBinaryStartTarget: vi.fn(),
      tunnelClientDownloadUrl: "https://github.com/openai/tunnel-client/releases/latest"
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientDownloader", () => ({
      downloadOfficialTunnelClient: vi.fn()
    }));

    const { getMcpTunnelStatus, setTunnelAutoStart } = await import(
      "../main/mcpTunnel/mcpTunnelHandlers"
    );
    await expect(getMcpTunnelStatus()).resolves.toMatchObject({
      config: {
        hasRuntimeApiKey: true,
        runtimeApiKeyPersistence: "persisted",
        runtimeApiKeyStorage: "available",
        autoStart: true
      }
    });

    electronMock.safeStorage.isEncryptionAvailable.mockReturnValue(false);

    await expect(getMcpTunnelStatus()).resolves.toMatchObject({
      config: {
        hasRuntimeApiKey: true,
        runtimeApiKeyPersistence: "session-only",
        runtimeApiKeyStorage: "unavailable",
        autoStart: false
      }
    });
    await expect(setTunnelAutoStart(true)).rejects.toThrow(
      "Auto-start requires a runtime API key that can be restored from secure storage."
    );
    const { autoStartMcpTunnel } = await import("../main/mcpTunnel/mcpTunnelHandlers");
    await autoStartMcpTunnel();

    expect(tunnelStart).not.toHaveBeenCalled();
    await expect(readTunnelClientConfig()).resolves.toMatchObject({
      autoStart: false
    });
  });

  it("keeps persisting runtime API keys when safeStorage is available", async () => {
    vi.resetModules();
    const planweaveHome = await useTempPlanweaveHome();
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    const tunnelStart = vi.fn(
      async (options: { input: { tunnelId: string; runtimeApiKey: string } }) => ({
        phase: "running",
        profile: "planweave-local-http",
        tunnelId: options.input.tunnelId,
        pid: 123,
        healthUrl: "http://127.0.0.1:12345",
        ready: true,
        error: null
      })
    );

    electronMock.app.getPath.mockReturnValue(userDataDir);
    electronMock.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    electronMock.safeStorage.encryptString.mockImplementation((value: string) =>
      Buffer.from(`encrypted:${value}`, "utf8")
    );
    vi.doMock("../main/mcpTunnel/localMcpProcess", () => ({
      LocalMcpServerManager: class {
        getStatus = vi.fn(() => ({
          phase: "running",
          endpoint: "http://127.0.0.1:8787/mcp",
          host: "127.0.0.1",
          port: 8787,
          pid: process.pid,
          planweaveHome,
          planweaveHomeFromEnv: true,
          healthy: true,
          error: null
        }));
        start = vi.fn();
        stop = vi.fn();
      }
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientProcess", () => ({
      TunnelClientProcessManager: class {
        getStatus = vi.fn(() => ({
          phase: "stopped",
          profile: "planweave-local-http",
          tunnelId: null,
          pid: null,
          healthUrl: null,
          ready: false,
          error: null
        }));
        start = tunnelStart;
        stop = vi.fn();
      }
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientBinary", () => ({
      resolveTunnelClientBinary: vi.fn(async () => ({
        path: "/usr/local/bin/tunnel-client",
        available: true,
        source: "manual",
        assetName: null,
        assetSha256: null,
        sha256: "0".repeat(64),
        version: null,
        verified: false,
        error: null
      })),
      resolveTunnelClientBinaryStartTarget: vi.fn(async () => ({
        path: "/usr/local/bin/tunnel-client",
        available: true,
        source: "manual",
        executableDir: "/usr/local/bin",
        executableName: "tunnel-client"
      })),
      tunnelClientDownloadUrl: "https://github.com/openai/tunnel-client/releases/latest"
    }));
    vi.doMock("../main/mcpTunnel/tunnelClientDownloader", () => ({
      downloadOfficialTunnelClient: vi.fn()
    }));

    const { getMcpTunnelStatus, setTunnelAutoStart, startTunnel } = await import(
      "../main/mcpTunnel/mcpTunnelHandlers"
    );

    await startTunnel({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "secret-runtime-key"
    });
    const config = await readTunnelClientConfig();

    expect(config.encryptedRuntimeApiKey).toBe(
      Buffer.from("encrypted:secret-runtime-key", "utf8").toString("base64")
    );
    await expect(setTunnelAutoStart(true)).resolves.toMatchObject({
      config: {
        autoStart: true,
        runtimeApiKeyPersistence: "persisted",
        runtimeApiKeyStorage: "available"
      }
    });
    await expect(getMcpTunnelStatus()).resolves.toMatchObject({
      config: {
        hasRuntimeApiKey: true,
        runtimeApiKeyPersistence: "persisted"
      }
    });
  });

  it("surfaces invalid tunnel config JSON through the MCP tunnel status handler", async () => {
    vi.resetModules();
    await useTempPlanweaveHome();
    const userDataDir = await mkdtemp(join(tmpdir(), "planweave-user-data-"));
    electronMock.app.getPath.mockReturnValue(userDataDir);
    await mkdir(dirname(mcpTunnelConfigPath()), { recursive: true });
    await writeFile(mcpTunnelConfigPath(), "{");

    const { getMcpTunnelStatus } = await import("../main/mcpTunnel/mcpTunnelHandlers");

    await expect(getMcpTunnelStatus()).rejects.toThrow("Invalid MCP tunnel config JSON");
  });

  it("registers cleanup for MCP tunnel processes before app quit", async () => {
    const source = await readFile(join(process.cwd(), "packages/desktop/src/main/main.ts"), "utf8");

    expect(source).toContain("stopMcpTunnelProcesses");
    expect(source).toContain("shutdownDesktopAutoRuns");
    expect(source).toContain('app.on("before-quit"');
  });
});
