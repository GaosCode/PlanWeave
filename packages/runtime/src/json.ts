import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const retryableRenameErrorCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const renameRetryDelaysMs = [10, 20, 40, 80, 160, 250] as const;

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

export type WriteJsonFileOptions = {
  /**
   * Override the final atomic rename. Production still removes `temporaryPath`
   * when this throws (same contract as a real rename failure).
   */
  rename?(temporaryPath: string, targetPath: string): Promise<void>;
};

function isRetryableRenameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    retryableRenameErrorCodes.has(error.code)
  );
}

async function renameWithRetry(
  renameFile: NonNullable<WriteJsonFileOptions["rename"]>,
  temporaryPath: string,
  targetPath: string,
  attempt = 0
): Promise<void> {
  try {
    await renameFile(temporaryPath, targetPath);
  } catch (error) {
    const retryDelayMs = renameRetryDelaysMs[attempt];
    if (retryDelayMs === undefined || !isRetryableRenameError(error)) {
      throw error;
    }
    await wait(retryDelayMs);
    await renameWithRetry(renameFile, temporaryPath, targetPath, attempt + 1);
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown,
  options?: WriteJsonFileOptions
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  const doRename = options?.rename ?? rename;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameWithRetry(doRename, temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
