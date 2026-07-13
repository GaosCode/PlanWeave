export type McpOAuthConfig = {
  enabled: boolean;
  accessTokenTtlMs?: number;
  authorizationCodeTtlMs?: number;
  clientStorePath?: string;
  tokenStorePath?: string;
};

export type McpConfig = {
  host: string;
  maxRequestBodyBytes: number;
  port: number;
  token?: string;
  oauth?: McpOAuthConfig;
  planweaveHomeFromEnv: boolean;
  toolDiscoveryMode?: "default" | "compat";
  trustProxy?: boolean;
};

export type McpConfigEnv = Partial<
  Record<
    | "PLANWEAVE_MCP_HOST"
    | "PLANWEAVE_MCP_MAX_BODY_BYTES"
    | "PLANWEAVE_MCP_OAUTH_CLIENT_STORE"
    | "PLANWEAVE_MCP_OAUTH_ENABLED"
    | "PLANWEAVE_MCP_OAUTH_TOKEN_STORE"
    | "PLANWEAVE_MCP_PORT"
    | "PLANWEAVE_MCP_TOKEN"
    | "PLANWEAVE_MCP_TOOL_DISCOVERY"
    | "PLANWEAVE_HOME",
    string | undefined
  >
>;

const defaultHost = "127.0.0.1";
const defaultMaxRequestBodyBytes = 1_048_576;
const defaultPort = 8787;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined): number {
  const trimmed = readOptionalString(value);
  if (!trimmed) {
    return defaultPort;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("PLANWEAVE_MCP_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PLANWEAVE_MCP_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseMaxRequestBodyBytes(value: string | undefined): number {
  const trimmed = readOptionalString(value);
  if (!trimmed) {
    return defaultMaxRequestBodyBytes;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("PLANWEAVE_MCP_MAX_BODY_BYTES must be an integer between 1 and 10485760.");
  }
  const bytes = Number(trimmed);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 10_485_760) {
    throw new Error("PLANWEAVE_MCP_MAX_BODY_BYTES must be an integer between 1 and 10485760.");
  }
  return bytes;
}

function parseBooleanFlag(value: string | undefined): boolean {
  const trimmed = readOptionalString(value)?.toLowerCase();
  if (!trimmed) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(trimmed)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(trimmed)) {
    return false;
  }
  throw new Error("PLANWEAVE_MCP_OAUTH_ENABLED must be a boolean flag.");
}

function parseToolDiscoveryMode(value: string | undefined): "default" | "compat" | undefined {
  const trimmed = readOptionalString(value)?.toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "default" || trimmed === "compat") {
    return trimmed;
  }
  throw new Error("PLANWEAVE_MCP_TOOL_DISCOVERY must be 'default' or 'compat'.");
}

export function readMcpConfig(env: McpConfigEnv = process.env): McpConfig {
  const host = readOptionalString(env.PLANWEAVE_MCP_HOST) ?? defaultHost;
  const token = readOptionalString(env.PLANWEAVE_MCP_TOKEN);
  const oauthEnabled = parseBooleanFlag(env.PLANWEAVE_MCP_OAUTH_ENABLED);
  const oauthClientStorePath = readOptionalString(env.PLANWEAVE_MCP_OAUTH_CLIENT_STORE);
  const oauthTokenStorePath = readOptionalString(env.PLANWEAVE_MCP_OAUTH_TOKEN_STORE);
  const toolDiscoveryMode = parseToolDiscoveryMode(env.PLANWEAVE_MCP_TOOL_DISCOVERY);
  if (!token && !oauthEnabled && !loopbackHosts.has(host)) {
    throw new Error("PLANWEAVE_MCP_TOKEN or PLANWEAVE_MCP_OAUTH_ENABLED is required when PLANWEAVE_MCP_HOST is not loopback.");
  }

  return {
    host,
    maxRequestBodyBytes: parseMaxRequestBodyBytes(env.PLANWEAVE_MCP_MAX_BODY_BYTES),
    oauth: oauthEnabled
      ? {
          enabled: true,
          ...(oauthClientStorePath ? { clientStorePath: oauthClientStorePath } : {}),
          ...(oauthTokenStorePath ? { tokenStorePath: oauthTokenStorePath } : {})
        }
      : undefined,
    port: parsePort(env.PLANWEAVE_MCP_PORT),
    token,
    planweaveHomeFromEnv: Boolean(readOptionalString(env.PLANWEAVE_HOME)),
    ...(toolDiscoveryMode ? { toolDiscoveryMode } : {})
  };
}
