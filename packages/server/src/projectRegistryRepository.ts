import { isAbsolute } from "node:path";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  type CanvasAccessRecord,
  type ProjectAccessRecord
} from "@planweave-ai/collaboration-protocol/access/project";
import { z } from "zod";
import {
  aclMigrationIdFor,
  canvasRegistryIdFor,
  projectRegistryIdFor,
  readAclRegistryMigration,
  upsertAclRegistryMigration
} from "./migrations/aclRegistry.js";
import {
  canvasAccessRecord,
  parseCanvas,
  parseProject,
  projectAccessRecord,
  type InternalCanvasRecord,
  type InternalProjectRecord
} from "./projectRegistryRecords.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import { assertNoPendingSnapshotRestore } from "./authorizationFence.js";

export {
  canvasAccessRecord,
  parseCanvas,
  parseProject,
  projectAccessRecord
} from "./projectRegistryRecords.js";
export type { InternalCanvasRecord, InternalProjectRecord } from "./projectRegistryRecords.js";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const visibilitySchema = z.enum(["private", "shared"]);
const projectRegistrationSchema = z
  .object({
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    projectRoot: z.string().min(1).max(4096).refine(isAbsolute, "project_root_must_be_absolute"),
    visibility: visibilitySchema.default("private"),
    ownerHumanPrincipalId: identifierSchema.nullable().default(null)
  })
  .strict();
const canvasRegistrationSchema = z
  .object({
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema,
    packageDir: z.string().min(1).max(4096).refine(isAbsolute, "package_dir_must_be_absolute"),
    visibility: visibilitySchema.default("private"),
    ownerHumanPrincipalId: identifierSchema.nullable().default(null)
  })
  .strict();
const pathlessCanvasRegistrationSchema = z
  .object({
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema
  })
  .strict();

export class ProjectRegistryRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  registerProjectInternal(rawInput: unknown): InternalProjectRecord {
    const input = projectRegistrationSchema.parse(rawInput);
    const at = this.clock().toISOString();
    const registryId = projectRegistryIdFor(input.workspaceId, input.projectId);
    return inWriteTransaction(this.database, () => {
      const row = this.database
        .prepare("SELECT * FROM project_registry WHERE workspace_id=? AND project_id=?")
        .get(input.workspaceId, input.projectId) as Record<string, unknown> | undefined;
      if (row) {
        const project = parseProject(row);
        if (
          project.projectRegistryId !== registryId ||
          project.projectRoot !== input.projectRoot ||
          project.visibility !== input.visibility
        )
          throw new Error("project_registry_conflict");
        if (
          input.ownerHumanPrincipalId !== null &&
          project.ownerHumanPrincipalId !== input.ownerHumanPrincipalId
        )
          throw new Error(
            project.ownerHumanPrincipalId === null
              ? "project_registry_owner_initialization_required"
              : "project_registry_conflict"
          );
        if (project.revokedAt !== null) throw new Error("project_registry_revoked");
        return project;
      }
      if (
        input.ownerHumanPrincipalId !== null &&
        !activeWorkspacePrincipal(this.database, input.workspaceId, input.ownerHumanPrincipalId)
      )
        throw new Error("project_registry_owner_not_active");
      this.database
        .prepare(
          `INSERT INTO project_registry(project_registry_id,workspace_id,project_id,project_root_internal,visibility,owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,0,?,?,NULL)`
        )
        .run(
          registryId,
          input.workspaceId,
          input.projectId,
          input.projectRoot,
          input.visibility,
          input.ownerHumanPrincipalId,
          at,
          at
        );
      upsertAclRegistryMigration(this.database, {
        migrationId: aclMigrationIdFor("trusted_project", input.workspaceId, input.projectId),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: null,
        sourceKind: "trusted_project",
        marker: "path_bound",
        status: "in_progress",
        failureCode: null,
        updatedAt: at
      });
      const project = parseProject(
        this.database
          .prepare("SELECT * FROM project_registry WHERE project_registry_id=?")
          .get(registryId) as Record<string, unknown>
      );
      return project;
    });
  }

  registerProject(rawInput: unknown): ProjectAccessRecord | undefined {
    const project = this.registerProjectInternal(rawInput);
    return project.ownerHumanPrincipalId ? projectAccessRecord(project) : undefined;
  }

  registerCanvasInternal(rawInput: unknown): InternalCanvasRecord {
    const input = canvasRegistrationSchema.parse(rawInput);
    const at = this.clock().toISOString();
    const canvasRegistryId = canvasRegistryIdFor(
      input.workspaceId,
      input.projectId,
      input.canvasId
    );
    return inWriteTransaction(this.database, () => {
      const project = this.projectInternal(input.workspaceId, input.projectId);
      if (!project) throw new Error("project_registry_not_found");
      if (project.revokedAt !== null) throw new Error("project_registry_revoked");
      assertNoPendingSnapshotRestore(this.database, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId
      });
      const row = this.database
        .prepare(
          "SELECT * FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .get(input.workspaceId, input.projectId, input.canvasId) as
        | Record<string, unknown>
        | undefined;
      if (row) {
        let canvas = parseCanvas(row);
        const expectedOwner = input.ownerHumanPrincipalId ?? project.ownerHumanPrincipalId;
        if (
          canvas.canvasRegistryId !== canvasRegistryId ||
          (canvas.packageDir !== null && canvas.packageDir !== input.packageDir) ||
          canvas.visibility !== input.visibility
        )
          throw new Error("canvas_registry_conflict");
        if (expectedOwner !== null && canvas.ownerHumanPrincipalId !== expectedOwner)
          throw new Error(
            canvas.ownerHumanPrincipalId === null
              ? "canvas_registry_owner_initialization_required"
              : "canvas_registry_conflict"
          );
        if (canvas.revokedAt !== null) throw new Error("canvas_registry_revoked");
        if (canvas.packageDir === null) {
          const migration = readAclRegistryMigration(this.database, {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            canvasId: input.canvasId,
            sourceKind: "trusted_canvas"
          });
          if (migration?.status === "completed")
            throw new Error("canvas_registry_migration_conflict");
          this.database
            .prepare(
              "UPDATE canvas_registry SET package_dir_internal=?,updated_at=? WHERE canvas_registry_id=? AND package_dir_internal IS NULL"
            )
            .run(input.packageDir, at, canvas.canvasRegistryId);
          upsertAclRegistryMigration(this.database, {
            migrationId: aclMigrationIdFor(
              "trusted_canvas",
              input.workspaceId,
              input.projectId,
              input.canvasId
            ),
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            canvasId: input.canvasId,
            sourceKind: "trusted_canvas",
            marker: "path_bound",
            status: "in_progress",
            failureCode: null,
            updatedAt: at
          });
          canvas = parseCanvas(
            this.database
              .prepare("SELECT * FROM canvas_registry WHERE canvas_registry_id=?")
              .get(canvas.canvasRegistryId) as Record<string, unknown>
          );
        }
        return canvas;
      }
      const ownerHumanPrincipalId = input.ownerHumanPrincipalId ?? project.ownerHumanPrincipalId;
      if (
        ownerHumanPrincipalId !== null &&
        !activeWorkspacePrincipal(this.database, input.workspaceId, ownerHumanPrincipalId)
      )
        throw new Error("canvas_registry_owner_not_active");
      this.database
        .prepare(
          `INSERT INTO canvas_registry(canvas_registry_id,project_registry_id,workspace_id,project_id,canvas_id,package_dir_internal,visibility,owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,NULL)`
        )
        .run(
          canvasRegistryId,
          project.projectRegistryId,
          input.workspaceId,
          input.projectId,
          input.canvasId,
          input.packageDir,
          input.visibility,
          ownerHumanPrincipalId,
          at,
          at
        );
      upsertAclRegistryMigration(this.database, {
        migrationId: aclMigrationIdFor(
          "trusted_canvas",
          input.workspaceId,
          input.projectId,
          input.canvasId
        ),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId,
        sourceKind: "trusted_canvas",
        marker: "canvas_registered",
        status: "in_progress",
        failureCode: null,
        updatedAt: at
      });
      const canvas = parseCanvas(
        this.database
          .prepare("SELECT * FROM canvas_registry WHERE canvas_registry_id=?")
          .get(canvasRegistryId) as Record<string, unknown>
      );
      return canvas;
    });
  }

  registerCanvas(rawInput: unknown): CanvasAccessRecord | undefined {
    const canvas = this.registerCanvasInternal(rawInput);
    return canvas.ownerHumanPrincipalId ? canvasAccessRecord(canvas) : undefined;
  }

  registerPathlessCanvas(rawInput: unknown): CanvasAccessRecord {
    const input = pathlessCanvasRegistrationSchema.parse(rawInput);
    const at = this.clock().toISOString();
    const canvasRegistryId = canvasRegistryIdFor(
      input.workspaceId,
      input.projectId,
      input.canvasId
    );
    return inWriteTransaction(this.database, () => {
      const project = this.projectInternal(input.workspaceId, input.projectId);
      if (!project || project.revokedAt !== null) throw new Error("project_registry_not_found");
      if (!project.ownerHumanPrincipalId) throw new Error("project_registry_owner_missing");
      assertNoPendingSnapshotRestore(this.database, input);
      const existing = this.canvasInternal(input.workspaceId, input.projectId, input.canvasId);
      if (existing) {
        if (
          existing.canvasRegistryId !== canvasRegistryId ||
          existing.ownerHumanPrincipalId !== project.ownerHumanPrincipalId
        ) {
          throw new Error("canvas_registry_conflict");
        }
        if (existing.revokedAt !== null) {
          const restored = this.database
            .prepare(
              "UPDATE canvas_registry SET package_dir_internal=NULL,revoked_at=NULL,updated_at=? WHERE canvas_registry_id=? AND revoked_at IS NOT NULL"
            )
            .run(at, existing.canvasRegistryId);
          if (restored.changes !== 1) throw new Error("canvas_registry_conflict");
          return canvasAccessRecord(
            parseCanvas(
              this.database
                .prepare("SELECT * FROM canvas_registry WHERE canvas_registry_id=?")
                .get(existing.canvasRegistryId) as Record<string, unknown>
            )
          );
        }
        return canvasAccessRecord(existing);
      }
      if (
        !activeWorkspacePrincipal(this.database, input.workspaceId, project.ownerHumanPrincipalId)
      ) {
        throw new Error("canvas_registry_owner_not_active");
      }
      this.database
        .prepare(
          `INSERT INTO canvas_registry(canvas_registry_id,project_registry_id,workspace_id,project_id,canvas_id,package_dir_internal,visibility,owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,NULL,'private',?,0,?,?,NULL)`
        )
        .run(
          canvasRegistryId,
          project.projectRegistryId,
          input.workspaceId,
          input.projectId,
          input.canvasId,
          project.ownerHumanPrincipalId,
          at,
          at
        );
      return canvasAccessRecord(
        parseCanvas(
          this.database
            .prepare("SELECT * FROM canvas_registry WHERE canvas_registry_id=?")
            .get(canvasRegistryId) as Record<string, unknown>
        )
      );
    });
  }

  initializeProjectOwner(
    workspaceId: string,
    projectId: string,
    ownerHumanPrincipalId: string
  ): InternalProjectRecord {
    if (!activeWorkspacePrincipal(this.database, workspaceId, ownerHumanPrincipalId))
      throw new Error("project_registry_owner_not_active");
    return inWriteTransaction(this.database, () => {
      const project = this.projectInternal(workspaceId, projectId);
      if (!project || project.revokedAt !== null) throw new Error("project_registry_not_found");
      assertNoPendingSnapshotRestore(this.database, { workspaceId, projectId });
      if (project.ownerHumanPrincipalId !== null) {
        if (project.ownerHumanPrincipalId !== ownerHumanPrincipalId)
          throw new Error("project_registry_owner_conflict");
        return project;
      }
      const at = this.clock().toISOString();
      const result = this.database
        .prepare(
          "UPDATE project_registry SET owner_human_principal_id=?,updated_at=? WHERE project_registry_id=? AND owner_human_principal_id IS NULL AND revoked_at IS NULL"
        )
        .run(ownerHumanPrincipalId, at, project.projectRegistryId);
      if (result.changes !== 1) throw new Error("project_registry_owner_conflict");
      this.database
        .prepare(
          "UPDATE canvas_registry SET owner_human_principal_id=?,updated_at=? WHERE project_registry_id=? AND owner_human_principal_id IS NULL AND revoked_at IS NULL"
        )
        .run(ownerHumanPrincipalId, at, project.projectRegistryId);
      return this.projectInternal(workspaceId, projectId) as InternalProjectRecord;
    });
  }

  initializeCanvasOwner(
    workspaceId: string,
    projectId: string,
    canvasId: string,
    ownerHumanPrincipalId: string
  ): InternalCanvasRecord {
    if (!activeWorkspacePrincipal(this.database, workspaceId, ownerHumanPrincipalId))
      throw new Error("canvas_registry_owner_not_active");
    const canvas = this.canvasInternal(workspaceId, projectId, canvasId);
    if (!canvas || canvas.revokedAt !== null) throw new Error("canvas_registry_not_found");
    if (canvas.ownerHumanPrincipalId !== null) {
      if (canvas.ownerHumanPrincipalId !== ownerHumanPrincipalId)
        throw new Error("canvas_registry_owner_conflict");
      return canvas;
    }
    return inWriteTransaction(this.database, () => {
      assertNoPendingSnapshotRestore(this.database, { workspaceId, projectId, canvasId });
      const result = this.database
        .prepare(
          "UPDATE canvas_registry SET owner_human_principal_id=?,updated_at=? WHERE canvas_registry_id=? AND owner_human_principal_id IS NULL AND revoked_at IS NULL"
        )
        .run(ownerHumanPrincipalId, this.clock().toISOString(), canvas.canvasRegistryId);
      if (result.changes !== 1) throw new Error("canvas_registry_owner_conflict");
      return this.canvasInternal(workspaceId, projectId, canvasId) as InternalCanvasRecord;
    });
  }

  /**
   * Synchronize registry ownership from a human membership transition.
   * The caller must already hold the write transaction that changed membership.
   */
  synchronizeHumanMembershipOwnerInCallerTransaction(input: {
    workspaceId: string;
    projectId: string;
    humanPrincipalId: string;
    transition: "member_joined" | "member_removed" | "owner_promoted" | "owner_demoted";
    membershipRole: "owner" | "member";
  }): void {
    const project = this.projectInternal(input.workspaceId, input.projectId);
    if (!project || project.revokedAt !== null) throw new Error("project_registry_not_found");
    assertNoPendingSnapshotRestore(this.database, {
      workspaceId: input.workspaceId,
      projectId: input.projectId
    });

    if (
      (input.transition === "member_joined" && input.membershipRole === "owner") ||
      input.transition === "owner_promoted"
    ) {
      this.materializeProjectOwnerInCallerTransaction(project, input.humanPrincipalId);
      return;
    }

    if (
      (input.transition === "member_removed" || input.transition === "owner_demoted") &&
      project.ownerHumanPrincipalId === input.humanPrincipalId
    ) {
      const replacement = this.nextActiveOwnerInCallerTransaction(
        input.workspaceId,
        input.projectId
      );
      if (!replacement) throw new Error("project_registry_owner_transfer_required");
      this.transferProjectOwnerInCallerTransaction(project, replacement);
      return;
    }

    if (
      input.transition === "member_removed" &&
      project.ownerHumanPrincipalId !== input.humanPrincipalId
    ) {
      const currentProjectOwner = project.ownerHumanPrincipalId;
      if (currentProjectOwner === null) throw new Error("project_registry_owner_missing");
      if (!activeWorkspacePrincipal(this.database, input.workspaceId, currentProjectOwner)) {
        throw new Error("project_registry_owner_not_active");
      }
      this.database
        .prepare(
          "UPDATE canvas_registry SET owner_human_principal_id=?,updated_at=? WHERE project_registry_id=? AND owner_human_principal_id=? AND revoked_at IS NULL"
        )
        .run(
          currentProjectOwner,
          this.clock().toISOString(),
          project.projectRegistryId,
          input.humanPrincipalId
        );
    }
  }

  private materializeProjectOwnerInCallerTransaction(
    project: InternalProjectRecord,
    ownerHumanPrincipalId: string
  ): void {
    if (project.ownerHumanPrincipalId !== null) return;
    if (!activeWorkspacePrincipal(this.database, project.workspaceId, ownerHumanPrincipalId)) {
      throw new Error("project_registry_owner_not_active");
    }
    const at = this.clock().toISOString();
    const updated = this.database
      .prepare(
        "UPDATE project_registry SET owner_human_principal_id=?,updated_at=? WHERE project_registry_id=? AND owner_human_principal_id IS NULL AND revoked_at IS NULL"
      )
      .run(ownerHumanPrincipalId, at, project.projectRegistryId);
    if (updated.changes !== 1) throw new Error("project_registry_owner_conflict");
    this.database
      .prepare(
        "UPDATE canvas_registry SET owner_human_principal_id=?,updated_at=? WHERE project_registry_id=? AND owner_human_principal_id IS NULL AND revoked_at IS NULL"
      )
      .run(ownerHumanPrincipalId, at, project.projectRegistryId);
  }

  private nextActiveOwnerInCallerTransaction(
    workspaceId: string,
    projectId: string
  ): string | undefined {
    const row = this.database
      .prepare(
        `SELECT m.human_principal_id
         FROM project_memberships m
         JOIN workspace_principals p
           ON p.workspace_id=? AND p.human_principal_id=m.human_principal_id
         JOIN workspace_memberships wm
           ON wm.workspace_id=p.workspace_id AND wm.human_principal_id=p.human_principal_id
         WHERE m.project_id=? AND m.role='owner' AND m.revoked_at IS NULL
           AND p.revoked_at IS NULL AND wm.revoked_at IS NULL
         ORDER BY m.created_at ASC,m.membership_id ASC
         LIMIT 1`
      )
      .get(workspaceId, projectId);
    return row ? String(row.human_principal_id) : undefined;
  }

  private transferProjectOwnerInCallerTransaction(
    project: InternalProjectRecord,
    ownerHumanPrincipalId: string
  ): void {
    const previousOwner = project.ownerHumanPrincipalId;
    if (previousOwner === null) throw new Error("project_registry_owner_missing");
    if (!activeWorkspacePrincipal(this.database, project.workspaceId, ownerHumanPrincipalId)) {
      throw new Error("project_registry_owner_not_active");
    }
    const at = this.clock().toISOString();
    const updated = this.database
      .prepare(
        "UPDATE project_registry SET owner_human_principal_id=?,updated_at=? WHERE project_registry_id=? AND owner_human_principal_id=? AND revoked_at IS NULL"
      )
      .run(ownerHumanPrincipalId, at, project.projectRegistryId, previousOwner);
    if (updated.changes !== 1) throw new Error("project_registry_owner_conflict");
    this.database
      .prepare(
        "UPDATE canvas_registry SET owner_human_principal_id=?,updated_at=? WHERE project_registry_id=? AND owner_human_principal_id=? AND revoked_at IS NULL"
      )
      .run(ownerHumanPrincipalId, at, project.projectRegistryId, previousOwner);
  }

  /** True when any Workspace still has an unretracted registry row for this project ID. */
  hasActiveProject(projectId: string): boolean {
    const parsed = identifierSchema.parse(projectId);
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM project_registry WHERE project_id=? AND revoked_at IS NULL LIMIT 1")
        .get(parsed)
    );
  }

  /**
   * Identity-only scope check: the Workspace still lists this project, and the
   * optional canvas row is still active. Does not require a bound package path.
   */
  hasActiveScope(input: { workspaceId: string; projectId: string; canvasId?: string }): boolean {
    const workspaceId = identifierSchema.parse(input.workspaceId);
    const projectId = identifierSchema.parse(input.projectId);
    const project = this.database
      .prepare(
        "SELECT 1 FROM project_registry WHERE workspace_id=? AND project_id=? AND revoked_at IS NULL LIMIT 1"
      )
      .get(workspaceId, projectId);
    if (!project) return false;
    if (input.canvasId === undefined) return true;
    const canvasId = identifierSchema.parse(input.canvasId);
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revoked_at IS NULL LIMIT 1"
        )
        .get(workspaceId, projectId, canvasId)
    );
  }

  projectInternal(workspaceId: string, projectId: string): InternalProjectRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM project_registry WHERE workspace_id=? AND project_id=?")
      .get(workspaceId, projectId) as Record<string, unknown> | undefined;
    return row ? parseProject(row) : undefined;
  }

  canvasInternal(
    workspaceId: string,
    projectId: string,
    canvasId: string
  ): InternalCanvasRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
      )
      .get(workspaceId, projectId, canvasId) as Record<string, unknown> | undefined;
    return row ? parseCanvas(row) : undefined;
  }

  project(workspaceId: string, projectId: string): ProjectAccessRecord | undefined {
    const project = this.projectInternal(workspaceId, projectId);
    return project?.ownerHumanPrincipalId ? projectAccessRecord(project) : undefined;
  }

  canvas(workspaceId: string, projectId: string, canvasId: string): CanvasAccessRecord | undefined {
    const canvas = this.canvasInternal(workspaceId, projectId, canvasId);
    return canvas?.ownerHumanPrincipalId ? canvasAccessRecord(canvas) : undefined;
  }

  bindProjectPath(workspaceId: string, projectId: string, projectRoot: string): void {
    if (!isAbsolute(projectRoot)) throw new Error("project_root_must_be_absolute");
    const project = this.projectInternal(workspaceId, projectId);
    if (!project) throw new Error("project_registry_not_found");
    if (project.projectRoot !== null && project.projectRoot !== projectRoot)
      throw new Error("project_registry_conflict");
    inWriteTransaction(this.database, () => {
      const at = this.clock().toISOString();
      this.database
        .prepare(
          "UPDATE project_registry SET project_root_internal=?,updated_at=? WHERE project_registry_id=?"
        )
        .run(projectRoot, at, project.projectRegistryId);
      upsertAclRegistryMigration(this.database, {
        migrationId: aclMigrationIdFor("trusted_project", workspaceId, projectId),
        workspaceId,
        projectId,
        canvasId: null,
        sourceKind: "trusted_project",
        marker: "path_bound",
        status: "in_progress",
        failureCode: null,
        updatedAt: at
      });
    });
  }

  bindCanvasPath(
    workspaceId: string,
    projectId: string,
    canvasId: string,
    packageDir: string
  ): void {
    if (!isAbsolute(packageDir)) throw new Error("package_dir_must_be_absolute");
    const canvas = this.canvasInternal(workspaceId, projectId, canvasId);
    if (!canvas) throw new Error("canvas_registry_not_found");
    if (canvas.packageDir !== null && canvas.packageDir !== packageDir)
      throw new Error("canvas_registry_conflict");
    inWriteTransaction(this.database, () => {
      const at = this.clock().toISOString();
      this.database
        .prepare(
          "UPDATE canvas_registry SET package_dir_internal=?,updated_at=? WHERE canvas_registry_id=?"
        )
        .run(packageDir, at, canvas.canvasRegistryId);
      const migration = readAclRegistryMigration(this.database, {
        workspaceId,
        projectId,
        canvasId,
        sourceKind: "trusted_canvas"
      });
      if (canvas.packageDir === null && migration?.status === "completed")
        throw new Error("canvas_registry_migration_conflict");
      if (!migration || migration.status !== "completed") {
        upsertAclRegistryMigration(this.database, {
          migrationId: aclMigrationIdFor("trusted_canvas", workspaceId, projectId, canvasId),
          workspaceId,
          projectId,
          canvasId,
          sourceKind: "trusted_canvas",
          marker: "path_bound",
          status: "in_progress",
          failureCode: null,
          updatedAt: at
        });
      }
    });
  }

  markCanvasCutover(workspaceId: string, projectId: string, canvasId: string): void {
    const project = this.projectInternal(workspaceId, projectId);
    const canvas = this.canvasInternal(workspaceId, projectId, canvasId);
    if (!project?.projectRoot || !canvas?.packageDir) throw new Error("runtime_location_unbound");
    const migration = {
      migrationId: aclMigrationIdFor("trusted_canvas", workspaceId, projectId, canvasId),
      workspaceId,
      projectId,
      canvasId,
      sourceKind: "trusted_canvas" as const,
      marker: "cutover_complete" as const,
      status: "completed" as const,
      failureCode: null,
      updatedAt: this.clock().toISOString()
    };
    upsertAclRegistryMigration(this.database, migration);
  }

  finalizeProjectCutover(workspaceId: string, projectId: string): void {
    const project = this.projectInternal(workspaceId, projectId);
    if (!project || !project.projectRoot) throw new Error("runtime_location_unbound");
    const canvases = this.database
      .prepare(
        "SELECT canvas_id,package_dir_internal FROM canvas_registry WHERE workspace_id=? AND project_id=? AND package_dir_internal IS NOT NULL AND revoked_at IS NULL ORDER BY canvas_id"
      )
      .all(workspaceId, projectId);
    if (canvases.length === 0) throw new Error("runtime_canvas_cutover_incomplete");
    for (const canvas of canvases) {
      const marker = readAclRegistryMigration(this.database, {
        workspaceId,
        projectId,
        canvasId: String(canvas.canvas_id),
        sourceKind: "trusted_canvas"
      });
      if (!marker || marker.status !== "completed" || marker.marker !== "cutover_complete")
        throw new Error("runtime_canvas_cutover_incomplete");
    }
    upsertAclRegistryMigration(this.database, {
      migrationId: aclMigrationIdFor("trusted_project", workspaceId, projectId),
      workspaceId,
      projectId,
      canvasId: null,
      sourceKind: "trusted_project",
      marker: "cutover_complete",
      status: "completed",
      failureCode: null,
      updatedAt: this.clock().toISOString()
    });
    const legacy = readAclRegistryMigration(this.database, {
      workspaceId,
      projectId,
      canvasId: null,
      sourceKind: "legacy_project"
    });
    if (legacy) {
      upsertAclRegistryMigration(this.database, {
        ...legacy,
        marker: "cutover_complete",
        status: "completed",
        failureCode: null,
        updatedAt: this.clock().toISOString()
      });
    }
  }

  /** Revoke active canvas rows that are no longer trusted by the current Runtime registry. */
  reconcileRuntimeCanvases(
    workspaceId: string,
    projectId: string,
    trustedCanvasIds: readonly string[]
  ): void {
    const canvasIds = z.array(identifierSchema).min(1).parse(trustedCanvasIds);
    inWriteTransaction(this.database, () => {
      const project = this.projectInternal(workspaceId, projectId);
      if (!project || project.revokedAt !== null) throw new Error("project_registry_not_found");
      assertNoPendingSnapshotRestore(this.database, { workspaceId, projectId });
      const placeholders = canvasIds.map(() => "?").join(",");
      const at = this.clock().toISOString();
      this.database
        .prepare(
          `UPDATE canvas_registry
           SET revoked_at=?,updated_at=?
           WHERE workspace_id=? AND project_id=? AND revoked_at IS NULL
             AND package_dir_internal IS NOT NULL
             AND canvas_id NOT IN (${placeholders})`
        )
        .run(at, at, workspaceId, projectId, ...canvasIds);
    });
  }

  resolveCanvasPath(input: { workspaceId: string; projectId: string; canvasId: string }): {
    scope: z.infer<typeof canvasScopeRefSchema>;
    projectRoot: string;
    packageDir: string;
    aclRevision: number;
  } {
    const project = this.projectInternal(input.workspaceId, input.projectId);
    const canvas = this.canvasInternal(input.workspaceId, input.projectId, input.canvasId);
    if (project?.revokedAt !== null || canvas?.revokedAt !== null)
      throw new Error("runtime_canvas_revoked");
    if (!project || !canvas || !project.projectRoot || !canvas.packageDir)
      throw new Error("runtime_location_unbound");
    const migration = readAclRegistryMigration(this.database, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      sourceKind: "trusted_canvas"
    });
    if (!migration || migration.status !== "completed" || migration.marker !== "cutover_complete")
      throw new Error("runtime_canvas_cutover_incomplete");
    const trustedProject = readAclRegistryMigration(this.database, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: null,
      sourceKind: "trusted_project"
    });
    if (
      !trustedProject ||
      trustedProject.status !== "completed" ||
      trustedProject.marker !== "cutover_complete"
    )
      throw new Error("runtime_project_cutover_incomplete");
    const legacyProject = readAclRegistryMigration(this.database, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: null,
      sourceKind: "legacy_project"
    });
    if (
      legacyProject &&
      (legacyProject.status !== "completed" || legacyProject.marker !== "cutover_complete")
    )
      throw new Error("runtime_project_cutover_incomplete");
    return {
      scope: canvasScopeRefSchema.parse(input),
      projectRoot: project.projectRoot,
      packageDir: canvas.packageDir,
      aclRevision: canvas.aclRevision
    };
  }
}

export function activeWorkspacePrincipal(
  database: SqliteDatabase,
  workspaceId: string,
  principalId: string
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM workspace_principals p JOIN workspace_memberships m ON m.workspace_id=p.workspace_id AND m.human_principal_id=p.human_principal_id WHERE p.workspace_id=? AND p.human_principal_id=? AND p.revoked_at IS NULL AND m.revoked_at IS NULL`
      )
      .get(workspaceId, principalId)
  );
}
