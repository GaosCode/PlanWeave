import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCanvasReplicaDocument } from "@planweave-ai/runtime";
import { afterEach, expect } from "vitest";
import { basicManifest } from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../../canvas/contentVersionRepository.js";
import { parseServerConfig } from "../../config.js";
import { HumanIdentityRepository } from "../../identity/repository.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { applyMigrations } from "../../migrations.js";
import { hashOperatorToken } from "../../operatorAuth.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import { createDistributedServerComposition } from "../../serverComposition.js";
import { openServerDatabase, type SqliteDatabase } from "../../sqlite.js";
import { applyMigrationsThroughVersion } from "./migrationFixture.js";
import { resetCommentActivityHttpRateLimits } from "../../comments/index.js";
import {
  auth,
  createPending,
  createWorkspaceDevice,
  uploadPending
} from "./commentAttachmentHttpFixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetCommentActivityHttpRateLimits();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

export async function setupCommentReadComposition(
  options: {
    clock?: () => Date;
    prepareLegacy?: (input: {
      database: SqliteDatabase;
      directory: string;
      projectId: string;
      owner: { token: string; principalId: string; workspaceId: string };
    }) => Promise<void>;
  } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-read-composition-"));
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: directory,
    trustedProjects: [],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"R".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const database = await openServerDatabase(config.databasePath, 5000);
  if (options.prepareLegacy) applyMigrationsThroughVersion(database, 73);
  else applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const access = new ProjectAccessRepository(database);
  const projectId = "same-project";
  const workspaceA = workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
  const registerOwner = (workspaceId: string, index: number) => {
    const owner =
      index === 0
        ? (() => {
            const result = new HumanIdentityRepository(database).bootstrapOwner({
              kind: "local_administrative_proof",
              projectId,
              humanPrincipalId: "read-owner-a",
              displayName: "Owner A",
              issuedAt: new Date().toISOString()
            });
            return { token: result.deviceToken, principalId: result.principal.humanPrincipalId };
          })()
        : createWorkspaceDevice({
            database,
            workspaceIdentity,
            authorizeScope() {},
            workspaceId,
            projectId,
            suffix: `read-${index}`
          });
    access.registerProjectInternal({
      workspaceId,
      projectId,
      projectRoot: directory,
      ownerHumanPrincipalId: owner.principalId
    });
    const manifest = basicManifest();
    const content = encodeCanvasReplicaDocument({
      schemaVersion: "canvas-replica-document/v1",
      manifest,
      promptMarkdownByPath: Object.fromEntries(
        manifest.nodes.flatMap((task) => [
          [task.prompt, "# Task"],
          ...task.blocks.map((block) => [block.prompt, "# Block"])
        ])
      ),
      layout: {
        version: "desktop-layout/v1",
        projectId,
        nodes: [],
        updatedAt: new Date().toISOString()
      }
    });
    for (const canvasId of ["default", "other"]) {
      access.registerPathlessCanvas({ workspaceId, projectId, canvasId });
      new ContentVersionRepository(database).publishInitial({
        scope: { workspaceId, projectId, canvasId },
        content,
        createdBy: { kind: "human", id: owner.principalId }
      });
    }
    return { ...owner, workspaceId };
  };
  const owner = registerOwner(workspaceA, 0);
  if (options.prepareLegacy) {
    await options.prepareLegacy({ database, directory, projectId, owner });
    applyMigrations(database);
  }
  const server = createServer();
  const composition = await createDistributedServerComposition({
    httpServer: server,
    config,
    clock: options.clock
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected HTTP address");
  cleanups.push(async () => {
    await composition.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${address.port}/api/v1/projects/${projectId}`;
  return {
    directory,
    config,
    composition,
    origin: `http://127.0.0.1:${address.port}`,
    base,
    projectId,
    database,
    access,
    owner,
    createOtherWorkspace: () => registerOwner("read-workspace-b", 1),
    async mutateAccess(
      token: string,
      workspaceId: string,
      canvasId: string | null,
      change: Record<string, unknown>
    ) {
      const response = await fetch(`${base}/canvases/${canvasId ?? "default"}/access`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          scope: { scopeKind: canvasId ? "canvas" : "project", workspaceId, projectId, canvasId },
          ...change
        })
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { aclRevision: number };
      return body;
    },
    async createComment(token: string, canvasId: string, body: string, attachments: object[] = []) {
      const response = await fetch(`${base}/comments`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          workItem: { kind: "task", canvasId, taskId: "T-001" },
          body,
          attachments
        })
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { commentId: string; revision: number };
    },
    async stage(token: string, bytes: Buffer) {
      const digestSha256 = createHash("sha256").update(bytes).digest("hex");
      const created = await createPending(`http://127.0.0.1:${address.port}`, token, projectId, {
        expectedSizeBytes: bytes.length,
        mediaType: "text/plain",
        fileName: "private-evidence.txt",
        expectedDigestSha256: digestSha256
      });
      expect(created.response.status).toBe(201);
      const pendingUploadId = created.payload.pendingUploadId as string;
      const uploaded = await uploadPending(
        `http://127.0.0.1:${address.port}`,
        token,
        projectId,
        pendingUploadId,
        bytes,
        "text/plain",
        digestSha256
      );
      expect(uploaded.response.status).toBe(201);
      return {
        pendingUploadId,
        digestSha256,
        sizeBytes: bytes.length,
        mediaType: "text/plain",
        fileName: "private-evidence.txt"
      };
    }
  };
}
