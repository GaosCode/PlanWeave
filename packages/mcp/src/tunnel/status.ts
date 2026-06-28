import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import { resolveTunnelClientBinary } from "./binary.js";
import { parseLoopbackMcpUrl } from "./configStore.js";
import type {
  RuntimeApiKeyResolution,
  RuntimeApiKeySource,
  RuntimeApiKeyStatus,
  TunnelConfig,
  TunnelConfigStore,
  TunnelDiagnosticCheck,
  TunnelStatusReport
} from "./types.js";

export function resolveRuntimeApiKey(env: NodeJS.ProcessEnv = process.env): RuntimeApiKeyResolution {
  const openaiKey = env.OPENAI_RUNTIME_API_KEY?.trim();
  if (openaiKey) {
    return { available: true, source: "OPENAI_RUNTIME_API_KEY", value: openaiKey };
  }
  const controlPlaneKey = env.CONTROL_PLANE_API_KEY?.trim();
  if (controlPlaneKey) {
    return { available: true, source: "CONTROL_PLANE_API_KEY", value: controlPlaneKey };
  }
  return { available: false, source: null, value: null };
}

function toRuntimeApiKeyStatus(resolution: RuntimeApiKeyResolution): RuntimeApiKeyStatus {
  return {
    available: resolution.available,
    source: resolution.source
  };
}

function check(status: boolean, name: string, passed: string, failed: string): TunnelDiagnosticCheck {
  return {
    check: name,
    status: status ? "passed" : "failed",
    message: status ? passed : failed
  };
}

export function createTunnelDiagnosticChecks(input: {
  configPath: string;
  config: TunnelConfig;
  binaryAvailable: boolean;
  binaryExecutable: boolean;
  binaryVerified: boolean;
  binarySource: "managed" | "manual" | null;
  binaryError: string | null;
  runtimeApiKey: RuntimeApiKeyStatus;
}): TunnelDiagnosticCheck[] {
  const mcpUrl = parseLoopbackMcpUrl(input.config.mcpUrl);
  const runtimeKeySource: RuntimeApiKeySource | null = input.runtimeApiKey.source;
  return [
    check(true, "config_readable", `Config readable at ${input.configPath}.`, `Config is not readable at ${input.configPath}.`),
    check(Boolean(input.config.tunnelClientPath), "binary_configured", "Tunnel client binary path is configured.", "Tunnel client binary path is not configured."),
    check(input.binaryExecutable, "binary_executable", "Tunnel client binary is executable.", input.binaryError ?? "Tunnel client binary is not executable."),
    check(
      input.binarySource !== "managed" || input.binaryVerified,
      "binary_checksum",
      input.binarySource === "managed" ? "Managed tunnel client checksum is valid." : "Manual tunnel client path does not require managed checksum.",
      input.binaryError ?? "Managed tunnel client checksum is not valid."
    ),
    check(Boolean(input.config.tunnelId), "tunnel_id_configured", "Tunnel id is configured.", "Tunnel id is not configured."),
    check(
      input.runtimeApiKey.available,
      "runtime_api_key_available",
      `Runtime API key is available from ${runtimeKeySource}.`,
      "Runtime API key is missing. Set OPENAI_RUNTIME_API_KEY or CONTROL_PLANE_API_KEY."
    ),
    check(true, "mcp_url_loopback", "MCP URL is loopback HTTP /mcp.", "MCP URL must be loopback HTTP /mcp."),
    check(Boolean(mcpUrl.port) || mcpUrl.hostname === "localhost" || mcpUrl.hostname === "127.0.0.1" || mcpUrl.hostname === "[::1]", "mcp_url_port", "MCP URL port is valid.", "MCP URL port is invalid."),
    check(true, "planweave_home_resolved", `PLANWEAVE_HOME resolved to ${resolvePlanweaveHome()}.`, "PLANWEAVE_HOME could not be resolved.")
  ];
}

export async function getTunnelStatusReport(store: TunnelConfigStore, env: NodeJS.ProcessEnv = process.env): Promise<TunnelStatusReport> {
  const config = await store.read();
  const binary = await resolveTunnelClientBinary(config.tunnelClientPath, config.verification);
  const runtimeApiKey = toRuntimeApiKeyStatus(resolveRuntimeApiKey(env));
  const checks = createTunnelDiagnosticChecks({
    configPath: store.path(),
    config,
    binaryAvailable: binary.available,
    binaryExecutable: binary.available,
    binaryVerified: binary.verified,
    binarySource: binary.source,
    binaryError: binary.error,
    runtimeApiKey
  });
  const configured = checks.every((item) => item.status === "passed");
  return {
    configured,
    configPath: store.path(),
    config,
    binary,
    runtimeApiKey,
    checks
  };
}
