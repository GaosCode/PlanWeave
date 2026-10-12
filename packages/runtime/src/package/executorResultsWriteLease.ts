import { withImportTransactionReadAdmission } from "./importTransactionLock.js";
import { assertResultsStorageIdentity } from "./packageStorageIdentity.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import { withCurrentProjectWorkspace } from "../project.js";
import { assertCurrentCanvasWorkspace } from "./assertCurrentCanvasWorkspace.js";
import { assertNoPendingImportTransactionWrite } from "./importTransaction.js";
import {
  canonicalPackageFileTarget,
  withPackageFileConsistency
} from "./packageFileConsistency.js";

const leaseSchema = z
  .object({
    version: z.literal(1),
    token: z.string().uuid(),
    resultsRoot: z.string().min(1),
    ownerPid: z.number().int().positive(),
    executionIdentity: z.string().min(1),
    createdAt: z.string().datetime(),
    status: z.enum(["writing", "uncertain"])
  })
  .strict();

function leaseRoot(): string {
  return join(userInfo().homedir, ".cache", "planweave", "executor-results-leases");
}
function overlaps(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function pidStatus(pid: number): string {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return "not alive";
    return "liveness unconfirmed";
  }
}

/** Caller holds the same canonical target lock used for lease registration. */
export async function assertNoExecutorResultsWriteLease(target: string): Promise<void> {
  const root = leaseRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const canonical = await canonicalPackageFileTarget(target);
  for (const entry of entries.filter((entry) => entry.endsWith(".json"))) {
    const path = join(root, entry);
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const lease = leaseSchema.parse(raw);
    if (entry !== `${lease.token}.json` || !isAbsolute(lease.resultsRoot)) {
      throw new Error(`Invalid executor results lease at ${path}.`);
    }
    if (overlaps(canonical, lease.resultsRoot) || overlaps(lease.resultsRoot, canonical)) {
      throw new Error(
        `Import transaction executor results write conflict at ${target}: ${lease.executionIdentity}, owner PID ${lease.ownerPid} (${pidStatus(lease.ownerPid)}), ${lease.status}; lease preserved at ${path}. Confirm the executor and its child/session writers have stopped before manual reconciliation.`
      );
    }
  }
}

/** The lifetime reserves the results tree without holding storage or canvas locks. */
export async function acquireExecutorResultsWriteLease(
  workspace: ProjectWorkspace,
  executionIdentity: string
): Promise<{ path: string; release(): Promise<void>; markUncertain(): Promise<void> }> {
  const token = randomUUID();
  const path = join(leaseRoot(), `${token}.json`);
  const lease = await withCurrentProjectWorkspace(workspace, () =>
    withPackageFileConsistency(
      [workspace.packageDir, workspace.stateFile, workspace.resultsDir],
      async () => {
        return withImportTransactionReadAdmission(
          [dirname(workspace.projectFile)],
          [workspace.resultsDir],
          async () => {
            await assertCurrentCanvasWorkspace(workspace);
            await assertResultsStorageIdentity(workspace);
            await assertNoPendingImportTransactionWrite({
              workspaceRoot: dirname(workspace.projectFile),
              target: workspace.resultsDir
            });
            const record = leaseSchema.parse({
              version: 1,
              token,
              resultsRoot: await canonicalPackageFileTarget(workspace.resultsDir),
              ownerPid: process.pid,
              executionIdentity,
              createdAt: new Date().toISOString(),
              status: "writing"
            });
            await mkdir(leaseRoot(), { recursive: true, mode: 0o700 });
            await writeJsonFile(path, record);
            return record;
          }
        );
      }
    )
  );
  return {
    path,
    markUncertain: () =>
      withPackageFileConsistency([workspace.resultsDir], () =>
        writeJsonFile(path, { ...lease, status: "uncertain" })
      ),
    release: () =>
      withPackageFileConsistency([workspace.resultsDir], async () => {
        const current = leaseSchema.parse(await readJsonFile<unknown>(path));
        if (
          current.token !== token ||
          current.ownerPid !== process.pid ||
          current.resultsRoot !== lease.resultsRoot
        )
          throw new Error(`Executor results lease ownership changed at ${path}.`);
        await rm(path);
      })
  };
}
