import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { optionalStat } from "./optionalFile.js";

export type AdvisoryLockFs = {
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  lstat(
    path: string
  ): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }>;
  writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  rmdir(path: string): Promise<void>;
  optionalStat(path: string): Promise<{ mtimeMs: number } | null>;
};

export const defaultLockFs: AdvisoryLockFs = {
  mkdir: async (path) => {
    await mkdir(path);
  },
  readdir,
  lstat,
  writeFile,
  readFile: (path, encoding) => readFile(path, encoding),
  rename,
  rm,
  rmdir,
  optionalStat
};

export function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export const lockHolderSchema = z
  .object({
    version: z.literal(2),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    acquiredAt: z.string().datetime(),
    operation: z.string().trim().min(1),
    ownerToken: z.string().uuid()
  })
  .strict();
export type LockHolder = z.infer<typeof lockHolderSchema>;
export type LockOwner = {
  name: string;
  pid: number;
  token: string;
  holder: LockHolder | null;
  writersDrained: boolean;
  detail: string;
};
const ownerName =
  /^(?:lease|drained)-v2-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function unsupportedLock(path: string, detail: string): Error {
  return new Error(
    `LOCK_FORMAT_UNSUPPORTED at ${path}: ${detail}; stop all old clients before upgrading; no lock data was removed`
  );
}

export async function inspectLockOwner(
  lockPath: string,
  fs: AdvisoryLockFs
): Promise<LockOwner | "empty" | null> {
  try {
    const root = await fs.lstat(lockPath);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw unsupportedLock(lockPath, "lock root must be a real directory");
    const entries = await fs.readdir(lockPath);
    if (entries.length === 0) return "empty";
    const match = entries.length === 1 ? ownerName.exec(entries[0]) : null;
    if (!match || !Number.isSafeInteger(Number(match[1])))
      throw unsupportedLock(lockPath, `unexpected entries: ${entries.join(", ")}`);
    const name = entries[0];
    const metadata = await fs.lstat(join(lockPath, name));
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw unsupportedLock(lockPath, "lease must be a real directory");
    const owner: LockOwner = {
      name,
      pid: Number(match[1]),
      token: match[2],
      holder: null,
      writersDrained: name.startsWith("drained-v2-"),
      detail: "holder missing"
    };
    if (owner.writersDrained) {
      owner.detail = "writer drainage confirmed before cleanup";
      return owner;
    }
    try {
      const holderMetadata = await fs.lstat(join(lockPath, name, "holder.json"));
      if (!holderMetadata.isFile() || holderMetadata.isSymbolicLink())
        throw unsupportedLock(lockPath, "holder must be a regular file");
      const parsed = lockHolderSchema.safeParse(
        JSON.parse(await fs.readFile(join(lockPath, name, "holder.json"), "utf8"))
      );
      if (
        parsed.success &&
        parsed.data.pid === owner.pid &&
        parsed.data.ownerToken === owner.token
      ) {
        owner.holder = parsed.data;
        owner.detail = "holder valid";
      } else owner.detail = "holder JSON invalid or identity mismatch";
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isErrno(error, "ENOENT")) throw error;
      owner.detail = error instanceof SyntaxError ? "holder JSON invalid" : "holder missing";
    }
    return owner;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

/** Drainage is committed in the UUID directory identity before any contents are deleted. */
export async function removeExactLockOwner(
  lockPath: string,
  name: string,
  fs: AdvisoryLockFs
): Promise<void> {
  if (!ownerName.test(name)) throw new Error("Invalid lock lease identity");
  const drainedName = name.replace(/^lease-v2-/, "drained-v2-");
  if (drainedName !== name) {
    try {
      await fs.rename(join(lockPath, name), join(lockPath, drainedName));
    } catch (error) {
      // Another cleanup may already have retired or removed this exact UUID.
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  await fs.rm(join(lockPath, drainedName), { recursive: true, force: true });
  await removeEmptyLockRoot(lockPath, fs);
}

export async function removeEmptyLockRoot(lockPath: string, fs: AdvisoryLockFs): Promise<void> {
  try {
    await fs.rmdir(lockPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY") && !isErrno(error, "EEXIST"))
      throw error;
  }
}
