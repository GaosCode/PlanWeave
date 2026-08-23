import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCanvasPublishReceiptStore } from "../main/collaboration/WorkspaceCanvasPublishReceiptStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const key = {
  serverOrigin: "http://127.0.0.1:50653",
  projectId: "server-project",
  localProjectId: "local-project-a",
  localCanvasId: "default"
};

describe("WorkspaceCanvasPublishReceiptStore", () => {
  it("persists pending then committed receipts across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-publish-receipts-"));
    directories.push(directory);
    const path = join(directory, "workspace-canvas-publish-receipts.json");
    const pending = await new WorkspaceCanvasPublishReceiptStore(path).rememberPending({
      ...key,
      operationId: "publish-op-1"
    });
    expect(pending).toMatchObject({ status: "pending", operationId: "publish-op-1" });

    const committed = await new WorkspaceCanvasPublishReceiptStore(path).commit({
      ...key,
      operationId: "publish-op-1",
      recoveryToken: "wp-publish-op-1",
      workspaceId: "workspace-1",
      canvasId: "wsc-11111111-1111-1111-1111-111111111111",
      visibility: "private"
    });
    await expect(new WorkspaceCanvasPublishReceiptStore(path).find(key)).resolves.toMatchObject({
      status: "committed",
      operationId: "publish-op-1",
      canvasId: committed.canvasId
    });
    await expect(readFile(path, "utf8")).resolves.not.toContain("projectRoot");
  });

  it("keeps the original operationId when a committed receipt is remembered again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-publish-receipts-"));
    directories.push(directory);
    const store = new WorkspaceCanvasPublishReceiptStore(
      join(directory, "workspace-canvas-publish-receipts.json")
    );
    await store.commit({
      ...key,
      operationId: "publish-op-1",
      recoveryToken: "wp-publish-op-1",
      workspaceId: "workspace-1",
      canvasId: "wsc-11111111-1111-1111-1111-111111111111",
      visibility: "private"
    });
    await expect(
      store.rememberPending({ ...key, operationId: "publish-op-restart" })
    ).resolves.toMatchObject({
      status: "committed",
      operationId: "publish-op-1"
    });
  });

  it("isolates receipts by server origin, project, and local source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-publish-receipts-"));
    directories.push(directory);
    const store = new WorkspaceCanvasPublishReceiptStore(
      join(directory, "workspace-canvas-publish-receipts.json")
    );
    await store.rememberPending({ ...key, operationId: "publish-op-1" });
    for (const isolated of [
      { ...key, serverOrigin: "https://collab.example.com" },
      { ...key, projectId: "server-project-2" },
      { ...key, localProjectId: "local-project-b" },
      { ...key, localCanvasId: "planning" }
    ]) {
      await expect(store.find(isolated)).resolves.toBeNull();
    }
  });

  it("records an explicitly verified legacy adoption without inventing publish credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-publish-receipts-"));
    directories.push(directory);
    const path = join(directory, "workspace-canvas-publish-receipts.json");
    const store = new WorkspaceCanvasPublishReceiptStore(path);
    const adopted = await store.adopt({
      ...key,
      workspaceId: "workspace-1",
      canvasId: "default",
      visibility: "shared",
      revision: 206,
      content: {
        versionId: `version-${"b".repeat(64)}`,
        canonicalDigest: "b".repeat(64),
        verification: "complete"
      }
    });

    expect(adopted).toMatchObject({
      status: "adopted",
      canvasId: "default",
      revision: 206
    });
    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toContain("operationId");
    expect(serialized).not.toContain("recoveryToken");
  });

  it("keeps an identical legacy adoption idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-publish-receipts-"));
    directories.push(directory);
    const store = new WorkspaceCanvasPublishReceiptStore(
      join(directory, "workspace-canvas-publish-receipts.json")
    );
    const input = {
      ...key,
      workspaceId: "workspace-1",
      canvasId: "default",
      visibility: "shared" as const,
      revision: 206,
      content: {
        versionId: `version-${"b".repeat(64)}`,
        canonicalDigest: "b".repeat(64),
        verification: "complete" as const
      }
    };
    const first = await store.adopt(input);
    await expect(store.adopt(input)).resolves.toEqual(first);
  });

  it("rejects redirecting an existing legacy adoption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-publish-receipts-"));
    directories.push(directory);
    const store = new WorkspaceCanvasPublishReceiptStore(
      join(directory, "workspace-canvas-publish-receipts.json")
    );
    const input = {
      ...key,
      workspaceId: "workspace-1",
      canvasId: "default",
      visibility: "shared" as const,
      revision: 206,
      content: {
        versionId: `version-${"b".repeat(64)}`,
        canonicalDigest: "b".repeat(64),
        verification: "complete" as const
      }
    };
    await store.adopt(input);
    await expect(store.adopt({ ...input, canvasId: "other" })).rejects.toThrow(
      "workspace_canvas_adoption_conflict"
    );
    await expect(
      store.adopt({
        ...input,
        content: {
          ...input.content,
          versionId: `version-${"c".repeat(64)}`,
          canonicalDigest: "c".repeat(64)
        }
      })
    ).rejects.toThrow("workspace_canvas_adoption_conflict");
  });

  it("invalidates only the exact stale adoption and permits a new publish operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-publish-receipts-"));
    directories.push(directory);
    const store = new WorkspaceCanvasPublishReceiptStore(
      join(directory, "workspace-canvas-publish-receipts.json")
    );
    const adopted = await store.adopt({
      ...key,
      workspaceId: "workspace-1",
      canvasId: "default",
      visibility: "shared",
      revision: 206,
      content: {
        versionId: `version-${"b".repeat(64)}`,
        canonicalDigest: "b".repeat(64),
        verification: "complete"
      }
    });
    if (adopted.status !== "adopted") throw new Error("expected adopted receipt");

    await expect(
      store.invalidateAdoption({ ...adopted, updatedAt: "2026-08-23T00:00:00.000Z" })
    ).resolves.toBe(false);
    await expect(store.invalidateAdoption(adopted)).resolves.toBe(true);
    await expect(
      store.rememberPending({ ...key, operationId: "publish-after-adoption-invalidated" })
    ).resolves.toMatchObject({
      status: "pending",
      operationId: "publish-after-adoption-invalidated"
    });
  });
});
