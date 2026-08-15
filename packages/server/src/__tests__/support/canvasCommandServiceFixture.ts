import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import type {
  CanvasCommandAccepted,
  CanvasCommandIntent,
  CanvasJournalEntry
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { createTestWorkspace } from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  CanvasCommandRepository,
  CanvasCommandService,
  ContentVersionRepository,
  SqliteAuthoritativeCanvasCommitStore,
  createDefaultCanvasRuntimePort,
  type CanvasRuntimeMutationPort
} from "../../canvas/index.js";
import type { HumanAuthContext } from "../../identity/schemas.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { applyMigrations } from "../../migrations.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

export function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fakeRuntime(initialDigest = digestOf("empty")): CanvasRuntimeMutationPort & {
  calls: number;
  setDigest(next: string): void;
} {
  let digest = initialDigest;
  return {
    calls: 0,
    setDigest(next: string) {
      digest = next;
    },
    async apply(input) {
      this.calls += 1;
      digest = digestOf(`${digest}:${JSON.stringify(input.intent)}`);
      return {
        ok: true,
        contentDigest: digest,
        digestManifest: {
          manifest: { digestSha256: digest, sizeBytes: 10 },
          prompts: [],
          totalBytes: 10
        },
        packageDir: input.expectedPackageDir ?? String(input.projectRoot),
        sizeBytes: 10
      };
    },
    async readDigest(input) {
      return {
        ok: true,
        contentDigest: digest,
        digestManifest: {
          manifest: { digestSha256: digest, sizeBytes: 10 },
          prompts: [],
          totalBytes: 10
        },
        packageDir: input.expectedPackageDir ?? String(input.projectRoot),
        sizeBytes: 10
      };
    },
    async readStatus(input) {
      return {
        schemaVersion: "canvas-runtime-status/v2",
        scope: input.scope,
        packageFingerprint: `pkg-${"a".repeat(64)}`,
        capturedAt: input.capturedAt ?? "2026-01-02T00:00:00.000Z",
        tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }],
        blocks: []
      };
    }
  };
}

export async function canvasCommandServiceFixture(options?: {
  journalRetention?: number;
  runtime?: CanvasRuntimeMutationPort;
  contentVersions?: boolean;
  onAcceptedInCallerTransaction?: (accepted: CanvasCommandAccepted) => void;
  onAcceptedEntry?: (entry: CanvasJournalEntry) => void;
  onAcceptedEntryUnavailable?: (input: {
    scope: { workspaceId: string; projectId: string; canvasId: string };
    headRevision: number;
    headContentDigest: string;
  }) => void;
}) {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01T00:00:00.000Z',NULL),
      ('w','editor','Editor','2026-01-01T00:00:00.000Z',NULL),
      ('w','viewer','Viewer','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-editor','editor','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-viewer','viewer','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-01-01');
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
    visibility: "private",
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.finalizeProjectCutover("w", "p");
  access.grant({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    humanPrincipalId: "editor",
    role: "editor",
    grantedBy: { kind: "human", id: "owner" }
  });
  access.grant({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    humanPrincipalId: "viewer",
    role: "viewer",
    grantedBy: { kind: "human", id: "owner" }
  });

  const repository = new CanvasCommandRepository(database, {
    clock: () => new Date("2026-01-02T00:00:00.000Z"),
    maxJournalEntries: options?.journalRetention ?? 3
  });
  const runtime = options?.runtime ?? fakeRuntime();
  const contentVersions = new ContentVersionRepository(
    database,
    () => new Date("2026-01-02T00:00:00.000Z")
  );
  const authorityRuntime = createDefaultCanvasRuntimePort();
  if (!authorityRuntime.captureContent) throw new Error("authority content capture unavailable");
  const initialContent = await authorityRuntime.captureContent({
    projectRoot: workspace.root,
    canvasId: "default",
    expectedPackageDir: workspace.init.workspace.packageDir,
    authorityProjectId: "p"
  });
  if (!initialContent.ok) throw new Error(initialContent.detail);
  contentVersions.publishInitial({
    scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
    content: initialContent.content,
    createdBy: { kind: "human", id: "owner" }
  });
  const service = new CanvasCommandService({
    repository,
    access,
    workspaceIdentity: new WorkspaceIdentityRepository(database),
    runtime,
    contentVersions,
    authoritativeCommits: new SqliteAuthoritativeCanvasCommitStore(
      database,
      contentVersions,
      repository,
      options?.onAcceptedInCallerTransaction
    ),
    onAcceptedEntry: options?.onAcceptedEntry,
    onAcceptedEntryUnavailable: options?.onAcceptedEntryUnavailable,
    clock: () => new Date("2026-01-02T00:00:00.000Z"),
    presenceHeadProbe: () => 999
  });
  return { workspace, database, access, repository, service, runtime, contentVersions };
}

export function actor(id: "owner" | "editor" | "viewer"): HumanAuthContext {
  return {
    humanPrincipalId: id,
    displayName: id,
    deviceCredentialId: `device-${id}`,
    projectId: "p",
    role: id === "owner" ? "owner" : "member",
    membershipId: `m-${id}`
  };
}

export function submitBody(
  operationId: string,
  expectedRevision: number,
  intent: CanvasCommandIntent = {
    kind: "update_task_prompt",
    taskId: "T-001",
    promptMarkdown: "# updated"
  }
) {
  return {
    type: "canvas.command.submit" as const,
    protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
    schemaVersion: "canvas-command/v1" as const,
    projectId: "p",
    canvasId: "default",
    operationId,
    expectedRevision,
    intent
  };
}
