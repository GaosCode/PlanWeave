import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tunnelClientPlatformAsset } from "../main/mcpTunnel/tunnelClientDownloader.js";
import * as store from "../main/mcpTunnel/tunnelClientStore.js";

const mocks = vi.hoisted(() => ({ userData: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: mocks.userData },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }]
  },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}));
vi.mock("../main/mcpTunnel/tunnelClientStore.js", async (original) => {
  const actual = await original<typeof store>();
  return { ...actual, writeTunnelClientConfig: vi.fn(actual.writeTunnelClientConfig) };
});

let root: string;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function serveFixture(content: string) {
  const platform = tunnelClientPlatformAsset();
  const assetName = `tunnel-client-v-test-${platform.assetSuffix}`;
  const bytes = zipSync({ [platform.binaryName]: Buffer.from(content) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/latest"))
        return Response.json({
          tag_name: "v-test",
          assets: [
            { name: assetName, browser_download_url: "https://fixture.test/client.zip" },
            { name: "SHA256SUMS.txt", browser_download_url: "https://fixture.test/checksum" }
          ]
        });
      if (String(url).endsWith("/checksum")) return new Response(`${hash(bytes)}  ${assetName}\n`);
      return new Response(bytes);
    })
  );
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "planweave-wrapper-download-"));
  vi.stubEnv("PLANWEAVE_HOME", root);
  vi.stubEnv("PLANWEAVE_TUNNEL_CLIENT_PATH", "");
  mocks.userData.mockReturnValue(join(root, "user-data"));
  const realStore = await vi.importActual<typeof store>("../main/mcpTunnel/tunnelClientStore.js");
  vi.mocked(store.writeTunnelClientConfig)
    .mockReset()
    .mockImplementation(realStore.writeTunnelClientConfig);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Desktop tunnel download owner integration", () => {
  it("keeps the verified previous generation through a real download and failed config commit, then retries", async () => {
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    const activeStore = await import("../main/mcpTunnel/tunnelClientStore.js");
    serveFixture("old verified binary");
    const initial = await api.downloadTunnelClient();
    expect(initial.download.phase).toBe("ready");
    expect(initial.binary.verified).toBe(true);
    const previous = await activeStore.readTunnelClientConfig();
    const previousConfigBytes = await readFile(activeStore.mcpTunnelConfigPath(), "utf8");
    if (!previous.tunnelClientPath) throw new Error("Expected installed path");
    const previousBinary = await readFile(previous.tunnelClientPath);
    serveFixture("replacement binary");
    vi.mocked(activeStore.writeTunnelClientConfig).mockRejectedValueOnce(
      new Error("config commit denied")
    );
    await expect(api.downloadTunnelClient()).rejects.toThrow("config commit denied");
    expect(await readFile(activeStore.mcpTunnelConfigPath(), "utf8")).toBe(previousConfigBytes);
    expect(await readFile(previous.tunnelClientPath)).toEqual(previousBinary);
    const failed = await api.getMcpTunnelStatus();
    expect(failed.download).toMatchObject({ phase: "error", error: "config commit denied" });
    expect(failed.binary).toMatchObject({
      path: previous.tunnelClientPath,
      available: true,
      verified: true
    });
    const recovered = await api.downloadTunnelClient();
    expect(recovered.download.phase).toBe("ready");
    expect(recovered.binary.verified).toBe(true);
    expect(recovered.binary.path).not.toBe(previous.tunnelClientPath);
    if (!recovered.binary.path) throw new Error("Expected replacement path");
    expect(await readFile(recovered.binary.path, "utf8")).toBe("replacement binary");
    expect(await readFile(previous.tunnelClientPath)).toEqual(previousBinary);
    expect(await activeStore.readTunnelClientConfig()).toMatchObject({
      tunnelClientPath: recovered.binary.path
    });
  });

  it.each([
    "deadline",
    "byte limit"
  ])("publishes owner %s failures and permits a new download", async (kind) => {
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    if (kind === "deadline") {
      const nativeTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
        nativeTimeout(callback, delay === 120_000 ? 10 : delay, ...args)
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(() => undefined))
      );
    } else {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))
      );
    }
    await expect(api.downloadTunnelClient()).rejects.toThrow(
      kind === "deadline" ? "operation deadline" : "byte limit"
    );
    expect((await api.getMcpTunnelStatus()).download.phase).toBe("error");
    vi.restoreAllMocks();
    serveFixture("recovered binary");
    expect((await api.downloadTunnelClient()).download.phase).toBe("ready");
    expect(mocks.send.mock.calls.some((call) => call[1].download.phase === "error")).toBe(true);
  });
});
