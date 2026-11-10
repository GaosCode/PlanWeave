import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  packageFileAddressKey,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import type { ProjectWorkspace } from "../types.js";
import { readPackageSnapshot } from "../package/packageSnapshot.js";
import { sameSnapshotFile, snapshotConflict } from "../package/packageSnapshotRead.js";

export async function verifyStagedContentVersionPackage(
  workspace: ProjectWorkspace,
  content: CompleteContentVersion
): Promise<void> {
  const expected = new Map(
    content.members
      .filter((member) => member.kind !== "desktop_layout")
      .map((member) => [member.path, member])
  );
  const directories = new Map<string, BigIntStats>();
  const files = new Set<string>();
  async function visit(directory: string, prefix: string): Promise<void> {
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory()) throw new Error("content_version_staging_directory_invalid");
    directories.set(directory, metadata);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
      else if (entry.isFile()) files.add(path);
      else throw new Error(`content_version_staging_member_type:${path}`);
    }
  }
  await visit(workspace.packageDir, "");
  const expectedAddresses = new Set([...expected.keys()].map(packageFileAddressKey));
  const actualAddresses = new Set([...files].map(packageFileAddressKey));
  if (
    files.size !== expected.size ||
    actualAddresses.size !== files.size ||
    [...actualAddresses].some((key) => !expectedAddresses.has(key))
  ) {
    throw new Error("content_version_staging_file_set_mismatch");
  }
  const captured = await readPackageSnapshot(workspace);
  if (captured.snapshot.files.length !== expected.size) {
    throw new Error("content_version_staging_file_set_mismatch");
  }
  for (const file of captured.snapshot.files) {
    const member = expected.get(file.path);
    if (
      !member ||
      member.content !== file.content ||
      member.digestSha256 !== file.digestSha256 ||
      member.sizeBytes !== file.sizeBytes
    ) {
      throw new Error(`content_version_staging_member_mismatch:${file.path}`);
    }
  }
  for (const [directory, before] of directories) {
    if (!sameSnapshotFile(before, await lstat(directory, { bigint: true }))) {
      throw snapshotConflict(directory);
    }
  }
}
