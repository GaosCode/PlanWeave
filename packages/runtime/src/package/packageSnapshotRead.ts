import type { BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import { PACKAGE_SNAPSHOT_MAX_FILE_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { resolvePackagePath } from "./resolvePackagePath.js";

export type SnapshotMemberRead = {
  path: string;
  target: string;
  metadata: BigIntStats;
  bytes: Buffer;
};

export function sameSnapshotFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export class PackageSnapshotConflictError extends Error {
  readonly code = "package_snapshot_conflict";
  constructor(
    readonly path: string,
    cause?: unknown
  ) {
    super(`package_snapshot_conflict:${path}`, { cause });
    this.name = "PackageSnapshotConflictError";
  }
}

export function snapshotConflict(path: string, cause?: unknown): PackageSnapshotConflictError {
  return new PackageSnapshotConflictError(path, cause);
}

/** Pin a validated real target and cap actual reads even if an external writer grows the file. */
export async function readSnapshotMember(
  root: string,
  path: string,
  remainingBytes: number,
  expected?: SnapshotMemberRead
): Promise<SnapshotMemberRead> {
  const candidate = await resolvePackagePath(root, path, { requireExisting: true });
  const target = await realpath(candidate);
  const realRoot = await realpath(root);
  await resolvePackagePath(realRoot, relative(realRoot, target), { requireExisting: true });
  const metadata = await stat(candidate, { bigint: true });
  if (expected && (target !== expected.target || !sameSnapshotFile(metadata, expected.metadata)))
    throw snapshotConflict(path);
  if (!metadata.isFile()) throw new Error(`package_snapshot_not_file:${path}`);
  if (metadata.size > BigInt(PACKAGE_SNAPSHOT_MAX_FILE_BYTES))
    throw new Error(`package_snapshot_file_too_large:${path}`);
  if (metadata.size > BigInt(remainingBytes))
    throw new Error("package_snapshot_total_bytes_exceeded");
  const handle = await open(target, "r");
  try {
    if (!sameSnapshotFile(metadata, await handle.stat({ bigint: true })))
      throw snapshotConflict(path);
    const chunks: Buffer[] = [];
    const limit = Math.min(PACKAGE_SNAPSHOT_MAX_FILE_BYTES, remainingBytes);
    let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (expected && size > limit) throw snapshotConflict(path);
      if (size > PACKAGE_SNAPSHOT_MAX_FILE_BYTES)
        throw new Error(`package_snapshot_file_too_large:${path}`);
      if (size > remainingBytes) throw new Error("package_snapshot_total_bytes_exceeded");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (!sameSnapshotFile(metadata, await handle.stat({ bigint: true })))
      throw snapshotConflict(path);
    return { path, target, metadata, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

/** One bounded second collection followed by an identity fence across the entire closure. */
export async function verifySnapshotMembers(
  root: string,
  members: SnapshotMemberRead[]
): Promise<void> {
  for (const member of members) {
    try {
      const current = await readSnapshotMember(root, member.path, member.bytes.length, member);
      if (
        current.target !== member.target ||
        !sameSnapshotFile(current.metadata, member.metadata) ||
        !current.bytes.equals(member.bytes)
      )
        throw snapshotConflict(member.path);
    } catch (error) {
      if (
        error instanceof PackageSnapshotConflictError ||
        (error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR"))
      )
        throw snapshotConflict(member.path, error);
      throw error;
    }
  }
  for (const member of members) {
    try {
      const candidate = await resolvePackagePath(root, member.path, { requireExisting: true });
      if (
        (await realpath(candidate)) !== member.target ||
        !sameSnapshotFile(member.metadata, await stat(candidate, { bigint: true }))
      )
        throw snapshotConflict(member.path);
    } catch (error) {
      if (
        error instanceof PackageSnapshotConflictError ||
        (error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR"))
      )
        throw snapshotConflict(member.path, error);
      throw error;
    }
  }
}
