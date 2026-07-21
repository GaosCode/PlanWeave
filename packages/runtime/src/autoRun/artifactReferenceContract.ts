import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  artifactReferenceSchema,
  artifactRelativePathSchema,
  type ArtifactReference
} from "./runnerContractSchemas.js";

export const RUNNER_ARTIFACT_MAX_CONTENT_BYTES = 768 * 1_024;

export class ArtifactReferenceVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactReferenceVerificationError";
  }
}

export type ArtifactMaterializationHooks = {
  beforeCommit?: () => Promise<void> | void;
};

function mediaTypeForKind(kind: ArtifactReference["kind"]): ArtifactReference["mediaType"] {
  return kind === "review" ? "application/json" : "text/markdown";
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeFileName(relativePath: string): string {
  return artifactRelativePathSchema.parse(relativePath);
}

/**
 * Prefer O_NOFOLLOW when available. On Windows (and other platforms without the flag),
 * callers must use lstat + open + fstat identity checks instead of hard-failing.
 */
function withNoFollowFlag(baseFlags: number): number {
  return typeof constants.O_NOFOLLOW === "number" ? baseFlags | constants.O_NOFOLLOW : baseFlags;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Open a path for read without following symlinks.
 * Unix: O_NOFOLLOW. Windows: lstat rejects links, then open + fstat re-checks identity.
 */
async function openWithoutFollowingSymlinks(
  path: string,
  baseFlags: number,
  mode?: number
): Promise<FileHandle> {
  const flags = withNoFollowFlag(baseFlags);
  if (typeof constants.O_NOFOLLOW === "number") {
    return mode === undefined ? open(path, flags) : open(path, flags, mode);
  }

  // Create-exclusive: path must not exist; O_EXCL already rejects existing names (including links).
  const creatingExclusive =
    (baseFlags & constants.O_CREAT) !== 0 && (baseFlags & constants.O_EXCL) !== 0;
  if (creatingExclusive) {
    return mode === undefined ? open(path, flags) : open(path, flags, mode);
  }

  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    throw new ArtifactReferenceVerificationError(
      "Referenced artifact could not be safely opened without following symbolic links."
    );
  }
  if ((baseFlags & constants.O_RDONLY) === constants.O_RDONLY && !entry.isFile()) {
    throw new ArtifactReferenceVerificationError(
      "Referenced artifact could not be safely opened without following symbolic links."
    );
  }
  const handle = mode === undefined ? await open(path, flags) : await open(path, flags, mode);
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile() || descriptor.dev !== entry.dev || descriptor.ino !== entry.ino) {
      throw new ArtifactReferenceVerificationError(
        "Artifact path identity changed while its descriptor was held."
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function removeTemporaryPath(path: string, root: string): Promise<void> {
  if ((await realpath(dirname(path))) !== root) {
    throw new ArtifactReferenceVerificationError(
      "Temporary artifact cleanup refused because the trusted root identity changed."
    );
  }
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

async function readDescriptor(handle: FileHandle, size: number): Promise<Buffer> {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(content, offset, size - offset, offset);
    if (bytesRead === 0) {
      throw new ArtifactReferenceVerificationError(
        "Artifact bytes ended before the descriptor-reported size."
      );
    }
    offset += bytesRead;
  }
  return content;
}

async function openArtifactForRead(path: string): Promise<FileHandle> {
  try {
    return await openWithoutFollowingSymlinks(path, constants.O_RDONLY);
  } catch (error) {
    if (error instanceof ArtifactReferenceVerificationError) {
      throw error;
    }
    throw new ArtifactReferenceVerificationError(
      "Referenced artifact could not be safely opened without following symbolic links."
    );
  }
}

async function assertDescriptorIdentity(options: {
  root: string;
  path: string;
  handle: FileHandle;
}): Promise<{ size: number; bytes: Buffer }> {
  const resolved = await realpath(options.path);
  const fromRoot = relative(options.root, resolved);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new ArtifactReferenceVerificationError(
      "Artifact path resolves outside its materialization root."
    );
  }
  const [descriptor, pathEntry] = await Promise.all([options.handle.stat(), lstat(options.path)]);
  if (
    !descriptor.isFile() ||
    !pathEntry.isFile() ||
    descriptor.dev !== pathEntry.dev ||
    descriptor.ino !== pathEntry.ino
  ) {
    throw new ArtifactReferenceVerificationError(
      "Artifact path identity changed while its descriptor was held."
    );
  }
  if (descriptor.size > RUNNER_ARTIFACT_MAX_CONTENT_BYTES) {
    throw new ArtifactReferenceVerificationError(
      `Materialized artifact exceeds ${RUNNER_ARTIFACT_MAX_CONTENT_BYTES} bytes.`
    );
  }
  return { size: descriptor.size, bytes: await readDescriptor(options.handle, descriptor.size) };
}

function referenceFromBytes(options: {
  relativePath: string;
  kind: ArtifactReference["kind"];
  bytes: Buffer;
}): ArtifactReference {
  return artifactReferenceSchema.parse({
    version: "planweave.runner/v1",
    kind: options.kind,
    relativePath: options.relativePath,
    sha256: digest(options.bytes),
    sizeBytes: options.bytes.byteLength,
    mediaType: mediaTypeForKind(options.kind)
  });
}

export async function materializeArtifactBytes(
  options: {
    rootDir: string;
    relativePath: string;
    kind: ArtifactReference["kind"];
    content: string | Buffer;
  },
  hooks: ArtifactMaterializationHooks = {}
): Promise<ArtifactReference> {
  const relativePath = safeFileName(options.relativePath);
  const bytes = Buffer.isBuffer(options.content) ? options.content : Buffer.from(options.content);
  if (bytes.byteLength > RUNNER_ARTIFACT_MAX_CONTENT_BYTES) {
    throw new ArtifactReferenceVerificationError(
      `Materialized artifact exceeds ${RUNNER_ARTIFACT_MAX_CONTENT_BYTES} bytes.`
    );
  }
  const root = await realpath(options.rootDir);
  const targetPath = resolve(root, relativePath);
  const temporaryPath = resolve(root, `.planweave-artifact-${randomUUID()}.tmp`);
  const handle = await openWithoutFollowingSymlinks(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600
  );
  let committed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const temporary = await assertDescriptorIdentity({ root, path: temporaryPath, handle });
    if (temporary.size !== bytes.byteLength || !temporary.bytes.equals(bytes)) {
      throw new ArtifactReferenceVerificationError(
        "Artifact descriptor bytes differ from the requested materialization."
      );
    }
    await hooks.beforeCommit?.();
    if ((await realpath(options.rootDir)) !== root) {
      throw new ArtifactReferenceVerificationError(
        "Artifact materialization root identity changed before commit."
      );
    }
    await rename(temporaryPath, targetPath);
    committed = true;
    const published = await assertDescriptorIdentity({ root, path: targetPath, handle });
    if (!published.bytes.equals(bytes)) {
      throw new ArtifactReferenceVerificationError(
        "Committed artifact bytes differ from the held materialization descriptor."
      );
    }
    return referenceFromBytes({ relativePath, kind: options.kind, bytes: published.bytes });
  } finally {
    await handle.close();
    if (!committed) {
      await removeTemporaryPath(temporaryPath, root);
    }
  }
}

export async function readVerifiedArtifactReference(options: {
  rootDir: string;
  value: unknown;
}): Promise<{ reference: ArtifactReference; bytes: Buffer }> {
  const parsed = artifactReferenceSchema.safeParse(options.value);
  if (!parsed.success) {
    throw new ArtifactReferenceVerificationError("Persisted runner artifact reference is corrupt.");
  }
  const reference = parsed.data;
  if (reference.mediaType !== mediaTypeForKind(reference.kind)) {
    throw new ArtifactReferenceVerificationError(
      "Referenced artifact media type does not match its artifact kind."
    );
  }
  const root = await realpath(options.rootDir);
  const path = resolve(root, safeFileName(reference.relativePath));
  const handle = await openArtifactForRead(path);
  try {
    const artifact = await assertDescriptorIdentity({ root, path, handle });
    if (artifact.size !== reference.sizeBytes) {
      throw new ArtifactReferenceVerificationError(
        "Referenced artifact size does not match its verified materialization."
      );
    }
    if (digest(artifact.bytes) !== reference.sha256) {
      throw new ArtifactReferenceVerificationError(
        "Referenced artifact digest does not match its verified materialization."
      );
    }
    return { reference, bytes: artifact.bytes };
  } finally {
    await handle.close();
  }
}

export async function createArtifactReference(options: {
  rootDir: string;
  relativePath: string;
  kind: ArtifactReference["kind"];
}): Promise<ArtifactReference> {
  const placeholder = artifactReferenceSchema.parse({
    version: "planweave.runner/v1",
    kind: options.kind,
    relativePath: options.relativePath,
    sha256: "0".repeat(64),
    sizeBytes: 0,
    mediaType: mediaTypeForKind(options.kind)
  });
  const root = await realpath(options.rootDir);
  const path = resolve(root, safeFileName(options.relativePath));
  const handle = await openArtifactForRead(path);
  try {
    const artifact = await assertDescriptorIdentity({ root, path, handle });
    return referenceFromBytes({
      relativePath: placeholder.relativePath,
      kind: placeholder.kind,
      bytes: artifact.bytes
    });
  } finally {
    await handle.close();
  }
}

export async function verifyArtifactReference(options: {
  rootDir: string;
  reference: ArtifactReference;
}): Promise<ArtifactReference> {
  return (
    await readVerifiedArtifactReference({ rootDir: options.rootDir, value: options.reference })
  ).reference;
}

export async function verifyPersistedArtifactReference(options: {
  rootDir: string;
  value: unknown;
}): Promise<ArtifactReference> {
  return (await readVerifiedArtifactReference(options)).reference;
}
