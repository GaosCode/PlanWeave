import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";
import { withImportAdmissions } from "./importTransactionAdmission.js";
import { canonicalPackageFileTarget } from "./packageFileConsistency.js";

async function importTransactionLockRoot(): Promise<string> {
  const root = join(userInfo().homedir, ".cache", "planweave", "import-transaction-locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

/** Every possible ancestor journal remains in scope, including roots not yet published. */
export function importTransactionScanRoots(
  workspaceRoots: readonly string[],
  targets: readonly string[]
): string[] {
  const roots = new Set(workspaceRoots.map((root) => resolve(root)));
  for (const target of targets) {
    for (let ancestor = dirname(resolve(target)); ; ancestor = dirname(ancestor)) {
      roots.add(ancestor);
      if (dirname(ancestor) === ancestor) break;
    }
  }
  return [...roots];
}

export async function withImportTransactionAdmission<T>(
  options: {
    exclusiveRoots?: readonly string[];
    sharedRoots: readonly string[];
  },
  action: () => Promise<T>
): Promise<T> {
  const root = await importTransactionLockRoot();
  const requests = await Promise.all(
    [
      ...(options.exclusiveRoots ?? []).map((workspace) => ({
        workspace,
        mode: "exclusive" as const
      })),
      ...options.sharedRoots.map((workspace) => ({ workspace, mode: "shared" as const }))
    ].map(async ({ workspace, mode }) => ({
      path: join(
        root,
        createHash("sha256")
          .update(JSON.stringify(["workspace", await canonicalPackageFileTarget(workspace)]))
          .digest("hex")
      ),
      mode
    }))
  );
  return withImportAdmissions(requests, action);
}

/** Lock order: storage targets, complete workspace admission, then individual journals. */
export function withImportTransactionWorkspaceLocks<T>(
  workspaceRoots: readonly string[],
  action: () => Promise<T>
): Promise<T> {
  return withImportTransactionAdmission(
    { exclusiveRoots: workspaceRoots, sharedRoots: [] },
    action
  );
}

export function withImportTransactionReadAdmission<T>(
  workspaceRoots: readonly string[],
  targets: readonly string[],
  action: () => Promise<T>
): Promise<T> {
  return withImportTransactionAdmission(
    { sharedRoots: importTransactionScanRoots(workspaceRoots, targets) },
    action
  );
}

export function withImportTransactionMutationAdmission<T>(
  workspaceRoots: readonly string[],
  targets: readonly string[],
  action: () => Promise<T>
): Promise<T> {
  return withImportTransactionAdmission(
    {
      exclusiveRoots: workspaceRoots,
      sharedRoots: importTransactionScanRoots(workspaceRoots, targets)
    },
    action
  );
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
