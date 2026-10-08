import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";
import { join } from "node:path";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { applyMigrations } from "../migrations.js";
import { PackageSnapshotRepository } from "../packageSnapshotRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase } from "../sqlite.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../canvas/localFilesystemRuntimeAdapter.js";

export async function packageSnapshotFixture(
  onRetentionCleanupError?: (error: unknown, canvasRegistryId: string) => void,
  throughSchemaVersion?: number
) {
  const workspace = await createTestWorkspace();
  const database = await openServerDatabase(":memory:", 5_000);
  if (throughSchemaVersion === undefined) applyMigrations(database);
  else applyMigrationsThroughVersion(database, throughSchemaVersion);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01T00:00:00.000Z',NULL),('w','viewer','Viewer','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),('w','m-viewer','viewer','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: workspace.root,
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    packageDir: workspace.init.workspace.packageDir,
    visibility: "shared",
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "other",
    packageDir: workspace.init.workspace.packageDir,
    visibility: "shared",
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.markCanvasCutover("w", "p", "other");
  access.finalizeProjectCutover("w", "p");
  let runtimeAttached = true;
  const runtimeLocations = {
    resolveExactCanvasLocation(scope: {
      workspaceId: string;
      projectId: string;
      canvasId: string;
    }) {
      return runtimeAttached &&
        scope.workspaceId === "w" &&
        scope.projectId === "p" &&
        scope.canvasId === "default"
        ? {
            workspaceId: "w",
            projectId: "p",
            canvasId: "default",
            projectRoot: workspace.root,
            packageDir: workspace.init.workspace.packageDir
          }
        : undefined;
    }
  };
  const snapshots = new PackageSnapshotRepository(
    database,
    access,
    join(workspace.root, "snapshot-data"),
    createLocalFilesystemCanvasRuntimeAdapter(runtimeLocations),
    () => new Date("2026-01-02T00:00:00.000Z"),
    onRetentionCleanupError
  );
  return {
    workspace,
    database,
    access,
    snapshots,
    detachRuntime() {
      runtimeAttached = false;
    }
  };
}
