import { createServer, type Server as HttpServer } from "node:http";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { afterEach, describe, expect, it } from "vitest";
import { handleAccessHttpRequest } from "../accessHttp.js";
import { applyMigrations } from "../migrations.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const servers: HttpServer[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-a");
  const identity = new HumanIdentityRepository(database);
  const owner = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId: "project-a",
    humanPrincipalId: "owner",
    displayName: "Owner",
    issuedAt: "2026-01-01T00:00:00.000Z"
  });
  const invitation = identity.createInvitation({
    projectId: "project-a",
    createdByHumanPrincipalId: "owner"
  });
  const viewer = identity.consumeInvitation({
    projectId: "project-a",
    invitationToken: invitation.invitationToken,
    displayName: "Viewer"
  });
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({
    workspaceId,
    projectId: "project-a",
    projectRoot: "/srv/a",
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId,
    projectId: "project-a",
    canvasId: "default",
    packageDir: "/srv/a/default",
    ownerHumanPrincipalId: "owner"
  });
  const server = createServer((request, response) => {
    void handleAccessHttpRequest(request, response, {
      access,
      repository: identity,
      workspaceIdentity,
      collaborationScopeAuthority: {
        hasScope: (scope) =>
          scope.workspaceId === workspaceId &&
          scope.projectId === "project-a" &&
          scope.canvasId === "default",
        hasProject: (projectId) => projectId === "project-a"
      },
      transportAdmission: loopbackHttpTransportAdmission
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  return { access, workspaceId, origin: `http://127.0.0.1:${address.port}`, owner, viewer };
}

describe("access HTTP", () => {
  it("does not expose People for a private active workspace member", async () => {
    const state = await fixture();
    const response = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        headers: { Authorization: `Bearer ${state.viewer.deviceToken}` }
      }
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: "scope_private" });
    expect(JSON.stringify(body)).not.toContain("people");
  });

  it("returns redacted current scope only to readers and rejects cross-workspace mutation scope", async () => {
    const state = await fixture();
    const current = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        headers: { Authorization: `Bearer ${state.owner.deviceToken}` }
      }
    );
    expect(current.status).toBe(200);
    const view = await current.json();
    expect(view.project.effectiveRole).toBe("owner");
    expect(view.canvas.effectiveRole).toBe("owner");
    expect(view).toMatchObject({ projectAclRevision: 0, canvasAclRevision: 0 });
    expect(JSON.stringify(view)).not.toMatch(/projectRoot|packageDir|\/srv/);

    const projectVisibility = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.owner.deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          operation: "visibility",
          scope: {
            scopeKind: "project",
            workspaceId: state.workspaceId,
            projectId: "project-a",
            canvasId: null
          },
          expectedAclRevision: 0,
          visibility: "shared"
        })
      }
    );
    expect(projectVisibility.status).toBe(200);
    await expect(projectVisibility.json()).resolves.toMatchObject({
      status: "applied",
      aclRevision: 1
    });

    const canvasVisibility = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.owner.deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          operation: "visibility",
          scope: {
            scopeKind: "canvas",
            workspaceId: state.workspaceId,
            projectId: "project-a",
            canvasId: "default"
          },
          expectedAclRevision: 0,
          visibility: "shared"
        })
      }
    );
    expect(canvasVisibility.status).toBe(200);
    await expect(canvasVisibility.json()).resolves.toMatchObject({
      status: "applied",
      aclRevision: 1
    });

    const revised = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        headers: { Authorization: `Bearer ${state.owner.deviceToken}` }
      }
    );
    await expect(revised.json()).resolves.toMatchObject({
      projectVisibility: "shared",
      canvasVisibility: "shared",
      projectAclRevision: 1,
      canvasAclRevision: 1
    });

    const staleProject = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.owner.deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          operation: "visibility",
          scope: {
            scopeKind: "project",
            workspaceId: state.workspaceId,
            projectId: "project-a",
            canvasId: null
          },
          expectedAclRevision: 0,
          visibility: "private"
        })
      }
    );
    expect(staleProject.status).toBe(409);
    await expect(staleProject.json()).resolves.toMatchObject({
      status: "conflict",
      reason: "acl_revision_conflict",
      aclRevision: 1
    });

    const crossWorkspace = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.owner.deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          operation: "visibility",
          scope: {
            scopeKind: "canvas",
            workspaceId: "workspace-other",
            projectId: "project-a",
            canvasId: "default"
          },
          expectedAclRevision: 0,
          visibility: "shared"
        })
      }
    );
    expect(crossWorkspace.status).toBe(403);
    await expect(crossWorkspace.json()).resolves.toEqual({ error: "cross_workspace" });
  });

  it("projects only active exact-scope grants for People revocation", async () => {
    const state = await fixture();
    const projectGrant = state.access.grant({
      workspaceId: state.workspaceId,
      projectId: "project-a",
      humanPrincipalId: state.viewer.principal.humanPrincipalId,
      role: "editor",
      grantedBy: { kind: "human", id: "owner" }
    });
    const canvasGrant = state.access.grant({
      workspaceId: state.workspaceId,
      projectId: "project-a",
      canvasId: "default",
      humanPrincipalId: state.viewer.principal.humanPrincipalId,
      role: "viewer",
      grantedBy: { kind: "human", id: "owner" }
    });
    const current = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        headers: { Authorization: `Bearer ${state.owner.deviceToken}` }
      }
    );
    const view = (await current.json()) as {
      people: Array<{ humanPrincipalId: string; grants: unknown[] }>;
    };
    expect(view.people.find((person) => person.humanPrincipalId === "owner")?.grants).toEqual([]);
    expect(
      view.people.find(
        (person) => person.humanPrincipalId === state.viewer.principal.humanPrincipalId
      )?.grants
    ).toEqual([
      { grantId: projectGrant.grantId, scopeKind: "project", role: "editor" },
      { grantId: canvasGrant.grantId, scopeKind: "canvas", role: "viewer" }
    ]);

    state.access.revoke({
      workspaceId: state.workspaceId,
      projectId: "project-a",
      canvasId: null,
      grantId: projectGrant.grantId,
      actor: { kind: "human", id: "owner" },
      expectedAclRevision: 1
    });
    state.access.revoke({
      workspaceId: state.workspaceId,
      projectId: "project-a",
      canvasId: "default",
      grantId: canvasGrant.grantId,
      actor: { kind: "human", id: "owner" },
      expectedAclRevision: 1
    });
    const refreshed = await fetch(
      `${state.origin}/api/v1/projects/project-a/canvases/default/access`,
      {
        headers: { Authorization: `Bearer ${state.owner.deviceToken}` }
      }
    );
    const refreshedView = (await refreshed.json()) as {
      people: Array<{ humanPrincipalId: string; grants: unknown[] }>;
    };
    expect(
      refreshedView.people.find(
        (person) => person.humanPrincipalId === state.viewer.principal.humanPrincipalId
      )?.grants
    ).toEqual([]);
  });
});
