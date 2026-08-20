import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
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
const available = {
  schemaVersion: "canvas-runtime-availability/v1" as const,
  kind: "available" as const,
  status: {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope: {
      workspaceId: "workspace-main",
      projectId: "remote-project",
      canvasId: "canvas-main"
    },
    packageFingerprint: `pkg-${"a".repeat(64)}`,
    capturedAt: "2026-08-20T00:00:00.000Z",
    tasks: [{ taskId: "T-001", status: "implemented" as const, openFeedbackCount: 0 }],
    blocks: []
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

    await store.put(key, available);
    await expect(new CollaborationRuntimeAvailabilityStore(path).get(key)).resolves.toEqual(
      available
    );
    for (const isolated of [
      { ...key, profileId: "profile-2" },
      { ...key, serverOrigin: "https://collab.example.com" },
      { ...key, projectId: "remote-project-2" },
      { ...key, localProjectId: "local-project-2" },
      { ...key, localCanvasId: "canvas-2" }
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

    await expect(store.put(key, unavailable)).resolves.toEqual(unavailable);
    await expect(store.get(key)).resolves.toEqual(unavailable);
  });

  it("fails closed on a damaged or non-strict cache document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-availability-"));
    directories.push(directory);
    const path = join(directory, "runtime-availability.json");
    await writeFile(path, JSON.stringify({ version: 1, records: [], unexpected: true }));

    await expect(new CollaborationRuntimeAvailabilityStore(path).get(key)).rejects.toThrow(
      "collaboration_runtime_availability_store_invalid"
    );
  });
});
