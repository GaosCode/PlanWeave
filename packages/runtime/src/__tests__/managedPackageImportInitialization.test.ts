import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTaskCanvas } from "../desktop/canvasApi.js";
import { listPendingImportRecoveries } from "../desktop/importRecoveryApi.js";
import { initialManifest } from "../initWorkspace.js";
import { listPendingImportTransactions } from "../package/importRecovery.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { importManagedPackage } from "../package/managedPackageImport.js";
import { createManagedProjectId } from "../projectId.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), rmdir: vi.fn(actual.rmdir) };
});

let home: string;
let draftRoot: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "planweave-import-initialization-")));
  draftRoot = join(home, "draft");
  await mkdir(draftRoot);
  await writeFile(join(draftRoot, "manifest.json"), JSON.stringify(initialManifest("Incoming")));
  vi.stubEnv("PLANWEAVE_HOME", home);
  vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", join(home, "settings.json"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

function recoveryRoot(transactionId: string): string {
  return join(home, "desktop", "recovery", "package-import", transactionId);
}

function runImport(name: string) {
  return importManagedPackage({ name, draftRoot, overwrite: false });
}

async function failFirstJournal(
  beforeFailure?: (temporaryPath: string, targetPath: string) => Promise<void>
): Promise<() => string> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let failedPath: string | undefined;
  vi.mocked(rename).mockImplementation(async (source, target) => {
    if (!failedPath && String(target).endsWith("/recovery.json")) {
      const journal = JSON.parse(await readFile(source, "utf8"));
      if (journal.state === "active" && journal.operations.length === 0) {
        failedPath = String(target);
        await beforeFailure?.(String(source), String(target));
        throw Object.assign(new Error("initial journal rename EIO"), { code: "EIO" });
      }
    }
    return actual.rename(source, target);
  });
  return () => {
    if (!failedPath) throw new Error("Expected an injected initial journal failure");
    return failedPath;
  };
}

it("releases failed initialization so retries and other projects remain usable", async () => {
  const healthy = await runImport("Healthy");
  await mkdir(healthy.workspace.resultsDir, { recursive: true });
  const sentinel = join(healthy.workspace.resultsDir, "sentinel.txt");
  await writeFile(sentinel, "existing result");
  const before = await Promise.all(
    [healthy.workspace.manifestFile, healthy.workspace.stateFile, sentinel].map((path) =>
      readFile(path)
    )
  );
  const failedPath = await failFirstJournal();
  await expect(runImport("Retry after failure")).rejects.toThrow("initial journal rename EIO");
  const failedJournal = failedPath();
  vi.mocked(rename).mockRestore();
  const failedProject = join(home, "projects", createManagedProjectId("Retry after failure"));
  await expect(lstat(failedProject)).rejects.toMatchObject({ code: "ENOENT" });
  const outcomes = [];
  for (const action of [
    () => runImport("Retry after failure"),
    () => runImport("Different project"),
    () => listPendingImportRecoveries(healthy.workspace.rootPath),
    () => createTaskCanvas(healthy.workspace.rootPath, { name: "After failed initialization" })
  ]) {
    outcomes.push(await Promise.allSettled([action()]));
  }
  expect(
    await Promise.all(
      [healthy.workspace.manifestFile, healthy.workspace.stateFile, sentinel].map((path) =>
        readFile(path)
      )
    )
  ).toEqual(before);
  expect(outcomes.map(([result]) => result)).toEqual(
    Array.from({ length: 4 }, () => expect.objectContaining({ status: "fulfilled" }))
  );
  expect(await readdir(dirname(dirname(failedJournal)))).toEqual([]);
  const retried = await ImportTransaction.create({
    workspaceRoot: home,
    transactionId: basename(dirname(failedJournal))
  });
  await retried.rollback();
});

it.each([
  "valid",
  "unknown",
  "dangling-symlink"
])("preserves an existing %s recovery entry instead of claiming it", async (kind) => {
  const transactionId = "existing";
  const root = recoveryRoot(transactionId);
  if (kind === "valid") {
    await ImportTransaction.create({ workspaceRoot: home, transactionId });
  } else {
    await mkdir(dirname(root), { recursive: true });
    if (kind === "dangling-symlink") {
      await symlink(join(home, "missing"), root, process.platform === "win32" ? "junction" : "dir");
    } else {
      await mkdir(root);
      await writeFile(join(root, "recovery.json"), "unknown damaged journal");
    }
  }
  const before = await lstat(root);
  const journal = kind === "dangling-symlink" ? null : await readFile(join(root, "recovery.json"));
  await expect(ImportTransaction.create({ workspaceRoot: home, transactionId })).rejects.toThrow();
  expect((await lstat(root)).ino).toBe(before.ino);
  if (journal) expect(await readFile(join(root, "recovery.json"))).toEqual(journal);
  if (kind === "valid") {
    expect(await listPendingImportTransactions(home)).toMatchObject([{ transactionId }]);
  } else if (kind === "unknown") {
    await expect(listPendingImportTransactions(home)).rejects.toThrow();
  } else {
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
    await expect(lstat(join(home, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("retains a journal when publication succeeded before the I/O reported failure", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const failedPath = await failFirstJournal((source, target) => actual.rename(source, target));
  await expect(runImport("Published journal")).rejects.toThrow("initial journal rename EIO");
  const path = failedPath();
  const pending = await listPendingImportTransactions(home);
  expect(pending).toMatchObject([{ operationCount: 0, recoveryRoot: dirname(path) }]);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ state: "active" });
});

it.each([
  "directory",
  "symlink"
])("preserves a replacement %s when initial publication fails", async (kind) => {
  const displaced = join(home, "displaced");
  const replacement = join(home, "replacement");
  await mkdir(replacement);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const failedPath = await failFirstJournal(async (_source, target) => {
    const root = dirname(target);
    await actual.rename(root, displaced);
    if (kind === "symlink") {
      await symlink(replacement, root, process.platform === "win32" ? "junction" : "dir");
    } else {
      await mkdir(root);
    }
  });
  await expect(runImport("Replacement")).rejects.toThrow("initial journal rename EIO");
  expect((await lstat(dirname(failedPath()))).isSymbolicLink()).toBe(kind === "symlink");
  expect(await readdir(replacement)).toEqual([]);
  expect((await lstat(displaced)).isDirectory()).toBe(true);
});

it("reports both initial publication and directory cleanup failures", async () => {
  const failedPath = await failFirstJournal();
  vi.mocked(rmdir).mockRejectedValueOnce(new Error("initial directory cleanup EACCES"));
  const error = await runImport("Cleanup failure").catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error("Expected initialization AggregateError");
  expect(error.message).toContain("initial journal rename EIO");
  expect(error.message).toContain("initial directory cleanup EACCES");
  expect(error.errors.map((failure: Error) => failure.message)).toEqual([
    "initial journal rename EIO",
    "initial directory cleanup EACCES"
  ]);
  expect(await readdir(dirname(failedPath()))).toEqual([]);
});

it("preserves unknown content created during a failed initial publication", async () => {
  const failedPath = await failFirstJournal(async (_source, target) => {
    await writeFile(join(dirname(target), "unknown.txt"), "must remain");
  });
  await expect(runImport("Unknown content")).rejects.toThrow("initial journal rename EIO");
  expect(await readFile(join(dirname(failedPath()), "unknown.txt"), "utf8")).toBe("must remain");
});
