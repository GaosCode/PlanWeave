import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ownTunnelClientDownload } from "./downloadCandidate.js";
import { TunnelDownloadOperation } from "./downloadOperation.js";
import { TunnelDownloadError, tunnelDownloadLimits } from "./downloadPolicy.js";
import { verifyAndExtractTunnelBinary } from "./downloadArchive.js";
import { tunnelClientDownloadUrl } from "./binary.js";
import type {
  GitHubRelease,
  GitHubReleaseAsset,
  TunnelClientDownloadResult,
  TunnelClientPlatformAsset
} from "./types.js";

const latestReleaseApiUrl = "https://api.github.com/repos/openai/tunnel-client/releases/latest";

export function tunnelClientPlatformAsset(
  platform = process.platform,
  arch = process.arch
): TunnelClientPlatformAsset {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !cpu) {
    throw new Error(`Unsupported tunnel-client platform: ${platform}-${arch}.`);
  }
  return {
    assetSuffix: `${os}-${cpu}.zip`,
    binaryName: os === "windows" ? "tunnel-client.exe" : "tunnel-client"
  };
}

const releaseSchema = z.object({
  tag_name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() }))
});

export function parseSha256Sums(content: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseSha256SumLine(line);
    if (parsed) {
      sums.set(parsed.name, parsed.hash);
    }
  }
  return sums;
}

function parseSha256SumLine(line: string): { hash: string; name: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length <= 64) {
    return null;
  }
  const hash = trimmed.slice(0, 64);
  if (!isHexSha256(hash)) {
    return null;
  }
  let index = 64;
  if (!isWhitespace(trimmed[index])) {
    return null;
  }
  while (index < trimmed.length && isWhitespace(trimmed[index])) {
    index += 1;
  }
  if (trimmed[index] === "*") {
    index += 1;
  }
  const name = trimmed.slice(index).trim();
  return name ? { hash: hash.toLowerCase(), name } : null;
}

function isHexSha256(value: string): boolean {
  if (value.length !== 64) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const hex =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
    if (!hex) {
      return false;
    }
  }
  return true;
}

function isWhitespace(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  switch (value) {
    case " ":
    case "\t":
    case "\v":
    case "\f":
      return true;
    default:
      return false;
  }
}

export function selectTunnelClientReleaseAssets(
  release: GitHubRelease,
  platformAsset: TunnelClientPlatformAsset
): { checksumAsset: GitHubReleaseAsset; platformZipAsset: GitHubReleaseAsset } {
  const checksums = release.assets.filter((asset) => asset.name === "SHA256SUMS.txt");
  const assetName = `tunnel-client-${release.tag_name}-${platformAsset.assetSuffix}`;
  const platforms = release.assets.filter((asset) => asset.name === assetName);
  if (checksums.length !== 1) {
    throw new Error("Tunnel client release must contain exactly one SHA256SUMS.txt.");
  }
  if (platforms.length !== 1) {
    throw new Error(`Tunnel client release must contain exactly one ${assetName}.`);
  }
  const checksumAsset = checksums[0];
  const platformZipAsset = platforms[0];
  return { checksumAsset, platformZipAsset };
}

export async function downloadOfficialTunnelClient(
  targetRoot: string
): Promise<TunnelClientDownloadResult> {
  const operation = new TunnelDownloadOperation();
  let stagingDir: string | undefined;
  try {
    const platformAsset = tunnelClientPlatformAsset();
    let metadata: Uint8Array;
    try {
      metadata = await operation.bytes(
        latestReleaseApiUrl,
        "release metadata",
        tunnelDownloadLimits.metadataBytes,
        { accept: "application/vnd.github+json" }
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Failed to download release metadata: 403.") {
        throw new Error(
          `GitHub API rate limit blocked tunnel-client metadata. Open ${tunnelClientDownloadUrl} and try again later.`
        );
      }
      throw error;
    }
    const release = releaseSchema.parse(JSON.parse(new TextDecoder().decode(metadata)));
    const { checksumAsset, platformZipAsset } = selectTunnelClientReleaseAssets(
      release,
      platformAsset
    );
    const requests = [
      operation.bytes(
        checksumAsset.browser_download_url,
        "checksum",
        tunnelDownloadLimits.checksumBytes
      ),
      operation.bytes(
        platformZipAsset.browser_download_url,
        "archive",
        tunnelDownloadLimits.zipBytes
      )
    ];
    let responses: Uint8Array[];
    try {
      responses = await Promise.all(requests);
    } catch (error) {
      operation.abort(error);
      await Promise.allSettled(requests);
      throw error;
    }
    const expectedAssetSha256 = parseSha256Sums(new TextDecoder().decode(responses[0])).get(
      platformZipAsset.name
    );
    if (!expectedAssetSha256)
      throw new Error(`SHA256SUMS.txt does not contain ${platformZipAsset.name}.`);
    const { binary, binarySha256 } = await verifyAndExtractTunnelBinary(
      responses[1],
      platformAsset.binaryName,
      expectedAssetSha256,
      operation
    );
    operation.check();
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    operation.check();
    await chmod(targetRoot, 0o700);
    operation.check();
    const versionDir = join(targetRoot, "tunnel-client", release.tag_name);
    await mkdir(versionDir, { recursive: true, mode: 0o700 });
    operation.check();
    await chmod(versionDir, 0o700);
    operation.check();
    // Each successful install has its own path so persisted verification never describes overwritten bytes.
    stagingDir = await mkdtemp(join(versionDir, "install-"));
    operation.check();
    const pendingPath = join(stagingDir, ".binary.pending");
    const binaryPath = join(stagingDir, platformAsset.binaryName);
    await writeFile(pendingPath, binary, { mode: 0o700, signal: operation.signal });
    operation.check();
    await rename(pendingPath, binaryPath);
    operation.check();
    const result = {
      binaryPath,
      verification: {
        assetName: platformZipAsset.name,
        assetSha256: expectedAssetSha256,
        binarySha256
      }
    };
    ownTunnelClientDownload(result, stagingDir);
    stagingDir = undefined;
    return result;
  } catch (error) {
    const reason = operation.signal.reason;
    const failure =
      error instanceof Error &&
      error.name === "AbortError" &&
      error.cause === reason &&
      reason instanceof TunnelDownloadError &&
      reason.code === "timeout"
        ? reason
        : error;
    operation.abort(failure);
    if (stagingDir) {
      try {
        await rm(stagingDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          "Tunnel client download failed and its staging directory could not be removed."
        );
      }
    }
    throw failure;
  } finally {
    operation.close();
  }
}
