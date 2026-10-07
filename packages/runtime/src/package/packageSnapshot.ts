import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  PACKAGE_SNAPSHOT_MAX_FILE_BYTES,
  PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS,
  PACKAGE_SNAPSHOT_MAX_SOURCE_REVISION_LENGTH,
  PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  packageSnapshotDigestManifestSchema,
  type PackageSnapshotDigestManifest
} from "@planweave-ai/collaboration-protocol/content/snapshot";
import type { PackageWorkspaceRef } from "../types.js";
import { loadPackage, resolvePackageWorkspace } from "./loadPackage.js";
import { resolvePackagePath } from "./resolvePackagePath.js";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { ImportTransaction } from "./importTransaction.js";
import { manifestSchema } from "../schema/manifest.js";
import { packageFingerprintFromContent } from "../plangraph/hash.js";
import { withPackageFileConsistency } from "./packageFileConsistency.js";
import {
  readSnapshotMember,
  sameSnapshotFile,
  snapshotConflict,
  verifySnapshotMembers
} from "./packageSnapshotRead.js";

const sourceRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(PACKAGE_SNAPSHOT_MAX_SOURCE_REVISION_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export type PackageSnapshotFile = {
  path: string;
  content: string;
  digestSha256: string;
  sizeBytes: number;
};

export type CapturedPackageSnapshot = {
  sourceRevision: string;
  digestManifest: PackageSnapshotDigestManifest;
  files: PackageSnapshotFile[];
};

export type CapturePackageSnapshotResult = {
  snapshot: CapturedPackageSnapshot;
  resolvedPackageDir: string;
};

export function packageSnapshotSourceRevision(
  digestManifestInput: PackageSnapshotDigestManifest
): string {
  const digestManifest = packageSnapshotDigestManifestSchema.parse(digestManifestInput);
  return sourceRevisionSchema.parse(
    `snapshot:${createHash("sha256").update(JSON.stringify(digestManifest)).digest("hex")}`
  );
}

/** Graph identity is derived from the captured closure, never from a later disk read. */
export function packageSnapshotGraphFingerprint(snapshot: CapturedPackageSnapshot): string {
  const manifestFile = snapshot.files.find((file) => file.path === "manifest.json");
  if (!manifestFile) throw new Error("package_snapshot_manifest_missing");
  const manifest = manifestSchema.parse(JSON.parse(manifestFile.content));
  return packageFingerprintFromContent(
    manifest,
    new Map(
      snapshot.files
        .filter((file) => file.path !== "manifest.json")
        .map((file) => [file.path, file.content])
    )
  );
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedUtf8(bytes: Uint8Array, path: string): string {
  if (bytes.byteLength > PACKAGE_SNAPSHOT_MAX_FILE_BYTES) {
    throw new Error(`package_snapshot_file_too_large:${path}`);
  }
  const content = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("package_snapshot_invalid_utf8");
  return content;
}

function referencedPromptPaths(
  manifest: Awaited<ReturnType<typeof loadPackage>>["manifest"]
): string[] {
  const paths = new Set<string>();
  for (const node of manifest.nodes) {
    paths.add(node.prompt);
    for (const block of node.blocks) paths.add(block.prompt);
  }
  if (paths.size > PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS) {
    throw new Error("package_snapshot_prompt_count_exceeded");
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export async function capturePackageSnapshot(input: {
  projectRoot: PackageWorkspaceRef;
  canvasId?: string | null;
}): Promise<CapturePackageSnapshotResult> {
  const projectRoot = input.canvasId
    ? await resolveTaskCanvasWorkspace(String(input.projectRoot), input.canvasId)
    : input.projectRoot;
  const workspace = await resolvePackageWorkspace(projectRoot);
  return withPackageFileConsistency([workspace.packageDir], async () => {
    const rootBefore = await stat(workspace.packageDir, { bigint: true });
    const manifestRead = await readSnapshotMember(
      workspace.packageDir,
      "manifest.json",
      PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES
    );
    const manifest = manifestSchema.parse(
      JSON.parse(boundedUtf8(manifestRead.bytes, "manifest.json"))
    );
    const paths = ["manifest.json", ...referencedPromptPaths(manifest)];
    const files: PackageSnapshotFile[] = [];
    const members = [];
    let totalBytes = 0;
    for (const path of paths) {
      const member =
        path === "manifest.json"
          ? manifestRead
          : await readSnapshotMember(
              workspace.packageDir,
              path,
              PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES - totalBytes
            );
      members.push(member);
      const bytes = member.bytes;
      totalBytes += bytes.byteLength;
      if (totalBytes > PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES) {
        throw new Error("package_snapshot_total_bytes_exceeded");
      }
      const content = boundedUtf8(bytes, path);
      files.push({ path, content, digestSha256: digest(bytes), sizeBytes: bytes.byteLength });
    }
    await verifySnapshotMembers(workspace.packageDir, members);
    if (!sameSnapshotFile(rootBefore, await stat(workspace.packageDir, { bigint: true })))
      throw snapshotConflict("directory");
    const manifestFile = files[0];
    if (!manifestFile) throw new Error("package_snapshot_manifest_missing");
    const prompts = files.slice(1).map((file) => ({
      path: file.path,
      digest: { digestSha256: file.digestSha256, sizeBytes: file.sizeBytes }
    }));
    const digestManifest = packageSnapshotDigestManifestSchema.parse({
      manifest: {
        digestSha256: manifestFile.digestSha256,
        sizeBytes: manifestFile.sizeBytes
      },
      prompts,
      totalBytes
    });
    const sourceRevision = packageSnapshotSourceRevision(digestManifest);
    return {
      snapshot: { sourceRevision, digestManifest, files },
      resolvedPackageDir: workspace.packageDir
    };
  });
}

export async function restorePackageSnapshot(input: {
  projectRoot: PackageWorkspaceRef;
  canvasId?: string | null;
  expectedPackageDir?: string;
  snapshot: CapturedPackageSnapshot;
  beforeCommit?: () => Promise<void> | void;
}): Promise<void> {
  const snapshot = input.snapshot;
  sourceRevisionSchema.parse(snapshot.sourceRevision);
  packageSnapshotDigestManifestSchema.parse(snapshot.digestManifest);
  const projectRoot = input.canvasId
    ? await resolveTaskCanvasWorkspace(String(input.projectRoot), input.canvasId)
    : input.projectRoot;
  const workspace = await resolvePackageWorkspace(projectRoot);
  if (input.expectedPackageDir !== undefined && workspace.packageDir !== input.expectedPackageDir)
    throw new Error("runtime_package_location_mismatch");
  const expected = new Map<string, { digestSha256: string; sizeBytes: number }>([
    ["manifest.json", snapshot.digestManifest.manifest],
    ...snapshot.digestManifest.prompts.map((prompt) => [prompt.path, prompt.digest] as const)
  ]);
  if (snapshot.files.length !== expected.size)
    throw new Error("package_snapshot_file_set_mismatch");
  for (const file of snapshot.files) {
    const metadata = expected.get(file.path);
    if (
      !metadata ||
      file.sizeBytes !== metadata.sizeBytes ||
      file.digestSha256 !== metadata.digestSha256
    ) {
      throw new Error(`package_snapshot_digest_mismatch:${file.path}`);
    }
    const bytes = Buffer.from(file.content, "utf8");
    if (bytes.byteLength !== metadata.sizeBytes || digest(bytes) !== metadata.digestSha256) {
      throw new Error(`package_snapshot_digest_mismatch:${file.path}`);
    }
  }
  await withPackageFileConsistency([workspace.packageDir], async () => {
    await mkdir(dirname(workspace.packageDir), { recursive: true });
    const staging = await mkdtemp(join(dirname(workspace.packageDir), ".planweave-snapshot-"));
    const transaction = await ImportTransaction.create({ workspaceRoot: workspace.workspaceRoot });
    try {
      await cp(workspace.packageDir, staging, { recursive: true, force: true });
      for (const file of snapshot.files) {
        const target = await resolvePackagePath(staging, file.path, { forWrite: true });
        const bytes = Buffer.from(file.content, "utf8");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const stagedWorkspace = {
        ...workspace,
        packageDir: staging,
        manifestFile: join(staging, "manifest.json")
      };
      await loadPackage(stagedWorkspace);
      await input.beforeCommit?.();
      await transaction.replacePath(workspace.packageDir, staging);
      await transaction.commit();
    } catch (error) {
      let rollbackError: unknown;
      try {
        await transaction.rollback();
      } catch (failure) {
        rollbackError = failure;
      }
      let cleanupError: unknown;
      try {
        await rm(staging, { recursive: true, force: true });
      } catch (failure) {
        cleanupError = failure;
      }
      if (rollbackError || cleanupError) {
        throw new AggregateError(
          [
            error,
            ...(rollbackError ? [rollbackError] : []),
            ...(cleanupError ? [cleanupError] : [])
          ],
          "package_snapshot_restore_failed"
        );
      }
      throw error;
    }
  });
}
