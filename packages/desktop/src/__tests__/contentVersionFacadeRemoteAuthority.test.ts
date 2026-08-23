import { describe, expect, it, vi } from "vitest";
import { ContentVersionFacade } from "../main/collaboration/ContentVersionFacade.js";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";

const runtime = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getProjectOverview: vi.fn()
}));

vi.mock("@planweave-ai/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@planweave-ai/runtime")>()),
  listProjects: runtime.listProjects,
  getProjectOverview: runtime.getProjectOverview
}));

const binding = {
  kind: "remote" as const,
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};
const scope = {
  workspaceId: binding.workspaceId,
  projectId: binding.projectId,
  canvasId: binding.canvasId
};
const packageFingerprint = `pkg-${"a".repeat(64)}`;
const status = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope,
  packageFingerprint,
  capturedAt: "2026-08-22T00:00:00.000Z",
  tasks: [],
  blocks: []
};
const availability = {
  schemaVersion: "canvas-runtime-view/v1" as const,
  state: { kind: "initialized" as const, runtimeRevision: 2, status },
  execution: {
    schemaVersion: "canvas-runtime-availability/v1" as const,
    kind: "available" as const,
    status,
    sourceRevision: "source-1",
    graphFingerprint: packageFingerprint
  }
};
const head = {
  schemaVersion: "content-version/v1" as const,
  scope,
  revision: 9,
  content: {
    versionId: `version-${"b".repeat(64)}`,
    canonicalDigest: "b".repeat(64),
    verification: "complete" as const
  },
  advancedAt: "2026-08-22T00:00:00.000Z"
};

const adoptedReceipt = {
  status: "adopted" as const,
  serverOrigin: "https://server.example.test",
  projectId: "project-1",
  localProjectId: "project-1",
  localCanvasId: "canvas-1",
  workspaceId: "workspace-1",
  canvasId: "canvas-1",
  visibility: "shared" as const,
  revision: head.revision,
  content: head.content,
  adoptedAt: "2026-08-22T00:00:00.000Z",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z"
};

function fakeClient() {
  const listCanvases = vi.fn(async () => ({
    items: [
      {
        registry: scope,
        visibility: "shared" as const
      }
    ],
    nextCursor: null
  }));
  const readRuntimeAvailability = vi.fn(async () => availability);
  const fetchContentHead = vi.fn(async () => head);
  const resetRuntime = vi.fn(async () => ({
    type: "canvas.runtime.reset.rejected" as const,
    operationId: "reset-1",
    code: "host_offline" as const
  }));
  const client = {
    projectId: binding.projectId,
    connectionProfile: {
      profileId: "profile-1",
      serverBaseUrl: "https://server.example.test",
      projectId: binding.projectId,
      allowInsecureTransport: false
    },
    registry: () => ({ listCanvases }),
    readRuntimeAvailability,
    fetchContentHead,
    resetRuntime
  } as CollaborationClient;
  return {
    client,
    calls: { listCanvases, readRuntimeAvailability, fetchContentHead, resetRuntime }
  };
}

describe("ContentVersionFacade remote authority", () => {
  it("reconciles a Server canvas from its authoritative publish source without a receipt", async () => {
    runtime.listProjects.mockResolvedValueOnce([
      { projectId: "project-1", rootPath: "/tmp/nonexistent-planweave-sharing" }
    ]);
    runtime.getProjectOverview.mockResolvedValueOnce({
      rootPath: "/tmp/nonexistent-planweave-sharing",
      projectId: "project-1",
      name: "Local project",
      taskCanvases: [{ canvasId: "canvas-1", name: "Default canvas" }]
    });
    const fake = fakeClient();
    fake.calls.listCanvases.mockResolvedValueOnce({
      items: [
        {
          registry: scope,
          visibility: "private",
          publishSource: { localProjectId: "project-1", localCanvasId: "canvas-1" }
        }
      ],
      nextCursor: null
    });
    vi.mocked(fake.client.fetchContentHead).mockResolvedValueOnce({ scope } as never);
    const facade = new ContentVersionFacade(() => fake.client, {
      find: vi.fn().mockResolvedValue(null)
    } as never);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      {
        localProjectId: "project-1",
        projectName: "Local project",
        canvasId: "canvas-1",
        canvasName: "Default canvas",
        state: "published_private",
        workspaceCanvasId: "canvas-1",
        visibility: "private"
      }
    ]);
  });

  it("does not infer a local source from matching project and canvas ids", async () => {
    runtime.listProjects.mockResolvedValueOnce([
      { projectId: "project-1", rootPath: "/tmp/nonexistent-planweave-sharing" }
    ]);
    runtime.getProjectOverview.mockResolvedValueOnce({
      rootPath: "/tmp/nonexistent-planweave-sharing",
      projectId: "project-1",
      name: "Local project",
      taskCanvases: [{ canvasId: "canvas-1", name: "Default canvas" }]
    });
    const fake = fakeClient();
    const facade = new ContentVersionFacade(() => fake.client, {
      find: vi.fn().mockResolvedValue(null)
    } as never);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      {
        localProjectId: "project-1",
        projectName: "Local project",
        canvasId: "canvas-1",
        canvasName: "Default canvas",
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      }
    ]);
    expect(fake.calls.fetchContentHead).not.toHaveBeenCalled();
  });

  it("uses an explicitly adopted legacy source after Server authorization is rechecked", async () => {
    runtime.listProjects.mockResolvedValueOnce([
      { projectId: "project-1", rootPath: "/tmp/nonexistent-planweave-sharing" }
    ]);
    runtime.getProjectOverview.mockResolvedValueOnce({
      rootPath: "/tmp/nonexistent-planweave-sharing",
      projectId: "project-1",
      name: "Local project",
      taskCanvases: [{ canvasId: "canvas-1", name: "Default canvas" }]
    });
    const fake = fakeClient();
    const facade = new ContentVersionFacade(() => fake.client, {
      find: vi.fn().mockResolvedValue(adoptedReceipt),
      invalidateAdoption: vi.fn().mockResolvedValue(true)
    } as never);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      {
        localProjectId: "project-1",
        projectName: "Local project",
        canvasId: "canvas-1",
        canvasName: "Default canvas",
        state: "published_shared",
        workspaceCanvasId: "canvas-1",
        visibility: "shared"
      }
    ]);
    expect(fake.calls.fetchContentHead).toHaveBeenCalledWith("canvas-1");
  });

  it("ignores an adopted source after Server authorization is revoked", async () => {
    runtime.listProjects.mockResolvedValueOnce([
      { projectId: "project-1", rootPath: "/tmp/nonexistent-planweave-sharing" }
    ]);
    runtime.getProjectOverview.mockResolvedValueOnce({
      rootPath: "/tmp/nonexistent-planweave-sharing",
      projectId: "project-1",
      name: "Local project",
      taskCanvases: [{ canvasId: "canvas-1", name: "Default canvas" }]
    });
    const fake = fakeClient();
    fake.calls.listCanvases.mockResolvedValueOnce({ items: [], nextCursor: null });
    const invalidateAdoption = vi.fn().mockResolvedValue(true);
    const facade = new ContentVersionFacade(() => fake.client, {
      find: vi.fn().mockResolvedValue(adoptedReceipt),
      invalidateAdoption
    } as never);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      })
    ]);
    expect(fake.calls.fetchContentHead).not.toHaveBeenCalled();
    expect(invalidateAdoption).toHaveBeenCalledWith(adoptedReceipt);
  });

  it("ignores an adopted source when the verified Server head no longer matches", async () => {
    runtime.listProjects.mockResolvedValueOnce([
      { projectId: "project-1", rootPath: "/tmp/nonexistent-planweave-sharing" }
    ]);
    runtime.getProjectOverview.mockResolvedValueOnce({
      rootPath: "/tmp/nonexistent-planweave-sharing",
      projectId: "project-1",
      name: "Local project",
      taskCanvases: [{ canvasId: "canvas-1", name: "Default canvas" }]
    });
    const fake = fakeClient();
    fake.calls.fetchContentHead.mockResolvedValueOnce({
      ...head,
      revision: 10,
      content: { ...head.content, canonicalDigest: "c".repeat(64) }
    });
    const invalidateAdoption = vi.fn().mockResolvedValue(true);
    const facade = new ContentVersionFacade(() => fake.client, {
      find: vi.fn().mockResolvedValue(adoptedReceipt),
      invalidateAdoption
    } as never);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      })
    ]);
    expect(invalidateAdoption).toHaveBeenCalledWith(adoptedReceipt);
  });

  it("uses current Server visibility for a verified adopted source", async () => {
    runtime.listProjects.mockResolvedValueOnce([
      { projectId: "project-1", rootPath: "/tmp/nonexistent-planweave-sharing" }
    ]);
    runtime.getProjectOverview.mockResolvedValueOnce({
      rootPath: "/tmp/nonexistent-planweave-sharing",
      projectId: "project-1",
      name: "Local project",
      taskCanvases: [{ canvasId: "canvas-1", name: "Default canvas" }]
    });
    const fake = fakeClient();
    fake.calls.listCanvases.mockResolvedValueOnce({
      items: [{ registry: scope, visibility: "private" }],
      nextCursor: null
    });
    const facade = new ContentVersionFacade(() => fake.client, {
      find: vi.fn().mockResolvedValue(adoptedReceipt),
      invalidateAdoption: vi.fn().mockResolvedValue(true)
    } as never);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({
        state: "published_private",
        workspaceCanvasId: "canvas-1",
        visibility: "private"
      })
    ]);
  });

  it("ignores an adopted source when its Server head is missing", async () => {
    runtime.listProjects.mockResolvedValueOnce([
      { projectId: "project-1", rootPath: "/tmp/nonexistent-planweave-sharing" }
    ]);
    runtime.getProjectOverview.mockResolvedValueOnce({
      rootPath: "/tmp/nonexistent-planweave-sharing",
      projectId: "project-1",
      name: "Local project",
      taskCanvases: [{ canvasId: "canvas-1", name: "Default canvas" }]
    });
    const fake = fakeClient();
    fake.calls.fetchContentHead.mockResolvedValueOnce(null);
    const invalidateAdoption = vi.fn().mockResolvedValue(true);
    const facade = new ContentVersionFacade(() => fake.client, {
      find: vi.fn().mockResolvedValue(adoptedReceipt),
      invalidateAdoption
    } as never);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      })
    ]);
    expect(invalidateAdoption).toHaveBeenCalledWith(adoptedReceipt);
  });

  it("derives Workspace scope only from the explicit remote binding", async () => {
    const fake = fakeClient();
    const facade = new ContentVersionFacade(() => fake.client);

    await expect(facade.resolveCanvasScope(binding)).resolves.toEqual(scope);
    await expect(facade.resolveCanvasBinding(binding)).resolves.toEqual({
      ...binding,
      remoteProjectId: binding.projectId,
      remoteCanvasId: binding.canvasId
    });
    expect(fake.calls.listCanvases).toHaveBeenCalledTimes(2);
  });

  it("rejects Local Canvas without scanning local projects or calling Server", async () => {
    const fake = fakeClient();
    const facade = new ContentVersionFacade(() => fake.client);

    await expect(
      facade.resolveCanvasScope({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "default"
      })
    ).rejects.toMatchObject({ code: "workspace_canvas_remote_binding_required" });
    expect(fake.calls.listCanvases).not.toHaveBeenCalled();
  });

  it("reads remote Runtime availability and derives reset content revision from Server head", async () => {
    const fake = fakeClient();
    const facade = new ContentVersionFacade(() => fake.client);

    await expect(facade.readRuntimeAvailability(binding)).resolves.toEqual(availability);
    await expect(
      facade.resetRuntime(binding, {
        operationId: "reset-1",
        expectedSourceRevision: "source-1",
        expectedGraphFingerprint: packageFingerprint
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.rejected",
      code: "host_offline"
    });
    expect(fake.calls.resetRuntime).toHaveBeenCalledWith(
      binding.canvasId,
      expect.objectContaining({ expectedContentRevision: 9 })
    );
  });
});
