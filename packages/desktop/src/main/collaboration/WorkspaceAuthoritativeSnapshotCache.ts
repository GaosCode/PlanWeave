import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeContentVersionSchema } from "@planweave-ai/collaboration-protocol/content/version";
import { decodeCanvasReplicaDocument } from "@planweave-ai/runtime";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import type { CanvasReplicaCommittedSnapshot } from "./CanvasReplicaStore.js";
import {
  type WorkspaceRemoteAuthorityKey,
  workspaceRemoteAuthorityId,
  workspaceRemoteAuthorityKeySchema
} from "./WorkspaceRemoteAuthorityIdentity.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const workspaceAuthoritativeSnapshotCacheEntrySchema = z
  .object({
    schemaVersion: z.literal("workspace-authoritative-snapshot-cache/v1"),
    key: workspaceRemoteAuthorityKeySchema,
    contentRevision: z.number().int().nonnegative(),
    contentDigest: digestSchema,
    contentIdentity: z
      .object({
        canonicalDigest: digestSchema,
        totalBytes: z.number().int().positive()
      })
      .strict(),
    recovery: z
      .object({
        mode: z.literal("offline_readonly"),
        mutationsAllowed: z.literal(false),
        executionAllowed: z.literal(false)
      })
      .strict(),
    cachedAt: z.string().datetime(),
    content: completeContentVersionSchema
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.contentDigest !== entry.content.canonicalDigest ||
      entry.contentIdentity.canonicalDigest !== entry.content.canonicalDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentDigest"],
        message: "workspace_snapshot_content_digest_mismatch"
      });
    }
    if (entry.contentIdentity.totalBytes !== entry.content.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["contentIdentity", "totalBytes"],
        message: "workspace_snapshot_content_size_mismatch"
      });
    }
  });
export type WorkspaceAuthoritativeSnapshotCacheEntry = z.infer<
  typeof workspaceAuthoritativeSnapshotCacheEntrySchema
>;

const writeLocks = new Map<string, Promise<void>>();

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sameKey(left: WorkspaceRemoteAuthorityKey, right: WorkspaceRemoteAuthorityKey): boolean {
  return (
    left.connectionProfileId === right.connectionProfileId &&
    left.serverOrigin === right.serverOrigin &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

async function withWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  writeLocks.set(path, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(path) === queued) writeLocks.delete(path);
  }
}

/**
 * Main-only durable recovery copy of a Server-confirmed Workspace snapshot.
 * Each exact remote authority has an isolated file; invalid files are quarantined and never read.
 */
export class WorkspaceAuthoritativeSnapshotCache {
  private tail: Promise<void> = Promise.resolve();
  private lastWriteError: unknown = null;

  constructor(
    private readonly directory: string = join(
      desktopHomePaths().collaborationDir,
      "workspace-authoritative-snapshots"
    ),
    private readonly now: () => Date = () => new Date()
  ) {}

  pathForKey(input: WorkspaceRemoteAuthorityKey): string {
    const key = workspaceRemoteAuthorityKeySchema.parse(input);
    const digest = createHash("sha256").update(JSON.stringify(key), "utf8").digest("hex");
    return join(this.directory, `${digest}.json`);
  }

  async get(
    input: WorkspaceRemoteAuthorityKey
  ): Promise<WorkspaceAuthoritativeSnapshotCacheEntry | null> {
    const key = workspaceRemoteAuthorityKeySchema.parse(input);
    const path = this.pathForKey(key);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const entry = workspaceAuthoritativeSnapshotCacheEntrySchema.parse(JSON.parse(text));
      if (!sameKey(entry.key, key)) throw new Error("workspace_snapshot_cache_identity_mismatch");
      decodeCanvasReplicaDocument(entry.content);
      return entry;
    } catch {
      await this.quarantine(path);
      return null;
    }
  }

  async put(input: {
    key: WorkspaceRemoteAuthorityKey;
    contentRevision: number;
    contentDigest: string;
    content: CanvasReplicaCommittedSnapshot["content"];
  }): Promise<WorkspaceAuthoritativeSnapshotCacheEntry> {
    const entry = workspaceAuthoritativeSnapshotCacheEntrySchema.parse({
      schemaVersion: "workspace-authoritative-snapshot-cache/v1",
      key: input.key,
      contentRevision: input.contentRevision,
      contentDigest: input.contentDigest,
      contentIdentity: {
        canonicalDigest: input.content.canonicalDigest,
        totalBytes: input.content.totalBytes
      },
      recovery: {
        mode: "offline_readonly",
        mutationsAllowed: false,
        executionAllowed: false
      },
      cachedAt: this.now().toISOString(),
      content: input.content
    });
    decodeCanvasReplicaDocument(entry.content);
    const path = this.pathForKey(entry.key);
    return withWriteLock(path, async () => {
      const current = await this.get(entry.key);
      if (current && current.contentRevision > entry.contentRevision) return current;
      if (current && current.contentRevision === entry.contentRevision) {
        if (current.contentDigest !== entry.contentDigest) {
          throw new Error("workspace_snapshot_cache_revision_digest_conflict");
        }
        return current;
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporaryPath, path);
      return entry;
    });
  }

  capture(key: WorkspaceRemoteAuthorityKey, snapshot: CanvasReplicaCommittedSnapshot): void {
    const parsedKey = workspaceRemoteAuthorityKeySchema.parse(key);
    if (
      snapshot.scope.bindingKind !== "remote" ||
      snapshot.scope.workspaceId !== parsedKey.workspaceId ||
      snapshot.scope.projectId !== parsedKey.projectId ||
      snapshot.scope.canvasId !== parsedKey.canvasId ||
      snapshot.scope.authorityId !== workspaceRemoteAuthorityId(parsedKey)
    ) {
      throw new Error("workspace_snapshot_cache_capture_scope_mismatch");
    }
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.put({
            key: parsedKey,
            contentRevision: snapshot.revision,
            contentDigest: snapshot.contentDigest,
            content: snapshot.content
          });
          this.lastWriteError = null;
        } catch (error) {
          this.lastWriteError = error;
        }
      });
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.lastWriteError) throw this.lastWriteError;
  }

  private async quarantine(path: string): Promise<void> {
    const quarantinePath = `${path}.invalid-${this.now().getTime()}`;
    try {
      await rename(path, quarantinePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
