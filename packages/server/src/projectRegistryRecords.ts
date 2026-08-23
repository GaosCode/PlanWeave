import {
  canvasAccessRecordSchema,
  canvasRegistryRefSchema,
  projectAccessRecordSchema,
  projectRegistryRefSchema,
  type CanvasAccessRecord,
  type ProjectAccessRecord
} from "@planweave-ai/collaboration-protocol/access/project";
import {
  workspaceCanvasPublishLocalSourceSchema,
  type WorkspaceCanvasPublishLocalSource
} from "@planweave-ai/collaboration-protocol/content/version";

export type InternalProjectRecord = {
  projectRegistryId: string;
  workspaceId: string;
  projectId: string;
  projectRoot: string | null;
  visibility: "private" | "shared";
  ownerHumanPrincipalId: string | null;
  aclRevision: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type InternalCanvasRecord = {
  canvasRegistryId: string;
  projectRegistryId: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  packageDir: string | null;
  visibility: "private" | "shared";
  ownerHumanPrincipalId: string | null;
  aclRevision: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export function parseProject(row: Record<string, unknown>): InternalProjectRecord {
  return {
    projectRegistryId: String(row.project_registry_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    projectRoot: row.project_root_internal === null ? null : String(row.project_root_internal),
    visibility: row.visibility as InternalProjectRecord["visibility"],
    ownerHumanPrincipalId:
      row.owner_human_principal_id === null ? null : String(row.owner_human_principal_id),
    aclRevision: Number(row.acl_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}

export function parseCanvas(row: Record<string, unknown>): InternalCanvasRecord {
  return {
    canvasRegistryId: String(row.canvas_registry_id),
    projectRegistryId: String(row.project_registry_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    canvasId: String(row.canvas_id),
    packageDir: row.package_dir_internal === null ? null : String(row.package_dir_internal),
    visibility: row.visibility as InternalCanvasRecord["visibility"],
    ownerHumanPrincipalId:
      row.owner_human_principal_id === null ? null : String(row.owner_human_principal_id),
    aclRevision: Number(row.acl_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}

export function projectAccessRecord(project: InternalProjectRecord): ProjectAccessRecord {
  if (!project.ownerHumanPrincipalId) throw new Error("project_registry_owner_missing");
  return projectAccessRecordSchema.parse({
    schemaVersion: "project-access/v1",
    registry: projectRegistryRefSchema.parse({
      projectRegistryId: project.projectRegistryId,
      workspaceId: project.workspaceId,
      projectId: project.projectId
    }),
    visibility: project.visibility,
    acl: { revision: project.aclRevision, updatedAt: project.updatedAt },
    owner: project.ownerHumanPrincipalId,
    updatedAt: project.updatedAt
  });
}

export function canvasAccessRecord(
  canvas: InternalCanvasRecord,
  publishSource?: WorkspaceCanvasPublishLocalSource | null
): CanvasAccessRecord {
  if (!canvas.ownerHumanPrincipalId) throw new Error("canvas_registry_owner_missing");
  return canvasAccessRecordSchema.parse({
    schemaVersion: "project-access/v1",
    registry: canvasRegistryRefSchema.parse({
      projectRegistryId: canvas.projectRegistryId,
      canvasRegistryId: canvas.canvasRegistryId,
      workspaceId: canvas.workspaceId,
      projectId: canvas.projectId,
      canvasId: canvas.canvasId
    }),
    visibility: canvas.visibility,
    acl: { revision: canvas.aclRevision, updatedAt: canvas.updatedAt },
    owner: canvas.ownerHumanPrincipalId,
    ...(publishSource === undefined
      ? {}
      : {
          publishSource:
            publishSource && workspaceCanvasPublishLocalSourceSchema.parse(publishSource)
        }),
    updatedAt: canvas.updatedAt
  });
}
