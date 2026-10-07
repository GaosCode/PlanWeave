import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNodeFileNotFoundError, optionalStat } from "../fs/optionalFile.js";

async function existingDirectory(path: string): Promise<string> {
  let candidate = resolve(path);
  for (;;) {
    const info = await optionalStat(candidate);
    if (info?.isDirectory()) return realpath(candidate);
    const parent = dirname(candidate);
    if (parent === candidate)
      throw new Error(`Import target parent '${path}' has no existing directory.`);
    candidate = parent;
  }
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Own temporary import content independently of durable transaction recovery. */
export async function withPackageDraftImportStaging<T>(
  workspaceRoot: string,
  targets: string[],
  apply: (stagingRoot: string) => Promise<T>
): Promise<T> {
  const canonicalRoot = await realpath(workspaceRoot);
  const stagingDevice = (await stat(canonicalRoot)).dev;
  const recoveryParent = await existingDirectory(
    join(workspaceRoot, "desktop", "recovery", "package-import")
  );
  if ((await stat(recoveryParent)).dev !== stagingDevice) {
    throw new Error("Package draft import recovery must be on the workspace filesystem.");
  }
  for (const target of targets) {
    const parent = await existingDirectory(dirname(target));
    const relativeParent = relative(canonicalRoot, parent);
    if (
      relativeParent.startsWith(`..${sep}`) ||
      relativeParent === ".." ||
      isAbsolute(relativeParent)
    ) {
      throw new Error(`Import target '${target}' resolves outside the PlanWeave workspace.`);
    }
    if ((await stat(parent)).dev !== stagingDevice) {
      throw new Error(
        `Import target '${target}' cannot be atomically backed up across filesystems.`
      );
    }
    try {
      if ((await lstat(target)).dev !== stagingDevice) {
        throw new Error(
          `Import target '${target}' cannot be atomically backed up across filesystems.`
        );
      }
    } catch (error) {
      if (!isNodeFileNotFoundError(error)) throw error;
    }
  }
  const stagingRoot = await mkdtemp(join(canonicalRoot, ".planweave-import-"));
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await apply(stagingRoot) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await rm(stagingRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        `${errorSummary(outcome.error)}; package draft import staging cleanup failed: ${errorSummary(cleanupError)}`
      );
    }
    throw new Error(`Package draft import staging cleanup failed: ${errorSummary(cleanupError)}`, {
      cause: cleanupError
    });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
