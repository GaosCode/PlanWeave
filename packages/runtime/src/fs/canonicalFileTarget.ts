import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve aliases through the nearest existing ancestor, including not-yet-created targets. */
export async function canonicalFileTarget(path: string): Promise<string> {
  let target = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(await realpath(target), ...missing.reverse());
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
      )
        throw error;
      const parent = dirname(target);
      if (parent === target) throw error;
      missing.push(basename(target));
      target = parent;
    }
  }
}
