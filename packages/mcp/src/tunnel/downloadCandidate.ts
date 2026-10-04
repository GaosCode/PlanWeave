import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { withTunnelConfigLock } from "./configLock.js";
import type { TunnelClientDownloadResult } from "./types.js";

type Candidate = {
  directory: string;
  binaryPath: string;
  writeAttempted: boolean;
  committed: boolean;
  released: boolean;
};
const candidates = new WeakMap<TunnelClientDownloadResult, Candidate>();

export function ownTunnelClientDownload(
  result: TunnelClientDownloadResult,
  directory: string
): void {
  candidates.set(result, {
    directory,
    binaryPath: result.binaryPath,
    writeAttempted: false,
    committed: false,
    released: false
  });
}

async function releaseCandidate(candidate: Candidate): Promise<void> {
  // Fence queued commits before filesystem cleanup, including a failed cleanup.
  candidate.released = true;
  await rm(candidate.directory, { recursive: true, force: true });
}

function cleanupFailure(failure: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [failure, cleanupError],
    `${failure instanceof Error ? failure.message : String(failure)}; failed to release tunnel client download candidate`,
    { cause: failure }
  );
}

export async function withTunnelClientDownload<T>(
  result: TunnelClientDownloadResult,
  operation: () => Promise<T>
): Promise<T> {
  const candidate = candidates.get(result);
  if (!candidate)
    throw new Error("Tunnel client download candidate is not owned by this downloader.");
  if (candidate.released)
    throw new Error("Tunnel client download candidate has already been released.");
  try {
    return await operation();
  } catch (failure) {
    // The owning operation has not published this private candidate before write.
    // An attempted write instead needs reference reconciliation under the config lock.
    if (!candidate.writeAttempted && !candidate.committed && !candidate.released) {
      try {
        await releaseCandidate(candidate);
      } catch (cleanupError) {
        throw cleanupFailure(failure, cleanupError);
      }
    }
    throw failure;
  }
}

export async function commitTunnelClientDownload(
  result: TunnelClientDownloadResult,
  store: { configPath: string; write(): Promise<void>; readPath(): Promise<string | null> }
): Promise<void> {
  const candidate = candidates.get(result);
  if (!candidate)
    throw new Error("Tunnel client download candidate is not owned by this downloader.");
  await withTunnelClientDownload(result, () =>
    withTunnelConfigLock(store.configPath, async () => {
      if (candidate.released)
        throw new Error("Tunnel client download candidate has already been released.");
      try {
        candidate.writeAttempted = true;
        await store.write();
        candidate.committed = true;
      } catch (failure) {
        if (!candidate.committed) {
          try {
            const reference = await store.readPath();
            if (reference && resolve(reference) === resolve(candidate.binaryPath)) {
              candidate.committed = true;
            } else {
              await releaseCandidate(candidate);
            }
          } catch (cleanupError) {
            throw cleanupFailure(failure, cleanupError);
          }
        }
        throw failure;
      }
    })
  );
}
