import { describe, expect, it } from "vitest";
import {
  canvasAccessRecordSchema,
  canvasAccessRequestSchema,
  membershipGrantSchema,
  projectAccessRecordSchema,
  projectAccessDecisionSchema,
  projectAccessRequestSchema,
  registryPageQuerySchema,
  registryClientCommandSchema,
  serverAccessContextSchema
} from "../projectAccess.js";
import {
  exampleCanvasAccessRecord,
  exampleProjectAccessRecord
} from "../fixtures/collaboration.js";

const actor = { kind: "human" as const, id: "human-owner-001", displayName: "Owner" };
const registry = {
  projectRegistryId: "registry-project-001",
  workspaceId: "workspace-demo-001",
  projectId: "project-demo-001"
};
const canvasRegistry = {
  projectRegistryId: registry.projectRegistryId,
  canvasRegistryId: "registry-canvas-001",
  workspaceId: registry.workspaceId,
  projectId: registry.projectId,
  canvasId: "canvas-default"
};

describe("project and canvas access contracts", () => {
  it("keeps client requests opaque and path-free", () => {
    expect(projectAccessRequestSchema.parse({ projectId: registry.projectId })).toEqual({
      projectId: registry.projectId
    });
    expect(
      canvasAccessRequestSchema.parse({ projectId: registry.projectId, canvasId: "default" })
    ).toEqual({
      projectId: registry.projectId,
      canvasId: "default"
    });
    for (const value of [
      { projectId: registry.projectId, projectRoot: "/srv/planweave" },
      { projectId: registry.projectId, path: "../../etc/passwd" },
      { projectId: registry.projectId, actor },
      { projectId: registry.projectId, workspaceId: registry.workspaceId }
    ]) {
      expect(() => projectAccessRequestSchema.parse(value)).toThrow();
    }
  });

  it("requires Server-injected actor and scope for authorization context", () => {
    expect(
      serverAccessContextSchema.parse({
        actor,
        scope: {
          workspaceId: registry.workspaceId,
          projectId: registry.projectId,
          canvasId: canvasRegistry.canvasId
        },
        aclRevision: 3
      }).scope.canvasId
    ).toBe(canvasRegistry.canvasId);
    expect(() =>
      serverAccessContextSchema.parse({
        scope: { projectId: registry.projectId },
        aclRevision: 3
      })
    ).toThrow();
  });

  it("distinguishes private/shared records and explicit denial states", () => {
    expect(exampleProjectAccessRecord.visibility).toBe("private");
    expect(exampleCanvasAccessRecord.visibility).toBe("shared");
    expect(
      projectAccessRecordSchema.parse({
        schemaVersion: "project-access/v1",
        registry,
        visibility: "private",
        acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
        owner: actor.id,
        updatedAt: "2030-01-01T00:00:00.000Z"
      }).visibility
    ).toBe("private");
    expect(
      canvasAccessRecordSchema.parse({
        schemaVersion: "project-access/v1",
        registry: canvasRegistry,
        visibility: "shared",
        acl: { revision: 2, updatedAt: "2030-01-01T00:00:00.000Z" },
        owner: actor.id,
        updatedAt: "2030-01-01T00:00:00.000Z"
      }).visibility
    ).toBe("shared");
    expect(
      projectAccessDecisionSchema.parse({ decision: "deny", reason: "revoked", aclRevision: 4 })
    ).toEqual({
      decision: "deny",
      reason: "revoked",
      aclRevision: 4
    });
  });

  it("rejects malformed grants and unbounded registry operations", () => {
    const grant = {
      schemaVersion: "project-access/v1",
      grantId: "grant-001",
      workspaceId: registry.workspaceId,
      projectId: registry.projectId,
      canvasId: null,
      scopeKind: "project" as const,
      humanPrincipalId: actor.id,
      role: "viewer" as const,
      aclRevision: 1,
      grantedBy: actor,
      grantedAt: "2030-01-01T00:00:00.000Z",
      revokedAt: null
    };
    expect(membershipGrantSchema.parse(grant).role).toBe("viewer");
    expect(() => membershipGrantSchema.parse({ ...grant, token: "secret" })).toThrow();
    for (const operation of [
      "directory_enumeration",
      "watch",
      "upload",
      "download",
      "bidirectional_sync",
      "billing",
      "subscription",
      "license",
      "entitlement",
      "ssh",
      "vps",
      "crdt"
    ]) {
      expect(() => registryClientCommandSchema.parse({ operation })).toThrow();
    }
    expect(registryClientCommandSchema.parse({ operation: "list_authorized_projects" })).toEqual({
      operation: "list_authorized_projects"
    });
    expect(registryPageQuerySchema.parse({})).toEqual({ cursor: 0, limit: 100 });
    expect(
      registryClientCommandSchema.parse({
        operation: "list_authorized_canvases",
        projectId: registry.projectId,
        cursor: 10,
        limit: 20
      })
    ).toMatchObject({ operation: "list_authorized_canvases", cursor: 10, limit: 20 });
    expect(
      registryClientCommandSchema.parse({
        operation: "register_canvas",
        projectId: registry.projectId,
        canvasId: canvasRegistry.canvasId
      })
    ).toEqual({
      operation: "register_canvas",
      projectId: registry.projectId,
      canvasId: canvasRegistry.canvasId
    });
    expect(() =>
      registryClientCommandSchema.parse({
        operation: "register_canvas",
        projectId: registry.projectId,
        canvasId: canvasRegistry.canvasId,
        packageDir: "/srv/private"
      })
    ).toThrow();
    expect(() => registryPageQuerySchema.parse({ limit: 101 })).toThrow();
    expect(() => registryPageQuerySchema.parse({ cursor: -1 })).toThrow();
    expect(
      registryClientCommandSchema.parse({
        operation: "create_snapshot",
        projectId: registry.projectId,
        canvasId: canvasRegistry.canvasId,
        expectedAclRevision: 2
      }).operation
    ).toBe("create_snapshot");
    expect(() =>
      registryClientCommandSchema.parse({
        operation: "read_snapshot",
        projectId: registry.projectId,
        snapshotId: "snapshot-001"
      })
    ).toThrow();
  });
});
