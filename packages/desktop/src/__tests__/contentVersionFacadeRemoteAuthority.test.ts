import { describe, expect, it, vi } from "vitest";
import { ContentVersionFacade } from "../main/collaboration/ContentVersionFacade.js";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";

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
  const discoverContentAuthority = vi.fn(async () => ({
    authoritativeHead: {
      schemaVersion: "content-version/v1" as const,
      scope,
      revision: 9,
      content: {
        versionId: `version-${"b".repeat(64)}`,
        canonicalDigest: "b".repeat(64),
        verification: "complete" as const
      },
      advancedAt: "2026-08-22T00:00:00.000Z"
    },
    localReplica: null,
    lastAcknowledgement: null,
    replicaStatus: "snapshot_required" as const,
    recoveryAction: "fetch_head" as const,
    canPublishInitial: false,
    canMaterialize: true,
    canRecover: true
  }));
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
    discoverContentAuthority,
    resetRuntime
  } as CollaborationClient;
  return {
    client,
    calls: { listCanvases, readRuntimeAvailability, discoverContentAuthority, resetRuntime }
  };
}

describe("ContentVersionFacade remote authority", () => {
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
