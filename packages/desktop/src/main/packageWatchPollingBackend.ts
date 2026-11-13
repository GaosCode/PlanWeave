import type { PackageWatchBackendHandle } from "./packageWatchBackend.js";
import {
  changedFingerprint,
  collectWatchedPackageFingerprints,
  diffWatchedPackageSnapshots,
  loadPackageWatchInventory,
  type PackageWatchInventory,
  preserveContentHashes,
  type PackageFingerprintSnapshot
} from "./packageWatchFingerprints.js";
import type { TaskCanvasWorkspace } from "./packageWatchPaths.js";
import {
  PollingWatchLane,
  systemWatchScheduler,
  type WatchScheduler,
  WatchTaskQueue
} from "./watchRuntime.js";

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

type PollingLane = "probe" | "inventory" | "hash-sweep";

function warnPollingSnapshotFailure(
  workspaceRoot: string,
  lane: PollingLane,
  caught: unknown
): void {
  console.warn(
    `PlanWeave package polling watch [${lane}] failed for '${workspaceRoot}': ${caught instanceof Error ? caught.message : String(caught)}`
  );
}

export async function startPollingPackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void,
  onError?: (error: unknown) => void,
  scheduler: WatchScheduler = systemWatchScheduler
): Promise<PackageWatchBackendHandle> {
  let lastSnapshot: PackageFingerprintSnapshot = new Map();
  let inventory: PackageWatchInventory = { references: new Map(), orphans: [] };
  let closed = false;
  const queue = new WatchTaskQueue();

  function emitError(lane: PollingLane, caught: unknown): void {
    warnPollingSnapshotFailure(workspace.workspaceRoot, lane, caught);
    onError?.(caught);
  }

  try {
    inventory = await loadPackageWatchInventory(workspace);
    lastSnapshot = await collectWatchedPackageFingerprints(workspace, inventory);
  } catch (caught) {
    emitError("inventory", caught);
  }

  function publish(next: PackageFingerprintSnapshot, isCurrent: () => boolean): void {
    if (!isCurrent()) return;
    for (const path of diffWatchedPackageSnapshots(lastSnapshot, next)) recordChange(path);
    lastSnapshot = next;
  }

  async function probeKnownFiles(isCurrent: () => boolean): Promise<void> {
    const next = await collectWatchedPackageFingerprints(workspace, inventory);
    if (!isCurrent()) return;
    preserveContentHashes(lastSnapshot, next);
    if (
      changedFingerprint(
        lastSnapshot.get("package/manifest.json"),
        next.get("package/manifest.json")
      )
    ) {
      const previous = inventory.references;
      inventory = await loadPackageWatchInventory(workspace, inventory, true, false);
      if (!isCurrent()) return;
      for (const path of previous.keys()) {
        if (!inventory.references.has(path) && !inventory.orphans.includes(path))
          next.delete(`package/${path}`);
      }
    }
    publish(next, isCurrent);
  }

  async function refreshInventory(isCurrent: () => boolean): Promise<void> {
    const nextInventory = await loadPackageWatchInventory(workspace, inventory, false);
    const next = await collectWatchedPackageFingerprints(workspace, nextInventory);
    if (!isCurrent()) return;
    inventory = nextInventory;
    preserveContentHashes(lastSnapshot, next);
    publish(next, isCurrent);
  }

  async function hashSweep(isCurrent: () => boolean): Promise<void> {
    const next = await collectWatchedPackageFingerprints(
      workspace,
      inventory,
      true,
      POLLING_READ_CONCURRENCY
    );
    if (!isCurrent()) return;
    const oldManifestHash =
      lastSnapshot.get("package/manifest.json")?.hash ?? inventory.manifestHash;
    const newManifestHash = next.get("package/manifest.json")?.hash;
    if (newManifestHash && oldManifestHash !== newManifestHash) {
      inventory = await loadPackageWatchInventory(workspace, inventory, true, false);
    }
    if (!isCurrent()) return;
    for (const [path, fingerprint] of next) {
      const old = lastSnapshot.get(path);
      if (
        old &&
        !old.hash &&
        !(
          path === "package/manifest.json" &&
          oldManifestHash &&
          oldManifestHash !== newManifestHash
        ) &&
        !changedFingerprint(old, { ...fingerprint, hash: undefined })
      ) {
        lastSnapshot.set(path, fingerprint);
      }
    }
    publish(next, isCurrent);
  }

  const lanes = [
    new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: KNOWN_FILE_PROBE_INTERVAL_MS,
      kickoffMs: PROBE_KICKOFF_MS,
      runImmediately: true,
      backoffBaseMs: PROBE_BACKOFF_BASE_MS,
      backoffMaxMs: PROBE_BACKOFF_MAX_MS,
      run: probeKnownFiles,
      onError: (error) => emitError("probe", error)
    }),
    new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: INVENTORY_REFRESH_INTERVAL_MS,
      kickoffMs: INVENTORY_KICKOFF_MS,
      backoffBaseMs: INVENTORY_BACKOFF_BASE_MS,
      backoffMaxMs: INVENTORY_BACKOFF_MAX_MS,
      run: refreshInventory,
      onError: (error) => emitError("inventory", error)
    }),
    new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: CONTENT_HASH_SWEEP_INTERVAL_MS,
      kickoffMs: HASH_SWEEP_KICKOFF_MS,
      backoffBaseMs: SWEEP_BACKOFF_BASE_MS,
      backoffMaxMs: SWEEP_BACKOFF_MAX_MS,
      run: hashSweep,
      onError: (error) => emitError("hash-sweep", error)
    })
  ];
  for (const lane of lanes) {
    lane.start();
  }

  return {
    kind: "polling",
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const lane of lanes) {
        lane.close();
      }
      queue.close();
    }
  };
}
