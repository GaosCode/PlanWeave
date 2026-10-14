import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { chmod, link, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  commentAttachmentMediaTypeSchema,
  commentContentSha256Schema,
  type CommentAttachmentMediaType
} from "../comments/schemas.js";
import type { SqliteDatabase } from "../sqlite.js";
import { COMMENT_ATTACHMENT_MAX_BYTES } from "../comments/limits.js";
import { CommentAttachmentRepository } from "./repository.js";
import { withAttachmentCleanup, withAttachmentCleanupFailure } from "./errors.js";

const relativePathSchema = z.string().regex(/^[a-f0-9]{2}\/[a-f0-9]{64}$/);

const blobRowSchema = z
  .object({
    digest_sha256: commentContentSha256Schema,
    size_bytes: z.number().int().positive().max(COMMENT_ATTACHMENT_MAX_BYTES),
    media_type: commentAttachmentMediaTypeSchema,
    relative_path: relativePathSchema,
    created_at: z.string().datetime()
  })
  .strict();

export type CommentAttachmentBlobMetadata = {
  digestSha256: string;
  sizeBytes: number;
  mediaType: CommentAttachmentMediaType;
  createdAt: string;
};

/**
 * Content-addressed blob store for human comment attachments.
 * Reuses the ArtifactStore algorithm (stream hash, hardlink publish, path sharding)
 * but uses a separate table and filesystem root so dispatch grants never authorize
 * these bytes and attachment policy never touches artifact_grants.
 */
export class CommentAttachmentBlobStore {
  private readonly blobsDirectory: string;
  private readonly temporaryDirectory: string;
  private readonly rootDirectory: string;

  constructor(
    private readonly database: SqliteDatabase,
    dataDirectory: string,
    readonly maxBytes: number = COMMENT_ATTACHMENT_MAX_BYTES
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("maxBytes must be a positive safe integer.");
    }
    this.rootDirectory = join(dataDirectory, "comment-attachments");
    this.blobsDirectory = join(this.rootDirectory, "sha256");
    this.temporaryDirectory = join(this.rootDirectory, "tmp");
  }

  async stage(input: {
    expectedSha256: string;
    expectedSizeBytes: number;
    mediaType: CommentAttachmentMediaType;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<{
    publish: () => Promise<CommentAttachmentBlobMetadata>;
    dispose: () => Promise<void>;
  }> {
    const expectedSha256 = commentContentSha256Schema.parse(input.expectedSha256);
    const mediaType = commentAttachmentMediaTypeSchema.parse(input.mediaType);
    if (
      !Number.isSafeInteger(input.expectedSizeBytes) ||
      input.expectedSizeBytes < 1 ||
      input.expectedSizeBytes > this.maxBytes
    ) {
      throw new Error("attachment_size_limit");
    }

    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.temporaryDirectory, 0o700);
    const temporaryPath = join(this.temporaryDirectory, randomUUID());
    // Refuse to follow a pre-existing symlink at the temp path.
    await assertPathInsideRoot(this.temporaryDirectory, temporaryPath);

    const handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      await withAttachmentCleanup(
        async () => {
          for await (const chunk of input.chunks) {
            sizeBytes += chunk.byteLength;
            if (sizeBytes > input.expectedSizeBytes || sizeBytes > this.maxBytes) {
              throw new Error("attachment_size_mismatch");
            }
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
              if (bytesWritten < 1) throw new Error("attachment_write_stalled");
              offset += bytesWritten;
            }
          }
          await handle.sync();
        },
        () => handle.close()
      );

      if (sizeBytes !== input.expectedSizeBytes) throw new Error("attachment_size_mismatch");
      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== expectedSha256) throw new Error("attachment_digest_mismatch");

      return {
        publish: () => this.publishStaged(temporaryPath, expectedSha256, sizeBytes, mediaType),
        dispose: () => this.removeStagingFile(temporaryPath)
      };
    } catch (error) {
      try {
        await this.removeStagingFile(temporaryPath);
      } catch (cleanupError) {
        throw withAttachmentCleanupFailure(error, cleanupError);
      }
      throw error;
    }
  }

  /** Standalone content publication; application references are coordinated by the service. */
  async put(
    input: Parameters<CommentAttachmentBlobStore["stage"]>[0]
  ): Promise<CommentAttachmentBlobMetadata> {
    const staged = await this.stage(input);
    return withAttachmentCleanup(
      () => staged.publish(),
      () => staged.dispose()
    );
  }

  private async publishStaged(
    temporaryPath: string,
    expectedSha256: string,
    sizeBytes: number,
    mediaType: CommentAttachmentMediaType
  ): Promise<CommentAttachmentBlobMetadata> {
    const relativePath = relativePathSchema.parse(
      `${expectedSha256.slice(0, 2)}/${expectedSha256}`
    );
    const finalDirectory = join(this.blobsDirectory, expectedSha256.slice(0, 2));
    const finalPath = join(finalDirectory, expectedSha256);
    await mkdir(finalDirectory, { recursive: true, mode: 0o700 });
    await chmod(finalDirectory, 0o700);
    await assertPathInsideRoot(this.blobsDirectory, finalPath);

    try {
      await link(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await readFile(finalPath);
      if (
        existing.length !== sizeBytes ||
        createHash("sha256").update(existing).digest("hex") !== expectedSha256
      ) {
        throw new Error("attachment_blob_conflict");
      }
    }

    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO comment_attachment_blobs(
          digest_sha256,size_bytes,media_type,relative_path,created_at
        ) VALUES (?,?,?,?,?)
        ON CONFLICT(digest_sha256) DO NOTHING`
      )
      .run(expectedSha256, sizeBytes, mediaType, relativePath, createdAt);
    return this.getRequired(expectedSha256);
  }

  private async removeStagingFile(temporaryPath: string): Promise<void> {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }

  get(digestSha256: string): CommentAttachmentBlobMetadata | undefined {
    const digest = commentContentSha256Schema.parse(digestSha256);
    const raw = this.database
      .prepare("SELECT * FROM comment_attachment_blobs WHERE digest_sha256=?")
      .get(digest);
    if (!raw) return undefined;
    const row = blobRowSchema.parse(raw);
    return {
      digestSha256: row.digest_sha256,
      sizeBytes: row.size_bytes,
      mediaType: row.media_type,
      createdAt: row.created_at
    };
  }

  getRequired(digestSha256: string): CommentAttachmentBlobMetadata {
    const blob = this.get(digestSha256);
    if (!blob) throw new Error("attachment_not_found");
    return blob;
  }

  async read(digestSha256: string): Promise<Buffer> {
    const metadata = this.getRequired(digestSha256);
    const path = await this.resolveBlobPath(metadata.digestSha256);
    const bytes = await readFile(path);
    if (bytes.byteLength !== metadata.sizeBytes) throw new Error("attachment_blob_size_mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== metadata.digestSha256) throw new Error("attachment_blob_digest_mismatch");
    return bytes;
  }

  async openRead(
    digestSha256: string
  ): Promise<{ metadata: CommentAttachmentBlobMetadata; stream: ReadStream }> {
    const metadata = this.getRequired(digestSha256);
    const path = await this.resolveBlobPath(metadata.digestSha256);
    if ((await stat(path)).size !== metadata.sizeBytes) {
      throw new Error("attachment_blob_size_mismatch");
    }
    return { metadata, stream: createReadStream(path) };
  }

  /**
   * The repository owns reference eligibility, including durable audit bindings across scopes.
   * Callers must hold the root/digest claim through revocation, recheck and file/row deletion.
   */
  async deleteIfUnreferenced(digestSha256: string, nowIso: string): Promise<boolean> {
    const digest = commentContentSha256Schema.parse(digestSha256);
    if (!new CommentAttachmentRepository(this.database).canDeleteBlob(digest, nowIso)) return false;

    const path = await this.resolveBlobPath(digest);
    await unlink(path).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    const result = this.database
      .prepare("DELETE FROM comment_attachment_blobs WHERE digest_sha256=?")
      .run(digest);
    return result.changes > 0;
  }

  private async resolveBlobPath(digestSha256: string): Promise<string> {
    const relativePath = relativePathSchema.parse(`${digestSha256.slice(0, 2)}/${digestSha256}`);
    const candidate = join(this.blobsDirectory, relativePath);
    await assertPathInsideRoot(this.blobsDirectory, candidate);
    return candidate;
  }
}

function isRelativeInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  // relative() returns "" when equal; paths outside start with ".." or are absolute.
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertPathInsideRoot(root: string, candidate: string): Promise<void> {
  const logicalRoot = resolve(root);
  const logicalCandidate = resolve(candidate);
  // Prefer realpath comparison so macOS /var → /private/var does not false-positive.
  // Fall back to logical containment only when a path does not exist yet (staging create).
  try {
    const realRoot = await realpath(logicalRoot);
    try {
      const realCandidate = await realpath(logicalCandidate);
      if (!isRelativeInside(realRoot, realCandidate)) {
        throw new Error("attachment_path_escape");
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "attachment_path_escape") throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // Candidate not created yet: require logical containment under the logical root,
      // then ensure that logical root realpath is stable.
      if (!isRelativeInside(logicalRoot, logicalCandidate)) {
        throw new Error("attachment_path_escape");
      }
      return;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "attachment_path_escape") throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (!isRelativeInside(logicalRoot, logicalCandidate)) {
      throw new Error("attachment_path_escape");
    }
  }
}
