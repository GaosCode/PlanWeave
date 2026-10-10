import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { canonicalPackageFileTarget } from "./packageFileConsistency.js";

async function importTransactionLockRoot(): Promise<string> {
  const root = join(userInfo().homedir, ".cache", "planweave", "import-transaction-locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

/** Lock order: storage targets, workspace admission, then individual journals. */
export async function withImportTransactionWorkspaceLocks<T>(
  workspaceRoots: readonly string[],
  action: () => Promise<T>
): Promise<T> {
  const root = await importTransactionLockRoot();
  const workspaces = await Promise.all(workspaceRoots.map(canonicalPackageFileTarget));
  const keys = [
    ...new Set(
      workspaces.map((workspace) =>
        createHash("sha256")
          .update(JSON.stringify(["workspace", workspace]))
          .digest("hex")
      )
    )
  ].sort();
  async function acquire(index: number): Promise<T> {
    const key = keys[index];
    if (!key) return action();
    return withAdvisoryDirectoryLock(
      { lockPath: join(root, key), operation: "import-transaction-workspace" },
      () => acquire(index + 1)
    );
  }
  return acquire(0);
}

/** Acquire after storage locks; its stable key survives removal of the recovery directory. */
export async function withImportTransactionLock<T>(
  workspaceRoot: string,
  transactionId: string,
  action: () => Promise<T>
): Promise<T> {
  const root = await importTransactionLockRoot();
  const workspace = await canonicalPackageFileTarget(workspaceRoot);
  const key = createHash("sha256")
    .update(JSON.stringify([workspace, transactionId]))
    .digest("hex");
  return withAdvisoryDirectoryLock(
    { lockPath: join(root, key), operation: "import-transaction-lifecycle" },
    action
  );
}
