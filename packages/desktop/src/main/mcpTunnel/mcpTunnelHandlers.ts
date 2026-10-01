import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import type {
  McpTunnelStatus,
  TunnelClientDownloadStatus,
  StartLocalMcpInput,
  StartTunnelInput
} from "../../shared/mcpTunnel.js";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels } from "../../shared/mcpTunnel.js";
import { LocalMcpServerManager } from "./localMcpProcess.js";
import { downloadOfficialTunnelClient } from "./tunnelClientDownloader.js";
import {
  resolveTunnelClientBinary,
  resolveTunnelClientBinaryStartTarget,
  tunnelClientDownloadUrl
} from "./tunnelClientBinary.js";
import { TunnelClientProcessManager } from "./tunnelClientProcess.js";
import {
  mcpTunnelConfigStorePaths,
  readTunnelClientConfig,
  writeTunnelClientConfig,
  type TunnelClientConfig
} from "./tunnelClientStore.js";
import type { DesktopCredentialStorage } from "../credentialStorage/applicationCredentialStorage.js";
import {
  createTunnelClientConfigController,
  type TunnelClientConfigSnapshot
} from "./tunnelClientConfigController.js";
import type { CredentialStorageMode } from "../../shared/credentialStorageSettings.js";

const localMcp = new LocalMcpServerManager();
const tunnelClient = new TunnelClientProcessManager({ onStatusChange: () => void publishStatus() });
const envTunnelClientPath = process.env.PLANWEAVE_TUNNEL_CLIENT_PATH?.trim() || null;
let credentialStorageMode: CredentialStorageMode = "system";
let credentialStorage: DesktopCredentialStorage = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value)
};
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

const configController = createTunnelClientConfigController({
  read: () => readTunnelClientConfig(mcpTunnelConfigStorePaths(userDataDir())),
  write: (config) => writeTunnelClientConfig(config, mcpTunnelConfigStorePaths(userDataDir())),
  storage: () => credentialStorage,
  mode: () => credentialStorageMode
});

// Credential-mode migration shares the same configuration owner as IPC commands.
export async function updateMcpTunnelConfig(
  update: (config: TunnelClientConfig) => TunnelClientConfig
): Promise<void> {
  await configController.update((state) => ({ ...state, config: update(state.config) }));
  await publishStatus();
}

function binaryConfig(state: TunnelClientConfigSnapshot) {
  return {
    path: envTunnelClientPath ?? state.config.tunnelClientPath,
    verification: envTunnelClientPath ? null : state.config.verification
  };
}

async function statusSnapshot(): Promise<{
  state: TunnelClientConfigSnapshot;
  status: McpTunnelStatus;
}> {
  // Binary probing is outside the configuration queue. Discard a late probe if
  // another command committed while it was running.
  while (true) {
    const state = await configController.read();
    const binary = binaryConfig(state);
    const binaryStatus = await resolveTunnelClientBinary(binary.path, binary.verification);
    if (configController.current !== state) continue;
    return {
      state,
      status: {
        binary: binaryStatus,
        download:
          downloadStatus.phase === "idle" && binary.verification
            ? { phase: "ready", assetName: binary.verification.assetName, error: null }
            : downloadStatus,
        localMcp: localMcp.getStatus(),
        tunnel: tunnelClient.getStatus(),
        config: {
          tunnelId: state.config.tunnelId,
          hasRuntimeApiKey: configController.persistence(state) !== "missing",
          runtimeApiKeyPersistence: configController.persistence(state),
          runtimeApiKeyStorage: credentialStorage.isEncryptionAvailable()
            ? "available"
            : "unavailable",
          autoStart: state.config.autoStart && configController.persisted(state)
        },
        downloadUrl: tunnelClientDownloadUrl,
        updatedAt: nowIso()
      }
    };
  }
}

async function getStatus(): Promise<McpTunnelStatus> {
  return (await statusSnapshot()).status;
}

async function publishStatus(): Promise<McpTunnelStatus> {
  while (true) {
    const { state, status } = await statusSnapshot();
    if (configController.current !== state) continue;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(mcpTunnelChangedChannel, status);
      }
    }
    return status;
  }
}

export async function getMcpTunnelStatus(): Promise<McpTunnelStatus> {
  return getStatus();
}

export async function setTunnelClientPath(path: string | null): Promise<McpTunnelStatus> {
  await configController.update((state) => ({
    ...state,
    config: { ...state.config, tunnelClientPath: path?.trim() || null, verification: null }
  }));
  return publishStatus();
}

export async function setTunnelAutoStart(enabled: boolean): Promise<McpTunnelStatus> {
  await configController.update((state) => {
    if (enabled && !configController.persisted(state)) {
      throw new Error(
        "Auto-start requires a runtime API key that can be restored from secure storage."
      );
    }
    return { ...state, config: { ...state.config, autoStart: enabled } };
  });
  return publishStatus();
}

export async function downloadTunnelClient(): Promise<McpTunnelStatus> {
  await configController.read();
  downloadStatus = { phase: "downloading", assetName: null, error: null };
  await publishStatus();
  try {
    const result = await downloadOfficialTunnelClient();
    await configController.update((state) => ({
      ...state,
      config: {
        ...state.config,
        tunnelClientPath: result.binaryPath,
        verification: result.verification
      }
    }));
    downloadStatus = { phase: "ready", assetName: result.verification.assetName, error: null };
  } catch (error) {
    downloadStatus = {
      phase: "error",
      assetName: null,
      error: error instanceof Error ? error.message : String(error)
    };
    await publishStatus();
    throw error;
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
  const requestedTunnelId = input.tunnelId?.trim() || null;
  const requestedRuntimeApiKey = input.runtimeApiKey?.trim() || null;
  const state =
    requestedTunnelId || requestedRuntimeApiKey
      ? await configController.prepareStart(input)
      : await configController.read();
  const effectiveTunnelId = state.config.tunnelId;
  const effectiveRuntimeApiKey = configController.persisted(state)
    ? state.runtimeApiKey
    : configController.sessionKey(state);
  if (!effectiveTunnelId) throw new Error("tunnel_id is required.");
  if (!effectiveRuntimeApiKey) throw new Error("Runtime API key is required.");
  const binary = binaryConfig(state);
  const binaryStartTarget = await resolveTunnelClientBinaryStartTarget(
    binary.path,
    binary.verification
  );
  let localStatus = localMcp.getStatus();
  if (localStatus.phase !== "running" || !localStatus.endpoint) {
    if (localStatus.phase === "starting" || localStatus.phase === "stopping") {
      throw new Error(
        "Wait for the local PlanWeave MCP server to finish changing state before starting the tunnel."
      );
    }
    localStatus = await localMcp.start();
    await publishStatus();
  }
  if (localStatus.phase !== "running" || !localStatus.endpoint) {
    throw new Error(
      localStatus.error
        ? `Failed to start the local PlanWeave MCP server: ${localStatus.error}`
        : "Failed to start the local PlanWeave MCP server."
    );
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
  const state = await configController.read();
  if (!state.config.autoStart) return;
  if (!configController.persisted(state)) {
    await configController.update((current) => ({
      ...current,
      config: {
        ...current.config,
        autoStart: configController.persisted(current) ? current.config.autoStart : false
      }
    }));
    await publishStatus();
    return;
  }
  try {
    await startTunnel();
  } catch (error) {
    console.error(
      `Failed to auto-start MCP tunnel: ${error instanceof Error ? error.message : String(error)}`
    );
    await publishStatus();
  }
}

export async function stopMcpTunnelProcesses(): Promise<void> {
  await tunnelClient.stop();
  await localMcp.stop();
  await publishStatus();
}

export function registerMcpTunnelHandlers(
  options: {
    credentialStorage?: DesktopCredentialStorage;
    credentialStorageMode?: CredentialStorageMode;
  } = {}
): void {
  if (options.credentialStorage) credentialStorage = options.credentialStorage;
  if (options.credentialStorageMode) credentialStorageMode = options.credentialStorageMode;
  ipcMain.handle(mcpTunnelInvokeChannels.getMcpTunnelStatus, () => getMcpTunnelStatus());
  ipcMain.handle(mcpTunnelInvokeChannels.downloadTunnelClient, () => downloadTunnelClient());
  ipcMain.handle(mcpTunnelInvokeChannels.setTunnelClientPath, (_event, path: string | null) =>
    setTunnelClientPath(path)
  );
  ipcMain.handle(mcpTunnelInvokeChannels.setTunnelAutoStart, (_event, enabled: boolean) =>
    setTunnelAutoStart(enabled)
  );
  ipcMain.handle(mcpTunnelInvokeChannels.startLocalMcp, (_event, input?: StartLocalMcpInput) =>
    startLocalMcp(input)
  );
  ipcMain.handle(mcpTunnelInvokeChannels.stopLocalMcp, () => stopLocalMcp());
  ipcMain.handle(mcpTunnelInvokeChannels.startTunnel, (_event, input: StartTunnelInput) =>
    startTunnel(input)
  );
  ipcMain.handle(mcpTunnelInvokeChannels.stopTunnel, () => stopTunnel());
}
