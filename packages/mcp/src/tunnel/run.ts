import type { McpOAuthConfig } from "../config.js";
import { LocalMcpServerManager } from "./localMcpServer.js";
import { TunnelClientProcessManager } from "./process.js";
import { resolveTunnelClientBinaryStartTarget } from "./binary.js";
import { parseLoopbackMcpUrl } from "./configStore.js";
import type { LocalMcpServerStatus, TunnelClientStatus, TunnelConfigStore } from "./types.js";
import { resolveRuntimeApiKey } from "./status.js";

type SignalSource = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

type RunLocalMcpManager = {
  start(input?: {
    host?: string | null;
    port?: number | null;
    token?: string | null;
    oauth?: McpOAuthConfig | null;
  }): Promise<LocalMcpServerStatus>;
  stop(): Promise<LocalMcpServerStatus>;
};

type RunTunnelClientManager = {
  start(options: Parameters<TunnelClientProcessManager["start"]>[0]): Promise<TunnelClientStatus>;
  stop(): Promise<TunnelClientStatus>;
  getStatus(): TunnelClientStatus;
};

export type RunMcpTunnelDependencies = {
  localMcp?: RunLocalMcpManager;
  tunnelClient?: RunTunnelClientManager;
  signals?: SignalSource;
  exit?: (code: number) => never;
};

function serverHostFromUrl(url: URL): string {
  return url.hostname === "[::1]" ? "::1" : url.hostname;
}

function serverPortFromUrl(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return 80;
}

function servedMcpOAuthEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes", "on"].includes(
    (env.PLANWEAVE_MCP_OAUTH_ENABLED ?? "").trim().toLowerCase()
  );
}

function servedMcpAuthConfigured(env: NodeJS.ProcessEnv): boolean {
  const token = env.PLANWEAVE_MCP_TOKEN?.trim();
  return Boolean(token) || servedMcpOAuthEnabled(env);
}

/** Mirror config.ts oauthEnabled branch so tunnel --serve actually enables OAuth. */
function servedMcpOAuthConfig(env: NodeJS.ProcessEnv): McpOAuthConfig | undefined {
  if (!servedMcpOAuthEnabled(env)) {
    return undefined;
  }
  const clientStorePath = env.PLANWEAVE_MCP_OAUTH_CLIENT_STORE?.trim();
  const tokenStorePath = env.PLANWEAVE_MCP_OAUTH_TOKEN_STORE?.trim();
  return {
    enabled: true,
    ...(clientStorePath ? { clientStorePath } : {}),
    ...(tokenStorePath ? { tokenStorePath } : {})
  };
}

async function stopManagers(
  localMcp: RunLocalMcpManager | null,
  tunnelClient: RunTunnelClientManager
): Promise<void> {
  await Promise.allSettled([tunnelClient.stop(), localMcp ? localMcp.stop() : Promise.resolve()]);
}

export async function runMcpTunnel(
  input: {
    store: TunnelConfigStore;
    serve?: boolean;
    env?: NodeJS.ProcessEnv;
  },
  dependencies: RunMcpTunnelDependencies = {}
): Promise<never> {
  const config = await input.store.read();
  const mcpUrl = parseLoopbackMcpUrl(config.mcpUrl);
  const runtimeApiKey = resolveRuntimeApiKey(input.env ?? process.env);
  if (!runtimeApiKey.available) {
    throw new Error(
      "Runtime API key is missing. Set OPENAI_RUNTIME_API_KEY or CONTROL_PLANE_API_KEY."
    );
  }
  if (!config.tunnelId) {
    throw new Error(
      "Tunnel id is not configured. Run planweave mcp tunnel configure --tunnel-id <id>."
    );
  }
  const binary = await resolveTunnelClientBinaryStartTarget(
    config.tunnelClientPath,
    config.verification
  );
  let settle: ((result: { exitCode: number; error?: Error }) => void) | null = null;
  const tunnelClient =
    dependencies.tunnelClient ??
    new TunnelClientProcessManager({
      onStatusChange: () => {
        const status = tunnelClient.getStatus();
        if ((status.phase === "error" || status.phase === "stopped") && settle) {
          settle({
            exitCode: status.phase === "error" ? 1 : 0,
            error: status.error ? new Error(status.error) : undefined
          });
        }
      }
    });
  if (input.serve === true && !servedMcpAuthConfigured(input.env ?? process.env)) {
    throw new Error(
      "Serving MCP through a tunnel requires authentication. Set PLANWEAVE_MCP_TOKEN or PLANWEAVE_MCP_OAUTH_ENABLED=true before running with --serve."
    );
  }
  const env = input.env ?? process.env;
  const localMcp =
    input.serve === true ? (dependencies.localMcp ?? new LocalMcpServerManager()) : null;
  if (localMcp) {
    const localStatus: LocalMcpServerStatus = await localMcp.start({
      host: serverHostFromUrl(mcpUrl),
      port: serverPortFromUrl(mcpUrl),
      token: env.PLANWEAVE_MCP_TOKEN?.trim() || null,
      oauth: servedMcpOAuthConfig(env) ?? null
    });
    if (localStatus.phase !== "running") {
      throw new Error(localStatus.error ?? "Failed to start local MCP server.");
    }
  }
  const tunnelStatus: TunnelClientStatus = await tunnelClient.start({
    binary,
    localMcpEndpoint: config.mcpUrl,
    input: {
      tunnelId: config.tunnelId,
      runtimeApiKey: runtimeApiKey.value
    }
  });
  if (tunnelStatus.phase !== "running") {
    await stopManagers(localMcp, tunnelClient);
    throw new Error(tunnelStatus.error ?? "Failed to start tunnel-client.");
  }

  const signalSource = dependencies.signals ?? process;
  const result = await new Promise<{ exitCode: number; error?: Error }>((resolve) => {
    let settled = false;
    const finish = (nextResult: { exitCode: number; error?: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      settle = null;
      resolve(nextResult);
    };
    const stop = (signal: NodeJS.Signals) => {
      void stopManagers(localMcp, tunnelClient).then(() => {
        finish({ exitCode: signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1 });
      });
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    settle = finish;
    signalSource.once("SIGINT", onSigint);
    signalSource.once("SIGTERM", onSigterm);
    const currentStatus = tunnelClient.getStatus();
    if (currentStatus.phase === "error" || currentStatus.phase === "stopped") {
      finish({
        exitCode: currentStatus.phase === "error" ? 1 : 0,
        error: currentStatus.error ? new Error(currentStatus.error) : undefined
      });
    }
  });
  if (result.error) {
    await stopManagers(localMcp, tunnelClient);
    throw result.error;
  }
  const exit = dependencies.exit ?? process.exit;
  exit(result.exitCode);
  return await new Promise<never>(() => undefined);
}
