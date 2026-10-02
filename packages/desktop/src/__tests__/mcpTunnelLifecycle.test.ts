import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TunnelClientConfig } from "../main/mcpTunnel/tunnelClientStore.js";
import type { LocalMcpServerStatus, TunnelClientStatus } from "../shared/mcpTunnel.js";

const mocks = vi.hoisted(() => ({
  userData: vi.fn(),
  target: vi.fn(),
  read: vi.fn<() => Promise<TunnelClientConfig>>(),
  start: vi.fn(),
  stop: vi.fn(),
  localStart: vi.fn(),
  localStop: vi.fn(),
  send: vi.fn()
}));
vi.mock("electron", () => ({
  app: { getPath: mocks.userData },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }]
  },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}));
vi.mock("../main/mcpTunnel/tunnelClientBinary.js", () => ({
  resolveTunnelClientBinary: async () => ({
    available: true,
    path: "/fixture/tunnel-client",
    source: "manual",
    error: null
  }),
  resolveTunnelClientBinaryStartTarget: mocks.target,
  tunnelClientDownloadUrl: "https://example.test/tunnel-client"
}));
vi.mock("../main/mcpTunnel/tunnelClientStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../main/mcpTunnel/tunnelClientStore.js")>();
  return { ...actual, readTunnelClientConfig: mocks.read };
});

let local: LocalMcpServerStatus;
let tunnel: TunnelClientStatus;
vi.mock("../main/mcpTunnel/localMcpProcess.js", () => ({
  LocalMcpServerManager: class {
    getStatus = () => local;
    start = mocks.localStart;
    stop = mocks.localStop;
  }
}));
vi.mock("../main/mcpTunnel/tunnelClientProcess.js", () => ({
  TunnelClientProcessManager: class {
    getStatus = () => tunnel;
    start = mocks.start;
    stop = mocks.stop;
  }
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let root: string;
const config: TunnelClientConfig = {
  tunnelClientPath: "/fixture/tunnel-client",
  verification: null,
  tunnelId: "fixture-id",
  encryptedRuntimeApiKey: Buffer.from("fixture-key").toString("base64"),
  encryptedRuntimeApiKeys: { system: Buffer.from("fixture-key").toString("base64") },
  autoStart: true
};
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "pw-mcp-handler-lifecycle-"));
  vi.stubEnv("PLANWEAVE_HOME", root);
  vi.stubEnv("PLANWEAVE_TUNNEL_CLIENT_PATH", "");
  mocks.userData.mockReturnValue(root);
  local = {
    phase: "running",
    endpoint: "http://127.0.0.1:8787/mcp",
    host: "127.0.0.1",
    port: 8787,
    pid: process.pid,
    planweaveHome: root,
    planweaveHomeFromEnv: true,
    healthy: true,
    error: null
  };
  tunnel = {
    phase: "stopped",
    profile: "planweave-local-http",
    tunnelId: null,
    pid: null,
    healthUrl: null,
    ready: false,
    error: null
  };
  mocks.read.mockResolvedValue(config);
  mocks.target.mockResolvedValue({ path: "/fixture/tunnel-client" });
  mocks.start.mockImplementation(async () => {
    tunnel = { ...tunnel, phase: "running", ready: true, pid: 123 };
    return tunnel;
  });
  mocks.stop.mockImplementation(async () => {
    tunnel = { ...tunnel, phase: "stopped", ready: false, pid: null };
    return tunnel;
  });
  mocks.localStart.mockImplementation(async () => {
    local = { ...local, phase: "running" };
    return local;
  });
  mocks.localStop.mockImplementation(async () => {
    local = { ...local, phase: "stopped", endpoint: null, healthy: false, pid: null };
    return local;
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Desktop MCP start intent and stop ownership", () => {
  it("drains binary resolution before acknowledging stop and never dispatches its old start", async () => {
    const gate = deferred<{ path: string }>();
    mocks.target.mockReturnValueOnce(gate.promise);
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    const starting = api.startTunnel();
    await vi.waitFor(() => expect(mocks.target).toHaveBeenCalledOnce());
    const stopping = api.stopTunnel();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    gate.resolve({ path: "/fixture/tunnel-client" });
    await Promise.all([starting, stopping]);
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await api.getMcpTunnelStatus()).tunnel.phase).toBe("stopped");
  });

  it("cancels an autostart still reading config before any manager starts", async () => {
    const gate = deferred<TunnelClientConfig>();
    mocks.read.mockReturnValueOnce(gate.promise);
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    const starting = api.autoStartMcpTunnel();
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    const stopping = api.stopMcpTunnelProcesses();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    gate.resolve(config);
    await Promise.all([starting, stopping]);
    expect(mocks.localStart).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await api.getMcpTunnelStatus()).localMcp.phase).toBe("stopped");
  });

  it("coalesces explicit tunnel start and autostart while binary resolution is pending", async () => {
    const gate = deferred<{ path: string }>();
    mocks.target.mockReturnValue(gate.promise);
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    const first = api.startTunnel();
    await vi.waitFor(() => expect(mocks.target).toHaveBeenCalledOnce());
    const second = api.autoStartMcpTunnel();
    gate.resolve({ path: "/fixture/tunnel-client" });
    await Promise.all([first, second]);
    expect(mocks.start).toHaveBeenCalledOnce();
    await api.stopMcpTunnelProcesses();
  });

  it("reuses a local pending start and rejects a competing tunnel start intent", async () => {
    const gate = deferred<LocalMcpServerStatus>();
    mocks.localStart.mockReturnValue(gate.promise);
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    const first = api.startLocalMcp();
    const second = api.startLocalMcp();
    await expect(api.startTunnel()).rejects.toThrow("Another MCP process start is still pending.");
    gate.resolve(local);
    await Promise.all([first, second]);
    expect(mocks.localStart).toHaveBeenCalledOnce();
    await api.stopMcpTunnelProcesses();
  });

  it("rejects an explicit start competing with unresolved disabled autostart", async () => {
    const gate = deferred<TunnelClientConfig>();
    mocks.read.mockReturnValueOnce(gate.promise);
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    const automatic = api.autoStartMcpTunnel();
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    await expect(api.startTunnel()).rejects.toThrow("Another MCP process start is still pending.");
    gate.resolve({ ...config, autoStart: false });
    await automatic;
    expect(mocks.start).not.toHaveBeenCalled();
    await api.startTunnel();
    expect(mocks.start).toHaveBeenCalledOnce();
    await api.stopMcpTunnelProcesses();
  });

  it("propagates a failed stop instead of publishing stopped", async () => {
    mocks.stop.mockRejectedValueOnce(new Error("child-drain-failed"));
    const api = await import("../main/mcpTunnel/mcpTunnelHandlers.js");
    await expect(api.stopTunnel()).rejects.toThrow("child-drain-failed");
    expect(mocks.send).not.toHaveBeenCalled();
    await api.stopTunnel();
  });
});
