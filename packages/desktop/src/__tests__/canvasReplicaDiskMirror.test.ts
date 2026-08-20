import { describe, expect, it, vi } from "vitest";
import { encodeCanvasReplicaDocument, parseCanvasReplicaDocument } from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CanvasReplicaDiskMirror } from "../main/collaboration/CanvasReplicaDiskMirror.js";
import type { CanvasReplicaScope } from "../main/collaboration/CanvasReplicaStore.js";

function content() {
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
        projectId: "remote-project",
        nodes: [{ nodeId: "T-001", x: 0, y: 0 }],
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    })
  );
}

function scope(authorityId = "authority-1"): CanvasReplicaScope {
  return {
    bindingKind: "local",
    authorityId,
    localProjectId: "local-project",
    localCanvasId: "local-canvas",
    workspaceId: "workspace-1",
    projectId: "remote-project",
    canvasId: "remote-canvas"
  };
}

describe("CanvasReplicaDiskMirror", () => {
  it("serializes confirmed revisions into the bound local replica", async () => {
    const localBinding = { expectedContentDigest: "a".repeat(64) };
    const materializeConfirmed = vi.fn().mockResolvedValue(undefined);
    const mirror = new CanvasReplicaDiskMirror({
      bind: vi.fn().mockResolvedValue(localBinding),
      materializeConfirmed
    });
    const committed = content();

    await mirror.bind(scope());
    mirror.capture({
      scope: scope(),
      revision: 4,
      contentDigest: committed.canonicalDigest,
      content: committed
    });
    await mirror.flush();

    expect(materializeConfirmed).toHaveBeenCalledWith(localBinding, {
      content: committed,
      contentDigest: committed.canonicalDigest
    });
  });

  it("surfaces persistence failures instead of marking the replica durable", async () => {
    const mirror = new CanvasReplicaDiskMirror({
      bind: vi.fn().mockResolvedValue({ expectedContentDigest: "a".repeat(64) }),
      materializeConfirmed: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    const committed = content();

    await mirror.bind(scope());
    mirror.capture({
      scope: scope(),
      revision: 4,
      contentDigest: committed.canonicalDigest,
      content: committed
    });

    await expect(mirror.flush()).rejects.toThrow("disk full");
  });

  it("coalesces queued revisions while one materialization is in progress", async () => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const materializeConfirmed = vi
      .fn()
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValue(undefined);
    const mirror = new CanvasReplicaDiskMirror({
      bind: vi.fn().mockResolvedValue({ expectedContentDigest: "a".repeat(64) }),
      materializeConfirmed
    });
    const first = content();
    const second = { ...content(), canonicalDigest: "b".repeat(64) };
    const latest = { ...content(), canonicalDigest: "c".repeat(64) };

    await mirror.bind(scope());
    mirror.capture({
      scope: scope(),
      revision: 1,
      contentDigest: first.canonicalDigest,
      content: first
    });
    await vi.waitFor(() => expect(materializeConfirmed).toHaveBeenCalledTimes(1));
    mirror.capture({
      scope: scope(),
      revision: 2,
      contentDigest: second.canonicalDigest,
      content: second
    });
    mirror.capture({
      scope: scope(),
      revision: 3,
      contentDigest: latest.canonicalDigest,
      content: latest
    });

    releaseFirst();
    await mirror.flush();

    expect(materializeConfirmed).toHaveBeenCalledTimes(2);
    expect(materializeConfirmed).toHaveBeenLastCalledWith(expect.anything(), {
      content: latest,
      contentDigest: latest.canonicalDigest
    });
  });

  it("does not expose a replacement binding until the previous write is stable", async () => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const materializeConfirmed = vi
      .fn()
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValue(undefined);
    const mirror = new CanvasReplicaDiskMirror({
      bind: vi
        .fn()
        .mockResolvedValueOnce({ expectedContentDigest: "a".repeat(64) })
        .mockResolvedValueOnce({ expectedContentDigest: "b".repeat(64) }),
      materializeConfirmed
    });
    const committed = content();

    await mirror.bind(scope("authority-1"));
    mirror.capture({
      scope: scope("authority-1"),
      revision: 1,
      contentDigest: committed.canonicalDigest,
      content: committed
    });
    await vi.waitFor(() => expect(materializeConfirmed).toHaveBeenCalledTimes(1));

    const rebinding = mirror.bind(scope("authority-2"));
    mirror.capture({
      scope: scope("authority-2"),
      revision: 1,
      contentDigest: committed.canonicalDigest,
      content: committed
    });
    releaseFirst();
    await rebinding;
    expect(materializeConfirmed).toHaveBeenCalledTimes(1);

    mirror.capture({
      scope: scope("authority-2"),
      revision: 1,
      contentDigest: committed.canonicalDigest,
      content: committed
    });
    await mirror.flush();
    expect(materializeConfirmed).toHaveBeenCalledTimes(2);
  });
});
