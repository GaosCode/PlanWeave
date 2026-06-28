import {
  downloadOfficialTunnelClient as downloadOfficialTunnelClientToRoot,
  parseSha256Sums,
  selectTunnelClientReleaseAssets,
  tunnelClientPlatformAsset
} from "@planweave-ai/mcp";
import type {
  GitHubRelease,
  GitHubReleaseAsset,
  TunnelClientDownloadResult,
  TunnelClientPlatformAsset
} from "@planweave-ai/mcp";
import { mcpTunnelDataDir } from "./tunnelClientStore.js";

export { parseSha256Sums, selectTunnelClientReleaseAssets, tunnelClientPlatformAsset };
export type { GitHubRelease, GitHubReleaseAsset, TunnelClientDownloadResult, TunnelClientPlatformAsset };

export async function downloadOfficialTunnelClient(userDataDir: string): Promise<TunnelClientDownloadResult> {
  return downloadOfficialTunnelClientToRoot(mcpTunnelDataDir(userDataDir));
}
