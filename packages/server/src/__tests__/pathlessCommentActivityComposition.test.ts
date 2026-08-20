import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCanvasReplicaDocument, type PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { parseServerConfig } from "../config.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import { inWriteTransaction, openServerDatabase } from "../sqlite.js";

const clock = () => new Date("2026-08-20T00:00:00.000Z");
const projectId = "project-pathless-comments";
const canvasId = "default";
const ownerId = "pathless-comment-owner";
const operatorToken = `pw_operator_${"P".repeat(43)}`;
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function authoritativeContent(manifest: PlanPackageManifest) {
  const promptMarkdownByPath = Object.fromEntries(
    manifest.nodes.flatMap((task) => [
      [task.prompt, `# ${task.title}\n`],
      ...task.blocks.map((block) => [block.prompt, `# ${block.title}\n`])
    ])
  );
  return encodeCanvasReplicaDocument({
    schemaVersion: "canvas-replica-document/v1",
    manifest,
    promptMarkdownByPath,
    layout: {
      version: "desktop-layout/v1",
      projectId,
      nodes: [],
      updatedAt: clock().toISOString()
    }
  });
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

async function setupPathlessComposition() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-pathless-comments-"));
  directories.push(dataDirectory);
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory,
    trustedProjects: [],
    operatorCredentials: [
      {
        operatorId: "pathless-admin",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const database = await openServerDatabase(config.databasePath, 5_000);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
  const identity = new HumanIdentityRepository(database, clock);
  const owner = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId,
    humanPrincipalId: ownerId,
    displayName: "Pathless Comment Owner",
    issuedAt: clock().toISOString()
  });
  const access = new ProjectAccessRepository(database, clock);
  access.registerProjectInternal({
    workspaceId,
    projectId,
    projectRoot: "/restored/source/project",
    ownerHumanPrincipalId: ownerId
  });
  access.registerCanvasInternal({
    workspaceId,
    projectId,
    canvasId,
    packageDir: "/restored/source/project/canvases/default/package",
    ownerHumanPrincipalId: ownerId
  });
  access.markCanvasCutover(workspaceId, projectId, canvasId);
  access.finalizeProjectCutover(workspaceId, projectId);
  database
    .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
    .run(projectId);
  database
    .prepare(
      "UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=? AND canvas_id=?"
    )
    .run(projectId, canvasId);
  const scope = { workspaceId, projectId, canvasId };
  const contentVersions = new ContentVersionRepository(database, clock);
  contentVersions.publishInitial({
    scope,
    content: authoritativeContent(basicManifest()),
    createdBy: { kind: "human", id: ownerId }
  });
  database.close();

  const httpServer = createServer();
  servers.push(httpServer);
  const composition = await createDistributedServerComposition({ httpServer, config, clock });
  compositions.push(composition);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected HTTP address");
  return {
    config,
    scope,
    token: owner.deviceToken,
    origin: `http://127.0.0.1:${address.port}`
  };
}

describe("pathless comment activity composition", () => {
  it("uses restored registry scope and current authoritative content without a Runtime registry", async () => {
    const fixture = await setupPathlessComposition();
    const workItem = { kind: "block", canvasId, blockRef: "T-001#B-001" } as const;
    const bytes = Buffer.from("pathless attachment");
    const digestSha256 = createHash("sha256").update(bytes).digest("hex");

    const staged = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/pending`,
      {
        method: "POST",
        headers: jsonHeaders(fixture.token),
        body: JSON.stringify({
          expectedSizeBytes: bytes.byteLength,
          mediaType: "text/plain",
          expectedDigestSha256: digestSha256,
          fileName: "pathless.txt"
        })
      }
    );
    const stagedBody = (await staged.json()) as { pendingUploadId: string };
    expect(staged.status).toBe(201);

    const uploaded = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/pending/${stagedBody.pendingUploadId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          "content-type": "text/plain",
          "content-length": String(bytes.byteLength),
          "x-planweave-content-sha256": digestSha256
        },
        body: bytes
      }
    );
    expect(uploaded.status).toBe(201);

    const createdResponse = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/comments`, {
      method: "POST",
      headers: jsonHeaders(fixture.token),
      body: JSON.stringify({
        workItem,
        body: "Created from authoritative content",
        attachments: [
          {
            pendingUploadId: stagedBody.pendingUploadId,
            digestSha256,
            sizeBytes: bytes.byteLength,
            mediaType: "text/plain",
            fileName: "pathless.txt"
          }
        ]
      })
    });
    const created = (await createdResponse.json()) as { commentId: string };
    expect(createdResponse.status).toBe(201);

    const query = new URLSearchParams({ workItem: JSON.stringify(workItem) });
    const listed = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/comments?${query}`, {
      headers: { Authorization: `Bearer ${fixture.token}` }
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      items: [{ commentId: created.commentId }]
    });

    const attachment = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/comments/${created.commentId}/${digestSha256}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } }
    );
    expect(attachment.status).toBe(200);
    expect(Buffer.from(await attachment.arrayBuffer())).toEqual(bytes);

    const database = await openServerDatabase(fixture.config.databasePath, 5_000);
    const contentVersions = new ContentVersionRepository(database, clock);
    const withoutWorkItems: PlanPackageManifest = {
      ...basicManifest(),
      nodes: [],
      edges: []
    };
    const advanced = contentVersions.persistImmutable({
      scope: fixture.scope,
      content: authoritativeContent(withoutWorkItems),
      createdBy: { kind: "human", id: ownerId }
    });
    inWriteTransaction(database, () => {
      contentVersions.advanceHeadForSqliteCommit({
        scope: fixture.scope,
        expectedRevision: 1,
        content: advanced.completed
      });
    });
    database.close();

    const staleWorkItemCreate = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments`,
      {
        method: "POST",
        headers: jsonHeaders(fixture.token),
        body: JSON.stringify({ workItem, body: "Must not use a cached graph", attachments: [] })
      }
    );
    expect(staleWorkItemCreate.status).toBe(404);
    await expect(staleWorkItemCreate.json()).resolves.toEqual({
      error: "comment_work_item_not_found"
    });

    const revokedDatabase = await openServerDatabase(fixture.config.databasePath, 5_000);
    revokedDatabase
      .prepare("UPDATE project_registry SET revoked_at=? WHERE workspace_id=? AND project_id=?")
      .run(clock().toISOString(), fixture.scope.workspaceId, projectId);
    revokedDatabase.close();

    const revokedList = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments?${query}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } }
    );
    expect(revokedList.status).toBe(403);
    const revokedAttachment = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/comments/${created.commentId}/${digestSha256}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } }
    );
    expect(revokedAttachment.status).toBe(401);
    await expect(revokedAttachment.json()).resolves.toEqual({
      error: "attachment_auth_unauthenticated"
    });
  });
});
