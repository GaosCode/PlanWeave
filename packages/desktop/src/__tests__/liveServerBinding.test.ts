import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationHttpTransport } from "../main/collaboration/collaborationHttpTransport.js";
import {
  buildLiveCollaborationProfile,
  listLiveRegistryProjects,
  pickLiveProjectId
} from "../main/collaboration/liveServerBinding.js";
import { collaborationEndpointForServerOrigin } from "../main/collaboration/collaborationProfileEndpoint.js";

describe("live Server binding", () => {
  it.each([
    "https://vm.example.test",
    "https://vm.example.test/"
  ])("keeps the profile and endpoint origin consistent for %s", (serverBaseUrl) => {
    const profile = buildLiveCollaborationProfile({
      profileId: "workspace-connection",
      displayName: "Team",
      serverBaseUrl,
      allowInsecureTransport: false,
      projectId: "chosen-project"
    });
    expect(profile.serverBaseUrl).toBe(serverBaseUrl);
    expect(profile.endpoint.serverOrigin).toBe(serverBaseUrl);
  });
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

describe("bounded registry traversal", () => {
  const project = (projectId: string, workspaceId = "workspace-target") => ({
    schemaVersion: "project-access/v1",
    registry: { projectRegistryId: `registry-${projectId}`, workspaceId, projectId },
    visibility: "shared",
    acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
    owner: "human-owner",
    updatedAt: "2030-01-01T00:00:00.000Z"
  });
  const read = (request: typeof fetch) =>
    listLiveRegistryProjects({
      serverBaseUrl: "https://workspace.example.test/",
      getDeviceToken: async () => "device-token",
      request
    });

  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("releases transport after a complete list (empty=%s)", async (empty) => {
    const dispose = vi.spyOn(CollaborationHttpTransport.prototype, "dispose");
    const projects = await read(async () =>
      Response.json({
        items: empty ? [] : [project("other", "workspace-other")],
        nextCursor: null
      })
    );
    expect(
      pickLiveProjectId({
        workspaceId: "workspace-target",
        preferredProjectId: null,
        registryProjects: projects
      })
    ).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.instances[0].disposedOrAborted).toBe(true);
  });

  it("continues past an empty page and a fallback project to a preferred project", async () => {
    const cursors: number[] = [];
    const projects = await read(async (input) => {
      const cursor = Number(new URL(String(input)).searchParams.get("cursor"));
      cursors.push(cursor);
      return Response.json({
        items: cursor === 0 ? [] : [project(cursor === 50 ? "fallback" : "preferred")],
        nextCursor: cursor === 100 ? null : cursor + 50
      });
    });
    expect(cursors).toEqual([0, 50, 100]);
    expect(
      pickLiveProjectId({
        workspaceId: "workspace-target",
        preferredProjectId: "preferred",
        registryProjects: projects
      })
    ).toBe("preferred");
  });

  it.each([
    50, 25
  ])("rejects a non-advancing second cursor %s without returning partial projects", async (nextCursor) => {
    const dispose = vi.spyOn(CollaborationHttpTransport.prototype, "dispose");
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        items: [project("partial")],
        nextCursor: request.mock.calls.length === 1 ? 50 : nextCursor
      })
    );
    await expect(read(request)).rejects.toMatchObject({
      code: "live_registry_pagination_invalid",
      kind: "protocol",
      retryable: false
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.instances[0].disposedOrAborted).toBe(true);
  });

  it.each([true, false])("bounds requests at 100 pages (terminal=%s)", async (terminal) => {
    const dispose = vi.spyOn(CollaborationHttpTransport.prototype, "dispose");
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        items: [project(`project-${request.mock.calls.length}`)],
        nextCursor:
          terminal && request.mock.calls.length === 100 ? null : request.mock.calls.length * 50
      })
    );
    if (terminal) await expect(read(request)).resolves.toHaveLength(100);
    else
      await expect(read(request)).rejects.toMatchObject({
        code: "live_registry_page_limit_exceeded",
        retryable: false
      });
    expect(request).toHaveBeenCalledTimes(100);
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.instances[0].disposedOrAborted).toBe(true);
  });

  it.each([
    ["http", "http_503"],
    ["network", "collaboration_offline"],
    ["protocol", "collaboration_response_invalid"]
  ])("rejects second-page %s failure and releases transport", async (failure, code) => {
    const dispose = vi.spyOn(CollaborationHttpTransport.prototype, "dispose");
    const request = vi.fn<typeof fetch>(async () => {
      if (request.mock.calls.length === 1)
        return Response.json({ items: [project("partial")], nextCursor: 50 });
      if (failure === "network") throw new TypeError("network failed");
      return failure === "http"
        ? new Response("unavailable", { status: 503 })
        : Response.json({ items: [], nextCursor: "invalid" });
    });
    await expect(read(request)).rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.instances[0].disposedOrAborted).toBe(true);
  });
});
