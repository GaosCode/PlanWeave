import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import type {
  McpTunnelRuntimeApiKeyPersistence,
  McpTunnelStatus,
  TunnelClientDownloadStatus,
  StartLocalMcpInput,
  StartTunnelInput
} from "../../shared/mcpTunnel.js";
import {
  mcpTunnelChangedChannel,
  mcpTunnelInvokeChannels
} from "../../shared/mcpTunnel.js";
import { LocalMcpServerManager } from "./localMcpProcess.js";
import { downloadOfficialTunnelClient } from "./tunnelClientDownloader.js";
import { resolveTunnelClientBinary, resolveTunnelClientBinaryStartTarget, tunnelClientDownloadUrl } from "./tunnelClientBinary.js";
import type { TunnelClientBinaryVerification } from "./tunnelClientBinary.js";
import { TunnelClientProcessManager } from "./tunnelClientProcess.js";
import { readTunnelClientConfig, writeTunnelClientConfig } from "./tunnelClientStore.js";

const localMcp = new LocalMcpServerManager();
const tunnelClient = new TunnelClientProcessManager({ onStatusChange: () => void publishStatus() });
const envTunnelClientPath = process.env.PLANWEAVE_TUNNEL_CLIENT_PATH?.trim() || null;
let tunnelClientPath: string | null = envTunnelClientPath;
let tunnelClientVerification: TunnelClientBinaryVerification | null = null;
let tunnelId: string | null = null;
let runtimeApiKey: string | null = null;
let sessionRuntimeApiKey: string | null = null;
let encryptedRuntimeApiKey: string | null = null;
let tunnelAutoStart = false;
let tunnelClientConfigLoaded = false;
let downloadStatus: TunnelClientDownloadStatus = {
  phase: "idle",
  assetName: null,
  error: null
};

function nowIso(): string {
  return new Date().toISOString();
}

function userDataDir(): string {
  return app.getPath("userData");
}

function runtimeApiKeyStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function decryptRuntimeApiKey(value: string | null): string | null {
  if (!value || !runtimeApiKeyStorageAvailable()) {
    return null;
  }
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(value, "base64")).trim();
    return decrypted || null;
  } catch {
    return null;
  }
}

function encryptRuntimeApiKey(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (!runtimeApiKeyStorageAvailable()) {
    throw new Error("Electron safeStorage is unavailable, so the runtime API key cannot be persisted securely.");
  }
  return safeStorage.encryptString(value).toString("base64");
}

function hasRestorableRuntimeApiKey(): boolean {
  return Boolean(runtimeApiKey && runtimeApiKeyStorageAvailable());
}

function sessionOnlyRuntimeApiKey(): string | null {
  return sessionRuntimeApiKey ?? (runtimeApiKeyStorageAvailable() ? null : runtimeApiKey);
}

function runtimeApiKeyPersistence(): McpTunnelRuntimeApiKeyPersistence {
  if (hasRestorableRuntimeApiKey()) {
    return "persisted";
  }
  if (sessionOnlyRuntimeApiKey()) {
    return "session-only";
  }
  return "missing";
}

function effectiveTunnelAutoStart(): boolean {
  return tunnelAutoStart && hasRestorableRuntimeApiKey();
}

async function loadTunnelClientConfig(): Promise<void> {
  if (tunnelClientConfigLoaded) {
    return;
  }
  tunnelClientConfigLoaded = true;
  const config = await readTunnelClientConfig(userDataDir());
  tunnelId = config.tunnelId;
  encryptedRuntimeApiKey = config.encryptedRuntimeApiKey;
  runtimeApiKey = decryptRuntimeApiKey(encryptedRuntimeApiKey);
  tunnelAutoStart = config.autoStart;
  if (envTunnelClientPath) {
    tunnelClientVerification = null;
    return;
  }
  tunnelClientPath = config.tunnelClientPath;
  tunnelClientVerification = config.verification;
  if (tunnelClientVerification && downloadStatus.phase === "idle") {
    downloadStatus = {
      phase: "ready",
      assetName: tunnelClientVerification.assetName,
      error: null
    };
  }
}

async function persistTunnelClientConfig(): Promise<void> {
  await writeTunnelClientConfig(userDataDir(), {
    tunnelClientPath,
    verification: tunnelClientVerification,
    tunnelId,
    encryptedRuntimeApiKey,
    autoStart: tunnelAutoStart
  });
}

async function getStatus(): Promise<McpTunnelStatus> {
  await loadTunnelClientConfig();
  return {
    binary: await resolveTunnelClientBinary(tunnelClientPath, tunnelClientVerification),
    download: downloadStatus,
    localMcp: localMcp.getStatus(),
    tunnel: tunnelClient.getStatus(),
    config: {
      tunnelId,
      hasRuntimeApiKey: Boolean(hasRestorableRuntimeApiKey() || sessionOnlyRuntimeApiKey()),
      runtimeApiKeyPersistence: runtimeApiKeyPersistence(),
      runtimeApiKeyStorage: runtimeApiKeyStorageAvailable() ? "available" : "unavailable",
      autoStart: effectiveTunnelAutoStart()
    },
    downloadUrl: tunnelClientDownloadUrl,
    updatedAt: nowIso()
  };
}

async function publishStatus(): Promise<McpTunnelStatus> {
  const status = await getStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(mcpTunnelChangedChannel, status);
    }
  }
  return status;
}

export async function getMcpTunnelStatus(): Promise<McpTunnelStatus> {
  return getStatus();
}

export async function setTunnelClientPath(path: string | null): Promise<McpTunnelStatus> {
  await loadTunnelClientConfig();
  tunnelClientPath = path?.trim() || null;
  tunnelClientVerification = null;
  await persistTunnelClientConfig();
  return publishStatus();
}

export async function setTunnelAutoStart(enabled: boolean): Promise<McpTunnelStatus> {
  await loadTunnelClientConfig();
  if (enabled && !hasRestorableRuntimeApiKey()) {
    throw new Error("Auto-start requires a runtime API key that can be restored from secure storage.");
  }
  tunnelAutoStart = enabled;
  await persistTunnelClientConfig();
  return publishStatus();
}

export async function downloadTunnelClient(): Promise<McpTunnelStatus> {
  await loadTunnelClientConfig();
  downloadStatus = {
    phase: "downloading",
    assetName: null,
    error: null
  };
  await publishStatus();
  try {
    const result = await downloadOfficialTunnelClient(userDataDir());
    tunnelClientPath = result.binaryPath;
    tunnelClientVerification = result.verification;
    downloadStatus = {
      phase: "ready",
      assetName: result.verification.assetName,
      error: null
    };
    await persistTunnelClientConfig();
  } catch (error) {
    downloadStatus = {
      phase: "error",
      assetName: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return publishStatus();
}

export async function startLocalMcp(input: StartLocalMcpInput = {}): Promise<McpTunnelStatus> {
  await localMcp.start(input);
  return publishStatus();
}

export async function stopLocalMcp(): Promise<McpTunnelStatus> {
  await tunnelClient.stop();
  await localMcp.stop();
  return publishStatus();
}

export async function startTunnel(input: StartTunnelInput = {}): Promise<McpTunnelStatus> {
  await loadTunnelClientConfig();
  const requestedTunnelId = input.tunnelId?.trim() || null;
  const requestedRuntimeApiKey = input.runtimeApiKey?.trim() || null;
  const effectiveTunnelId = requestedTunnelId ?? tunnelId;
  const effectiveRuntimeApiKey = requestedRuntimeApiKey ?? (hasRestorableRuntimeApiKey() ? runtimeApiKey : sessionOnlyRuntimeApiKey());
  if (!effectiveTunnelId) {
    throw new Error("tunnel_id is required.");
  }
  if (!effectiveRuntimeApiKey) {
    throw new Error("Runtime API key is required.");
  }
  if (requestedTunnelId || requestedRuntimeApiKey) {
    tunnelId = effectiveTunnelId;
    if (requestedRuntimeApiKey) {
      if (runtimeApiKeyStorageAvailable()) {
        runtimeApiKey = effectiveRuntimeApiKey;
        sessionRuntimeApiKey = null;
        encryptedRuntimeApiKey = encryptRuntimeApiKey(runtimeApiKey);
      } else {
        sessionRuntimeApiKey = effectiveRuntimeApiKey;
        encryptedRuntimeApiKey = null;
        tunnelAutoStart = false;
      }
    }
    await persistTunnelClientConfig();
  }
  const binaryStartTarget = await resolveTunnelClientBinaryStartTarget(tunnelClientPath, tunnelClientVerification);
  let localStatus = localMcp.getStatus();
  if (localStatus.phase !== "running" || !localStatus.endpoint) {
    if (localStatus.phase === "starting" || localStatus.phase === "stopping") {
      throw new Error("Wait for the local PlanWeave MCP server to finish changing state before starting the tunnel.");
    }
    localStatus = await localMcp.start();
    await publishStatus();
  }
  if (localStatus.phase !== "running" || !localStatus.endpoint) {
    throw new Error(localStatus.error ? `Failed to start the local PlanWeave MCP server: ${localStatus.error}` : "Failed to start the local PlanWeave MCP server.");
  }
  await tunnelClient.start({
    binary: binaryStartTarget,
    localMcpEndpoint: localStatus.endpoint,
    input: {
      tunnelId: effectiveTunnelId,
      runtimeApiKey: effectiveRuntimeApiKey
    }
  });
  return publishStatus();
}

export async function stopTunnel(): Promise<McpTunnelStatus> {
  await tunnelClient.stop();
  return publishStatus();
}

export async function autoStartMcpTunnel(): Promise<void> {
  await loadTunnelClientConfig();
  if (!tunnelAutoStart) {
    return;
  }
  if (!hasRestorableRuntimeApiKey()) {
    tunnelAutoStart = false;
    await persistTunnelClientConfig();
    await publishStatus();
    return;
  }
  try {
    await startTunnel();
  } catch (error) {
    console.error(`Failed to auto-start MCP tunnel: ${error instanceof Error ? error.message : String(error)}`);
    await publishStatus();
  }
}

export async function stopMcpTunnelProcesses(): Promise<void> {
  await tunnelClient.stop();
  await localMcp.stop();
  await publishStatus();
}

export function registerMcpTunnelHandlers(): void {
  ipcMain.handle(mcpTunnelInvokeChannels.getMcpTunnelStatus, () => getMcpTunnelStatus());
  ipcMain.handle(mcpTunnelInvokeChannels.downloadTunnelClient, () => downloadTunnelClient());
  ipcMain.handle(mcpTunnelInvokeChannels.setTunnelClientPath, (_event, path: string | null) => setTunnelClientPath(path));
  ipcMain.handle(mcpTunnelInvokeChannels.setTunnelAutoStart, (_event, enabled: boolean) => setTunnelAutoStart(enabled));
  ipcMain.handle(mcpTunnelInvokeChannels.startLocalMcp, (_event, input?: StartLocalMcpInput) => startLocalMcp(input));
  ipcMain.handle(mcpTunnelInvokeChannels.stopLocalMcp, () => stopLocalMcp());
  ipcMain.handle(mcpTunnelInvokeChannels.startTunnel, (_event, input: StartTunnelInput) => startTunnel(input));
  ipcMain.handle(mcpTunnelInvokeChannels.stopTunnel, () => stopTunnel());
}
