import { createServer, type Server as HttpServer } from "node:http";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { afterEach, describe, expect, it } from "vitest";
import { actorRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { type RegistryHttpService } from "../registryHttp.js";
import { handleRegistryHttpRequest, type RegistryHttpOptions } from "../registryHttp.js";
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

async function setup() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-a");
  const identity = new HumanIdentityRepository(database);
  const owner = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId: "project-a",
    humanPrincipalId: "human-owner",
    displayName: "Owner",
    issuedAt: "2026-01-01T00:00:00.000Z"
  });
  const access = new ProjectAccessRepository(database);
  access.registerProjectInternal({
    workspaceId,
    projectId: "project-a",
    projectRoot: "/srv/project-a",
    ownerHumanPrincipalId: owner.principal.humanPrincipalId
  });
  access.registerCanvasInternal({
    workspaceId,
    projectId: "project-a",
    canvasId: "default",
    packageDir: "/srv/project-a/canvases/default",
    ownerHumanPrincipalId: owner.principal.humanPrincipalId
  });
  access.registerCanvasInternal({
    workspaceId,
    projectId: "project-a",
    canvasId: "shared",
    packageDir: "/srv/project-a/canvases/shared",
    visibility: "shared",
    ownerHumanPrincipalId: owner.principal.humanPrincipalId
  });
  access.registerProjectInternal({
    workspaceId,
    projectId: "project-b",
    projectRoot: "/srv/project-b",
    ownerHumanPrincipalId: owner.principal.humanPrincipalId
  });
  const service: RegistryHttpService = {
    listProjects(input) {
      const items = access.listAuthorizedProjects({
        workspaceId: input.workspaceId,
        actor: input.actor,
        limit: input.limit,
        offset: input.cursor
      });
      return {
        items,
        nextCursor: items.length === input.limit ? input.cursor + input.limit : null
      };
    },
    listCanvases(input) {
      const items = access.listAuthorizedCanvases({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: input.actor,
        limit: input.limit,
        offset: input.cursor
      });
      return {
        items,
        nextCursor: items.length === input.limit ? input.cursor + input.limit : null
      };
    },
    readSnapshot() {
      throw new Error("snapshot_not_found");
    },
    createSnapshot() {
      throw new Error("snapshot_not_found");
    },
    restoreSnapshot() {
      return {
        schemaVersion: "package-snapshot/v1",
        outcome: "conflict",
        snapshotId: "snapshot-001",
        scope: { workspaceId, projectId: "project-a", canvasId: "default" },
        actor: { kind: "human", id: "human-owner", displayName: "Owner" },
        aclRevision: 1,
        migrationMarker: "none",
        sourceRevision: null,
        restoredAt: null,
        detail: "stale_acl_revision"
      };
    }
  };
  const options: RegistryHttpOptions = {
    repository: identity,
    workspaceIdentity,
    service,
    transportAdmission: loopbackHttpTransportAdmission
  };
  const server = createServer((request, response) => {
    void handleRegistryHttpRequest(request, response, options);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    token: owner.deviceToken!,
    database,
    access,
    identity,
    workspaceIdentity,
    workspaceId,
    service
  };
}

describe("registry HTTP boundary", () => {
  it("maps an unavailable Canvas Runtime to 503 after authentication and preserves ACL denial", async () => {
    const fixture = await setup();
    fixture.service.createSnapshot = async (input) => {
      if (input.actor.id !== "human-owner") throw new Error("canvas_access_denied:not_member");
      throw new Error("canvas_runtime_unavailable");
    };
    const snapshotUrl = `${fixture.origin}/api/v1/registry/projects/project-a/canvases/default/snapshots`;
    const request = (token: string) =>
      fetch(snapshotUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          projectId: "project-a",
          canvasId: "default",
          expectedAclRevision: 1
        })
      });

    const unavailable = await request(fixture.token);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "canvas_runtime_unavailable" });

    const invitation = fixture.identity.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: "human-owner"
    });
    const viewer = fixture.identity.consumeInvitation({
      projectId: "project-a",
      invitationToken: invitation.invitationToken,
      displayName: "Viewer"
    });
    const denied = await request(viewer.deviceToken);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "registry_resource_not_found" });
  });

  it("lists only redacted registry records with bounded pagination", async () => {
    const fixture = await setup();
    const response = await fetch(`${fixture.origin}/api/v1/registry/projects?cursor=0&limit=1`, {
      headers: { Authorization: `Bearer ${fixture.token}` }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/projectRoot|packageDir|absolute|\/srv/);
    expect(body.items[0]).toMatchObject({ visibility: "private" });
    expect(() => actorRefSchema.parse({ kind: "human", id: "human-owner" })).not.toThrow();

    const secondPage = await fetch(`${fixture.origin}/api/v1/registry/projects?cursor=1&limit=1`, {
      headers: { Authorization: `Bearer ${fixture.token}` }
    });
    expect(secondPage.status).toBe(200);
    const secondBody = (await secondPage.json()) as {
      items: Array<{ registry: { projectId: string } }>;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0].registry.projectId).not.toBe(
      (body.items[0].registry as { projectId: string }).projectId
    );

    const invalid = await fetch(`${fixture.origin}/api/v1/registry/projects?limit=101`, {
      headers: { Authorization: `Bearer ${fixture.token}` }
    });
    expect(invalid.status).toBe(400);
    for (const query of ["cursor=abc", "cursor=1&cursor=2", "cursor=9007199254740992"]) {
      const malformed = await fetch(`${fixture.origin}/api/v1/registry/projects?${query}`, {
        headers: { Authorization: `Bearer ${fixture.token}` }
      });
      expect(malformed.status).toBe(400);
    }
  });

  it("authenticates before exposing registry resources and rejects browser/sync paths", async () => {
    const fixture = await setup();
    const unauthenticated = await fetch(`${fixture.origin}/api/v1/registry/projects`);
    expect(unauthenticated.status).toBe(401);

    for (const path of [
      "/api/v1/registry/directory",
      "/api/v1/registry/watch",
      "/api/v1/registry/upload",
      "/api/v1/registry/download",
      "/api/v1/registry/sync"
    ]) {
      const rejected = await fetch(`${fixture.origin}${path}`, {
        headers: { Authorization: `Bearer ${fixture.token}` }
      });
      expect(rejected.status).toBe(404);
    }
  });

  it("keeps project/canvas ACLs independent, rejects ambiguous workspace scope, and returns conflicts", async () => {
    const fixture = await setup();
    const invitation = fixture.identity.createInvitation({
      projectId: "project-a",
      createdByHumanPrincipalId: "human-owner"
    });
    const viewer = fixture.identity.consumeInvitation({
      projectId: "project-a",
      invitationToken: invitation.invitationToken,
      displayName: "Viewer"
    });

    const viewerProjects = await fetch(`${fixture.origin}/api/v1/registry/projects`, {
      headers: { Authorization: `Bearer ${viewer.deviceToken}` }
    });
    expect(viewerProjects.status).toBe(200);
    expect((await viewerProjects.json()).items).toEqual([]);

    const viewerCanvases = await fetch(
      `${fixture.origin}/api/v1/registry/projects/project-a/canvases`,
      { headers: { Authorization: `Bearer ${viewer.deviceToken}` } }
    );
    expect(viewerCanvases.status).toBe(200);
    const canvasItems = (await viewerCanvases.json()).items as Array<{
      registry: { canvasId: string };
    }>;
    expect(canvasItems.map((item) => item.registry.canvasId)).toEqual(["shared"]);

    const otherWorkspaceId = fixture.workspaceIdentity.ensureWorkspaceForLegacyProject("project-c");
    fixture.database
      .prepare(
        "INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)"
      )
      .run(otherWorkspaceId, "human-owner", "Owner", "2026-01-01T00:00:00.000Z");
    fixture.database
      .prepare(
        "INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)"
      )
      .run(
        otherWorkspaceId,
        "workspace-membership-cross",
        "human-owner",
        "member",
        1,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      );
    fixture.access.registerProjectInternal({
      workspaceId: otherWorkspaceId,
      projectId: "project-c",
      projectRoot: "/srv/project-c",
      ownerHumanPrincipalId: "human-owner"
    });
    const scopedWorkspace = await fetch(`${fixture.origin}/api/v1/registry/projects`, {
      headers: { Authorization: `Bearer ${fixture.token}` }
    });
    expect(scopedWorkspace.status).toBe(200);
    const scopedItems = (await scopedWorkspace.json()).items as Array<{
      registry: { workspaceId: string; projectId: string };
    }>;
    expect(scopedItems).toHaveLength(2);
    const scopedProjectIds = scopedItems.map((item) => item.registry.projectId).sort();
    expect(scopedProjectIds).toEqual(["project-a", "project-b"]);
    expect(scopedProjectIds).not.toContain("project-c");
    expect(scopedItems.map((item) => item.registry.workspaceId)).toEqual([
      fixture.workspaceId,
      fixture.workspaceId
    ]);
    expect(scopedItems.map((item) => item.registry.workspaceId)).not.toContain(otherWorkspaceId);

    fixture.database
      .prepare(
        "DELETE FROM workspace_device_sessions WHERE workspace_id=? AND human_principal_id=?"
      )
      .run(fixture.workspaceId, "human-owner");
    const ambiguousWorkspace = await fetch(`${fixture.origin}/api/v1/registry/projects`, {
      headers: { Authorization: `Bearer ${fixture.token}` }
    });
    expect(ambiguousWorkspace.status).toBe(403);
    expect(await ambiguousWorkspace.json()).toEqual({
      error: "registry_workspace_scope_forbidden"
    });

    fixture.database
      .prepare(
        "UPDATE workspace_memberships SET revoked_at=?,updated_at=? WHERE workspace_id=? AND human_principal_id=?"
      )
      .run("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", otherWorkspaceId, "human-owner");

    const conflict = await fetch(
      `${fixture.origin}/api/v1/registry/projects/project-a/canvases/default/snapshots/snapshot-001/restore`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          projectId: "project-a",
          canvasId: "default",
          snapshotId: "snapshot-001",
          expectedAclRevision: 0
        })
      }
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).outcome).toBe("conflict");
  });
});
