import type { Stats } from "node:fs";
import { lstat, type mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";

async function inspectEntry(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) return null;
    throw error;
  }
}

/** Caller holds mutation admission and the stable journal lock through publication. */
export async function initializeImportTransaction(options: {
  recoveryRoot: string;
  mkdir: typeof mkdir;
  publish: () => Promise<void>;
}): Promise<void> {
  const { recoveryRoot } = options;
  await options.mkdir(dirname(recoveryRoot), { recursive: true });
  // Exclusive creation must reject existing entries, including dangling symlinks.
  await options.mkdir(recoveryRoot);
  let created: Stats | undefined;
  try {
    created = await lstat(recoveryRoot);
    if (!created.isDirectory()) {
      throw new Error(`Import transaction directory identity changed at '${recoveryRoot}'.`);
    }
    await options.publish();
  } catch (error) {
    try {
      const current = await inspectEntry(recoveryRoot);
      if (current) {
        if (
          !created ||
          !current.isDirectory() ||
          current.dev !== created.dev ||
          current.ino !== created.ino ||
          current.birthtimeMs !== created.birthtimeMs
        ) {
          throw new Error(
            `Import transaction directory identity changed; preserved '${recoveryRoot}'.`
          );
        }
        if (await inspectEntry(join(recoveryRoot, "recovery.json"))) {
          throw new Error(`Import transaction journal was published; preserved '${recoveryRoot}'.`);
        }
        // Never recursively remove unknown content, even inside our original directory.
        await rmdir(recoveryRoot);
      }
    } catch (cleanupError) {
      const detail = error instanceof Error ? error.message : String(error);
      const cleanupDetail =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError(
        [error, cleanupError],
        `Import transaction initialization failed: ${detail}; cleanup failed: ${cleanupDetail}; recovery '${recoveryRoot}'.`
      );
    }
    throw error;
  }
}
