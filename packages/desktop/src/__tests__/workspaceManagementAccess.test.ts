import { expect, it, vi } from "vitest";
import {
  accessCapabilityFlags,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { collaborationConnectionProfileSchema } from "@planweave-ai/collaboration-protocol/connection";
import { CurrentCanvasAccessFacade } from "../main/collaboration/CurrentCanvasAccessFacade.js";
const accessView: CurrentCanvasAccessView = {
  scope: {
    scopeKind: "canvas",
    workspaceId: "workspace-1",
    projectId: "remote-project",
    canvasId: "remote-canvas"
  },
  projectVisibility: "private",
  canvasVisibility: "shared",
  projectAclRevision: 1,
  canvasAclRevision: 2,
  project: {
    scope: {
      scopeKind: "project",
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: null
    },
    aclRevision: 1,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  canvas: {
    scope: {
      scopeKind: "canvas",
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    },
    aclRevision: 2,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  people: []
};

function fixture() {
  const client = {
    projectId: "remote-project",
    connectionProfile: collaborationConnectionProfileSchema.parse({
      profileId: "remote",
      displayName: "Team",
      serverBaseUrl: "https://remote.example/",
      projectId: "remote-project",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://remote.example/",
        allowedClientOrigins: ["https://remote.example/"],
        tlsTrust: "system_ca"
      }
    }),
    getCurrentCanvasAccess: vi.fn().mockResolvedValue(accessView),
    mutateCurrentCanvasAccess: vi.fn()
  };
  const active = vi.fn(async () => {
    throw new Error("sidebar session must not be used");
  });
  const facade = new CurrentCanvasAccessFacade({
    ensureWorkspaceHydrated: async () => {},
    buildWorkspaceConnectionView: async () => ({
      status: "connected",
      workspaceId: "workspace-1",
      profile: { serverBaseUrl: "https://remote.example/" }
    }),
    withActiveClient: active,
    withProjectClient: async (projectId, run) => {
      expect(projectId).toBe("remote-project");
      return run(client);
    }
  });
  return { facade, client, active };
}
it("reads a management selection without the sidebar canvas session", async () => {
  const { facade, active } = fixture();
  await expect(
    facade.get({ projectId: "remote-project", canvasId: "remote-canvas" })
  ).resolves.toEqual(accessView);
  expect(active).not.toHaveBeenCalled();
});
it("rejects an access response outside the current Workspace", async () => {
  const { facade, client } = fixture();
  client.getCurrentCanvasAccess.mockResolvedValue({
    ...accessView,
    scope: { ...accessView.scope, workspaceId: "foreign" }
  });
  await expect(
    facade.get({ projectId: "remote-project", canvasId: "remote-canvas" })
  ).rejects.toMatchObject({ code: "collaboration_access_scope_mismatch" });
});
it("rejects a mutation that changes the selected canvas scope", async () => {
  const { facade, client } = fixture();
  await expect(
    facade.mutate({
      projectId: "remote-project",
      canvasId: "remote-canvas",
      request: {
        operation: "visibility",
        scope: { ...accessView.scope, projectId: "other" },
        expectedAclRevision: 2,
        visibility: "shared"
      }
    })
  ).rejects.toMatchObject({ code: "collaboration_access_scope_mismatch" });
  expect(client.mutateCurrentCanvasAccess).not.toHaveBeenCalled();
});
