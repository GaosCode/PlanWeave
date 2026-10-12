import { cp, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { initWorkspace } from "../initWorkspace.js";
import { loadPackage } from "../package/loadPackage.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { markBlockBlocked, markBlockDiverged } from "../taskManager/blockStatusMutations.js";
import { claimDispatchedBlock } from "../taskManager/claimBlockDispatch.js";
import { resetMaxCycleReviewsForRetryWithRollback } from "../taskManager/reviewRetry.js";
import { createEmptyState, ensureStateForManifest, writeState } from "../state.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

it.each(
  (["package", "results"] as const).flatMap((reset) =>
    (["blocked", "diverged", "claim"] as const).map((entry) => ({ reset, entry }))
  )
)("rejects queued $entry from a retired $reset instance", async ({ reset, entry }) => {
  const { root } = await createTestWorkspace();
  const { workspace } = await loadPackage(root);
  const manifestBytes = await readFile(workspace.manifestFile, "utf8");
  const baselinePackage = join(root, "baseline-package");
  await cp(workspace.packageDir, baselinePackage, { recursive: true });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withProjectMutationLock(dirname(workspace.projectFile), () =>
    withPackageFileConsistency(
      [workspace.packageDir, workspace.stateFile, workspace.resultsDir],
      async () => {
        enter();
        await proceed;
        await initWorkspace({
          projectRoot: root,
          ...(reset === "package" ? { resetPackage: true } : { resetResults: true })
        });
        if (reset === "package")
          await cp(baselinePackage, workspace.packageDir, { recursive: true });
        return readFile(workspace.stateFile, "utf8");
      }
    )
  );
  await entered;
  const options = { projectRoot: workspace, ref: "T-001#B-001", reason: "retired request" };
  const writer = (
    entry === "claim"
      ? claimDispatchedBlock(options)
      : entry === "blocked"
        ? markBlockBlocked(options)
        : markBlockDiverged(options)
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  try {
    await delay(40);
    release();
    const stateBytes = await holder;
    expect(await writer).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("identity changed")
      })
    });
    expect(await readFile(workspace.manifestFile, "utf8")).toBe(manifestBytes);
    expect(await readFile(workspace.stateFile, "utf8")).toBe(stateBytes);
    const fresh = (await loadPackage(root)).workspace;
    if (entry === "claim") {
      await expect(claimDispatchedBlock({ ...options, projectRoot: fresh })).resolves.toMatchObject(
        {
          kind: "block",
          ref: options.ref
        }
      );
    } else {
      const mutation = entry === "blocked" ? markBlockBlocked : markBlockDiverged;
      await expect(mutation({ ...options, projectRoot: fresh })).resolves.toMatchObject({
        status: entry
      });
    }
  } finally {
    release();
    await holder;
    await writer;
  }
});

it("rejects an escaped review reset rollback after results retirement", async () => {
  const { root } = await createTestWorkspace();
  const { workspace, manifest } = await loadPackage(root);
  const state = ensureStateForManifest(manifest, createEmptyState());
  state.blocks["T-001#B-001"] = { ...state.blocks["T-001#B-001"], status: "completed" };
  state.blocks["T-001#R-001"] = {
    ...state.blocks["T-001#R-001"],
    status: "blocked",
    completionReason: "max_cycles_reached"
  };
  await writeState(workspace.stateFile, state);
  const transaction = await resetMaxCycleReviewsForRetryWithRollback({
    projectRoot: workspace,
    scope: { kind: "project" }
  });
  expect(transaction.refs).toEqual(["T-001#R-001"]);
  await initWorkspace({ projectRoot: root, resetResults: true });
  const freshState = await readFile(workspace.stateFile, "utf8");
  await expect(transaction.rollback()).rejects.toThrow("identity changed");
  expect(await readFile(workspace.stateFile, "utf8")).toBe(freshState);
});
