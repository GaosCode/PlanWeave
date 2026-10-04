import { useCallback, useEffect, useRef, useState } from "react";
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
      runtimeApiKeyPersistence: "missing",
      runtimeApiKeyStorage: "unavailable",
      autoStart: false
    },
    downloadUrl: "https://github.com/openai/tunnel-client/releases/latest",
    updatedAt: new Date(0).toISOString()
  };
}

export function useMcpTunnelStatus({ setError }: { setError: (message: string | null) => void }) {
  const [status, setStatus] = useState<McpTunnelStatus>(() => idleStatus());
  const acceptedStatus = useRef(status);
  const acceptStatus = useCallback((nextStatus: McpTunnelStatus) => {
    acceptedStatus.current = nextStatus;
    setStatus(nextStatus);
  }, []);
  const activeActions = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const lifecycle = useRef<object | null>(null);
  useEffect(() => {
    lifecycle.current = {};
    return () => {
      lifecycle.current = null;
      activeActions.current.clear();
    };
  }, []);
  const statusEvents = useRef(0);
  const api = typeof window !== "undefined" ? window.planweaveMcpTunnel : undefined;

  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    const initialEvents = statusEvents.current;
    void api
      .getMcpTunnelStatus()
      .then((nextStatus) => {
        if (!cancelled && statusEvents.current === initialEvents) {
          acceptStatus(nextStatus);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : String(error));
        }
      });
    const unsubscribe = api.onMcpTunnelChanged((nextStatus) => {
      if (cancelled) return;
      statusEvents.current += 1;
      acceptStatus(nextStatus);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, setError, acceptStatus]);

  const invoke = useCallback(
    async (
      name: string,
      action: () => Promise<McpTunnelStatus>
    ): Promise<McpTunnelStatus | null> => {
      const actionLifecycle = lifecycle.current;
      if (!actionLifecycle) return null;
      if (!api) {
        setError("MCP tunnel bridge unavailable.");
        return null;
      }
      if (activeActions.current.has(name)) return null;
      activeActions.current.add(name);
      setPending(new Set(activeActions.current));
      const eventsBeforeAction = statusEvents.current;
      try {
        const nextStatus = await action();
        if (lifecycle.current !== actionLifecycle) return null;
        if (statusEvents.current === eventsBeforeAction) acceptStatus(nextStatus);
        const error =
          name === "downloadTunnelClient"
            ? nextStatus.download.error
            : name === "startTunnel" || name === "stopTunnel"
              ? nextStatus.tunnel.error
              : name === "startLocalMcp" || name === "stopLocalMcp"
                ? nextStatus.localMcp.error
                : null;
        setError(error);
        return error ? null : acceptedStatus.current;
      } catch (error) {
        if (lifecycle.current !== actionLifecycle) return null;
        setError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        if (lifecycle.current === actionLifecycle) {
          activeActions.current.delete(name);
          setPending(new Set(activeActions.current));
        }
      }
    },
    [api, setError, acceptStatus]
  );

  return {
    available: Boolean(api),
    pending,
    status,
    downloadTunnelClient: () => invoke("downloadTunnelClient", () => api!.downloadTunnelClient()),
    setTunnelClientPath: (path: string | null) =>
      invoke("setTunnelClientPath", () => api!.setTunnelClientPath(path)),
    setTunnelAutoStart: (enabled: boolean) =>
      invoke("setTunnelAutoStart", () => api!.setTunnelAutoStart(enabled)),
    startLocalMcp: (input?: StartLocalMcpInput) =>
      invoke("startLocalMcp", () => api!.startLocalMcp(input)),
    stopLocalMcp: () => invoke("stopLocalMcp", () => api!.stopLocalMcp()),
    startTunnel: (input: StartTunnelInput) => invoke("startTunnel", () => api!.startTunnel(input)),
    stopTunnel: () => invoke("stopTunnel", () => api!.stopTunnel())
  };
}
