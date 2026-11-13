import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  loadPackagePromptReferenceInventory,
  promptTargetPaths,
  resolvePackagePromptTargets
} from "@planweave-ai/runtime";
import type { TaskCanvasWorkspace } from "./packageWatchPaths.js";

export type PackageFileFingerprint = {
  mtimeMs: number;
  size: number;
  target?: string;
  problem?: string;
  hash?: string;
};

export type PackageFingerprintSnapshot = Map<string, PackageFileFingerprint>;

export function isMissingPathError(caught: unknown): boolean {
  return (
    caught instanceof Error &&
    "code" in caught &&
    (caught.code === "ENOENT" || caught.code === "ENOTDIR")
  );
}

export async function fingerprintIfPresent(
  path: string,
  hashContent = false
): Promise<PackageFileFingerprint | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return null;
    }
    return {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      hash: hashContent
        ? createHash("sha256")
            .update(await readFile(path))
            .digest("hex")
        : undefined
    };
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return null;
    }
    throw caught;
  }
}

export type PackageWatchInventory = {
  references: ReadonlyMap<string, string>;
  orphans: string[];
  manifestHash?: string;
};

export async function loadPackageWatchInventory(
  workspace: TaskCanvasWorkspace,
  previous?: PackageWatchInventory,
  reloadManifest = true,
  rescanOrphans = true
): Promise<PackageWatchInventory> {
  let references = previous?.references ?? new Map<string, string>();
  let manifestHash = previous?.manifestHash;
  if (reloadManifest) {
    try {
      const inventory = await loadPackagePromptReferenceInventory(workspace);
      references = inventory.paths;
      manifestHash = inventory.manifestHash;
    } catch (error) {
      console.warn("PlanWeave polling package watcher could not load prompt references:", error);
    }
  }
  if (!rescanOrphans) return { references, orphans: previous?.orphans ?? [], manifestHash };
  const targets = await resolvePackagePromptTargets(workspace.packageDir, references.keys(), {
    includeOrphans: true,
    manifestPaths: references
  });
  const orphans = [...targets.paths.keys()].filter((path) => !references.has(path));
  for (const diagnostic of targets.diagnostics) {
    if (diagnostic.code === "prompt_directory_read_failed") {
      throw new Error(diagnostic.message);
    }
  }
  return { references, orphans, manifestHash };
}

export async function collectWatchedPackageFingerprints(
  workspace: TaskCanvasWorkspace,
  inventory: PackageWatchInventory,
  hashContent = false,
  concurrency = 1
): Promise<PackageFingerprintSnapshot> {
  const targets = await resolvePackagePromptTargets(
    workspace.packageDir,
    [...inventory.references.keys(), ...inventory.orphans],
    { manifestPaths: inventory.references }
  );
  const snapshot: PackageFingerprintSnapshot = new Map();
  const groups = [
    [workspace.manifestFile, ["package/manifest.json"]],
    [workspace.projectPromptFile, ["policy/project-prompt.md"]],
    ...[...promptTargetPaths(targets)].map(
      ([target, paths]) => [target, paths.map((path) => `package/${path}`)] as const
    )
  ] as const;
  const fingerprints = await mapWithBoundedConcurrency(
    groups,
    concurrency,
    async ([target, paths]) =>
      [paths, await fingerprintIfPresent(target, hashContent), target] as const
  );
  for (const [paths, fingerprint, target] of fingerprints) {
    if (!fingerprint) continue;
    for (const path of paths) snapshot.set(path, { ...fingerprint, target });
  }
  for (const [path, failure] of targets.failures) {
    snapshot.set(`package/${path}`, {
      size: 0,
      mtimeMs: 0,
      problem: failure.kind === "read_error" ? failure.error.message : failure.kind
    });
  }
  return snapshot;
}

export function changedFingerprint(
  left: PackageFileFingerprint | undefined,
  right: PackageFileFingerprint | undefined
): boolean {
  return (
    left?.mtimeMs !== right?.mtimeMs ||
    left?.size !== right?.size ||
    left?.target !== right?.target ||
    left?.problem !== right?.problem ||
    left?.hash !== right?.hash
  );
}

export function diffWatchedPackageSnapshots(
  previous: PackageFingerprintSnapshot,
  next: PackageFingerprintSnapshot
): string[] {
  const paths = new Set([...previous.keys(), ...next.keys()]);
  return [...paths].filter((path) => changedFingerprint(previous.get(path), next.get(path)));
}

/**
 * Keep authoritative content hashes when mtime+size are unchanged.
 * Inventory/probe snapshots are hash-free; without this, hash baselines are wiped every inventory tick.
 */
export function preserveContentHashes(
  previous: PackageFingerprintSnapshot,
  next: PackageFingerprintSnapshot
): void {
  for (const [path, fingerprint] of next) {
    if (fingerprint.hash) {
      continue;
    }
    const prior = previous.get(path);
    if (prior?.hash && !changedFingerprint({ ...prior, hash: undefined }, fingerprint)) {
      fingerprint.hash = prior.hash;
    }
  }
}

/**
 * Bounded concurrency mapper. On first rejection it stops scheduling new work,
 * but waits for already-active workers to settle before rejecting — so callers
 * can release single-flight flags without overlapping generations.
 */
export async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let active = 0;
  let failed = false;
  let firstError: unknown;
  let settled = false;

  return await new Promise<R[]>((resolve, reject) => {
    const finishIfIdle = () => {
      if (active !== 0) {
        return;
      }
      if (failed) {
        if (!settled) {
          settled = true;
          reject(firstError);
        }
        return;
      }
      if (nextIndex >= items.length && !settled) {
        settled = true;
        resolve(results);
      }
    };

    const runNext = () => {
      while (active < limit && nextIndex < items.length && !failed) {
        const current = nextIndex;
        nextIndex += 1;
        active += 1;
        void fn(items[current])
          .then((value) => {
            results[current] = value;
            active -= 1;
            runNext();
            finishIfIdle();
          })
          .catch((error: unknown) => {
            if (!failed) {
              failed = true;
              firstError = error;
            }
            active -= 1;
            finishIfIdle();
          });
      }
      finishIfIdle();
    };

    runNext();
  });
}
