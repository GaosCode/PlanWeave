import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeContentVersionSchema } from "@planweave-ai/collaboration-protocol/content/version";
import { decodeCanvasReplicaDocument, withAdvisoryDirectoryLock } from "@planweave-ai/runtime";
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

type CapturedWrite = {
  snapshot: CanvasReplicaCommittedSnapshot;
  sequence: number;
};

type CaptureState = {
  key: WorkspaceRemoteAuthorityKey;
  pending: CapturedWrite | null;
  inflight: CapturedWrite | null;
  failed: CapturedWrite | null;
  latest: { revision: number; contentDigest: string } | null;
  submitted: number;
  settled: number;
  error: unknown;
  conflict: Error | null;
  barriers: Array<{ target: number; resolve(): void; reject(error: unknown): void }>;
};

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

/**
 * Main-only durable recovery copy of a Server-confirmed Workspace snapshot.
 * Each exact remote authority has an isolated file; invalid files are quarantined and never read.
 */
export class WorkspaceAuthoritativeSnapshotCache {
  private readonly captures = new Map<string, CaptureState>();
  private readonly ready = new Set<string>();
  private draining = false;

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
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withAdvisoryDirectoryLock(
      {
        lockPath: `${path}.write.lock`,
        operation: "workspace-authoritative-snapshot-write"
      },
      async () => {
        const current = await this.get(entry.key);
        if (current && current.contentRevision > entry.contentRevision) return current;
        if (current && current.contentRevision === entry.contentRevision) {
          if (current.contentDigest !== entry.contentDigest) {
            throw new Error("workspace_snapshot_cache_revision_digest_conflict");
          }
          return current;
        }
        const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600
        });
        await rename(temporaryPath, path);
        return entry;
      }
    );
  }

  capture(key: WorkspaceRemoteAuthorityKey, snapshot: CanvasReplicaCommittedSnapshot): void {
    const parsedKey = workspaceRemoteAuthorityKeySchema.parse(key);
    if (
      snapshot.scope.workspaceId !== parsedKey.workspaceId ||
      snapshot.scope.projectId !== parsedKey.projectId ||
      snapshot.scope.canvasId !== parsedKey.canvasId ||
      snapshot.scope.authorityId !== workspaceRemoteAuthorityId(parsedKey)
    ) {
      throw new Error("workspace_snapshot_cache_capture_scope_mismatch");
    }
    z.number().int().nonnegative().parse(snapshot.revision);
    digestSchema.parse(snapshot.contentDigest);
    if (snapshot.contentDigest !== snapshot.content.canonicalDigest) {
      throw new Error("workspace_snapshot_content_digest_mismatch");
    }
    const id = this.pathForKey(parsedKey);
    let state = this.captures.get(id);
    if (!state) {
      state = {
        key: parsedKey,
        pending: null,
        inflight: null,
        failed: null,
        latest: null,
        submitted: 0,
        settled: 0,
        error: null,
        conflict: null,
        barriers: []
      };
      this.captures.set(id, state);
    }
    const comparable = [state.latest, state.pending?.snapshot, state.inflight?.snapshot];
    if (
      comparable.some(
        (value) =>
          value?.revision === snapshot.revision && value.contentDigest !== snapshot.contentDigest
      )
    ) {
      state.conflict = new Error("workspace_snapshot_cache_revision_digest_conflict");
      this.settleBarriers(state);
      throw state.conflict;
    }
    if (state.latest && snapshot.revision < state.latest.revision) return;
    state.latest = { revision: snapshot.revision, contentDigest: snapshot.contentDigest };
    state.pending = { snapshot, sequence: ++state.submitted };
    if (!state.inflight) this.ready.add(id);
    if (!this.draining) void this.drain();
  }

  async flush(): Promise<void> {
    const targets = [...this.captures.values()];
    // Retry only failures from earlier attempts; this barrier must report its own write failures.
    for (const state of targets) {
      if (state.failed && !state.pending && !state.inflight && !state.conflict) {
        state.pending = { snapshot: state.failed.snapshot, sequence: ++state.submitted };
        this.ready.add(this.pathForKey(state.key));
      }
    }
    try {
      const barriers = targets.map(
        (state) =>
          new Promise<void>((resolve, reject) => {
            state.barriers.push({ target: state.submitted, resolve, reject });
            this.settleBarriers(state);
          })
      );
      if (!this.draining) void this.drain();
      const results = await Promise.allSettled(barriers);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      for (const state of targets) {
        const id = this.pathForKey(state.key);
        if (
          this.captures.get(id) === state &&
          !state.pending &&
          !state.inflight &&
          !state.error &&
          !state.conflict &&
          state.barriers.length === 0
        ) {
          this.captures.delete(id);
        }
      }
    }
  }

  private settleBarriers(state: CaptureState): void {
    state.barriers = state.barriers.filter((barrier) => {
      if (state.settled < barrier.target) return true;
      if (state.conflict) {
        barrier.reject(state.conflict);
        return false;
      }
      if (state.error) barrier.reject(state.error);
      else barrier.resolve();
      return false;
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.ready.size > 0) {
        const id = this.ready.values().next().value;
        if (id === undefined) break;
        this.ready.delete(id);
        const state = this.captures.get(id);
        if (!state?.pending) continue;
        const write = state.pending;
        state.pending = null;
        state.inflight = write;
        try {
          await this.put({
            key: state.key,
            contentRevision: write.snapshot.revision,
            contentDigest: write.snapshot.contentDigest,
            content: write.snapshot.content
          });
          state.error = null;
          state.failed = null;
        } catch (error) {
          state.error = error;
          state.failed = write;
          if (
            error instanceof Error &&
            error.message === "workspace_snapshot_cache_revision_digest_conflict"
          ) {
            state.conflict = error;
          }
        }
        state.settled = write.sequence;
        state.inflight = null;
        this.settleBarriers(state);
        if (state.pending) this.ready.add(id);
      }
    } finally {
      this.draining = false;
    }
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
