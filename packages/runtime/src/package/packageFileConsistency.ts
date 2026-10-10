import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { canonicalFileTarget as canonicalPackageFileTarget } from "../fs/canonicalFileTarget.js";

export { canonicalFileTarget as canonicalPackageFileTarget } from "../fs/canonicalFileTarget.js";

const heldConsistencyKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/** Stable outside moved workspaces; every multi-root mutation acquires the same sorted keys. */
export async function withPackageFileConsistency<T>(
  roots: readonly string[],
  action: () => Promise<T>
): Promise<T> {
  const lockRoot = join(userInfo().homedir, ".cache", "planweave", "package-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const targets = await Promise.all(roots.map(canonicalPackageFileTarget));
  const keys = [
    ...new Set(targets.map((target) => createHash("sha256").update(target).digest("hex")))
  ].sort();
  const held = heldConsistencyKeys.getStore() ?? new Set<string>();
  const greatestHeld = [...held].sort().at(-1);
  if (greatestHeld && keys.some((key) => !held.has(key) && key < greatestHeld)) {
    throw new Error(
      "Package read consistency lock order violation: acquire all mutation roots together."
    );
  }
  async function acquire(index: number): Promise<T> {
    const key = keys[index];
    if (!key) return action();
    return withAdvisoryDirectoryLock(
      { lockPath: join(lockRoot, key), operation: "package-file-consistency" },
      () => acquire(index + 1)
    );
  }
  return heldConsistencyKeys.run(new Set([...held, ...keys]), () => acquire(0));
}

export async function withPackageDirectoryRead<T>(
  root: string,
  read: () => Promise<T>
): Promise<T> {
  return withPackageFileConsistency([root], async () => {
    const before = await stat(root, { bigint: true });
    const result = await read();
    const after = await stat(root, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error(
        "Package read consistency failed: the directory changed during the batch; retry the read."
      );
    }
    return result;
  });
}
