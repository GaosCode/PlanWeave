import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TunnelClientBinaryVerification } from "./tunnelClientBinary.js";

export type TunnelClientConfig = {
  tunnelClientPath: string | null;
  verification: TunnelClientBinaryVerification | null;
  tunnelId: string | null;
  encryptedRuntimeApiKey: string | null;
  autoStart: boolean;
};

const configFileName = "config.json";

export function mcpTunnelDataDir(userDataDir: string): string {
  return join(userDataDir, "mcp-tunnel");
}

export function mcpTunnelConfigPath(userDataDir: string): string {
  return join(mcpTunnelDataDir(userDataDir), configFileName);
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

export async function readTunnelClientConfig(userDataDir: string): Promise<TunnelClientConfig> {
  try {
    const parsed = JSON.parse(await readFile(mcpTunnelConfigPath(userDataDir), "utf8")) as Record<string, unknown>;
    return {
      tunnelClientPath: readString(parsed.tunnelClientPath),
      verification: readVerification(parsed.verification),
      tunnelId: readString(parsed.tunnelId),
      encryptedRuntimeApiKey: readString(parsed.encryptedRuntimeApiKey),
      autoStart: parsed.autoStart === true
    };
  } catch {
    return {
      tunnelClientPath: null,
      verification: null,
      tunnelId: null,
      encryptedRuntimeApiKey: null,
      autoStart: false
    };
  }
}

export async function writeTunnelClientConfig(userDataDir: string, config: TunnelClientConfig): Promise<void> {
  const path = mcpTunnelConfigPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
