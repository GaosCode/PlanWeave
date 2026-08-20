import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  packageSnapshotDigestManifestSchema,
  packageSnapshotDigestSchema,
  packageSnapshotRelativePathSchema,
  packageSnapshotSizeSchema,
  packageSnapshotSourceRevisionSchema
} from "@planweave-ai/collaboration-protocol/content/snapshot";
import {
  PACKAGE_SNAPSHOT_MAX_FILE_BYTES,
  PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS,
  PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES
} from "@planweave-ai/collaboration-protocol/core/limits";
import { z } from "zod";

export const snapshotFileSchema = z
  .object({
    path: packageSnapshotRelativePathSchema,
    content: z.string(),
    digestSha256: packageSnapshotDigestSchema,
    sizeBytes: packageSnapshotSizeSchema
  })
  .strict()
  .superRefine((file, ctx) => {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > PACKAGE_SNAPSHOT_MAX_FILE_BYTES)
      ctx.addIssue({ code: "custom", message: "snapshot_file_too_large", path: ["sizeBytes"] });
    if (bytes !== file.sizeBytes)
      ctx.addIssue({ code: "custom", message: "snapshot_file_size_mismatch", path: ["sizeBytes"] });
    if (createHash("sha256").update(file.content, "utf8").digest("hex") !== file.digestSha256)
      ctx.addIssue({
        code: "custom",
        message: "snapshot_file_digest_mismatch",
        path: ["digestSha256"]
      });
  });

export const capturedSnapshotSchema = z
  .object({
    sourceRevision: packageSnapshotSourceRevisionSchema,
    digestManifest: packageSnapshotDigestManifestSchema,
    files: z.array(snapshotFileSchema).max(PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS + 1)
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const paths = snapshot.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({ code: "custom", message: "snapshot_duplicate_file_path", path: ["files"] });
    const total = snapshot.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES)
      ctx.addIssue({ code: "custom", message: "snapshot_total_bytes_exceeded", path: ["files"] });
    if (total !== snapshot.digestManifest.totalBytes)
      ctx.addIssue({
        code: "custom",
        message: "snapshot_total_bytes_mismatch",
        path: ["digestManifest", "totalBytes"]
      });
  });

export const maxBackingBytes = PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES + 64 * 1024 * 1024;

export class PackageSnapshotBackingIntegrityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PackageSnapshotBackingIntegrityError";
  }
}

export function assertCapturedSnapshotIntegrity(
  snapshot: z.infer<typeof capturedSnapshotSchema>
): void {
  const expected = new Map<string, { digestSha256: string; sizeBytes: number }>([
    ["manifest.json", snapshot.digestManifest.manifest],
    ...snapshot.digestManifest.prompts.map((prompt) => [prompt.path, prompt.digest] as const)
  ]);
  if (snapshot.files.length !== expected.size) {
    throw new PackageSnapshotBackingIntegrityError("snapshot_file_set_mismatch");
  }
  for (const file of snapshot.files) {
    const digest = expected.get(file.path);
    if (
      !digest ||
      file.digestSha256 !== digest.digestSha256 ||
      file.sizeBytes !== digest.sizeBytes
    ) {
      throw new PackageSnapshotBackingIntegrityError("snapshot_digest_manifest_mismatch");
    }
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function fingerprint(manifest: unknown): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

export function snapshotId(
  canvasRegistryId: string,
  sourceRevision: string,
  digestFingerprint: string
): string {
  return `snapshot-${createHash("sha256").update([canvasRegistryId, sourceRevision, digestFingerprint].join("\0")).digest("hex").slice(0, 32)}`;
}

export function backingPath(root: string, id: string): string {
  return join(root, "snapshots", id);
}
