import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import type { TunnelClientBinaryVerification, TunnelConfig, TunnelConfigStore } from "./types.js";

export const defaultTunnelMcpUrl = "http://127.0.0.1:8787/mcp";
export const tunnelConfigVersion = "mcp-tunnel/v1";

const loopbackMcpHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function defaultTunnelConfigPath(planweaveHome = resolvePlanweaveHome()): string {
  return join(planweaveHome, "config", "mcp-tunnel", "config.json");
}

export function defaultTunnelClientInstallRoot(planweaveHome = resolvePlanweaveHome()): string {
  return join(planweaveHome, "config", "mcp-tunnel");
}

export function createDefaultTunnelConfig(): TunnelConfig {
  return {
    version: tunnelConfigVersion,
    tunnelClientPath: null,
    verification: null,
    tunnelId: null,
    mcpUrl: defaultTunnelMcpUrl
  };
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function parseVerification(value: unknown): TunnelClientBinaryVerification | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verification must be an object.");
  }
  const record = value as Record<string, unknown>;
  return {
    assetName: readRequiredString(record.assetName, "verification.assetName"),
    assetSha256: readRequiredString(record.assetSha256, "verification.assetSha256"),
    binarySha256: readRequiredString(record.binarySha256, "verification.binarySha256")
  };
}

export function parseLoopbackMcpUrl(value: string): URL {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("mcpUrl must be a valid URL.");
  }
  if (url.protocol !== "http:") {
    throw new Error("mcpUrl must use http.");
  }
  if (!loopbackMcpHosts.has(url.hostname)) {
    throw new Error("mcpUrl must use a loopback host: 127.0.0.1, localhost, or [::1].");
  }
  if (url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) {
    throw new Error("mcpUrl must be a loopback HTTP /mcp URL without credentials, query, or hash.");
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("mcpUrl port must be an integer between 1 and 65535.");
    }
  }
  return url;
}

export function normalizeTunnelConfig(input: unknown): TunnelConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tunnel config must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  const version = record.version ?? tunnelConfigVersion;
  if (version !== tunnelConfigVersion) {
    throw new Error(`Unsupported tunnel config version '${String(version)}'.`);
  }
  const mcpUrl = readOptionalString(record.mcpUrl, "mcpUrl") ?? defaultTunnelMcpUrl;
  parseLoopbackMcpUrl(mcpUrl);
  return {
    version: tunnelConfigVersion,
    tunnelClientPath: readOptionalString(record.tunnelClientPath, "tunnelClientPath"),
    verification: parseVerification(record.verification),
    tunnelId: readOptionalString(record.tunnelId, "tunnelId"),
    mcpUrl
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function createFileTunnelConfigStore(
  configPath = defaultTunnelConfigPath()
): TunnelConfigStore {
  const resolvedPath = resolve(configPath);
  return {
    path: () => resolvedPath,
    async read(): Promise<TunnelConfig> {
      if (!(await fileExists(resolvedPath))) {
        return createDefaultTunnelConfig();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
      } catch (error) {
        throw new Error(
          `Failed to read MCP tunnel config at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      try {
        return normalizeTunnelConfig(parsed);
      } catch (error) {
        throw new Error(
          `Invalid MCP tunnel config at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async write(config: TunnelConfig): Promise<void> {
      const normalized = normalizeTunnelConfig(config);
      const dir = dirname(resolvedPath);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      });
      const tempPath = join(dir, `.config-${process.pid}-${Date.now()}.tmp`);
      await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(tempPath, resolvedPath);
      const written = await stat(resolvedPath);
      if ((written.mode & 0o777) !== 0o600) {
        await chmod(resolvedPath, 0o600);
      }
    }
  };
}
