import { afterEach, describe, expect, it, vi } from "vitest";
import { accessMutationRequestSchema } from "@planweave-ai/collaboration-protocol/access/control";
import { applyMigrations } from "../migrations.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { createRegistryIdentityProjectAuthority } from "../composition/identityAccess.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openFixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w-other','Other workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01',NULL),
      ('w','editor','Editor','2026-01-01',NULL),
      ('w','viewer','Viewer','2026-01-01',NULL),
      ('w-other','owner-other','Owner','2026-01-01',NULL),
      ('w-other','editor-other','Editor','2026-01-01',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),
      ('w','m-editor','editor','member',1,'2026-01-01','2026-01-01',NULL),
      ('w','m-viewer','viewer','member',1,'2026-01-01','2026-01-01',NULL),
      ('w-other','m-owner','owner-other','owner',1,'2026-01-01','2026-01-01',NULL),
      ('w-other','m-editor','editor-other','member',1,'2026-01-01','2026-01-01',NULL);
  `);
  return {
    database,
    access: new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"))
  };
}

const owner = { kind: "human", id: "owner" } as const;
const editor = { kind: "human", id: "editor" } as const;
const viewer = { kind: "human", id: "viewer" } as const;

async function registered() {
  const fixture = await openFixture();
  fixture.access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: "/tmp/planweave-project",
    ownerHumanPrincipalId: "owner"
  });
  fixture.access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "c",
    packageDir: "/tmp/planweave-project-canvas",
    ownerHumanPrincipalId: "owner"
  });
  return fixture;
}

describe("project access registry", () => {
  it("uses only active registry rows for identity scope authority", async () => {
    const { access, database } = await registered();
    expect(access.registry.hasActiveProject("p")).toBe(true);
    expect(access.registry.hasActiveProject("missing")).toBe(false);
    expect(access.registry.hasActiveScope({ workspaceId: "w", projectId: "p" })).toBe(true);
    expect(
      access.registry.hasActiveScope({ workspaceId: "w", projectId: "p", canvasId: "c" })
    ).toBe(true);
    expect(
      access.registry.hasActiveScope({ workspaceId: "w", projectId: "p", canvasId: "gone" })
    ).toBe(false);
    expect(access.registry.hasActiveScope({ workspaceId: "w-other", projectId: "p" })).toBe(false);

    const runtimeAuthority = { hasProject: () => true, hasScope: () => true };
    const identityAuthority = createRegistryIdentityProjectAuthority(access.registry);
    expect(identityAuthority.hasProject("p")).toBe(true);
    expect(identityAuthority.hasProject("missing")).toBe(false);
    expect(identityAuthority.hasScope({ workspaceId: "w", projectId: "p" })).toBe(true);
    expect(runtimeAuthority.hasProject("missing")).toBe(true);
    expect(runtimeAuthority.hasScope({ workspaceId: "w", projectId: "missing" })).toBe(true);

    database.exec(
      "UPDATE project_registry SET revoked_at='2026-01-03T00:00:00.000Z' WHERE project_id='p'"
    );
    expect(access.registry.hasActiveProject("p")).toBe(false);
    expect(access.registry.hasActiveScope({ workspaceId: "w", projectId: "p" })).toBe(false);
    expect(runtimeAuthority.hasProject("p")).toBe(true);
    expect(runtimeAuthority.hasScope({ workspaceId: "w", projectId: "p" })).toBe(true);
    expect(identityAuthority.hasProject("p")).toBe(false);
    expect(identityAuthority.hasScope({ workspaceId: "w", projectId: "p" })).toBe(false);
  });

  it("publishes authority changes only after an ACL transaction commits", async () => {
    const { database } = await registered();
    const publish = vi.fn();
    const access = new ProjectAccessRepository(
      database,
      () => new Date("2026-01-02T00:00:00.000Z"),
      publish
    );
    database.exec(
      `CREATE TRIGGER reject_test_access_grant BEFORE INSERT ON project_access_grants
       BEGIN SELECT RAISE(ABORT, 'forced_acl_rollback'); END`
    );

    expect(() =>
      access.grant({
        workspaceId: "w",
        projectId: "p",
        humanPrincipalId: "viewer",
        role: "viewer",
        grantedBy: owner
      })
    ).toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("projects only active grants in the requested workspace and scope", async () => {
    const { access } = await registered();
    access.registerProjectInternal({
      workspaceId: "w-other",
      projectId: "p",
      projectRoot: "/tmp/other-project",
      ownerHumanPrincipalId: "owner-other"
    });
    access.registerCanvasInternal({
      workspaceId: "w-other",
      projectId: "p",
      canvasId: "c",
      packageDir: "/tmp/other-project-canvas",
      ownerHumanPrincipalId: "owner-other"
    });
    const projectGrant = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    const canvasGrant = access.grant({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      humanPrincipalId: "editor",
      role: "viewer",
      grantedBy: owner
    });
    const otherGrant = access.grant({
      workspaceId: "w-other",
      projectId: "p",
      humanPrincipalId: "editor-other",
      role: "viewer",
      grantedBy: { kind: "human", id: "owner-other" }
    });

    expect(
      access.listActiveCanvasPersonGrants({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "editor"
      })
    ).toEqual([
      { grantId: projectGrant.grantId, scopeKind: "project", role: "editor" },
      { grantId: canvasGrant.grantId, scopeKind: "canvas", role: "viewer" }
    ]);
    expect(
      access.listActiveCanvasPersonGrants({
        workspaceId: "w-other",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "editor-other"
      })
    ).toEqual([{ grantId: otherGrant.grantId, scopeKind: "project", role: "viewer" }]);

    access.revoke({
      workspaceId: "w",
      projectId: "p",
      canvasId: null,
      grantId: projectGrant.grantId,
      actor: owner,
      expectedAclRevision: 1
    });
    expect(
      access.listActiveCanvasPersonGrants({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "editor"
      })
    ).toEqual([{ grantId: canvasGrant.grantId, scopeKind: "canvas", role: "viewer" }]);
  });

  it("keeps grants and revokes owner-only and makes revoke replay idempotent", async () => {
    const { access } = await registered();
    const projectEditor = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    const projectViewer = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    expect(() =>
      access.grant({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "viewer",
        role: "viewer",
        grantedBy: editor
      })
    ).toThrow("access_capability_denied:capability_denied");
    const revoked = access.revoke({
      workspaceId: "w",
      projectId: "p",
      canvasId: null,
      grantId: projectViewer.grantId,
      actor: owner,
      expectedAclRevision: 2
    });
    expect(
      access.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: null,
        grantId: projectViewer.grantId,
        actor: owner,
        expectedAclRevision: 2
      })
    ).toEqual(revoked);
    expect(() =>
      access.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: null,
        grantId: projectViewer.grantId,
        actor: editor,
        expectedAclRevision: 2
      })
    ).toThrow("access_capability_denied:capability_denied");
    const canvasEditor = access.grant({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    expect(
      access.grant({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "viewer",
        role: "viewer",
        grantedBy: owner
      }).scopeKind
    ).toBe("canvas");
    expect(projectEditor.scopeKind).toBe("project");
    expect(canvasEditor.scopeKind).toBe("canvas");
  });

  it("inherits project grants consistently for private and shared canvas list and exact reads", async () => {
    const { access } = await registered();
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });

    for (const visibility of ["private", "shared"] as const) {
      if (visibility === "shared") {
        expect(
          access.compareAndSetAccess({
            actor: owner,
            request: accessMutationRequestSchema.parse({
              operation: "visibility",
              scope: {
                scopeKind: "canvas",
                workspaceId: "w",
                projectId: "p",
                canvasId: "c"
              },
              expectedAclRevision: 0,
              visibility
            })
          })
        ).toMatchObject({ status: "applied", aclRevision: 1 });
      }

      for (const [actor, role] of [
        [owner, "owner"],
        [editor, "editor"],
        [viewer, "viewer"]
      ] as const) {
        expect(
          access
            .listAuthorizedCanvases({
              workspaceId: "w",
              projectId: "p",
              actor,
              limit: 1,
              offset: 0
            })
            .map((canvas) => canvas.registry.canvasId)
        ).toEqual(["c"]);
        expect(
          access.evaluateEffectiveAccess({
            workspaceId: "w",
            projectId: "p",
            canvasId: "c",
            actor
          })
        ).toMatchObject({ effectiveRole: role, capabilities: { read: true } });
      }
    }
  });

  it("keeps SQL pagination bounded to authorized rows", async () => {
    const { access } = await registered();
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    expect(
      access.listAuthorizedProjects({ workspaceId: "w", actor: editor, limit: 1, offset: 0 })
    ).toHaveLength(1);
    expect(
      access.listAuthorizedCanvases({
        workspaceId: "w",
        projectId: "p",
        actor: editor,
        limit: 1,
        offset: 0
      })
    ).toHaveLength(1);
  });

  it("uses the shared capability matrix for visibility, explicit grants, and CAS", async () => {
    const { access } = await registered();
    const projectScope = {
      scopeKind: "project" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: null
    };
    const canvasScope = { ...projectScope, scopeKind: "canvas" as const, canvasId: "c" };
    const visibility = access.compareAndSetAccess({
      actor: owner,
      request: accessMutationRequestSchema.parse({
        operation: "visibility",
        scope: projectScope,
        expectedAclRevision: 0,
        visibility: "shared"
      })
    });
    expect(visibility).toEqual({
      status: "applied",
      aclRevision: 1,
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    const sharedViewer = access.evaluateEffectiveAccess({
      workspaceId: "w",
      projectId: "p",
      actor: viewer
    });
    expect(sharedViewer).toMatchObject({ effectiveRole: "viewer" });
    expect(sharedViewer.capabilities).toMatchObject({
      read: true,
      persistent_canvas_command: false,
      assignment: false,
      comment: false,
      grant: false,
      revoke: false,
      administration: false,
      visibility: false
    });

    const grant = access.compareAndSetAccess({
      actor: owner,
      request: accessMutationRequestSchema.parse({
        operation: "grant",
        scope: canvasScope,
        expectedAclRevision: 0,
        humanPrincipalId: "editor",
        role: "editor"
      })
    });
    expect(grant).toMatchObject({ status: "applied", aclRevision: 1 });
    const editorAccess = access.evaluateEffectiveAccess({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      actor: editor
    });
    expect(editorAccess.capabilities).toMatchObject({
      persistent_canvas_command: true,
      assignment: true,
      comment: true,
      grant: false,
      revoke: false,
      administration: false,
      visibility: false
    });
    const stale = access.compareAndSetAccess({
      actor: owner,
      request: accessMutationRequestSchema.parse({
        operation: "visibility",
        scope: canvasScope,
        expectedAclRevision: 0,
        visibility: "shared"
      })
    });
    expect(stale).toEqual({ status: "conflict", reason: "acl_revision_conflict", aclRevision: 1 });
    const editorGrant = access.compareAndSetAccess({
      actor: editor,
      request: accessMutationRequestSchema.parse({
        operation: "grant",
        scope: canvasScope,
        expectedAclRevision: 1,
        humanPrincipalId: "viewer",
        role: "viewer"
      })
    });
    expect(editorGrant).toMatchObject({ status: "denied", reason: "capability_denied" });
  });

  it("does not advance the ACL revision when a revoke is replayed", async () => {
    const { access } = await registered();
    const grant = access.grant({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    const request = (expectedAclRevision: number) =>
      accessMutationRequestSchema.parse({
        operation: "revoke",
        scope: { scopeKind: "canvas", workspaceId: "w", projectId: "p", canvasId: "c" },
        expectedAclRevision,
        grantId: grant.grantId
      });
    expect(access.compareAndSetAccess({ actor: owner, request: request(1) })).toMatchObject({
      status: "applied",
      aclRevision: 2
    });
    expect(access.compareAndSetAccess({ actor: owner, request: request(2) })).toEqual({
      status: "conflict",
      reason: "acl_revision_conflict",
      aclRevision: 2
    });
    expect(access.canvas("w", "p", "c")?.acl.revision).toBe(2);
  });

  it("requires explicit active owner initialization and verifies registration replay", async () => {
    const { access } = await openFixture();
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "ownerless",
      projectRoot: "/tmp/ownerless",
      visibility: "private"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "ownerless",
      canvasId: "c",
      packageDir: "/tmp/ownerless-c",
      visibility: "private"
    });
    expect(() =>
      access.registerProjectInternal({
        workspaceId: "w",
        projectId: "ownerless",
        projectRoot: "/tmp/ownerless",
        visibility: "shared",
        ownerHumanPrincipalId: "owner"
      })
    ).toThrow("project_registry_conflict");
    expect(() => access.initializeProjectOwner("w", "ownerless", "missing")).toThrow(
      "project_registry_owner_not_active"
    );
    const project = access.initializeProjectOwner("w", "ownerless", "owner");
    expect(project.ownerHumanPrincipalId).toBe("owner");
    expect(access.registry.canvasInternal("w", "ownerless", "c")?.ownerHumanPrincipalId).toBe(
      "owner"
    );
    expect(() => access.initializeProjectOwner("w", "ownerless", "editor")).toThrow(
      "project_registry_owner_conflict"
    );
    expect(access.project("w", "ownerless")?.owner).toBe("owner");
  });

  it("transfers registry ownership and preserves independent canvas owners", async () => {
    const { database, access } = await openFixture();
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES
        ('owner','Owner','2026-01-01'),('editor','Editor','2026-01-01'),('viewer','Viewer','2026-01-01');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,revision,created_at,updated_at
      ) VALUES
        ('m-owner','p','owner','owner',1,'2026-01-01','2026-01-01'),
        ('m-editor','p','editor','owner',1,'2026-01-02','2026-01-02'),
        ('m-viewer','p','viewer','owner',1,'2026-01-03','2026-01-03');
    `);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/transfer-project",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "inherited",
      packageDir: "/tmp/transfer-project-inherited",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "independent",
      packageDir: "/tmp/transfer-project-independent",
      ownerHumanPrincipalId: "viewer"
    });

    inWriteTransaction(database, () => {
      database
        .prepare(
          "UPDATE project_memberships SET role='member',revision=revision+1 WHERE membership_id=?"
        )
        .run("m-owner");
      database
        .prepare(
          "UPDATE workspace_memberships SET role='member',revision=revision+1 WHERE workspace_id=? AND human_principal_id=?"
        )
        .run("w", "owner");
      access.synchronizeHumanMembershipOwnerInCallerTransaction({
        workspaceId: "w",
        projectId: "p",
        humanPrincipalId: "owner",
        transition: "owner_demoted",
        membershipRole: "member"
      });
    });
    expect(access.project("w", "p")?.owner).toBe("editor");
    expect(access.canvas("w", "p", "inherited")?.owner).toBe("editor");
    expect(access.canvas("w", "p", "independent")?.owner).toBe("viewer");

    inWriteTransaction(database, () => {
      database
        .prepare(
          "UPDATE project_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE membership_id=?"
        )
        .run("m-editor");
      database
        .prepare(
          "UPDATE workspace_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE workspace_id=? AND human_principal_id=?"
        )
        .run("w", "editor");
      access.synchronizeHumanMembershipOwnerInCallerTransaction({
        workspaceId: "w",
        projectId: "p",
        humanPrincipalId: "editor",
        transition: "member_removed",
        membershipRole: "owner"
      });
    });
    expect(access.project("w", "p")?.owner).toBe("viewer");
    expect(access.canvas("w", "p", "inherited")?.owner).toBe("viewer");
    expect(access.canvas("w", "p", "independent")?.owner).toBe("viewer");
  });

  it("transfers independent canvas ownership when a member is removed", async () => {
    const { database, access } = await openFixture();
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES
        ('owner','Owner','2026-01-01'),('editor','Editor','2026-01-01');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,revision,created_at,updated_at
      ) VALUES
        ('m-owner','p','owner','owner',1,'2026-01-01','2026-01-01'),
        ('m-member','p','editor','member',1,'2026-01-02','2026-01-02');
    `);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/member-removal-project",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "independent",
      packageDir: "/tmp/member-removal-project-independent",
      ownerHumanPrincipalId: "editor"
    });

    inWriteTransaction(database, () => {
      database
        .prepare(
          "UPDATE project_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE membership_id=?"
        )
        .run("m-member");
      database
        .prepare(
          "UPDATE workspace_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE workspace_id=? AND human_principal_id=?"
        )
        .run("w", "editor");
      access.synchronizeHumanMembershipOwnerInCallerTransaction({
        workspaceId: "w",
        projectId: "p",
        humanPrincipalId: "editor",
        transition: "member_removed",
        membershipRole: "member"
      });
    });

    expect(access.canvas("w", "p", "independent")?.owner).toBe("owner");
  });

  it("transfers independent canvas ownership through HumanIdentityRepository removal", async () => {
    const { database, access } = await openFixture();
    database.exec(`
      UPDATE workspace_principals SET created_at='2026-01-01T00:00:00.000Z' WHERE workspace_id='w';
      UPDATE workspace_memberships
      SET created_at='2026-01-01T00:00:00.000Z',updated_at='2026-01-01T00:00:00.000Z'
      WHERE workspace_id='w';
    `);
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES
        ('owner','Owner','2026-01-01T00:00:00.000Z'),('editor','Editor','2026-01-01T00:00:00.000Z');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,revision,created_at,updated_at
      ) VALUES
        ('m-owner','p','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
        ('m-member','p','editor','member',1,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z');
      INSERT INTO legacy_project_workspace_mappings(
        legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
      ) VALUES ('p','legacy-project:p','w','2026-01-01T00:00:00.000Z');
      INSERT INTO workspace_identity_migrations(
        migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
        interruption_marker,authoritative_read_version,failure_code,updated_at
      ) VALUES(
        'identity-migration-p','p','w',0,1,'verify_cutover','completed',
        'read_cutover_complete','workspace-identity/v1',NULL,'2026-01-01T00:00:00.000Z'
      );
    `);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/identity-removal-project",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "independent",
      packageDir: "/tmp/identity-removal-project-independent",
      ownerHumanPrincipalId: "editor"
    });
    const identity = new HumanIdentityRepository(database, () => new Date("2026-01-04T00:00:00Z"), {
      onMembershipTransitionInTransaction: ({ membership, principal, type }) => {
        access.synchronizeHumanMembershipOwnerInCallerTransaction({
          workspaceId: "w",
          projectId: membership.projectId,
          humanPrincipalId: principal.humanPrincipalId,
          transition: type,
          membershipRole: membership.role
        });
      }
    });

    expect(identity.removeMember("p", "editor").humanPrincipalId).toBe("editor");
    expect(access.canvas("w", "p", "independent")?.owner).toBe("owner");
  });
});
