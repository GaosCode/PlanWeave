import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function capture(
  cache: WorkspaceAuthoritativeSnapshotCache,
  revision: number,
  x = revision,
  authority: WorkspaceRemoteAuthorityKey = key
) {
  const value = content(x);
  cache.capture(authority, {
    scope: {
      bindingKind: "remote",
      authorityId: workspaceRemoteAuthorityId(authority),
      workspaceId: authority.workspaceId,
      projectId: authority.projectId,
      canvasId: authority.canvasId
    },
    revision,
    contentDigest: value.canonicalDigest,
    content: value
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  it("coalesces a 100-revision burst and rotates queued authorities before the hot key", async () => {
    const { cache, directory } = await cacheHarness();
    const gate = deferred();
    const put = cache.put.bind(cache);
    const writes: Array<[string, number]> = [];
    vi.spyOn(cache, "put").mockImplementation(async (input) => {
      writes.push([input.key.canvasId, input.contentRevision]);
      if (writes.length === 1) await gate.promise;
      return put(input);
    });
    capture(cache, 1);
    const other = { ...key, canvasId: "canvas-2" };
    for (let revision = 2; revision <= 100; revision++) capture(cache, revision);
    capture(cache, 1, 1, other);
    capture(cache, 50);
    const flushed = cache.flush();
    gate.resolve();
    await flushed;
    expect(writes).toEqual([
      [key.canvasId, 1],
      [other.canvasId, 1],
      [key.canvasId, 100]
    ]);
    const reopened = new WorkspaceAuthoritativeSnapshotCache(directory);
    expect(await reopened.get(key)).toMatchObject({
      contentRevision: 100,
      contentDigest: content(100).canonicalDigest,
      content: content(100),
      recovery: { mode: "offline_readonly", mutationsAllowed: false, executionAllowed: false }
    });
    expect((await reopened.get(other))?.contentRevision).toBe(1);
  });

  it.each([
    1, 2
  ])("surfaces conflicting inflight or pending revision %s even after a later success", async (revision) => {
    const { cache } = await cacheHarness();
    const gate = deferred();
    const put = cache.put.bind(cache);
    vi.spyOn(cache, "put").mockImplementationOnce(async (input) => {
      await gate.promise;
      return put(input);
    });
    capture(cache, 1);
    capture(cache, 2);
    expect(() => capture(cache, revision, 999)).toThrow(
      "workspace_snapshot_cache_revision_digest_conflict"
    );
    capture(cache, 3);
    const rejected = expect(cache.flush()).rejects.toThrow(
      "workspace_snapshot_cache_revision_digest_conflict"
    );
    gate.resolve();
    await rejected;
    expect((await cache.get(key))?.contentRevision).toBe(3);
    await expect(cache.flush()).rejects.toThrow(
      "workspace_snapshot_cache_revision_digest_conflict"
    );
  });

  it("finishes a flush target while later captures remain blocked", async () => {
    const { cache } = await cacheHarness();
    const first = deferred();
    const later = deferred();
    const laterStarted = deferred();
    const put = cache.put.bind(cache);
    vi.spyOn(cache, "put")
      .mockImplementationOnce(async (input) => {
        await first.promise;
        return put(input);
      })
      .mockImplementationOnce(async (input) => {
        laterStarted.resolve();
        await later.promise;
        return put(input);
      });
    capture(cache, 1);
    const barrier = cache.flush();
    capture(cache, 2);
    first.resolve();
    await laterStarted.promise;
    await barrier;
    expect((await cache.get(key))?.contentRevision).toBe(1);
    capture(cache, 3);
    const final = cache.flush();
    later.resolve();
    await final;
    expect((await cache.get(key))?.contentRevision).toBe(3);
  });

  it("keeps one authority's failure visible across another success and retries the failed key", async () => {
    const { cache } = await cacheHarness();
    const put = cache.put.bind(cache);
    vi.spyOn(cache, "put").mockRejectedValueOnce(new Error("write_failed")).mockImplementation(put);
    capture(cache, 1);
    const other = { ...key, canvasId: "canvas-2" };
    capture(cache, 1, 1, other);
    await expect(cache.flush()).rejects.toThrow("write_failed");
    expect((await cache.get(other))?.contentRevision).toBe(1);
    await expect(cache.flush()).rejects.toThrow("write_failed");
    capture(cache, 1);
    await cache.flush();
    expect((await cache.get(key))?.contentRevision).toBe(1);
  });

  it("retains a persisted revision conflict across newer captures", async () => {
    const { cache } = await cacheHarness();
    const persisted = content(1);
    await cache.put({
      key,
      contentRevision: 1,
      contentDigest: persisted.canonicalDigest,
      content: persisted
    });
    capture(cache, 1, 2);
    await expect(cache.flush()).rejects.toThrow(
      "workspace_snapshot_cache_revision_digest_conflict"
    );
    capture(cache, 2);
    await expect(cache.flush()).rejects.toThrow(
      "workspace_snapshot_cache_revision_digest_conflict"
    );
    expect((await cache.get(key))?.contentRevision).toBe(2);
  });
  it("waits for all flush targets before reporting an authority failure", async () => {
    const { cache } = await cacheHarness();
    const gate = deferred();
    const started = deferred();
    const put = cache.put.bind(cache);
    vi.spyOn(cache, "put")
      .mockRejectedValueOnce(new Error("write_failed"))
      .mockImplementationOnce(async (input) => {
        started.resolve();
        await gate.promise;
        return put(input);
      });
    capture(cache, 1);
    const other = { ...key, canvasId: "canvas-2" };
    capture(cache, 1, 1, other);
    let result: string | null = null;
    const barrier = cache.flush().then(
      () => {
        result = "success";
      },
      () => {
        result = "failure";
      }
    );
    await started.promise;
    await Promise.resolve();
    expect(result).toBeNull();
    gate.resolve();
    await barrier;
    expect(result).toBe("failure");
    expect((await cache.get(other))?.contentRevision).toBe(1);
  });
  it.each([
    ["connectionProfileId", "profile-2"],
    ["serverOrigin", "https://another.example.test"],
    ["workspaceId", "workspace-2"],
    ["projectId", "project-2"],
    ["canvasId", "canvas-2"]
  ] as const)("isolates the persisted %s authority dimension on reopen", async (field, value) => {
    const { cache, directory } = await cacheHarness();
    const other = { ...key, [field]: value };
    capture(cache, 8);
    capture(cache, 2, 2, other);
    await cache.flush();
    const reopened = new WorkspaceAuthoritativeSnapshotCache(directory);
    expect(await reopened.get(key)).toMatchObject({ key, contentRevision: 8, content: content(8) });
    expect(await reopened.get(other)).toMatchObject({
      key: other,
      contentRevision: 2,
      content: content(2)
    });
  });

  it("keeps the previous head intact after a real temporary-file write failure and retries", async () => {
    const { cache, directory } = await cacheHarness();
    capture(cache, 1);
    await cache.flush();
    const original = await readFile(cache.pathForKey(key), "utf8");
    const timestamp = vi.spyOn(Date, "now").mockReturnValue(12345);
    const blocked = `${cache.pathForKey(key)}.${process.pid}.12345.tmp`;
    await mkdir(blocked);
    try {
      capture(cache, 2);
      await expect(cache.flush()).rejects.toMatchObject({ code: "EISDIR" });
      capture(cache, 1, 1, { ...key, canvasId: "other-canvas" });
      await expect(cache.flush()).rejects.toMatchObject({ code: "EISDIR" });
      expect(await readFile(cache.pathForKey(key), "utf8")).toBe(original);
      expect(
        (await new WorkspaceAuthoritativeSnapshotCache(directory).get(key))?.contentRevision
      ).toBe(1);
      await rm(blocked, { recursive: true });
      capture(cache, 3);
      await cache.flush();
      expect(
        (await new WorkspaceAuthoritativeSnapshotCache(directory).get(key))?.contentRevision
      ).toBe(3);
    } finally {
      timestamp.mockRestore();
    }
  });

  it("reports a real rename failure and recovers without reading the abandoned temporary snapshot", async () => {
    const { cache, directory } = await cacheHarness();
    const get = cache.get.bind(cache);
    vi.spyOn(cache, "get").mockImplementationOnce(async (authority) => {
      const current = await get(authority);
      await mkdir(cache.pathForKey(authority));
      return current;
    });
    capture(cache, 1);
    await expect(cache.flush()).rejects.toBeInstanceOf(Error);
    const filenames = await readdir(directory);
    const temporary = filenames.find((filename) => filename.endsWith(".tmp"));
    expect(temporary).toBeDefined();
    const abandoned = workspaceAuthoritativeSnapshotCacheEntrySchema.parse(
      JSON.parse(await readFile(join(directory, temporary!), "utf8"))
    );
    expect(abandoned.contentRevision).toBe(1);
    await rm(cache.pathForKey(key), { recursive: true });
    expect(await new WorkspaceAuthoritativeSnapshotCache(directory).get(key)).toBeNull();
    capture(cache, 2);
    await cache.flush();
    expect(await new WorkspaceAuthoritativeSnapshotCache(directory).get(key)).toMatchObject({
      contentRevision: 2,
      content: content(2)
    });
  });

  it("serializes direct writes from two cache instances in the same process", async () => {
    const { cache, directory } = await cacheHarness();
    const second = new WorkspaceAuthoritativeSnapshotCache(directory);
    const newer = content(9);
    const older = content(3);
    await Promise.all([
      cache.put({ key, contentRevision: 9, contentDigest: newer.canonicalDigest, content: newer }),
      second.put({ key, contentRevision: 3, contentDigest: older.canonicalDigest, content: older })
    ]);
    expect(await new WorkspaceAuthoritativeSnapshotCache(directory).get(key)).toMatchObject({
      contentRevision: 9,
      content: newer
    });
  });
});
