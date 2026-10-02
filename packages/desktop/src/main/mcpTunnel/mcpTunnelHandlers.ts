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
let processGeneration = 0;
let pendingStart: {
  kind: "local" | "tunnel" | "auto";
  promise: Promise<McpTunnelStatus>;
  controller: AbortController;
} | null = null;
let pendingStop: Promise<McpTunnelStatus> | null = null;
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
    const generation = processGeneration;
    const { state, status } = await statusSnapshot();
    if (generation !== processGeneration) continue;
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

function startProcesses(
  kind: "local" | "tunnel" | "auto",
  work: (signal: AbortSignal) => Promise<McpTunnelStatus>
): Promise<McpTunnelStatus> {
  if (pendingStop) return pendingStop.then(() => startProcesses(kind, work));
  if (pendingStart) {
    if (pendingStart.kind !== kind && !(kind === "auto" && pendingStart.kind === "tunnel"))
      return Promise.reject(new Error("Another MCP process start is still pending."));
    return pendingStart.promise;
  }
  processGeneration += 1;
  const controller = new AbortController();
  const promise = work(controller.signal).finally(() => {
    if (pendingStart?.promise === promise) pendingStart = null;
  });
  pendingStart = { kind, promise, controller };
  return promise;
}

function stopProcesses(stopLocal: boolean): Promise<McpTunnelStatus> {
  if (pendingStop) return pendingStop.then(() => (stopLocal ? stopProcesses(true) : getStatus()));
  processGeneration += 1;
  const start = pendingStart;
  start?.controller.abort();
  const stopping = (async () => {
    const stops: Promise<unknown>[] = [tunnelClient.stop()];
    if (stopLocal || localMcp.getStatus().phase === "starting") stops.push(localMcp.stop());
    const outcomes = await Promise.allSettled([...stops, ...(start ? [start.promise] : [])]);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return publishStatus();
  })().finally(() => {
    if (pendingStop === stopping) pendingStop = null;
  });
  pendingStop = stopping;
  return stopping;
}

export function startLocalMcp(input: StartLocalMcpInput = {}): Promise<McpTunnelStatus> {
  return startProcesses("local", async (signal) => {
    await localMcp.start(input);
    return signal.aborted ? getStatus() : publishStatus();
  });
}

export function stopLocalMcp(): Promise<McpTunnelStatus> {
  return stopProcesses(true);
}

export function startTunnel(input: StartTunnelInput = {}): Promise<McpTunnelStatus> {
  return startProcesses("tunnel", (signal) => startTunnelOwned(input, signal));
}

async function startTunnelOwned(
  input: StartTunnelInput,
  signal: AbortSignal
): Promise<McpTunnelStatus> {
  const requestedTunnelId = input.tunnelId?.trim() || null;
  const requestedRuntimeApiKey = input.runtimeApiKey?.trim() || null;
  const state =
    requestedTunnelId || requestedRuntimeApiKey
      ? await configController.prepareStart(input)
      : await configController.read();
  if (signal.aborted) return getStatus();
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
  if (signal.aborted) return getStatus();
  let localStatus = localMcp.getStatus();
  if (localStatus.phase !== "running" || !localStatus.endpoint) {
    localStatus = await localMcp.start();
    if (signal.aborted) return getStatus();
    await publishStatus();
    if (signal.aborted) return getStatus();
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
  return signal.aborted ? getStatus() : publishStatus();
}

export function stopTunnel(): Promise<McpTunnelStatus> {
  return stopProcesses(false);
}

export async function autoStartMcpTunnel(): Promise<void> {
  await startProcesses("auto", async (signal) => {
    const state = await configController.read();
    if (signal.aborted) return getStatus();
    if (!state.config.autoStart) return getStatus();
    if (!configController.persisted(state)) {
      await configController.update((current) => ({
        ...current,
        config: {
          ...current.config,
          autoStart: configController.persisted(current) ? current.config.autoStart : false
        }
      }));
      await publishStatus();
      return getStatus();
    }
    try {
      return await startTunnelOwned({}, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      console.error(
        `Failed to auto-start MCP tunnel: ${error instanceof Error ? error.message : String(error)}`
      );
      return signal.aborted ? getStatus() : publishStatus();
    }
  });
}

export async function stopMcpTunnelProcesses(): Promise<void> {
  await stopProcesses(true);
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
