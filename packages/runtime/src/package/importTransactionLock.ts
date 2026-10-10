import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { canonicalPackageFileTarget } from "./packageFileConsistency.js";

/** Acquire after storage locks; its stable key survives removal of the recovery directory. */
export async function withImportTransactionLock<T>(
  workspaceRoot: string,
  transactionId: string,
  action: () => Promise<T>
): Promise<T> {
  const root = join(userInfo().homedir, ".cache", "planweave", "import-transaction-locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspace = await canonicalPackageFileTarget(workspaceRoot);
  const key = createHash("sha256")
    .update(JSON.stringify([workspace, transactionId]))
    .digest("hex");
  return withAdvisoryDirectoryLock(
    { lockPath: join(root, key), operation: "import-transaction-lifecycle" },
    action
  );
}
