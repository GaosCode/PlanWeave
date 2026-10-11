import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ImportTransaction } from "../package/importTransaction.js";
import { rollbackPendingImportTransaction } from "../package/importRecovery.js";
import {
  tempWorkspace,
  writeText,
  recoveryRoot,
  readRecovery
} from "./support/importTransactionTestHarness.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture(reserved = false) {
  const workspaceRoot = await tempWorkspace();
  directories.push(workspaceRoot);
  const transactionId = "lifecycle";
  const transaction = await ImportTransaction.create({
    workspaceRoot,
    transactionId,
    writeIsolationTargets: reserved
      ? ["first", "second", "layout"].map((name) => join(workspaceRoot, name))
      : []
  });
  return { workspaceRoot, transactionId, transaction };
}
async function install(root: string, transaction: ImportTransaction, name: string) {
  const target = join(root, name);
  const staged = join(root, `${name}-staged`);
  await writeText(target, `${name}-old`);
  await writeText(staged, `${name}-new`);
  await transaction.replacePath(target, staged);
  return target;
}

it("reloads additional recovery targets before restoring a stale recovered object", async () => {
  const { workspaceRoot, transactionId, transaction } = await fixture();
  const first = await install(workspaceRoot, transaction, "first");
  const stale = await ImportTransaction.recover({ workspaceRoot, transactionId });
  const second = await install(workspaceRoot, transaction, "second");
  await stale.rollback();
  expect(await readFile(first, "utf8")).toBe("first-old");
  expect(await readFile(second, "utf8")).toBe("second-old");
  await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
});

it("preserves operations appended by another transaction handle", async () => {
  const { workspaceRoot, transactionId, transaction } = await fixture();
  const stale = await ImportTransaction.recover({ workspaceRoot, transactionId });
  const first = await install(workspaceRoot, transaction, "first");
  const second = await install(workspaceRoot, stale, "second");
  expect(
    (await readRecovery(workspaceRoot, transactionId)).operations.map((op) => op.target)
  ).toEqual([first, second]);
  await rollbackPendingImportTransaction({ workspaceRoot, transactionId });
  expect(await readFile(first, "utf8")).toBe("first-old");
  expect(await readFile(second, "utf8")).toBe("second-old");
});

it("preflights every backup before deleting any other installed target", async () => {
  const { workspaceRoot, transactionId, transaction } = await fixture(true);
  const first = await install(workspaceRoot, transaction, "first");
  const layout = join(workspaceRoot, "layout");
  const staged = join(workspaceRoot, "layout-staged");
  await writeFile(staged, "installed-layout");
  await transaction.replacePath(layout, staged);
  const recovery = recoveryRoot(workspaceRoot, transactionId);
  await rm(join(recovery, "backups", "000001"));
  const journal = await readFile(join(recovery, "recovery.json"), "utf8");
  await expect(rollbackPendingImportTransaction({ workspaceRoot, transactionId })).rejects.toThrow(
    "backup missing"
  );
  expect(await readFile(first, "utf8")).toBe("first-new");
  expect(await readFile(layout, "utf8")).toBe("installed-layout");
  expect(await readFile(join(recovery, "recovery.json"), "utf8")).toBe(journal);
});

it("does not let a second queued recovery recreate the removed journal", async () => {
  const { workspaceRoot, transactionId, transaction } = await fixture();
  const target = await install(workspaceRoot, transaction, "first");
  const a = await ImportTransaction.recover({ workspaceRoot, transactionId });
  const b = await ImportTransaction.recover({ workspaceRoot, transactionId });
  const outcomes = await Promise.allSettled([a.rollback(), b.rollback()]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
    reason: expect.objectContaining({ message: expect.stringContaining("no longer exists") })
  });
  expect(await readFile(target, "utf8")).toBe("first-old");
  await expect(access(recoveryRoot(workspaceRoot, transactionId))).rejects.toThrow();
});

it("allows an already committed handle to finish cleanup after another handle", async () => {
  const { workspaceRoot, transactionId, transaction } = await fixture();
  const target = await install(workspaceRoot, transaction, "first");
  await transaction.markCommitted();
  const second = await ImportTransaction.recover({ workspaceRoot, transactionId });
  await transaction.cleanupCommitted();
  await expect(second.cleanupCommitted()).resolves.toBeUndefined();
  expect(await readFile(target, "utf8")).toBe("first-new");
  await expect(second.rollback()).rejects.toThrow("no longer exists");
});

it.each([
  "missing-journal",
  "missing-active-transaction",
  "missing-workspace"
])("refuses cleanup for %s instead of treating corruption as completed", async (scenario) => {
  const { workspaceRoot, transactionId, transaction } = await fixture();
  if (scenario !== "missing-active-transaction") await transaction.markCommitted();
  const root = recoveryRoot(workspaceRoot, transactionId);
  if (scenario === "missing-journal") await rm(join(root, "recovery.json"));
  else if (scenario === "missing-workspace") {
    await rm(workspaceRoot, { recursive: true, force: true });
  } else await rm(root, { recursive: true, force: true });
  await expect(transaction.cleanupCommitted()).rejects.toThrow("no longer exists");
});
