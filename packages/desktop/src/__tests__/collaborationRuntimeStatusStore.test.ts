import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationRuntimeStatusStore } from "../main/collaboration/CollaborationRuntimeStatusStore.js";
import { CollaborationRuntimeAvailabilityStore } from "../main/collaboration/CollaborationRuntimeAvailabilityStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const key = {
  profileId: "profile-1",
  serverOrigin: "http://192.168.1.10:50653",
  projectId: "remote-project",
  localProjectId: "local-project",
  localCanvasId: "default"
};

const status = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope: {
    workspaceId: "workspace-main",
    projectId: "remote-project",
    canvasId: "canvas-main"
  },
  packageFingerprint: `pkg-${"a".repeat(64)}`,
  capturedAt: "2026-08-03T00:00:00.000Z",
  tasks: [{ taskId: "T-001", status: "implemented" as const, openFeedbackCount: 0 }],
  blocks: [
    {
      ref: "T-001#B-001",
      status: "completed" as const,
      completionReason: "passed" as const,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: false
    }
  ]
};

describe("CollaborationRuntimeStatusStore", () => {
  it("persists the last confirmed status for one exact authority and local replica", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-status-"));
    directories.push(directory);
    const path = join(directory, "runtime-status.json");

    await new CollaborationRuntimeStatusStore(path).put(key, status);

    await expect(new CollaborationRuntimeStatusStore(path).get(key)).resolves.toEqual(status);
    await expect(
      new CollaborationRuntimeStatusStore(path).get({ ...key, profileId: "profile-2" })
    ).resolves.toBeNull();
    await expect(readFile(path, "utf8")).resolves.not.toContain("projectRoot");
  });

  it("does not rewrite the cache when only capturedAt changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-status-"));
    directories.push(directory);
    const path = join(directory, "runtime-status.json");
    const store = new CollaborationRuntimeStatusStore(path);

    await store.put(key, status);
    const before = await readFile(path, "utf8");
    await store.put(key, { ...status, capturedAt: "2026-08-03T00:00:03.000Z" });

    await expect(readFile(path, "utf8")).resolves.toBe(before);
    await expect(store.get(key)).resolves.toEqual(status);
  });
});

const availabilityKey = {
  profileId: "profile-1",
  serverOrigin: "http://192.168.1.10:50653",
  projectId: "remote-project",
  localProjectId: "local-project",
  localCanvasId: "default"
};
const available = {
  schemaVersion: "canvas-runtime-availability/v1" as const,
  kind: "available" as const,
  status: {
    ...status,
    scope: { workspaceId: "workspace-main", projectId: "remote-project", canvasId: "canvas-main" }
  },
  sourceRevision: "src-revision-001",
  graphFingerprint: `pkg-${"b".repeat(64)}`
};

describe("CollaborationRuntimeAvailabilityStore", () => {
  it("round-trips the strict union and isolates every authority and local-replica key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-availability-"));
    directories.push(directory);
    const path = join(directory, "runtime-availability.json");
    const store = new CollaborationRuntimeAvailabilityStore(path);

    await store.put(availabilityKey, available);
    await expect(
      new CollaborationRuntimeAvailabilityStore(path).get(availabilityKey)
    ).resolves.toEqual(available);
    for (const isolated of [
      { ...availabilityKey, profileId: "profile-2" },
      { ...availabilityKey, serverOrigin: "https://collab.example.com" },
      { ...availabilityKey, projectId: "remote-project-2" },
      { ...availabilityKey, localProjectId: "local-project-2" },
      { ...availabilityKey, localCanvasId: "canvas-2" }
    ]) {
      await expect(store.get(isolated)).resolves.toBeNull();
    }
    await expect(readFile(path, "utf8")).resolves.not.toContain("projectRoot");
  });

  it("persists unavailable without inventing a runtime status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-availability-"));
    directories.push(directory);
    const store = new CollaborationRuntimeAvailabilityStore(
      join(directory, "runtime-availability.json")
    );
    const unavailable = {
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "unavailable" as const,
      reason: "runtime_not_attached" as const
    };

    await expect(store.put(availabilityKey, unavailable)).resolves.toEqual(unavailable);
    await expect(store.get(availabilityKey)).resolves.toEqual(unavailable);
  });

  it("fails closed on a damaged or non-strict cache document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-availability-"));
    directories.push(directory);
    const path = join(directory, "runtime-availability.json");
    await writeFile(path, JSON.stringify({ version: 1, records: [], unexpected: true }));

    await expect(
      new CollaborationRuntimeAvailabilityStore(path).get(availabilityKey)
    ).rejects.toThrow("collaboration_runtime_availability_store_invalid");
  });
});
