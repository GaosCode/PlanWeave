import type { PackageWatchBackendHandle } from "./packageWatchBackend.js";
import {
  changedFingerprint,
  collectWatchedPackageFingerprints,
  diffWatchedPackageSnapshots,
  fingerprintIfPresent,
  mapWithBoundedConcurrency,
  preserveContentHashes,
  type PackageFingerprintSnapshot
} from "./packageWatchFingerprints.js";
import { absolutePathForRelative, type TaskCanvasWorkspace } from "./packageWatchPaths.js";

/** Layered polling periods (internal, not user config). */
export const KNOWN_FILE_PROBE_INTERVAL_MS = 1000;
export const INVENTORY_REFRESH_INTERVAL_MS = 10_000;
export const CONTENT_HASH_SWEEP_INTERVAL_MS = 30_000;
export const POLLING_READ_CONCURRENCY = 4;

const PROBE_KICKOFF_MS = 50;
const INVENTORY_KICKOFF_MS = 500;
const HASH_SWEEP_KICKOFF_MS = 25_000;

/** Deterministic exponential backoff caps (ms). */
const PROBE_BACKOFF_BASE_MS = KNOWN_FILE_PROBE_INTERVAL_MS;
const PROBE_BACKOFF_MAX_MS = 16_000;
const INVENTORY_BACKOFF_BASE_MS = INVENTORY_REFRESH_INTERVAL_MS;
const INVENTORY_BACKOFF_MAX_MS = 60_000;
const SWEEP_BACKOFF_BASE_MS = CONTENT_HASH_SWEEP_INTERVAL_MS;
const SWEEP_BACKOFF_MAX_MS = 120_000;

function warnPollingSnapshotFailure(workspaceRoot: string, caught: unknown): void {
  console.warn(
    `PlanWeave package polling watch failed for '${workspaceRoot}': ${caught instanceof Error ? caught.message : String(caught)}`
  );
}

function nextBackoffMs(currentMs: number, baseMs: number, maxMs: number): number {
  if (currentMs <= 0) {
    return baseMs;
  }
  return Math.min(maxMs, currentMs * 2);
}

export async function startPollingPackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void,
  onError?: (error: unknown) => void
): Promise<PackageWatchBackendHandle> {
  let lastSnapshot: PackageFingerprintSnapshot = new Map();
  let knownRelativePaths: Set<string> = new Set();
  let closed = false;
  let probeInFlight = false;
  let inventoryInFlight = false;
  let sweepInFlight = false;

  let probeBackoffMs = 0;
  let inventoryBackoffMs = 0;
  let sweepBackoffMs = 0;
  let probeNextAllowedAt = 0;
  let inventoryNextAllowedAt = 0;
  let sweepNextAllowedAt = 0;

  const intervalTimers: NodeJS.Timeout[] = [];
  const kickoffTimers: NodeJS.Timeout[] = [];

  function emitError(caught: unknown): void {
    warnPollingSnapshotFailure(workspace.workspaceRoot, caught);
    onError?.(caught);
  }

  try {
    lastSnapshot = await collectWatchedPackageFingerprints(workspace);
    knownRelativePaths = new Set(lastSnapshot.keys());
  } catch (caught) {
    emitError(caught);
    // Proceed with empty known set; inventory will repopulate when healthy.
  }

  async function probeKnownFiles(): Promise<void> {
    if (closed || probeInFlight) {
      return;
    }
    if (Date.now() < probeNextAllowedAt) {
      return;
    }
    probeInFlight = true;
    try {
      const next: PackageFingerprintSnapshot = new Map();
      const knownList = Array.from(knownRelativePaths);
      for (const rel of knownList) {
        if (closed) {
          return;
        }
        const fingerprint = await fingerprintIfPresent(
          absolutePathForRelative(workspace, rel),
          false
        );
        if (fingerprint) {
          next.set(rel, fingerprint);
        }
      }
      if (closed) {
        return;
      }
      const manifestFp = await fingerprintIfPresent(workspace.manifestFile, false);
      if (manifestFp) {
        next.set("package/manifest.json", manifestFp);
      }
      const projectFp = await fingerprintIfPresent(workspace.projectPromptFile, false);
      if (projectFp) {
        next.set("policy/project-prompt.md", projectFp);
      }
      if (closed) {
        return;
      }

      const previous = lastSnapshot;
      preserveContentHashes(previous, next);
      for (const path of diffWatchedPackageSnapshots(previous, next)) {
        recordChange(path);
      }
      lastSnapshot = next;
      knownRelativePaths = new Set([...knownRelativePaths, ...next.keys()]);
      probeBackoffMs = 0;
      probeNextAllowedAt = 0;
    } catch (caught) {
      if (closed) {
        return;
      }
      emitError(caught);
      probeBackoffMs = nextBackoffMs(probeBackoffMs, PROBE_BACKOFF_BASE_MS, PROBE_BACKOFF_MAX_MS);
      probeNextAllowedAt = Date.now() + probeBackoffMs;
    } finally {
      probeInFlight = false;
    }
  }

  async function refreshInventory(): Promise<void> {
    if (closed || inventoryInFlight) {
      return;
    }
    if (Date.now() < inventoryNextAllowedAt) {
      return;
    }
    inventoryInFlight = true;
    try {
      const nextSnapshot = await collectWatchedPackageFingerprints(workspace);
      if (closed) {
        return;
      }
      const previousSnapshot = lastSnapshot;

      const previousKeys = new Set(previousSnapshot.keys());
      const nextKeys = new Set(nextSnapshot.keys());
      for (const key of nextKeys) {
        if (!previousKeys.has(key)) {
          recordChange(key);
        }
      }
      for (const key of previousKeys) {
        if (!nextKeys.has(key)) {
          recordChange(key);
        }
      }
      // mtime/size edits on known files remain probe's job; inventory only discovers membership.
      // Preserve their prior fingerprints so inventory cannot advance the shared baseline before
      // a concurrent probe has published the change. New paths start from inventory's fingerprint.
      lastSnapshot = new Map(
        [...nextSnapshot].map(([key, fingerprint]) => [
          key,
          previousSnapshot.get(key) ?? fingerprint
        ])
      );
      knownRelativePaths = new Set(nextKeys);
      inventoryBackoffMs = 0;
      inventoryNextAllowedAt = 0;
    } catch (caught) {
      if (closed) {
        return;
      }
      emitError(caught);
      inventoryBackoffMs = nextBackoffMs(
        inventoryBackoffMs,
        INVENTORY_BACKOFF_BASE_MS,
        INVENTORY_BACKOFF_MAX_MS
      );
      inventoryNextAllowedAt = Date.now() + inventoryBackoffMs;
    } finally {
      inventoryInFlight = false;
    }
  }

  async function hashSweep(): Promise<void> {
    if (closed || sweepInFlight) {
      return;
    }
    if (Date.now() < sweepNextAllowedAt) {
      return;
    }
    sweepInFlight = true;
    try {
      const knownList = Array.from(knownRelativePaths);
      const previousSnapshot = lastSnapshot;
      const updates = await mapWithBoundedConcurrency(
        knownList,
        POLLING_READ_CONCURRENCY,
        async (rel) => {
          const newFp = await fingerprintIfPresent(absolutePathForRelative(workspace, rel), true);
          return { rel, newFp };
        }
      );
      if (closed) {
        return;
      }

      for (const { rel, newFp } of updates) {
        if (!newFp) {
          continue;
        }
        const old = previousSnapshot.get(rel);
        const current = lastSnapshot.get(rel);
        // A deletion or incompatible probe/inventory commit after this sweep started owns the
        // newer state. Equivalent fingerprints remain safe even if their object identity changed.
        if (!old || !current || changedFingerprint(old, current)) {
          continue;
        }
        let changed = old.mtimeMs !== newFp.mtimeMs || old.size !== newFp.size;
        if (!changed && old.hash && newFp.hash && old.hash !== newFp.hash) {
          changed = true;
        }
        lastSnapshot.set(rel, newFp);
        if (changed) {
          recordChange(rel);
        }
      }
      sweepBackoffMs = 0;
      sweepNextAllowedAt = 0;
    } catch (caught) {
      if (closed) {
        return;
      }
      emitError(caught);
      sweepBackoffMs = nextBackoffMs(sweepBackoffMs, SWEEP_BACKOFF_BASE_MS, SWEEP_BACKOFF_MAX_MS);
      sweepNextAllowedAt = Date.now() + sweepBackoffMs;
    } finally {
      sweepInFlight = false;
    }
  }

  intervalTimers.push(
    setInterval(() => {
      if (closed) {
        return;
      }
      void probeKnownFiles();
    }, KNOWN_FILE_PROBE_INTERVAL_MS)
  );
  intervalTimers.push(
    setInterval(() => {
      if (closed) {
        return;
      }
      void refreshInventory();
    }, INVENTORY_REFRESH_INTERVAL_MS)
  );
  intervalTimers.push(
    setInterval(() => {
      if (closed) {
        return;
      }
      void hashSweep();
    }, CONTENT_HASH_SWEEP_INTERVAL_MS)
  );

  kickoffTimers.push(setTimeout(() => void probeKnownFiles(), PROBE_KICKOFF_MS));
  kickoffTimers.push(setTimeout(() => void refreshInventory(), INVENTORY_KICKOFF_MS));
  kickoffTimers.push(setTimeout(() => void hashSweep(), HASH_SWEEP_KICKOFF_MS));
  // Immediate first probe so known-file edits after start are not forced to wait a full interval.
  void probeKnownFiles();

  return {
    kind: "polling",
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const timer of intervalTimers) {
        clearInterval(timer);
      }
      intervalTimers.length = 0;
      for (const timer of kickoffTimers) {
        clearTimeout(timer);
      }
      kickoffTimers.length = 0;
    }
  };
}
