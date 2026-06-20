export type McpTunnelPhase = "stopped" | "starting" | "running" | "stopping" | "error";
export type McpTunnelDownloadPhase = "idle" | "downloading" | "ready" | "error";

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

export type McpTunnelStatus = {
  binary: TunnelClientBinaryStatus;
  download: TunnelClientDownloadStatus;
  localMcp: LocalMcpServerStatus;
  tunnel: TunnelClientStatus;
  config: {
    tunnelId: string | null;
    hasRuntimeApiKey: boolean;
    runtimeApiKeyStorage: "available" | "unavailable";
  };
  downloadUrl: string;
  updatedAt: string;
};

export type StartLocalMcpInput = {
  port?: number | null;
};

export type StartTunnelInput = {
  tunnelId?: string | null;
  runtimeApiKey?: string | null;
};

export const mcpTunnelInvokeChannels = {
  getMcpTunnelStatus: "planweave-mcp-tunnel:getStatus",
  downloadTunnelClient: "planweave-mcp-tunnel:downloadTunnelClient",
  setTunnelClientPath: "planweave-mcp-tunnel:setTunnelClientPath",
  startLocalMcp: "planweave-mcp-tunnel:startLocalMcp",
  stopLocalMcp: "planweave-mcp-tunnel:stopLocalMcp",
  startTunnel: "planweave-mcp-tunnel:startTunnel",
  stopTunnel: "planweave-mcp-tunnel:stopTunnel"
} as const;

export const mcpTunnelChangedChannel = "planweave-mcp-tunnel:changed";

export type PlanWeaveMcpTunnelApi = {
  getMcpTunnelStatus: () => Promise<McpTunnelStatus>;
  downloadTunnelClient: () => Promise<McpTunnelStatus>;
  setTunnelClientPath: (path: string | null) => Promise<McpTunnelStatus>;
  startLocalMcp: (input?: StartLocalMcpInput) => Promise<McpTunnelStatus>;
  stopLocalMcp: () => Promise<McpTunnelStatus>;
  startTunnel: (input: StartTunnelInput) => Promise<McpTunnelStatus>;
  stopTunnel: () => Promise<McpTunnelStatus>;
  onMcpTunnelChanged: (callback: (status: McpTunnelStatus) => void) => () => void;
};
