import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TaskCanvasWorkspace } from "./packageWatchPaths.js";
import { toPosixPath } from "./packageWatchPaths.js";

export type PackageFileFingerprint = {
  mtimeMs: number;
  size: number;
  hash?: string;
};

export type PackageFingerprintSnapshot = Map<string, PackageFileFingerprint>;

export function isMissingPathError(caught: unknown): boolean {
  return caught instanceof Error && "code" in caught && caught.code === "ENOENT";
}

export async function fingerprintIfPresent(
  path: string,
  hashContent = false
): Promise<PackageFileFingerprint | null> {
  try {
    const [metadata, content] = await Promise.all([
      stat(path),
      hashContent ? readFile(path) : Promise.resolve(null)
    ]);
    if (!metadata.isFile()) {
      return null;
    }
    return {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      hash: content ? createHash("sha256").update(content).digest("hex") : undefined
    };
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return null;
    }
    throw caught;
  }
}

async function collectMarkdownFingerprints(
  rootPath: string,
  relativeRoot: string,
  snapshot: PackageFingerprintSnapshot
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return;
    }
    throw caught;
  }

  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    const relativePath = toPosixPath(join(relativeRoot, entry.name));
    if (entry.isDirectory()) {
      await collectMarkdownFingerprints(path, relativePath, snapshot);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      // Poll path uses mtime+size only. Content hashing every tick is too expensive on large packages.
      const fingerprint = await fingerprintIfPresent(path, false);
      if (fingerprint) {
        snapshot.set(relativePath, fingerprint);
      }
    }
  }
}

export async function collectWatchedPackageFingerprints(
  workspace: TaskCanvasWorkspace
): Promise<PackageFingerprintSnapshot> {
  const snapshot: PackageFingerprintSnapshot = new Map();
  const manifestFingerprint = await fingerprintIfPresent(workspace.manifestFile);
  if (manifestFingerprint) {
    snapshot.set("package/manifest.json", manifestFingerprint);
  }
  const projectPromptFingerprint = await fingerprintIfPresent(workspace.projectPromptFile, false);
  if (projectPromptFingerprint) {
    snapshot.set("policy/project-prompt.md", projectPromptFingerprint);
  }
  await collectMarkdownFingerprints(join(workspace.packageDir, "nodes"), "package/nodes", snapshot);
  return snapshot;
}

export function changedFingerprint(
  left: PackageFileFingerprint | undefined,
  right: PackageFileFingerprint | undefined
): boolean {
  return (
    left?.mtimeMs !== right?.mtimeMs || left?.size !== right?.size || left?.hash !== right?.hash
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
    if (prior?.hash && prior.mtimeMs === fingerprint.mtimeMs && prior.size === fingerprint.size) {
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
