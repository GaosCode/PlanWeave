import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";

function nodeFileErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function isNodeFileNotFoundError(error: unknown): boolean {
  const code = nodeFileErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function optionalStat(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function optionalReaddir(
  path: string,
  options: { withFileTypes: true }
): Promise<Dirent[] | null> {
  try {
    return await readdir(path, options);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function optionalReadFile(
  path: string,
  encoding: BufferEncoding
): Promise<string | null> {
  try {
    return await readFile(path, encoding);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}
