import { useCallback, useEffect, useState } from "react";
import type { McpTunnelStatus, StartLocalMcpInput, StartTunnelInput } from "../../shared/mcpTunnel";

function idleStatus(): McpTunnelStatus {
  return {
    binary: {
      path: null,
      available: false,
      source: null,
      assetName: null,
      assetSha256: null,
      sha256: null,
      version: null,
      verified: false,
      error: "Tunnel client binary path is not configured."
    },
    download: {
      phase: "idle",
      assetName: null,
      error: null
    },
    localMcp: {
      phase: "stopped",
      endpoint: null,
      host: "127.0.0.1",
      port: 8787,
      pid: null,
      planweaveHome: "",
      planweaveHomeFromEnv: false,
      healthy: false,
      error: null
    },
    tunnel: {
      phase: "stopped",
      profile: "planweave-local-http",
      tunnelId: null,
      pid: null,
      healthUrl: null,
      ready: false,
      error: null
    },
    config: {
      tunnelId: null,
      hasRuntimeApiKey: false,
      runtimeApiKeyStorage: "unavailable"
    },
    downloadUrl: "https://github.com/openai/tunnel-client/releases/latest",
    updatedAt: new Date(0).toISOString()
  };
}

export function useMcpTunnelStatus({ setError }: { setError: (message: string | null) => void }) {
  const [status, setStatus] = useState<McpTunnelStatus>(() => idleStatus());
  const api = typeof window !== "undefined" ? window.planweaveMcpTunnel : undefined;

  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    void api.getMcpTunnelStatus().then((nextStatus) => {
      if (!cancelled) {
        setStatus(nextStatus);
      }
    });
    const unsubscribe = api.onMcpTunnelChanged((nextStatus) => {
      setStatus(nextStatus);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  const invoke = useCallback(
    async (action: () => Promise<McpTunnelStatus>) => {
      if (!api) {
        setError("MCP tunnel bridge unavailable.");
        return;
      }
      try {
        const nextStatus = await action();
        setStatus(nextStatus);
        setError(null);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [api, setError]
  );

  return {
    available: Boolean(api),
    status,
    downloadTunnelClient: () => invoke(() => api!.downloadTunnelClient()),
    setTunnelClientPath: (path: string | null) => invoke(() => api!.setTunnelClientPath(path)),
    startLocalMcp: (input?: StartLocalMcpInput) => invoke(() => api!.startLocalMcp(input)),
    stopLocalMcp: () => invoke(() => api!.stopLocalMcp()),
    startTunnel: (input: StartTunnelInput) => invoke(() => api!.startTunnel(input)),
    stopTunnel: () => invoke(() => api!.stopTunnel())
  };
}
