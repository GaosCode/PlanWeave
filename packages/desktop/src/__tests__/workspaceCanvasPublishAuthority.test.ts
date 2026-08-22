import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationCanvasOperationsFacade } from "../main/collaboration/CollaborationCanvasOperationsFacade.js";
import type { ContentVersionFacade } from "../main/collaboration/ContentVersionFacade.js";
import { WorkspaceCanvasSession } from "../main/collaboration/WorkspaceCanvasSession.js";
import type { CommittedWorkspaceCanvasPublish } from "../main/collaboration/workspaceCanvasPublish.js";

const locator = {
  kind: "workspace" as const,
  connectionProfileId: "profile-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "default"
};

const committed: CommittedWorkspaceCanvasPublish = {
  outcome: "published",
  operationId: "publish-operation-1",
  recoveryToken: "wp-publish-operation-1",
  locator,
  revision: 1,
  content: {
    versionId: `version-${"a".repeat(64)}`,
    canonicalDigest: "a".repeat(64),
    verification: "complete"
  },
  visibility: "private",
  localSourceRetained: true,
  candidate: {
    localProjectId: "local-project",
    projectName: "Local project",
    canvasId: "default",
    canvasName: "Default canvas",
    state: "published_private",
    visibility: "private"
  }
};

function createFacade(contentVersions: Pick<ContentVersionFacade, "publishWorkspaceCanvas">) {
  return new CollaborationCanvasOperationsFacade({
    enqueue: async (operation) => operation(),
    assertOpen: () => undefined,
    commands: {
      bind: vi.fn(),
      submit: vi.fn(),
      reconnect: vi.fn(),
      projectionForBinding: vi.fn(),
      session: vi.fn(),
      releaseBinding: vi.fn(),
      flushMaterialization: vi.fn()
    } as never,
    runtimeAvailability: {} as never,
    contentVersions: contentVersions as ContentVersionFacade,
    resolveConnectedProfileId: () => "profile-1",
    resolveSnapshotCacheKey: vi.fn(),
    snapshotCache: { get: vi.fn() }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace canvas publish authority switch", () => {
  it("opens the Workspace locator after Server commit", async () => {
    const publishWorkspaceCanvas = vi.fn(async () => committed);
    const open = vi.spyOn(WorkspaceCanvasSession.prototype, "open").mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: "server_authoritative",
      readOnly: false,
      cachedAt: null,
      conflict: null,
      rejectCode: null,
      replica: {} as never
    });
    const facade = createFacade({ publishWorkspaceCanvas });

    await expect(facade.publishWorkspaceCanvas({ canvasId: "default" })).resolves.toMatchObject({
      outcome: "published",
      locator,
      authoritySwitch: "opened",
      localSourceRetained: true
    });
    expect(publishWorkspaceCanvas).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(locator);
  });

  it("returns a retryable locator when Desktop switch fails after Server commit", async () => {
    const publishWorkspaceCanvas = vi.fn(async () => committed);
    vi.spyOn(WorkspaceCanvasSession.prototype, "open").mockRejectedValue(
      new Error("workspace_canvas_open_failed")
    );
    const facade = createFacade({ publishWorkspaceCanvas });

    await expect(facade.publishWorkspaceCanvas({ canvasId: "default" })).resolves.toMatchObject({
      outcome: "published",
      locator,
      recoveryToken: "wp-publish-operation-1",
      authoritySwitch: "retry_open"
    });
    expect(publishWorkspaceCanvas).toHaveBeenCalledOnce();
  });
});
