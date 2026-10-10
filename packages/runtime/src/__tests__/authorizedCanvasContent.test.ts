import { createHash } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { basename } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  captureAuthorizedCanvasContent,
  decodeCanvasReplicaDocument,
  readAuthorizedCanvasContentDigest
} from "../index.js";
import { buildCanvasCommandApplication } from "../graph/canvasCommandMutation.js";
import { commitCanvasCommandApplication } from "../graph/canvasCommandPort.js";
import { loadPackage } from "../package/loadPackage.js";
import {
  getDesktopLayoutDirect,
  layoutPathForWorkspace,
  saveDesktopLayoutDirect
} from "../desktop/layoutStore.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

const boundary = vi.hoisted(() => ({
  afterSnapshot: undefined as (() => Promise<void>) | undefined,
  lockRequested: undefined as ((path: string) => void) | undefined
}));
vi.mock("../package/packageSnapshot.js", async (original) => {
  const actual = await original<typeof import("../package/packageSnapshot.js")>();
  return {
    ...actual,
    capturePackageSnapshot: async (...args: Parameters<typeof actual.capturePackageSnapshot>) => {
      const captured = await actual.capturePackageSnapshot(...args);
      await boundary.afterSnapshot?.();
      return captured;
    }
  };
});
vi.mock("../fs/advisoryDirectoryLock.js", async (original) => {
  const actual = await original<typeof import("../fs/advisoryDirectoryLock.js")>();
  return {
    ...actual,
    withAdvisoryDirectoryLock: <T>(
      options: Parameters<typeof actual.withAdvisoryDirectoryLock>[0],
      action: () => Promise<T>
    ) => {
      const pending = actual.withAdvisoryDirectoryLock(options, action);
      boundary.lockRequested?.(options.lockPath);
      return pending;
    }
  };
});

const roots: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
afterEach(async () => {
  boundary.afterSnapshot = boundary.lockRequested = undefined;
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it.each([
  "content",
  "digest"
] as const)("captures a complete pre-commit pair through the public %s entry while add-task waits", async (entry) => {
  const fixture = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
  roots.push(fixture.home, fixture.root);
  const workspace = fixture.init.workspace;
  await saveDesktopLayoutDirect(
    workspace,
    {
      version: "desktop-layout/v1",
      projectId: workspace.id,
      nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    { updatedAt: "2026-01-01T00:00:00.000Z" }
  );
  const input = { projectRoot: workspace, canvasId: "default", authorityProjectId: "authority" };
  const before = await captureAuthorizedCanvasContent(input);
  const application = buildCanvasCommandApplication(
    (await loadPackage(workspace)).manifest,
    await getDesktopLayoutDirect(workspace),
    {
      kind: "add_task",
      taskId: "T-003",
      title: "Added task",
      promptMarkdown: "# Added task prompt\n",
      layout: { nodeId: "T-003", x: 3, y: 4 },
      layoutUpdatedAt: "2030-01-01T00:00:00.000Z"
    }
  );
  const targetKeys = new Set(
    await Promise.all(
      [workspace.packageDir, layoutPathForWorkspace(workspace)].map(async (path) =>
        createHash("sha256")
          .update(await realpath(path))
          .digest("hex")
      )
    )
  );
  const snapshotRead = deferred();
  const continueCapture = deferred();
  const writerQueued = deferred();
  boundary.afterSnapshot = async () => {
    boundary.afterSnapshot = undefined;
    snapshotRead.resolve();
    await continueCapture.promise;
  };
  const reading =
    entry === "content"
      ? captureAuthorizedCanvasContent(input).then((captured) => {
          const replica = decodeCanvasReplicaDocument(captured.content);
          expect(replica.manifest.nodes.map((node) => node.id)).toEqual(["T-001", "T-002"]);
          expect(replica.layout.nodes).toEqual([{ nodeId: "T-001", x: 10, y: 20 }]);
          expect(replica.layout.projectId).toBe("authority");
          return captured.content.canonicalDigest;
        })
      : readAuthorizedCanvasContentDigest(input).then((result) => {
          if (!result.ok) throw new Error(result.detail);
          return result.contentDigest;
        });
  await snapshotRead.promise;
  boundary.lockRequested = (path) => {
    if (targetKeys.has(basename(path))) writerQueued.resolve();
  };
  const writing = commitCanvasCommandApplication({ workspace, application });
  const completed = Promise.all([reading, writing]);
  try {
    await writerQueued.promise;
    boundary.lockRequested = undefined;
    continueCapture.resolve();
    const [digest, committed] = await completed;
    expect(committed.ok).toBe(true);
    expect(digest).toBe(before.content.canonicalDigest);
    const after = await captureAuthorizedCanvasContent(input);
    const replica = decodeCanvasReplicaDocument(after.content);
    expect(replica.manifest.nodes.map((node) => node.id)).toEqual(["T-001", "T-002", "T-003"]);
    expect(replica.layout.nodes).toEqual([
      { nodeId: "T-001", x: 10, y: 20 },
      { nodeId: "T-003", x: 3, y: 4 }
    ]);
    expect(replica.promptMarkdownByPath["nodes/T-003/prompt.md"]).toBe("# Added task prompt\n");
    expect(after.content.canonicalDigest).not.toBe(digest);
    const afterDigest = await readAuthorizedCanvasContentDigest(input);
    expect(afterDigest).toMatchObject({ ok: true, contentDigest: after.content.canonicalDigest });
  } finally {
    continueCapture.resolve();
    boundary.afterSnapshot = boundary.lockRequested = undefined;
    await Promise.allSettled([reading, writing]);
  }
});
