#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readMcpConfig } from "./config.js";
import { listenPlanweaveMcpServer } from "./server.js";

export { readMcpConfig, type McpConfig, type McpOAuthConfig } from "./config.js";
export { createHealthPayload, type HealthPayload } from "./health.js";
export { createPlanweaveMcpHttpServer, listenPlanweaveMcpServer } from "./server.js";
export {
  compatPlanweaveToolNames,
  debugPlanweaveToolNames,
  defaultPlanweaveToolNames,
  handlePlanweaveTool,
  isPlanweaveToolName,
  planweaveToolNames,
  type PlanweaveToolName,
  type RuntimeGateway
} from "./tools.js";
export {
  assertTunnelClientBinaryStartTarget,
  getTunnelClientBinaryStartError,
  resolveTunnelClientBinary,
  resolveTunnelClientBinaryStartTarget,
  tunnelClientDownloadUrl
} from "./tunnel/binary.js";
export {
  downloadOfficialTunnelClient,
  parseSha256Sums,
  selectTunnelClientReleaseAssets,
  tunnelClientPlatformAsset
} from "./tunnel/downloader.js";
export {
  createDefaultTunnelConfig,
  createFileTunnelConfigStore,
  defaultTunnelClientInstallRoot,
  defaultTunnelConfigPath,
  defaultTunnelMcpUrl,
  normalizeTunnelConfig,
  parseLoopbackMcpUrl,
  tunnelConfigVersion
} from "./tunnel/configStore.js";
export {
  LocalMcpServerManager,
  type LocalMcpServerManagerOptions
} from "./tunnel/localMcpServer.js";
export {
  buildTunnelClientInitArgs,
  buildTunnelClientRunArgs,
  TunnelClientProcessManager
} from "./tunnel/process.js";
export { runMcpTunnel, type RunMcpTunnelDependencies } from "./tunnel/run.js";
export {
  getTunnelStatusReport,
  resolveRuntimeApiKey,
  createTunnelDiagnosticChecks
} from "./tunnel/status.js";
export {
  renderSystemdEnvFile,
  renderSystemdService,
  renderSystemdTemplates,
  type SystemdTemplateInput
} from "./tunnel/systemd.js";
export type {
  GitHubRelease,
  GitHubReleaseAsset,
  LocalMcpServerStatus,
  McpTunnelDownloadPhase,
  McpTunnelPhase,
  McpTunnelRuntimeApiKeyPersistence,
  TunnelClientArgsInput,
  TunnelClientBinaryStartTarget,
  TunnelClientBinaryStatus,
  TunnelClientBinaryVerification,
  TunnelClientDownloadResult,
  TunnelClientDownloadStatus,
  TunnelClientExecutableName,
  TunnelClientPlatformAsset,
  TunnelClientStatus,
  RuntimeApiKeyResolution,
  RuntimeApiKeySource,
  RuntimeApiKeyStatus,
  TunnelCheckStatus,
  TunnelConfig,
  TunnelConfigStore,
  TunnelDiagnosticCheck,
  TunnelStatusReport
} from "./tunnel/types.js";

function isCliEntrypoint(): boolean {
  if (process.versions.electron) {
    return false;
  }
  if (!process.argv[1]) {
    return false;
  }
  return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
}

if (isCliEntrypoint()) {
  try {
    const config = readMcpConfig();
    await listenPlanweaveMcpServer(config);
    console.log(`PlanWeave MCP server listening on http://${config.host}:${config.port}/mcp`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
