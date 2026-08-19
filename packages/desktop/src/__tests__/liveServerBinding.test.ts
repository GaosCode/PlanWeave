import { describe, expect, it } from "vitest";
import { pickLiveProjectId } from "../main/collaboration/liveServerBinding.js";
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

  it("builds an HTTPS endpoint for a remote Server origin", () => {
    expect(collaborationEndpointForServerOrigin("https://vm.example.test/", false)).toMatchObject({
      topology: "public_https",
      serverOrigin: "https://vm.example.test/",
      tlsTrust: "system_ca"
    });
  });
});
