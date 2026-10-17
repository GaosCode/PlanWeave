import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

async function createTemporaryFile(path: string) {
  for (let attempt = 0; ; attempt++) {
    const temporaryPath = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
    try {
      return { temporaryPath, handle: await open(temporaryPath, "wx", 0o600) };
    } catch (error) {
      if (
        attempt >= 2 ||
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
  }
}

/** Publish complete bytes without replacing an existing managed runtime file. */
export async function publishManagedRuntimeFile(path: string, content: string): Promise<void> {
  const { temporaryPath, handle } = await createTemporaryFile(path);
  const errors: unknown[] = [];
  try {
    await handle.writeFile(content, "utf8");
  } catch (error) {
    errors.push(error);
  }
  try {
    await handle.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) {
    try {
      // Same-directory hard-link creation is atomic and fails if the target exists.
      await link(temporaryPath, path);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        errors.push(error);
      }
    }
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "managed_runtime_file_publication_failed");
  }
}
