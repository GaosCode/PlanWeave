import { ProjectRegistryRepository } from "../../projectRegistryRepository.js";
import { ProjectAccessPolicy } from "../../projectAccessPolicy.js";
import { CommentAttachmentDigestLifecycle } from "../../attachments/digestLifecycle.js";
import { loopbackHttpTransportAdmission } from "./transportAdmission.js";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import {
  CommentAttachmentBlobStore,
  CommentAttachmentRepository,
  CommentAttachmentService,
  handleCommentAttachmentHttpRequest
} from "../../attachments/index.js";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService,
  WorkspaceIdentityRepository,
  hashHumanToken,
  mintHumanDeviceToken,
  resetHumanHttpRateLimits
} from "../../identity/index.js";
import { applyMigrations } from "../../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../../sqlite.js";
const servers: HttpServer[] = [];
const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  resetHumanHttpRateLimits();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

export async function setup(options?: { clock?: () => Date; directory?: string }) {
  const directory =
    options?.directory ?? (await mkdtemp(join(tmpdir(), "planweave-comment-attach-")));
  if (!options?.directory) directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);

  const humanRepository = new HumanIdentityRepository(database, options?.clock);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceA = workspaceIdentity.ensureWorkspaceForLegacyProject("project-a");
  const workspaceB = workspaceIdentity.ensureWorkspaceForLegacyProject("project-b");
  const authorizedScopes = new Set([
    `${workspaceA}\u0000project-a`,
    `${workspaceB}\u0000project-b`
  ]);
  const collaborationScopeAuthority = {
    hasProject: (projectId: string) => projectId === "project-a" || projectId === "project-b",
    hasScope: (scope: { workspaceId: string; projectId: string }) =>
      authorizedScopes.has(`${scope.workspaceId}\u0000${scope.projectId}`)
  };
  const humanService = new HumanMembershipService({
    repository: humanRepository,
    collaborationScopeAuthority,
    workspaceForProject: (projectId) =>
      projectId === "project-a" ? workspaceA : projectId === "project-b" ? workspaceB : undefined,
    clock: options?.clock
  });
  const attachmentRepository = new CommentAttachmentRepository(database);
  const blobs = new CommentAttachmentBlobStore(database, directory);
  const lifecycle = new CommentAttachmentDigestLifecycle(database, directory);
  const registry = new ProjectRegistryRepository(database, options?.clock);
  const readPolicy = new ProjectAccessPolicy(database, registry);
  const attachmentService = new CommentAttachmentService({
    repository: attachmentRepository,
    lifecycle,
    blobs,
    identity: humanRepository,
    canRead({ actor, workspaceId, projectId, canvasId }) {
      if (!registry.projectInternal(workspaceId, projectId)) {
        const owner = database
          .prepare(`SELECT human_principal_id FROM workspace_memberships
          WHERE workspace_id=? AND role='owner' AND revoked_at IS NULL LIMIT 1`)
          .get(workspaceId) as { human_principal_id: string } | undefined;
        if (!owner) return false;
        registry.registerProjectInternal({
          workspaceId,
          projectId,
          projectRoot: directory,
          visibility: "shared",
          ownerHumanPrincipalId: owner.human_principal_id
        });
      }
      if (canvasId && !registry.canvasInternal(workspaceId, projectId, canvasId)) {
        registry.registerCanvasInternal({
          workspaceId,
          projectId,
          canvasId,
          packageDir: directory,
          visibility: "shared",
          ownerHumanPrincipalId: registry.projectInternal(workspaceId, projectId)!
            .ownerHumanPrincipalId
        });
      }
      return readPolicy.evaluate({
        workspaceId,
        projectId,
        canvasId,
        actor: { kind: "human", id: actor.humanPrincipalId }
      }).capabilities.read;
    },
    clock: options?.clock
  });

  const server = createServer((request, response) => {
    void (async () => {
      if (
        await handleHumanHttpRequest(request, response, {
          service: humanService,
          repository: humanRepository,
          collaborationScopeAuthority,
          transportAdmission: loopbackHttpTransportAdmission,
          clock: options?.clock
        })
      ) {
        return;
      }
      if (
        await handleCommentAttachmentHttpRequest(request, response, {
          service: attachmentService,
          repository: humanRepository,
          workspaceIdentity,
          collaborationScopeAuthority,
          transportAdmission: loopbackHttpTransportAdmission,
          clock: options?.clock
        })
      ) {
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "route_not_found" }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "request_failed" }));
      } else {
        response.destroy();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    directory,
    database,
    attachmentService,
    attachmentRepository,
    blobs,
    lifecycle,
    humanRepository,
    workspaceA,
    workspaceB,
    workspaceIdentity,
    authorizeScope(workspaceId: string, projectId: string) {
      authorizedScopes.add(`${workspaceId}\u0000${projectId}`);
    }
  };
}

export function createWorkspaceDevice(input: {
  database: SqliteDatabase;
  workspaceIdentity: WorkspaceIdentityRepository;
  authorizeScope(workspaceId: string, projectId: string): void;
  workspaceId: string;
  projectId: string;
  suffix: string;
}) {
  input.workspaceIdentity.ensureConfiguredWorkspace(input.workspaceId);
  input.authorizeScope(input.workspaceId, input.projectId);
  const token = mintHumanDeviceToken();
  const now = new Date().toISOString();
  const principalId = `human-workspace-${input.suffix}`;
  const sessionId = `device-workspace-${input.suffix}`;
  input.database
    .prepare(
      `INSERT INTO workspace_principals(
        workspace_id,human_principal_id,display_name,created_at,revoked_at
      ) VALUES(?,?,?,?,NULL)`
    )
    .run(input.workspaceId, principalId, `Workspace ${input.suffix}`, now);
  input.database
    .prepare(
      `INSERT INTO workspace_memberships(
        workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
      ) VALUES(?,?,?,?,1,?,?,NULL)`
    )
    .run(input.workspaceId, `membership-workspace-${input.suffix}`, principalId, "owner", now, now);
  input.database
    .prepare(
      `INSERT INTO workspace_device_sessions(
        workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,
        expires_at,revoked_at,last_used_at
      ) VALUES(?,?,?,?,?,?,NULL,NULL)`
    )
    .run(
      input.workspaceId,
      sessionId,
      principalId,
      hashHumanToken(token),
      now,
      new Date(Date.now() + 60_000).toISOString()
    );
  return { token, sessionId, principalId };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export function principalIdForDeviceToken(database: SqliteDatabase, token: string): string {
  const row = database
    .prepare(
      `SELECT human_principal_id FROM human_device_credentials
       WHERE token_sha256=? AND revoked_at IS NULL`
    )
    .get(hashHumanToken(token)) as { human_principal_id: string } | undefined;
  if (!row) throw new Error("device_principal_missing");
  return row.human_principal_id;
}

export async function bootstrap(
  origin: string,
  projectId = "project-a",
  principalId = "human-owner-1"
) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Owner", humanPrincipalId: principalId })
  });
  const payload = (await response.json()) as { deviceToken?: string; error?: string };
  if (!response.ok || !payload.deviceToken) {
    throw new Error(`bootstrap failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload.deviceToken;
}

export async function inviteAndJoin(
  origin: string,
  ownerToken: string,
  projectId: string,
  displayName: string
) {
  const invite = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(ownerToken) },
    body: JSON.stringify({})
  });
  const invitePayload = (await invite.json()) as { invitationToken?: string };
  expect(invite.status).toBe(201);
  const consume = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      invitationToken: invitePayload.invitationToken,
      displayName
    })
  });
  const consumePayload = (await consume.json()) as { deviceToken?: string };
  expect(consume.status).toBe(201);
  return consumePayload.deviceToken!;
}

export async function createPending(
  origin: string,
  token: string,
  projectId: string,
  body: Record<string, unknown>
) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/attachments/pending`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(token) },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as Record<string, unknown>;
  return { response, payload };
}

export async function uploadPending(
  origin: string,
  token: string,
  projectId: string,
  pendingUploadId: string,
  bytes: Buffer,
  mediaType: string,
  digest?: string
) {
  const headers: Record<string, string> = {
    "content-type": mediaType,
    "content-length": String(bytes.byteLength),
    ...auth(token)
  };
  if (digest) headers["x-planweave-content-sha256"] = digest;
  const response = await fetch(
    `${origin}/api/v1/projects/${projectId}/attachments/pending/${pendingUploadId}`,
    { method: "PUT", headers, body: new Uint8Array(bytes) }
  );
  const payload = (await response.json()) as Record<string, unknown>;
  return { response, payload };
}

export async function finalizePending(
  origin: string,
  token: string,
  projectId: string,
  pendingUploadId: string,
  expectedDigestSha256?: string
) {
  const response = await fetch(
    `${origin}/api/v1/projects/${projectId}/attachments/pending/${pendingUploadId}/finalize`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(token) },
      body: JSON.stringify(expectedDigestSha256 ? { expectedDigestSha256 } : {})
    }
  );
  const payload = (await response.json()) as Record<string, unknown>;
  return { response, payload };
}
