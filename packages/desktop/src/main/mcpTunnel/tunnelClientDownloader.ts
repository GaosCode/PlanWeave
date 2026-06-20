import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { TunnelClientBinaryVerification } from "./tunnelClientBinary.js";
import { tunnelClientDownloadUrl } from "./tunnelClientBinary.js";
import { mcpTunnelDataDir } from "./tunnelClientStore.js";

const latestReleaseApiUrl = "https://api.github.com/repos/openai/tunnel-client/releases/latest";

export type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

export type TunnelClientPlatformAsset = {
  assetSuffix: string;
  binaryName: string;
};

export type TunnelClientDownloadResult = {
  binaryPath: string;
  verification: TunnelClientBinaryVerification;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function tunnelClientPlatformAsset(platform = process.platform, arch = process.arch): TunnelClientPlatformAsset {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !cpu) {
    throw new Error(`Unsupported tunnel-client platform: ${platform}-${arch}.`);
  }
  return {
    assetSuffix: `${os}-${cpu}.zip`,
    binaryName: os === "windows" ? "tunnel-client.exe" : "tunnel-client"
  };
}

function parseRelease(value: unknown): GitHubRelease {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid tunnel-client release metadata.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || !Array.isArray(record.assets)) {
    throw new Error("Invalid tunnel-client release metadata.");
  }
  return {
    tag_name: record.tag_name,
    assets: record.assets.map((asset) => {
      const assetRecord = asset as Record<string, unknown>;
      if (typeof assetRecord.name !== "string" || typeof assetRecord.browser_download_url !== "string") {
        throw new Error("Invalid tunnel-client release asset metadata.");
      }
      return {
        name: assetRecord.name,
        browser_download_url: assetRecord.browser_download_url
      };
    })
  };
}

export function parseSha256Sums(content: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match) {
      sums.set(match[2].trim(), match[1].toLowerCase());
    }
  }
  return sums;
}

export function selectTunnelClientReleaseAssets(release: GitHubRelease, platformAsset: TunnelClientPlatformAsset): { checksumAsset: GitHubReleaseAsset; platformZipAsset: GitHubReleaseAsset } {
  const checksumAsset = release.assets.find((asset) => asset.name === "SHA256SUMS.txt");
  const platformZipAsset = release.assets.find((asset) => asset.name.endsWith(platformAsset.assetSuffix));
  if (!checksumAsset) {
    throw new Error("Tunnel client release is missing SHA256SUMS.txt.");
  }
  if (!platformZipAsset) {
    throw new Error(`Tunnel client release is missing ${platformAsset.assetSuffix}.`);
  }
  return { checksumAsset, platformZipAsset };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}.`);
  }
  return response.text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchRelease(): Promise<GitHubRelease> {
  const response = await fetch(latestReleaseApiUrl, {
    headers: {
      accept: "application/vnd.github+json"
    }
  });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(`GitHub API rate limit blocked tunnel-client metadata. Open ${tunnelClientDownloadUrl} and try again later.`);
    }
    throw new Error(`Failed to fetch tunnel-client release metadata: ${response.status}.`);
  }
  return parseRelease(await response.json());
}

function extractBinary(zipBytes: Uint8Array, binaryName: string): Uint8Array {
  const entries = unzipSync(zipBytes);
  const entry = Object.entries(entries).find(([name]) => name === binaryName || name.endsWith(`/${binaryName}`));
  if (!entry) {
    throw new Error(`Tunnel client archive does not contain ${binaryName}.`);
  }
  return entry[1];
}

export async function downloadOfficialTunnelClient(userDataDir: string): Promise<TunnelClientDownloadResult> {
  const platformAsset = tunnelClientPlatformAsset();
  const release = await fetchRelease();
  const { checksumAsset, platformZipAsset } = selectTunnelClientReleaseAssets(release, platformAsset);
  const [checksumText, zipBytes] = await Promise.all([
    fetchText(checksumAsset.browser_download_url),
    fetchBytes(platformZipAsset.browser_download_url)
  ]);
  const expectedAssetSha256 = parseSha256Sums(checksumText).get(platformZipAsset.name);
  if (!expectedAssetSha256) {
    throw new Error(`SHA256SUMS.txt does not contain ${platformZipAsset.name}.`);
  }
  const actualAssetSha256 = sha256(zipBytes);
  if (actualAssetSha256 !== expectedAssetSha256) {
    throw new Error("Tunnel client archive checksum does not match SHA256SUMS.txt.");
  }

  const binaryBytes = extractBinary(zipBytes, platformAsset.binaryName);
  const binarySha256 = sha256(binaryBytes);
  const targetDir = join(mcpTunnelDataDir(userDataDir), "tunnel-client", release.tag_name);
  const binaryPath = join(targetDir, platformAsset.binaryName);
  await mkdir(targetDir, { recursive: true });
  await writeFile(binaryPath, binaryBytes);
  if (process.platform !== "win32") {
    await chmod(binaryPath, 0o700);
  }

  return {
    binaryPath,
    verification: {
      assetName: platformZipAsset.name,
      assetSha256: expectedAssetSha256,
      binarySha256
    }
  };
}
