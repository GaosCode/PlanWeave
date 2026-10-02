import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { withPackageDirectoryRead, withPackageFileConsistency } from "./packageFileConsistency.js";
import { readDecodedUtf8Bytes } from "./decodedUtf8Bytes.js";
import { PackagePathError, resolvePackagePath } from "./resolvePackagePath.js";

export const packageFileEntrySchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.literal("utf8")
  })
  .strict();

export type PackageFileEntry = z.infer<typeof packageFileEntrySchema>;

export function toArchivePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid package file path '${value}'.`);
  }
  return normalized;
}

export function safePackageFilePath(root: string, archivePath: string): string {
  const target = resolve(root, archivePath.split("/").join(sep));
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Package file path '${archivePath}' resolves outside the package directory.`);
  }
  return target;
}

export const packageFileInventoryEntrySchema = packageFileEntrySchema
  .omit({ content: true })
  .extend({ contentBytes: z.number().int().nonnegative() });
export type PackageFileInventoryEntry = z.infer<typeof packageFileInventoryEntrySchema>;

async function* packageFilePaths(
  root: string,
  dir = root
): AsyncGenerator<{ archivePath: string; diskPath: string }> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* packageFilePaths(root, path);
    else if (entry.isFile())
      yield { archivePath: toArchivePath(relative(root, path)), diskPath: path };
  }
}

export async function readPackageFiles(root: string): Promise<PackageFileEntry[]> {
  return withPackageDirectoryRead(root, () => readPackageFilesBatch(root));
}

async function readPackageFilesBatch(root: string): Promise<PackageFileEntry[]> {
  const files: PackageFileEntry[] = [];
  for await (const { archivePath, diskPath } of packageFilePaths(root)) {
    files.push({ path: archivePath, content: await readFile(diskPath, "utf8"), encoding: "utf8" });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Exact decoded UTF-8 sizes, without retaining bodies or imposing export budgets. */
export async function readPackageFileInventory(root: string): Promise<PackageFileInventoryEntry[]> {
  return withPackageDirectoryRead(root, () => readPackageFileInventoryBatch(root));
}

async function readPackageFileInventoryBatch(root: string): Promise<PackageFileInventoryEntry[]> {
  const files: PackageFileInventoryEntry[] = [];
  for await (const { archivePath, diskPath } of packageFilePaths(root)) {
    files.push({
      path: archivePath,
      contentBytes: await readDecodedUtf8Bytes(diskPath),
      encoding: "utf8"
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function packageReadFailure(path: string, error: unknown): Error {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "package_file_unavailable";
  return new Error(`Package file '${path}' could not be read (${code}).`);
}

/** Read exact archive members in request order; repeats retain their output positions. */
export async function readSelectedPackageFiles(
  root: string,
  paths: readonly string[],
  duplicatePath: "first" | "last" = "first"
): Promise<PackageFileEntry[]> {
  if (paths.length === 0) return [];
  try {
    return await withPackageDirectoryRead(root, () =>
      readSelectedPackageFilesBatch(root, paths, duplicatePath)
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^E[A-Z]+$/.test(error.code)
    ) {
      throw packageReadFailure(paths.join(", "), error);
    }
    throw error;
  }
}

async function readSelectedPackageFilesBatch(
  root: string,
  paths: readonly string[],
  duplicatePath: "first" | "last"
): Promise<PackageFileEntry[]> {
  const requested = new Set(paths);
  const targets = new Map<string, string>();
  for (const path of paths) {
    // Validate the archive request separately from the actual member path.
    try {
      await resolvePackagePath(root, path);
    } catch (error) {
      if (error instanceof PackagePathError) throw error;
      throw packageReadFailure(path, error);
    }
    if (toArchivePath(path) !== path) {
      throw new Error(`Package file '${path}' was not found.`);
    }
  }
  if (requested.size === 0) return [];
  try {
    for await (const { archivePath, diskPath } of packageFilePaths(root)) {
      if (requested.has(archivePath) && (duplicatePath === "last" || !targets.has(archivePath))) {
        targets.set(archivePath, diskPath);
      }
    }
  } catch (error) {
    throw packageReadFailure([...requested].join(", "), error);
  }
  for (const path of requested) {
    const diskPath = targets.get(path);
    if (!diskPath) throw new Error(`Package file '${path}' was not found.`);
    try {
      await resolvePackagePath(root, relative(root, diskPath), { requireExisting: true });
    } catch (error) {
      if (error instanceof PackagePathError) throw error;
      throw packageReadFailure(path, error);
    }
  }
  const files = new Map<string, PackageFileEntry>();
  for (const path of requested) {
    const absolute = targets.get(path);
    if (!absolute) throw new Error(`Package file '${path}' was not found.`);
    try {
      files.set(path, { path, content: await readFile(absolute, "utf8"), encoding: "utf8" });
    } catch (error) {
      throw packageReadFailure(path, error);
    }
  }
  return paths.map((path) => {
    const file = files.get(path);
    if (!file) throw new Error(`Package file '${path}' was not found.`);
    return { ...file };
  });
}

export async function replacePackageFiles(root: string, files: PackageFileEntry[]): Promise<void> {
  await replacePackageFilesWithFileSystem(root, files, packageFileSystem);
}

/** @internal Kept out of the runtime index for filesystem fault-injection tests. */
export async function replacePackageFilesWithFileSystem(
  root: string,
  files: PackageFileEntry[],
  fileSystem: PackageFileSystem
): Promise<void> {
  const targetRoot = resolve(root);
  const preparedFiles = preparePackageFiles(targetRoot, files);
  const parent = dirname(targetRoot);
  const fs = fileSystem;

  await fs.mkdir(parent, { recursive: true });
  const lockPath = packageReplacementLockPath(targetRoot);
  const lock = await acquirePackageReplacementLock(fs, lockPath);
  let replacementFailed = false;
  let replacementFailureCause: unknown;
  let lockCleanupFailures: Error[] = [];

  try {
    try {
      await withPackageFileConsistency([targetRoot], () =>
        replacePreparedPackageFiles(fs, targetRoot, parent, preparedFiles)
      );
    } catch (error) {
      replacementFailed = true;
      replacementFailureCause = error;
    }
  } finally {
    lockCleanupFailures = await releasePackageReplacementLock(fs, lock, lockPath);
  }

  if (replacementFailed) {
    if (lockCleanupFailures.length > 0) {
      throw replacementFailure(
        `Package replacement at '${targetRoot}' failed and lock cleanup also failed.`,
        replacementFailureCause,
        lockCleanupFailures
      );
    }
    throw replacementFailureCause;
  }
  if (lockCleanupFailures.length > 0) {
    throw failuresError(
      `Package replacement completed at '${targetRoot}', but lock cleanup failed; inspect '${lockPath}' before another replacement.`,
      lockCleanupFailures
    );
  }
}

async function replacePreparedPackageFiles(
  fs: PackageFileSystem,
  targetRoot: string,
  parent: string,
  preparedFiles: PreparedPackageFile[]
): Promise<void> {
  const stagingRoot = await fs.mkdtemp(join(parent, `.${basename(targetRoot)}.staging-`));
  try {
    await writePreparedPackageFiles(fs, stagingRoot, preparedFiles);
  } catch (error) {
    throw replacementFailure(
      `Failed to write staged package replacement for '${targetRoot}'.`,
      error,
      await cleanupPathFailure(fs, stagingRoot, "staging directory")
    );
  }

  let targetExists: boolean;
  try {
    targetExists = await pathExists(fs, targetRoot);
  } catch (error) {
    throw replacementFailure(
      `Failed to inspect package replacement target '${targetRoot}'.`,
      error,
      await cleanupPathFailure(fs, stagingRoot, "staging directory")
    );
  }

  if (!targetExists) {
    try {
      await fs.rename(stagingRoot, targetRoot);
    } catch (error) {
      throw replacementFailure(
        `Failed to install staged package replacement at '${targetRoot}'.`,
        error,
        await cleanupPathFailure(fs, stagingRoot, "staging directory")
      );
    }
    return;
  }

  const backupRoot = join(parent, `.${basename(targetRoot)}.backup-${randomUUID()}`);
  try {
    await fs.rename(targetRoot, backupRoot);
  } catch (error) {
    throw replacementFailure(
      `Failed to move existing package '${targetRoot}' to backup '${backupRoot}'.`,
      error,
      await cleanupPathFailure(fs, stagingRoot, "staging directory")
    );
  }

  try {
    await fs.rename(stagingRoot, targetRoot);
  } catch (error) {
    const recovery = await restoreFailedPackageReplacement(fs, targetRoot, backupRoot, stagingRoot);
    throw replacementFailure(
      recovery.restored && recovery.failures.length === 0
        ? `Failed to install staged package replacement at '${targetRoot}'; the original package was restored from '${backupRoot}'.`
        : recovery.restored
          ? `Failed to install staged package replacement at '${targetRoot}'; the original package was restored from '${backupRoot}', but temporary cleanup failed.`
          : `Failed to install staged package replacement at '${targetRoot}'; original package recovery failed from '${backupRoot}'.`,
      error,
      recovery.failures
    );
  }

  const backupCleanupFailure = await cleanupPathFailure(fs, backupRoot, "backup directory");
  if (backupCleanupFailure) {
    throw replacementFailure(
      `Package replacement completed but backup cleanup failed at '${targetRoot}'.`,
      backupCleanupFailure
    );
  }
}

type PreparedPackageFile = PackageFileEntry & {
  archivePath: string;
};

export type PackageFileSystem = {
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  open: typeof open;
  rename: typeof rename;
  rm: typeof rm;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
};

type PackageReplacementLock = Awaited<ReturnType<typeof open>>;

const packageFileSystem: PackageFileSystem = {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  unlink,
  writeFile
};

/**
 * Serializes replacePackageFiles callers that use this runtime API; external writers must coordinate separately.
 */
function packageReplacementLockPath(targetRoot: string): string {
  return join(dirname(targetRoot), `.${basename(targetRoot)}.replace.lock`);
}

async function acquirePackageReplacementLock(
  fs: PackageFileSystem,
  lockPath: string
): Promise<PackageReplacementLock> {
  try {
    return await fs.open(lockPath, "wx");
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error(
        `Package replacement lock '${lockPath}' is already held or stale; no package files were changed. Wait for the current replacement or inspect the lock before retrying.`,
        { cause: error }
      );
    }
    throw new Error(
      `Failed to acquire package replacement lock '${lockPath}': ${errorSummary(error)}`,
      {
        cause: error
      }
    );
  }
}

async function releasePackageReplacementLock(
  fs: PackageFileSystem,
  lock: PackageReplacementLock,
  lockPath: string
): Promise<Error[]> {
  const failures: Error[] = [];
  try {
    await lock.close();
  } catch (error) {
    failures.push(
      new Error(`Failed to close package replacement lock '${lockPath}': ${errorSummary(error)}`, {
        cause: error
      })
    );
  }
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    failures.push(
      new Error(
        `Failed to remove package replacement lock '${lockPath}'; inspect it before another replacement: ${errorSummary(error)}`,
        { cause: error }
      )
    );
  }
  return failures;
}

function preparePackageFiles(root: string, files: readonly unknown[]): PreparedPackageFile[] {
  const archivePaths = new Set<string>();
  return files.map((file, index) => {
    const parsed = packageFileEntrySchema.safeParse(file);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid package file entry at index ${String(index)}: ${issues}`);
    }
    const archivePath = toArchivePath(parsed.data.path);
    safePackageFilePath(root, archivePath);
    if (archivePaths.has(archivePath)) {
      throw new Error(`Duplicate package file path '${archivePath}' after normalization.`);
    }
    archivePaths.add(archivePath);
    return { ...parsed.data, archivePath };
  });
}

async function writePreparedPackageFiles(
  fs: PackageFileSystem,
  root: string,
  files: PreparedPackageFile[]
): Promise<void> {
  for (const file of files) {
    const path = safePackageFilePath(root, file.archivePath);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, file.content, "utf8");
  }
}

async function pathExists(fs: PackageFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

type FailedPackageReplacementRecovery = {
  restored: boolean;
  failures: Error[];
};

async function restoreFailedPackageReplacement(
  fs: PackageFileSystem,
  targetRoot: string,
  backupRoot: string,
  stagingRoot: string
): Promise<FailedPackageReplacementRecovery> {
  const failures: Error[] = [];
  const targetCleanupFailure = await cleanupPathFailure(
    fs,
    targetRoot,
    "failed package replacement target"
  );
  let restored = false;
  if (targetCleanupFailure) {
    failures.push(targetCleanupFailure);
  } else {
    try {
      await fs.rename(backupRoot, targetRoot);
      restored = true;
    } catch (error) {
      failures.push(
        new Error(
          `Failed to restore original package from backup '${backupRoot}' to '${targetRoot}': ${errorSummary(error)}`,
          { cause: error }
        )
      );
    }
  }

  const stagingCleanupFailure = await cleanupPathFailure(fs, stagingRoot, "staging directory");
  if (stagingCleanupFailure) failures.push(stagingCleanupFailure);
  return { restored, failures };
}

async function cleanupPathFailure(
  fs: PackageFileSystem,
  path: string,
  label: string
): Promise<Error | null> {
  try {
    await fs.rm(path, { recursive: true, force: true });
    return null;
  } catch (error) {
    return new Error(`Failed to remove ${label} '${path}': ${errorSummary(error)}`, {
      cause: error
    });
  }
}

function replacementFailure(
  message: string,
  primary: unknown,
  secondary: Error | Error[] | null = null
): Error {
  const secondaryFailures =
    secondary === null ? [] : Array.isArray(secondary) ? secondary : [secondary];
  const failures = [primary, ...secondaryFailures];
  const details = failures.map(errorSummary).join("; ");
  return new AggregateError(failures, `${message} ${details}`);
}

function failuresError(message: string, failures: Error[]): Error {
  const details = failures.map(errorSummary).join("; ");
  return new AggregateError(failures, `${message} ${details}`);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read every file under a package workspace directory into archive entries.
 * Runtime state (`state.json`, `results/`) lives outside the package and is never included.
 */
export async function exportCanvasPackageFiles(workspace: {
  packageDir: string;
}): Promise<PackageFileEntry[]> {
  return readPackageFiles(workspace.packageDir);
}
