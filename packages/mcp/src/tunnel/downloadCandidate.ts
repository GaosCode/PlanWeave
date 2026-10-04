import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { withTunnelConfigLock } from "./configLock.js";
import type { TunnelClientDownloadResult } from "./types.js";

type Candidate = { directory: string; binaryPath: string; committed: boolean; released: boolean };
const candidates = new WeakMap<TunnelClientDownloadResult, Candidate>();

export function ownTunnelClientDownload(
  result: TunnelClientDownloadResult,
  directory: string
): void {
  candidates.set(result, {
    directory,
    binaryPath: result.binaryPath,
    committed: false,
    released: false
  });
}

export async function commitTunnelClientDownload(
  result: TunnelClientDownloadResult,
  store: { configPath: string; write(): Promise<void>; readPath(): Promise<string | null> }
): Promise<void> {
  const candidate = candidates.get(result);
  if (!candidate)
    throw new Error("Tunnel client download candidate is not owned by this downloader.");
  await withTunnelConfigLock(store.configPath, async () => {
    if (candidate.released)
      throw new Error("Tunnel client download candidate has already been released.");
    try {
      await store.write();
      candidate.committed = true;
    } catch (failure) {
      if (!candidate.committed) {
        try {
          const reference = await store.readPath();
          if (reference && resolve(reference) === resolve(candidate.binaryPath)) {
            candidate.committed = true;
          } else {
            await rm(candidate.directory, { recursive: true, force: true });
            candidate.released = true;
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [failure, cleanupError],
            `${failure instanceof Error ? failure.message : String(failure)}; failed to release tunnel client download candidate`,
            { cause: failure }
          );
        }
      }
      throw failure;
    }
  });
}
