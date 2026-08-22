import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCanvasReplicaDocument, parseCanvasReplicaDocument } from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  WorkspaceAuthoritativeSnapshotCache,
  type WorkspaceAuthoritativeSnapshotCacheEntry,
  workspaceAuthoritativeSnapshotCacheEntrySchema
} from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";
import {
  type WorkspaceRemoteAuthorityKey,
  workspaceRemoteAuthorityId,
  workspaceRemoteAuthorityKeyFromProfile
} from "../main/collaboration/WorkspaceRemoteAuthorityIdentity.js";

const directories: string[] = [];

async function cacheHarness() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-snapshot-cache-"));
  directories.push(directory);
  const cache = new WorkspaceAuthoritativeSnapshotCache(
    directory,
    () => new Date("2026-08-22T00:00:00.000Z")
  );
  return { cache, directory };
}

const key: WorkspaceRemoteAuthorityKey = {
  connectionProfileId: "profile-1",
  serverOrigin: "https://workspace.example.test",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};

function content(layoutX = 0) {
  const manifest = basicManifest();
  return encodeCanvasReplicaDocument(
    parseCanvasReplicaDocument({
      schemaVersion: "canvas-replica-document/v1",
      manifest,
      promptMarkdownByPath: Object.fromEntries(
        manifest.nodes.flatMap((task) => [
          [task.prompt, `# ${task.id}\n`],
          ...task.blocks.map((block) => [block.prompt, `# ${block.id}\n`])
        ])
      ),
      layout: {
        version: "desktop-layout/v1",
        projectId: key.projectId,
        nodes: [{ nodeId: "T-001", x: layoutX, y: 0 }],
        updatedAt: "2026-08-22T00:00:00.000Z"
      }
    })
  );
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("WorkspaceAuthoritativeSnapshotCache", () => {
  it("canonicalizes profile identity without depending on a local project path", () => {
    const locator = {
      kind: "workspace" as const,
      connectionProfileId: key.connectionProfileId,
      workspaceId: key.workspaceId,
      projectId: key.projectId,
      canvasId: key.canvasId
    };
    expect(
      workspaceRemoteAuthorityKeyFromProfile(locator, {
        profileId: key.connectionProfileId,
        serverBaseUrl: "https://workspace.example.test/api",
        projectId: key.projectId
      })
    ).toEqual(key);
    expect(workspaceRemoteAuthorityId(key)).toBe(
      "profile-1\u0000https://workspace.example.test\u0000project-1"
    );
  });

  it("builds, deletes, and rebuilds an exact remote authority cache", async () => {
    const { cache } = await cacheHarness();
    const first = content();
    await cache.put({
      key,
      contentRevision: 3,
      contentDigest: first.canonicalDigest,
      content: first
    });
    expect((await cache.get(key))?.contentRevision).toBe(3);

    await rm(cache.pathForKey(key));
    expect(await cache.get(key)).toBeNull();

    const rebuilt = content(10);
    await cache.put({
      key,
      contentRevision: 4,
      contentDigest: rebuilt.canonicalDigest,
      content: rebuilt
    });
    expect((await cache.get(key))?.contentDigest).toBe(rebuilt.canonicalDigest);
  });

  it.each([
    ["corrupt JSON", "{"],
    [
      "schema version drift",
      JSON.stringify({ schemaVersion: "workspace-authoritative-snapshot-cache/v2" })
    ]
  ])("quarantines %s instead of accepting it", async (_name, raw) => {
    const { cache, directory } = await cacheHarness();
    const first = content();
    await cache.put({
      key,
      contentRevision: 1,
      contentDigest: first.canonicalDigest,
      content: first
    });
    await writeFile(cache.pathForKey(key), raw, "utf8");
    expect(await cache.get(key)).toBeNull();
    await expect(readFile(cache.pathForKey(key), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(directory)).resolves.toEqual([expect.stringContaining(".invalid-")]);
  });

  it("quarantines a file whose embedded authority identity does not match its key", async () => {
    const { cache } = await cacheHarness();
    const snapshot = content();
    await cache.put({
      key,
      contentRevision: 1,
      contentDigest: snapshot.canonicalDigest,
      content: snapshot
    });
    const path = cache.pathForKey(key);
    const parsed = workspaceAuthoritativeSnapshotCacheEntrySchema.parse(
      JSON.parse(await readFile(path, "utf8"))
    );
    await writeFile(
      path,
      JSON.stringify({ ...parsed, key: { ...parsed.key, canvasId: "other-canvas" } }),
      "utf8"
    );

    expect(await cache.get(key)).toBeNull();
  });

  it.each<
    [
      string,
      (
        entry: WorkspaceAuthoritativeSnapshotCacheEntry
      ) => WorkspaceAuthoritativeSnapshotCacheEntry | Record<string, unknown>
    ]
  >([
    ["digest mismatch", (entry) => ({ ...entry, contentDigest: "f".repeat(64) })],
    ["invalid revision", (entry) => ({ ...entry, contentRevision: -1 })]
  ])("quarantines %s instead of exposing an inconsistent head", async (_name, mutate) => {
    const { cache } = await cacheHarness();
    const snapshot = content();
    await cache.put({
      key,
      contentRevision: 2,
      contentDigest: snapshot.canonicalDigest,
      content: snapshot
    });
    const path = cache.pathForKey(key);
    const parsed = workspaceAuthoritativeSnapshotCacheEntrySchema.parse(
      JSON.parse(await readFile(path, "utf8"))
    );
    await writeFile(path, JSON.stringify(mutate(parsed)), "utf8");

    expect(await cache.get(key)).toBeNull();
  });

  it("does not let an old or conflicting revision overwrite the newest confirmed snapshot", async () => {
    const { cache } = await cacheHarness();
    const older = content();
    const newer = content(20);
    await cache.put({
      key,
      contentRevision: 7,
      contentDigest: newer.canonicalDigest,
      content: newer
    });
    await cache.put({
      key,
      contentRevision: 6,
      contentDigest: older.canonicalDigest,
      content: older
    });
    expect((await cache.get(key))?.contentRevision).toBe(7);
    await expect(
      cache.put({
        key,
        contentRevision: 7,
        contentDigest: older.canonicalDigest,
        content: older
      })
    ).rejects.toThrow("workspace_snapshot_cache_revision_digest_conflict");
  });

  it("advances only from confirmed remote replica snapshots", async () => {
    const { cache } = await cacheHarness();
    const first = content();
    const second = content(30);
    const scope = {
      bindingKind: "remote" as const,
      authorityId: workspaceRemoteAuthorityId(key),
      workspaceId: key.workspaceId,
      projectId: key.projectId,
      canvasId: key.canvasId
    };
    cache.capture(key, {
      scope,
      revision: 8,
      contentDigest: first.canonicalDigest,
      content: first
    });
    cache.capture(key, {
      scope,
      revision: 9,
      contentDigest: second.canonicalDigest,
      content: second
    });
    await cache.flush();
    expect(await cache.get(key)).toMatchObject({
      contentRevision: 9,
      contentDigest: second.canonicalDigest,
      recovery: {
        mode: "offline_readonly",
        mutationsAllowed: false,
        executionAllowed: false
      }
    });
  });
});
