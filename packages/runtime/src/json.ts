import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
    await doRename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
