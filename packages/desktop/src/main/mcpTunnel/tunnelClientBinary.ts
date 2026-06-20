import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { TunnelClientBinaryStatus } from "../../shared/mcpTunnel.js";

export const tunnelClientDownloadUrl = "https://github.com/openai/tunnel-client/releases/latest";

export type TunnelClientBinaryVerification = {
  assetName: string;
  assetSha256: string;
  binarySha256: string;
};

export function getTunnelClientBinaryStartError(binary: TunnelClientBinaryStatus): string | null {
  if (!binary.available || !binary.path) {
    return binary.error ?? "Tunnel client binary is not available.";
  }
  if (binary.source === "managed" && !binary.verified) {
    return binary.error ?? "Tunnel client binary must pass SHA-256 verification before starting.";
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readVersion(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout}${stderr}`.trim());
    });
  });
}

function hasMacQuarantine(path: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile("/usr/bin/xattr", ["-p", "com.apple.quarantine", path], { timeout: 5_000 }, (error) => {
      resolve(!error);
    });
  });
}

function normalizeSha256(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function hashFileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isSupportedBinaryName(path: string): boolean {
  const name = basename(path);
  return name === "tunnel-client" || name === "tunnel-client.exe";
}

export async function resolveTunnelClientBinary(path: string | null, verification?: TunnelClientBinaryVerification | null): Promise<TunnelClientBinaryStatus> {
  const expectedBinarySha256 = normalizeSha256(verification?.binarySha256);
  const assetSha256 = normalizeSha256(verification?.assetSha256);
  if (!path?.trim()) {
    return {
      path: null,
      available: false,
      source: null,
      assetName: verification?.assetName ?? null,
      assetSha256,
      sha256: null,
      version: null,
      verified: false,
      error: "Tunnel client binary path is not configured."
    };
  }
  const trimmed = path.trim();
  if (!(await isExecutable(trimmed))) {
    return {
      path: trimmed,
      available: false,
      source: verification ? "managed" : "manual",
      assetName: verification?.assetName ?? null,
      assetSha256,
      sha256: null,
      version: null,
      verified: false,
      error: "Tunnel client binary is missing or not executable."
    };
  }
  if (!isSupportedBinaryName(trimmed)) {
    return {
      path: trimmed,
      available: false,
      source: verification ? "managed" : "manual",
      assetName: verification?.assetName ?? null,
      assetSha256,
      sha256: null,
      version: null,
      verified: false,
      error: "Configured binary must be named tunnel-client or tunnel-client.exe."
    };
  }
  try {
    const sha256 = await hashFileSha256(trimmed);
    const quarantined = await hasMacQuarantine(trimmed);
    if (!expectedBinarySha256) {
      if (verification) {
        return {
          path: trimmed,
          available: true,
          source: "managed",
          assetName: verification.assetName,
          assetSha256,
          sha256,
          version: null,
          verified: false,
          error: "Managed tunnel-client install metadata is missing the binary checksum."
        };
      }
      if (quarantined) {
        return {
          path: trimmed,
          available: false,
          source: "manual",
          assetName: null,
          assetSha256: null,
          sha256,
          version: null,
          verified: false,
          error: "macOS blocked tunnel-client because the downloaded file is quarantined. Allow it in Privacy & Security or remove the quarantine attribute before starting."
        };
      }
      return {
        path: trimmed,
        available: true,
        source: "manual",
        assetName: null,
        assetSha256,
        sha256,
        version: null,
        verified: false,
        error: null
      };
    }
    if (sha256 !== expectedBinarySha256) {
      return {
        path: trimmed,
        available: true,
        source: "managed",
        assetName: verification?.assetName ?? null,
        assetSha256,
        sha256,
        version: null,
        verified: false,
        error: "Managed tunnel-client binary checksum does not match."
      };
    }
    if (quarantined) {
      return {
        path: trimmed,
        available: false,
        source: "managed",
        assetName: verification?.assetName ?? null,
        assetSha256,
        sha256,
        version: null,
        verified: true,
        error: "macOS blocked tunnel-client because the downloaded file is quarantined. Allow it in Privacy & Security or remove the quarantine attribute before starting."
      };
    }
    const version = await readVersion(trimmed);
    if (!version.toLowerCase().includes("tunnel-client")) {
      return {
        path: trimmed,
        available: false,
        source: "managed",
        assetName: verification?.assetName ?? null,
        assetSha256,
        sha256,
        version,
        verified: false,
        error: "Configured binary did not identify itself as tunnel-client."
      };
    }
    return {
      path: trimmed,
      available: true,
      source: "managed",
      assetName: verification?.assetName ?? null,
      assetSha256,
      sha256,
      version,
      verified: true,
      error: null
    };
  } catch (error) {
    return {
      path: trimmed,
      available: false,
      source: verification ? "managed" : "manual",
      assetName: verification?.assetName ?? null,
      assetSha256,
      sha256: null,
      version: null,
      verified: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
