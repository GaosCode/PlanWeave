import { describe, expect, it } from "vitest";
import {
  listLiveRegistryProjects,
  pickLiveProjectId
} from "../main/collaboration/liveServerBinding.js";
import { collaborationEndpointForServerOrigin } from "../main/collaboration/collaborationProfileEndpoint.js";

describe("live Server binding", () => {
  it("keeps the current project when it still exists in the live Workspace", () => {
    expect(
      pickLiveProjectId({
        workspaceId: "workspace-a",
        preferredProjectId: "project-current",
        registryProjects: [
          { projectId: "project-other", workspaceId: "workspace-a" },
          { projectId: "project-current", workspaceId: "workspace-a" }
        ]
      })
    ).toBe("project-current");
  });

  it("falls back to the first project in the live Workspace", () => {
    expect(
      pickLiveProjectId({
        workspaceId: "workspace-a",
        preferredProjectId: "project-gone",
        registryProjects: [
          { projectId: "project-first", workspaceId: "workspace-a" },
          { projectId: "project-second", workspaceId: "workspace-a" }
        ]
      })
    ).toBe("project-first");
  });

  it("does not bind a project from another Workspace", () => {
    expect(
      pickLiveProjectId({
        workspaceId: "workspace-a",
        preferredProjectId: "project-other-workspace",
        registryProjects: [{ projectId: "project-other-workspace", workspaceId: "workspace-b" }]
      })
    ).toBeNull();
  });

  it("finds a shared project beyond the first registry page", async () => {
    const cursors: string[] = [];
    const projects = await listLiveRegistryProjects({
      serverBaseUrl: "https://workspace.example.test/",
      getDeviceToken: async () => "device-token",
      request: async (input) => {
        const cursor = new URL(String(input)).searchParams.get("cursor");
        cursors.push(cursor ?? "missing");
        const workspaceId = cursor === "0" ? "workspace-other" : "workspace-target";
        return new Response(
          JSON.stringify({
            items: [
              {
                schemaVersion: "project-access/v1",
                registry: {
                  projectRegistryId: `registry-${workspaceId}`,
                  workspaceId,
                  projectId: workspaceId
                },
                visibility: "shared",
                acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
                owner: "human-owner",
                updatedAt: "2030-01-01T00:00:00.000Z"
              }
            ],
            nextCursor: cursor === "0" ? 50 : null
          }),
          { status: 200 }
        );
      }
    });
    expect(cursors).toEqual(["0", "50"]);
    expect(
      pickLiveProjectId({
        workspaceId: "workspace-target",
        preferredProjectId: null,
        registryProjects: projects
      })
    ).toBe("workspace-target");
  });

  it("builds an HTTPS endpoint for a remote Server origin", () => {
    expect(collaborationEndpointForServerOrigin("https://vm.example.test/", false)).toMatchObject({
      topology: "public_https",
      serverOrigin: "https://vm.example.test/",
      tlsTrust: "system_ca"
    });
  });
});
