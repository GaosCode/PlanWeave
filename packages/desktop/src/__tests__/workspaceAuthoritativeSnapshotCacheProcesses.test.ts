import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCanvasReplicaDocument, parseCanvasReplicaDocument } from "@planweave-ai/runtime";
import { z } from "zod";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { WorkspaceAuthoritativeSnapshotCache } from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";

const writer = fileURLToPath(new URL("./support/workspaceSnapshotCacheWriter.ts", import.meta.url));
const directories: string[] = [];
const children: ChildProcess[] = [];
const key = {
  connectionProfileId: "profile-1",
  serverOrigin: "https://workspace.example.test",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};
const writerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started") }),
  z.object({ type: z.literal("read") }),
  z.object({
    type: z.literal("result"),
    status: z.enum(["written", "failed"]),
    message: z.string().optional()
  })
]);

function runWriter(directory: string, entryPath: string, hold = false) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", writer, directory, entryPath, hold ? "hold" : "write"],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  children.push(child);
  const messages: z.infer<typeof writerMessage>[] = [];
  const waiters: Array<() => void> = [];
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  child.on("message", (message) => {
    messages.push(writerMessage.parse(message));
    for (const notify of waiters.splice(0)) notify();
  });
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, error }));
    child.on("exit", (code) => {
      resolve({ code });
      for (const notify of waiters.splice(0)) notify();
    });
  });
  async function exited(): Promise<void> {
    const result = await completion;
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`snapshot writer exit ${result.code}: ${stderr}`);
  }
  async function message(type: z.infer<typeof writerMessage>["type"]) {
    while (!messages.some((item) => item.type === type)) {
      if (child.exitCode !== null)
        throw new Error(`snapshot writer exited before ${type}: ${stderr}`);
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return messages.find((item) => item.type === type)!;
  }
  return { child, exited, message };
}

async function entryFile(directory: string, revision: number, layoutX: number, authority = key) {
  const manifest = basicManifest();
  const content = encodeCanvasReplicaDocument(
    parseCanvasReplicaDocument({
      schemaVersion: "canvas-replica-document/v1",
      manifest,
      promptMarkdownByPath: Object.fromEntries(
        manifest.nodes.flatMap((task) => [
          [task.prompt, `# ${task.id}`],
          ...task.blocks.map((block) => [block.prompt, `# ${block.id}`])
        ])
      ),
      layout: {
        version: "desktop-layout/v1",
        projectId: key.projectId,
        nodes: [{ nodeId: "T-001", x: layoutX, y: 0 }],
        updatedAt: "2026-10-06T00:00:00.000Z"
      }
    })
  );
  const path = join(directory, `input-${revision}-${layoutX}-${authority.canvasId}.json`);
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: "workspace-authoritative-snapshot-cache/v1",
      key: authority,
      contentRevision: revision,
      contentDigest: content.canonicalDigest,
      contentIdentity: { canonicalDigest: content.canonicalDigest, totalBytes: content.totalBytes },
      recovery: { mode: "offline_readonly", mutationsAllowed: false, executionAllowed: false },
      cachedAt: "2026-10-06T00:00:00.000Z",
      content
    }),
    "utf8"
  );
  return { path, content };
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("workspace authoritative snapshot cache processes", () => {
  it.each([
    false,
    true
  ])("locks the read/check/rename transaction across writers (same revision conflict: %s)", async (conflict) => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-cache-processes-"));
    directories.push(directory);
    const cacheDirectory = join(directory, "snapshots");
    const cache = new WorkspaceAuthoritativeSnapshotCache(cacheDirectory);
    const firstEntry = await entryFile(directory, conflict ? 9 : 3, 3);
    const secondEntry = await entryFile(directory, 9, 9);
    const first = runWriter(cacheDirectory, firstEntry.path, true);
    await first.message("read");
    const lockPath = `${cache.pathForKey(key)}.write.lock`;
    expect(JSON.parse(await readFile(join(lockPath, "holder.json"), "utf8"))).toMatchObject({
      pid: first.child.pid
    });
    const second = runWriter(cacheDirectory, secondEntry.path);
    await second.message("started");
    const otherKey = { ...key, canvasId: "canvas-2" };
    const otherEntry = await entryFile(directory, 5, 5, otherKey);
    const isolated = runWriter(cacheDirectory, otherEntry.path);
    expect(await isolated.message("result")).toMatchObject({ status: "written" });
    await isolated.exited();
    expect((await cache.get(otherKey))?.contentRevision).toBe(5);
    expect(await cache.get(key)).toBeNull();
    first.child.send({ type: "resume" });
    const result = await second.message("result");
    if (conflict)
      expect(result).toMatchObject({
        status: "failed",
        message: "workspace_snapshot_cache_revision_digest_conflict"
      });
    else expect(result).toMatchObject({ status: "written" });
    await Promise.all([first.exited(), second.exited()]);
    const recovered = await new WorkspaceAuthoritativeSnapshotCache(cacheDirectory).get(key);
    expect(recovered).toMatchObject({
      contentRevision: 9,
      content: conflict ? firstEntry.content : secondEntry.content,
      recovery: { mode: "offline_readonly", mutationsAllowed: false, executionAllowed: false }
    });
    expect((await readdir(cacheDirectory)).sort()).toEqual(
      [
        cache.pathForKey(key).split(/[\\/]/).at(-1),
        cache.pathForKey(otherKey).split(/[\\/]/).at(-1)
      ].sort()
    );
    const next = await entryFile(directory, 10, 10);
    const retry = runWriter(cacheDirectory, next.path);
    expect(await retry.message("result")).toMatchObject({ status: "written" });
    await retry.exited();
    expect((await cache.get(key))?.contentRevision).toBe(10);
  }, 20000);
  it("reclaims an expired lock from an exited writer and publishes a valid atomic head", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-cache-stale-process-"));
    directories.push(directory);
    const cacheDirectory = join(directory, "snapshots");
    const cache = new WorkspaceAuthoritativeSnapshotCache(cacheDirectory);
    const input = await entryFile(directory, 3, 3);
    const crashed = runWriter(cacheDirectory, input.path, true);
    await crashed.message("read");
    const exit = expect(crashed.exited()).rejects.toThrow("snapshot writer exit");
    crashed.child.kill();
    await exit;
    const lockPath = `${cache.pathForKey(key)}.write.lock`;
    await utimes(lockPath, new Date(0), new Date(0));
    const next = await entryFile(directory, 9, 9);
    const recovered = runWriter(cacheDirectory, next.path);
    expect(await recovered.message("result")).toMatchObject({ status: "written" });
    await recovered.exited();
    expect(await cache.get(key)).toMatchObject({ contentRevision: 9, content: next.content });
    expect(await readdir(cacheDirectory)).toEqual([cache.pathForKey(key).split(/[/]/).at(-1)]);
  }, 20000);
});
