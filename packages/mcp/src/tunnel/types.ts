export type McpTunnelPhase = "stopped" | "starting" | "running" | "stopping" | "error";
export type McpTunnelDownloadPhase = "idle" | "downloading" | "ready" | "error";
export type McpTunnelRuntimeApiKeyPersistence = "persisted" | "session-only" | "missing";

export type TunnelClientBinaryVerification = {
  assetName: string;
  assetSha256: string;
  binarySha256: string;
};

export type TunnelClientBinaryStatus = {
  path: string | null;
  available: boolean;
  source: "managed" | "manual" | null;
  assetName: string | null;
  assetSha256: string | null;
  sha256: string | null;
  version: string | null;
  verified: boolean;
  error: string | null;
};

export type TunnelClientExecutableName = "tunnel-client" | "tunnel-client.exe";
export const tunnelClientBinaryStartTargetBrand: unique symbol = Symbol("TunnelClientBinaryStartTarget");

export type TunnelClientBinaryStartTarget = TunnelClientBinaryStatus & {
  readonly [tunnelClientBinaryStartTargetBrand]: true;
  path: string;
  available: true;
  source: "managed" | "manual";
  executableDir: string;
  executableName: TunnelClientExecutableName;
};

export type TunnelClientDownloadStatus = {
  phase: McpTunnelDownloadPhase;
  assetName: string | null;
  error: string | null;
};

export type LocalMcpServerStatus = {
  phase: McpTunnelPhase;
  endpoint: string | null;
  host: string;
  port: number;
  pid: number | null;
  planweaveHome: string;
  planweaveHomeFromEnv: boolean;
  healthy: boolean;
  error: string | null;
};

export type TunnelClientStatus = {
  phase: McpTunnelPhase;
  profile: string;
  tunnelId: string | null;
  pid: number | null;
  healthUrl: string | null;
  ready: boolean;
  error: string | null;
};

export type TunnelClientArgsInput = {
  tunnelId: string;
  mcpServerUrl: string;
};

export type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

export type TunnelClientPlatformAsset = {
  assetSuffix: string;
  binaryName: string;
};

export type TunnelClientDownloadResult = {
  binaryPath: string;
  verification: TunnelClientBinaryVerification;
};

export type TunnelConfig = {
  version: "mcp-tunnel/v1";
  tunnelClientPath: string | null;
  verification: TunnelClientBinaryVerification | null;
  tunnelId: string | null;
  mcpUrl: string;
};

export type TunnelConfigStore = {
  read(): Promise<TunnelConfig>;
  write(config: TunnelConfig): Promise<void>;
  path(): string;
};

export type RuntimeApiKeySource = "OPENAI_RUNTIME_API_KEY" | "CONTROL_PLANE_API_KEY";

export type RuntimeApiKeyStatus = {
  available: boolean;
  source: RuntimeApiKeySource | null;
};

export type RuntimeApiKeyResolution =
  | {
      available: true;
      source: RuntimeApiKeySource;
      value: string;
    }
  | {
      available: false;
      source: null;
      value: null;
    };

export type TunnelCheckStatus = "passed" | "failed";

export type TunnelDiagnosticCheck = {
  check: string;
  status: TunnelCheckStatus;
  message: string;
};

export type TunnelStatusReport = {
  configured: boolean;
  configPath: string;
  config: TunnelConfig;
  binary: TunnelClientBinaryStatus;
  runtimeApiKey: RuntimeApiKeyStatus;
  checks: TunnelDiagnosticCheck[];
};
