import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import type { CredentialStorageMode } from "../../shared/credentialStorageSettings.js";
import type { TunnelClientBinaryVerification } from "./tunnelClientBinary.js";

export type TunnelClientConfig = {
  tunnelClientPath: string | null;
  verification: TunnelClientBinaryVerification | null;
  tunnelId: string | null;
  encryptedRuntimeApiKey: string | null;
  encryptedRuntimeApiKeys?: Partial<Record<CredentialStorageMode, string>>;
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
  const encryptedRuntimeApiKeysRecord =
    record.encryptedRuntimeApiKeys &&
    typeof record.encryptedRuntimeApiKeys === "object" &&
    !Array.isArray(record.encryptedRuntimeApiKeys)
      ? (record.encryptedRuntimeApiKeys as Record<string, unknown>)
      : {};
  const encryptedRuntimeApiKeys: Partial<Record<CredentialStorageMode, string>> = {};
  const applicationKey = readString(encryptedRuntimeApiKeysRecord.application);
  const systemKey = readString(encryptedRuntimeApiKeysRecord.system);
  if (applicationKey) encryptedRuntimeApiKeys.application = applicationKey;
  if (systemKey) encryptedRuntimeApiKeys.system = systemKey;
  return {
    tunnelClientPath: readString(record.tunnelClientPath),
    verification: readVerification(record.verification),
    tunnelId: readString(record.tunnelId),
    encryptedRuntimeApiKey: readString(record.encryptedRuntimeApiKey),
    ...(Object.keys(encryptedRuntimeApiKeys).length > 0 ? { encryptedRuntimeApiKeys } : {}),
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
  const tmp = `${paths.configPath}.${randomUUID()}.tmp`;
  const file = await open(tmp, "wx", 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      const written = await file.stat();
      if ((written.mode & 0o777) !== 0o600) {
        await file.chmod(0o600);
        // Windows chmod cannot express POSIX owner-only permissions.
        if (process.platform !== "win32" && ((await file.stat()).mode & 0o777) !== 0o600) {
          throw new Error("MCP tunnel config temporary file permissions are not 0o600");
        }
      }
    } catch (error) {
      try {
        await file.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          `${error instanceof Error ? error.message : String(error)}; failed to close MCP tunnel config temporary file`
        );
      }
      throw error;
    }
    await file.close();
    // Rename is the commit point; all fallible preparation happens before it.
    await rename(tmp, paths.configPath);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch (cleanupError) {
      if (!isMissingFileError(cleanupError)) {
        throw new AggregateError(
          [error, cleanupError],
          `${error instanceof Error ? error.message : String(error)}; failed to clean MCP tunnel config temporary file`
        );
      }
    }
    throw error;
  }
}
