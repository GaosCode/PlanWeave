import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import type { TunnelClientBinaryVerification } from "./tunnelClientBinary.js";

export type TunnelClientConfig = {
  tunnelClientPath: string | null;
  verification: TunnelClientBinaryVerification | null;
  tunnelId: string | null;
  encryptedRuntimeApiKey: string | null;
  autoStart: boolean;
};

const configFileName = "config.json";

export type TunnelClientConfigStorePaths = {
  configPath: string;
  legacyConfigPath?: string | null;
};

function defaultTunnelClientConfig(): TunnelClientConfig {
  return {
    tunnelClientPath: null,
    verification: null,
    tunnelId: null,
    encryptedRuntimeApiKey: null,
    autoStart: false
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function mcpTunnelConfigPath(): string {
  return desktopHomePaths().mcpTunnelConfigFile;
}

export function mcpTunnelDownloadsDir(): string {
  return desktopHomePaths().mcpTunnelDownloadsDir;
}

export function mcpTunnelLegacyDataDir(userDataDir: string): string {
  return join(userDataDir, "mcp-tunnel");
}

export function mcpTunnelLegacyConfigPath(userDataDir: string): string {
  return join(mcpTunnelLegacyDataDir(userDataDir), configFileName);
}

export function mcpTunnelConfigStorePaths(
  userDataDir?: string | null
): TunnelClientConfigStorePaths {
  return {
    configPath: mcpTunnelConfigPath(),
    legacyConfigPath: userDataDir ? mcpTunnelLegacyConfigPath(userDataDir) : null
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readVerification(value: unknown): TunnelClientBinaryVerification | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const assetName = readString(record.assetName);
  const assetSha256 = readString(record.assetSha256);
  const binarySha256 = readString(record.binarySha256);
  if (!assetName || !assetSha256 || !binarySha256) {
    return null;
  }
  return { assetName, assetSha256, binarySha256 };
}

function normalizeTunnelClientConfig(parsed: unknown): TunnelClientConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaultTunnelClientConfig();
  }
  const record = parsed as Record<string, unknown>;
  return {
    tunnelClientPath: readString(record.tunnelClientPath),
    verification: readVerification(record.verification),
    tunnelId: readString(record.tunnelId),
    encryptedRuntimeApiKey: readString(record.encryptedRuntimeApiKey),
    autoStart: record.autoStart === true
  };
}

async function readConfigFile(path: string): Promise<TunnelClientConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw new Error(
      `Failed to read MCP tunnel config at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    return normalizeTunnelClientConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Invalid MCP tunnel config JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function readTunnelClientConfig(
  paths: TunnelClientConfigStorePaths = mcpTunnelConfigStorePaths()
): Promise<TunnelClientConfig> {
  const config = await readConfigFile(paths.configPath);
  if (config) {
    return config;
  }

  if (paths.legacyConfigPath) {
    const legacyConfig = await readConfigFile(paths.legacyConfigPath);
    if (legacyConfig) {
      await writeTunnelClientConfig(legacyConfig, paths);
      return legacyConfig;
    }
  }

  return defaultTunnelClientConfig();
}

export async function writeTunnelClientConfig(
  config: TunnelClientConfig,
  paths: Pick<TunnelClientConfigStorePaths, "configPath"> = mcpTunnelConfigStorePaths()
): Promise<void> {
  const dir = dirname(paths.configPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  });
  const tmp = `${paths.configPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, paths.configPath);
  const written = await stat(paths.configPath);
  if ((written.mode & 0o777) !== 0o600) {
    await chmod(paths.configPath, 0o600);
  }
}
