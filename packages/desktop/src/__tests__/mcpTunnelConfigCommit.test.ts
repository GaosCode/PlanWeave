import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TunnelClientConfig } from "../main/mcpTunnel/tunnelClientStore.js";
import type { McpTunnelStatus } from "../shared/mcpTunnel.js";

const mocks = vi.hoisted(() => ({
  userData: vi.fn(),
  send: vi.fn(),
  handle: vi.fn(),
  available: vi.fn(() => true),
  encrypt: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decrypt: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, "")),
  binary: vi.fn(),
  target: vi.fn(),
  download: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  localStart: vi.fn(),
  tunnelStatus: {
    phase: "stopped",
    profile: "planweave-local-http",
    tunnelId: null,
    pid: null,
    healthUrl: null,
    ready: false,
    error: null
  }
}));
vi.mock("electron", () => ({
  app: { getPath: mocks.userData },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }]
  },
  ipcMain: { handle: mocks.handle },
  safeStorage: {
    isEncryptionAvailable: mocks.available,
    encryptString: mocks.encrypt,
    decryptString: mocks.decrypt
  }
}));
vi.mock("../main/mcpTunnel/tunnelClientBinary.js", () => ({
  resolveTunnelClientBinary: mocks.binary,
  resolveTunnelClientBinaryStartTarget: mocks.target,
  tunnelClientDownloadUrl: "https://example.test/release"
}));
vi.mock("../main/mcpTunnel/tunnelClientDownloader.js", () => ({
  downloadOfficialTunnelClient: mocks.download
}));
vi.mock("../main/mcpTunnel/tunnelClientProcess.js", () => ({
  TunnelClientProcessManager: class {
    getStatus = () => mocks.tunnelStatus;
    start = mocks.start;
    stop = mocks.stop;
  }
}));
vi.mock("../main/mcpTunnel/localMcpProcess.js", () => ({
  LocalMcpServerManager: class {
    getStatus = () => ({
      phase: "running",
      endpoint: "http://127.0.0.1:8787/mcp",
      host: "127.0.0.1",
      port: 8787,
      pid: 1,
      planweaveHome: "",
      planweaveHomeFromEnv: true,
      healthy: true,
      error: null
    });
    start = mocks.localStart;
    stop = mocks.stop;
  }
}));
vi.mock("../main/mcpTunnel/tunnelClientStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../main/mcpTunnel/tunnelClientStore.js")>();
  return {
    ...actual,
    readTunnelClientConfig: vi.fn(actual.readTunnelClientConfig),
    writeTunnelClientConfig: vi.fn(actual.writeTunnelClientConfig)
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: string;
let store: typeof import("../main/mcpTunnel/tunnelClientStore.js");
const base: TunnelClientConfig = {
  tunnelClientPath: "/test/old",
  verification: null,
  tunnelId: "old-id",
  encryptedRuntimeApiKey: Buffer.from("encrypted:old-key").toString("base64"),
  encryptedRuntimeApiKeys: {
    system: Buffer.from("encrypted:old-key").toString("base64"),
    application: "other-mode-cipher"
  },
  autoStart: false
};
async function handlers() {
  return import("../main/mcpTunnel/mcpTunnelHandlers.js");
}
async function disk() {
  return store.readTunnelClientConfig();
}
function publications(): McpTunnelStatus[] {
  return mocks.send.mock.calls.map((call) => call[1]);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = await fs.mkdtemp(join(tmpdir(), "planweave-mcp-commit-"));
  vi.stubEnv("PLANWEAVE_HOME", root);
  vi.stubEnv("PLANWEAVE_TUNNEL_CLIENT_PATH", "");
  mocks.userData.mockReturnValue(join(root, "user-data"));
  mocks.available.mockReturnValue(true);
  mocks.encrypt.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`));
  mocks.decrypt.mockImplementation((value: Buffer) => value.toString().replace(/^encrypted:/, ""));
  mocks.binary.mockImplementation(async (path: string | null) => ({
    path,
    available: Boolean(path),
    source: "manual",
    assetName: null,
    assetSha256: null,
    sha256: null,
    version: null,
    verified: false,
    error: null
  }));
  mocks.target.mockImplementation(async (path: string) => ({
    path,
    source: "manual",
    executableDir: "/test",
    executableName: "client"
  }));
  mocks.start.mockResolvedValue(mocks.tunnelStatus);
  const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  store = await import("../main/mcpTunnel/tunnelClientStore.js");
  const realStore = await vi.importActual<typeof store>("../main/mcpTunnel/tunnelClientStore.js");
  vi.mocked(store.readTunnelClientConfig)
    .mockReset()
    .mockImplementation(realStore.readTunnelClientConfig);
  vi.mocked(store.writeTunnelClientConfig)
    .mockReset()
    .mockImplementation(realStore.writeTunnelClientConfig);
  await store.writeTunnelClientConfig(base);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("MCP tunnel application configuration commits", () => {
  it("serializes exported setters at arrival and restores both independent changes after restart", async () => {
    const api = await handlers();
    await api.getMcpTunnelStatus();
    const realStore = await vi.importActual<typeof store>("../main/mcpTunnel/tunnelClientStore.js");
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.mocked(store.writeTunnelClientConfig).mockImplementationOnce(async (config, paths) => {
      entered.resolve();
      await release.promise;
      await realStore.writeTunnelClientConfig(config, paths);
    });
    const path = api.setTunnelClientPath("/test/new");
    await entered.promise;
    const autoStart = api.setTunnelAutoStart(true);
    expect(await disk()).toEqual(base);
    release.resolve();
    await Promise.all([path, autoStart]);
    expect(await disk()).toMatchObject({
      tunnelClientPath: "/test/new",
      autoStart: true,
      encryptedRuntimeApiKeys: base.encryptedRuntimeApiKeys
    });
    const emitted = publications();
    const firstEnabled = emitted.findIndex((status) => status.config.autoStart);
    expect(firstEnabled).toBeGreaterThanOrEqual(0);
    expect(emitted.slice(firstEnabled).every((status) => status.config.autoStart)).toBe(true);
    vi.resetModules();
    await expect((await handlers()).getMcpTunnelStatus()).resolves.toMatchObject({
      binary: { path: "/test/new" },
      config: { autoStart: true, runtimeApiKeyPersistence: "persisted" }
    });
  });

  it.each([
    ["path", "write"],
    ["path", "rename"],
    ["key", "write"],
    ["key", "rename"],
    ["autostart", "write"],
    ["autostart", "rename"]
  ] as const)("%s %s failure keeps committed memory and disk and permits recovery", async (command, stage) => {
    const api = await handlers();
    const before = await api.getMcpTunnelStatus();
    const bytes = await fs.readFile(store.mcpTunnelConfigPath(), "utf8");
    if (stage === "rename")
      vi.mocked(fs.rename).mockRejectedValueOnce(new Error("injected commit failure"));
    else
      vi.mocked(store.writeTunnelClientConfig).mockRejectedValueOnce(
        new Error("injected commit failure")
      );
    const action =
      command === "path"
        ? api.setTunnelClientPath("/test/rejected")
        : command === "key"
          ? api.startTunnel({ tunnelId: "rejected-id", runtimeApiKey: "rejected-key" })
          : api.setTunnelAutoStart(true);
    await expect(action).rejects.toThrow("injected commit failure");
    const after = await api.getMcpTunnelStatus();
    expect(after.config).toEqual(before.config);
    expect(after.binary.path).toBe(before.binary.path);
    expect(await fs.readFile(store.mcpTunnelConfigPath(), "utf8")).toBe(bytes);
    expect(mocks.start).not.toHaveBeenCalled();
    await api.startTunnel({});
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { tunnelId: "old-id", runtimeApiKey: "old-key" } })
    );
    await api.setTunnelClientPath("/test/recovered");
    expect((await disk()).tunnelClientPath).toBe("/test/recovered");
  });

  it("encryption and read failures cannot publish a candidate key as persisted", async () => {
    const api = await handlers();
    await api.getMcpTunnelStatus();
    mocks.encrypt.mockImplementationOnce(() => {
      throw new Error("injected encrypt failure");
    });
    await expect(
      api.startTunnel({ tunnelId: "rejected", runtimeApiKey: "rejected-key" })
    ).rejects.toThrow("injected encrypt failure");
    vi.mocked(store.readTunnelClientConfig).mockRejectedValueOnce(
      new Error("injected read failure")
    );
    await expect(api.setTunnelClientPath("/test/rejected")).rejects.toThrow(
      "injected read failure"
    );
    expect((await api.getMcpTunnelStatus()).config.tunnelId).toBe("old-id");
    expect(await disk()).toEqual(base);
    await api.startTunnel({ runtimeApiKey: "valid-key" });
    expect((await disk()).encryptedRuntimeApiKeys?.application).toBe("other-mode-cipher");
    expect((await api.getMcpTunnelStatus()).config.runtimeApiKeyPersistence).toBe("persisted");
  });

  it("failed first persistence keeps a new key missing rather than session-only", async () => {
    await store.writeTunnelClientConfig({
      ...base,
      encryptedRuntimeApiKey: null,
      encryptedRuntimeApiKeys: {}
    });
    const api = await handlers();
    await api.getMcpTunnelStatus();
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(api.startTunnel({ runtimeApiKey: "new-key" })).rejects.toThrow("disk unavailable");
    expect((await api.getMcpTunnelStatus()).config).toMatchObject({
      hasRuntimeApiKey: false,
      runtimeApiKeyPersistence: "missing",
      autoStart: false
    });
    await expect(api.startTunnel({})).rejects.toThrow("Runtime API key is required");
    await api.startTunnel({ runtimeApiKey: "new-key" });
    expect((await api.getMcpTunnelStatus()).config.runtimeApiKeyPersistence).toBe("persisted");
  });

  it("single initial loading cannot overwrite a setter that arrived during its read", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const realStore = await vi.importActual<typeof store>("../main/mcpTunnel/tunnelClientStore.js");
    vi.mocked(store.readTunnelClientConfig).mockImplementationOnce(async (paths) => {
      const old = await realStore.readTunnelClientConfig(paths);
      entered.resolve();
      await release.promise;
      return old;
    });
    const api = await handlers();
    const initial = api.getMcpTunnelStatus();
    await entered.promise;
    const update = api.setTunnelClientPath("/test/new");
    const concurrentLoad = api.getMcpTunnelStatus();
    release.resolve();
    await Promise.all([initial, update, concurrentLoad]);
    expect((await api.getMcpTunnelStatus()).binary.path).toBe("/test/new");
    expect((await disk()).tunnelClientPath).toBe("/test/new");
  });

  it("pending downloads and process startup leave ordinary configuration commands free", async () => {
    const api = await handlers();
    const downloading = deferred<{
      binaryPath: string;
      verification: { assetName: string; assetSha256: string; binarySha256: string };
    }>();
    const downloadEntered = deferred<void>();
    mocks.download.mockImplementationOnce(() => {
      downloadEntered.resolve();
      return downloading.promise;
    });
    const result = api.downloadTunnelClient();
    await downloadEntered.promise;
    await api.setTunnelAutoStart(true);
    expect((await disk()).autoStart).toBe(true);
    downloading.resolve({
      binaryPath: "/test/downloaded",
      verification: { assetName: "test.zip", assetSha256: "a", binarySha256: "b" }
    });
    await result;
    const processEntered = deferred<void>();
    const processReady = deferred<typeof mocks.tunnelStatus>();
    mocks.start.mockImplementationOnce(() => {
      processEntered.resolve();
      return processReady.promise;
    });
    const starting = api.startTunnel({ tunnelId: "start-id", runtimeApiKey: "start-key" });
    await processEntered.promise;
    await api.setTunnelClientPath("/test/while-starting");
    const repeated = api.startTunnel({ tunnelId: "next-id", runtimeApiKey: "next-key" });
    processReady.resolve(mocks.tunnelStatus);
    await Promise.all([starting, repeated]);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls[0][0]).toMatchObject({
      binary: { path: "/test/downloaded" },
      input: { tunnelId: "start-id", runtimeApiKey: "start-key" }
    });
    expect((await disk()).tunnelClientPath).toBe("/test/while-starting");
  });

  it("download config failure reports failure without claiming the installed binary is ready", async () => {
    const api = await handlers();
    mocks.download.mockResolvedValueOnce({
      binaryPath: "/test/downloaded",
      verification: { assetName: "test.zip", assetSha256: "a", binarySha256: "b" }
    });
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("download commit denied"));
    await expect(api.downloadTunnelClient()).rejects.toThrow("download commit denied");
    expect((await api.getMcpTunnelStatus()).download).toMatchObject({
      phase: "error",
      error: "download commit denied"
    });
    expect((await disk()).tunnelClientPath).toBe("/test/old");
    await api.setTunnelClientPath("/test/downloaded");
    expect((await disk()).tunnelClientPath).toBe("/test/downloaded");
  });

  it("configuration survives process failure after its successful commit", async () => {
    const api = await handlers();
    mocks.start.mockRejectedValueOnce(new Error("process failed"));
    await expect(
      api.startTunnel({ tunnelId: "saved-id", runtimeApiKey: "saved-key" })
    ).rejects.toThrow("process failed");
    expect((await disk()).tunnelId).toBe("saved-id");
    expect((await api.getMcpTunnelStatus()).config).toMatchObject({
      tunnelId: "saved-id",
      runtimeApiKeyPersistence: "persisted"
    });
    vi.resetModules();
    await (await handlers()).startTunnel({});
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { tunnelId: "saved-id", runtimeApiKey: "saved-key" } })
    );
  });

  it("IPC configured application mode preserves system map and restores its own saved key", async () => {
    const api = await handlers();
    api.registerMcpTunnelHandlers({ credentialStorageMode: "application" });
    const start = mocks.handle.mock.calls.find((call) => call[0].endsWith(":startTunnel"))?.[1];
    if (!start) throw new Error("Missing startTunnel IPC handler");
    await start(null, { tunnelId: "application-id", runtimeApiKey: "application-key" });
    const saved = await disk();
    expect(saved.encryptedRuntimeApiKeys?.system).toBe(base.encryptedRuntimeApiKeys?.system);
    expect(saved.encryptedRuntimeApiKeys?.application).toBe(
      Buffer.from("encrypted:application-key").toString("base64")
    );
    vi.resetModules();
    const restarted = await handlers();
    restarted.registerMcpTunnelHandlers({ credentialStorageMode: "application" });
    await restarted.startTunnel({});
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: { tunnelId: "application-id", runtimeApiKey: "application-key" }
      })
    );
  });

  it("unavailable encryption uses explicit session state only after metadata commit and cannot autostart", async () => {
    const api = await handlers();
    await api.getMcpTunnelStatus();
    mocks.available.mockReturnValue(false);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("metadata failed"));
    await expect(api.startTunnel({ runtimeApiKey: "rejected-session-key" })).rejects.toThrow(
      "metadata failed"
    );
    await api.startTunnel({});
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { tunnelId: "old-id", runtimeApiKey: "old-key" } })
    );
    await api.startTunnel({ runtimeApiKey: "session-key" });
    expect((await api.getMcpTunnelStatus()).config).toMatchObject({
      runtimeApiKeyPersistence: "session-only",
      autoStart: false
    });
    expect((await disk()).encryptedRuntimeApiKeys?.application).toBe("other-mode-cipher");
    expect((await disk()).encryptedRuntimeApiKey).toBeNull();
    await expect(api.setTunnelAutoStart(true)).rejects.toThrow("Auto-start requires");
    vi.resetModules();
    expect((await (await handlers()).getMcpTunnelStatus()).config.runtimeApiKeyPersistence).toBe(
      "missing"
    );
  });

  it("mode migration and setters share the owner rather than dropping the other mode map", async () => {
    await store.writeTunnelClientConfig({
      ...base,
      encryptedRuntimeApiKeys: { system: base.encryptedRuntimeApiKeys?.system }
    });
    const api = await handlers();
    const { migrateCredentialStorage } = await import(
      "../main/credentialStorage/credentialStorageMigration.js"
    );
    const { credentialStoragePaths } = await import(
      "../main/credentialStorage/credentialStoragePaths.js"
    );
    const storage = {
      isEncryptionAvailable: mocks.available,
      encryptString: mocks.encrypt,
      decryptString: mocks.decrypt
    };
    const migration = migrateCredentialStorage({
      sourceMode: "system",
      targetMode: "application",
      sourcePaths: credentialStoragePaths("system"),
      targetPaths: credentialStoragePaths("application"),
      sourceStorage: storage,
      targetStorage: storage,
      mcpTunnelPaths: store.mcpTunnelConfigStorePaths(),
      commitMcpConfig: api.updateMcpTunnelConfig
    });
    await Promise.all([
      migration,
      api.setTunnelClientPath("/test/updated"),
      api.setTunnelAutoStart(true)
    ]);
    expect(await disk()).toMatchObject({
      tunnelClientPath: "/test/updated",
      autoStart: true,
      encryptedRuntimeApiKeys: {
        system: base.encryptedRuntimeApiKeys?.system,
        application: Buffer.from("encrypted:old-key").toString("base64")
      }
    });
  });

  it("environment binary override remains dominant after commits", async () => {
    vi.stubEnv("PLANWEAVE_TUNNEL_CLIENT_PATH", "/test/environment");
    const api = await handlers();
    await api.setTunnelClientPath("/test/saved");
    await api.startTunnel({});
    expect((await api.getMcpTunnelStatus()).binary.path).toBe("/test/environment");
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ binary: expect.objectContaining({ path: "/test/environment" }) })
    );
    expect((await disk()).tunnelClientPath).toBe("/test/saved");
  });
});
