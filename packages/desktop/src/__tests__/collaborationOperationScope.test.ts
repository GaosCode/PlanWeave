import { WorkspaceAuthoritativeSnapshotCache } from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";
import { createHash } from "node:crypto";
import {
  pendingAttachmentViewSchema,
  finalizePendingAttachmentResponseSchema
} from "@planweave-ai/collaboration-protocol/activity/attachments";
import { commentDisplayProjectionSchema } from "@planweave-ai/collaboration-protocol/activity/comments";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../../../server/src/config.js";
import { hashOperatorToken } from "../../../server/src/operatorAuth.js";
import { ProjectAccessRepository } from "../../../server/src/projectAccessRepository.js";
import { openServerDatabase } from "../../../server/src/sqlite.js";
import { createDistributedServerComposition } from "../../../server/src/serverComposition.js";
import { seedOperatorSessions } from "../../../server/src/__tests__/support/operatorAuthFixture.js";
import { legacyWorkspaceIdForProject } from "../../../server/src/__tests__/support/legacyWorkspaceId.js";
import { createLocalCollaborationActivationCommand } from "../main/collaboration/localCollaborationSelectionActivation.js";
import type { CollaborationStatus } from "../shared/collaboration.js";
import { collaborationInvokeChannels } from "../shared/collaboration.js";
import { deferred } from "./helpers/desktopProjectFixtures.js";

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipc.handlers.set(channel, handler)
  },
  safeStorage: { isEncryptionAvailable: () => false }
}));
vi.mock("../main/collaboration/CollaborationCoordinatorControl.js", () => ({
  LocalCollaborationCoordinatorControl: class {
    restore = async () => undefined;
    stop = async () => undefined;
  }
}));
vi.mock("../main/operatorControl/localOperatorBackend.js", () => ({
  setLocalOperatorBackendPort: vi.fn()
}));
vi.mock("../main/operatorControl/operatorControlHandlers.js", () => ({
  getOperatorControlService: vi.fn()
}));
vi.mock("../main/collaboration/persistedDesktopServerConnection.js", () => ({
  restorePersistedDesktopServerConnection: async () => undefined
}));
import {
  registerCollaborationHandlers,
  shutdownCollaborationHandlers
} from "../main/collaboration/collaborationHandlers.js";

const cleanups: Array<() => Promise<unknown>> = [];
const originalHome = process.env.PLANWEAVE_HOME;
afterEach(async () => {
  await shutdownCollaborationHandlers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  ipc.handlers.clear();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
});

async function serverFixture() {
  const workspace = await createTestWorkspace();
  cleanups.push(async () => {
    await rm(workspace.home, { recursive: true, force: true });
    await rm(workspace.root, { recursive: true, force: true });
  });
  const projectId = workspace.init.workspace.id;
  const workspaceId = legacyWorkspaceIdForProject(projectId);
  const adminToken = `pw_operator_${"S".repeat(43)}`;
  const httpServer = createServer();
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [{ workspaceId, projectId, canvasId: "default", projectRoot: workspace.root }],
    operatorCredentials: [
      {
        operatorId: "scope-admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const composition = await createDistributedServerComposition({ httpServer, config });
  await seedOperatorSessions(config.databasePath, config.operatorCredentials);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await composition.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("scope_server_address_missing");
  const origin = `http://127.0.0.1:${address.port}/`;
  const issue = await fetch(`${origin}api/v1/workspaces/${workspaceId}/setup-codes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "workspace-setup/v1", purpose: "device_session" })
  });
  expect(issue.status).toBe(201);
  const issued = await issue.json();
  const redeem = await fetch(`${origin}api/v1/setup-codes/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      setupCode: issued.setupCode,
      displayName: "Scope owner"
    })
  });
  expect(redeem.status).toBe(200);
  const credential = await redeem.json();
  const database = await openServerDatabase(config.databasePath, 5000);
  new ProjectAccessRepository(database).grant({
    workspaceId,
    projectId,
    canvasId: "default",
    humanPrincipalId: credential.humanPrincipalId,
    role: "editor",
    grantedBy: { kind: "human", id: credential.humanPrincipalId }
  });
  cleanups.push(async () => database.close());
  return { origin, projectId, workspaceId, database, credential, adminToken, home: workspace.home };
}

it("refuses an old renderer write while local activation has an unverified candidate, without touching B SQLite", async () => {
  const a = await serverFixture();
  const b = await serverFixture();
  const root = await mkdtemp(join(tmpdir(), "planweave-ipc-operation-scope-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.PLANWEAVE_HOME = root;
  const entered = deferred();
  const release = deferred();
  let published: CollaborationStatus | null = null;
  let barrier = false;
  const service = registerCollaborationHandlers({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStorePaths: { profilesPath: join(root, "workspaces.json") },
    credentialsPath: join(root, "credentials.json"),
    invitationsPath: join(root, "invitations.json"),
    exportedIdentityPath: join(root, "identity.json"),
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString()
    },
    onStatusChange: (status) => {
      published = status;
    },
    request: async (input, init) => {
      if (
        barrier &&
        String(input).startsWith(`${b.origin}api/v1/registry/projects/${b.projectId}/canvases`)
      ) {
        entered.resolve();
        await release.promise;
      }
      return fetch(input, init);
    }
  });
  vi.spyOn(service, "migrateLegacyLocalOwnerDisplayName").mockResolvedValue(false);
  const profiles = new Map();
  for (const [label, target] of [
    ["A", a],
    ["B", b]
  ] as const) {
    const profile = {
      profileId: `profile-${label}`,
      projectId: target.projectId,
      displayName: label,
      serverBaseUrl: target.origin,
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http" as const,
        serverOrigin: target.origin,
        allowedClientOrigins: [target.origin],
        tlsTrust: "not_applicable" as const
      }
    };
    profiles.set(profile.profileId, profile);
    await service.upsertProfile(profile);
    await service.importDeviceCredential({
      profileId: profile.profileId,
      deviceToken: target.credential.deviceToken,
      humanPrincipalId: target.credential.humanPrincipalId
    });
  }
  await service.connectSession({ profileId: "profile-A" });
  const scopeA = (await service.getStatus()).session.operationScope;
  if (!scopeA) throw new Error("verified_scope_missing");
  const invoke = async (name: keyof typeof collaborationInvokeChannels, input: unknown) => {
    const handler = ipc.handlers.get(collaborationInvokeChannels[name]);
    if (!handler) throw new Error(`handler_missing:${name}`);
    return handler({}, input);
  };
  const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };
  const bytes = Buffer.from("A scoped attachment");
  const digestSha256 = createHash("sha256").update(bytes).digest("hex");
  const pending = pendingAttachmentViewSchema.parse(
    await invoke("createCollaborationPendingAttachment", {
      operationScope: scopeA,
      expectedSizeBytes: bytes.length,
      mediaType: "text/plain",
      fileName: "a.txt"
    })
  );
  await invoke("uploadCollaborationPendingAttachment", {
    operationScope: scopeA,
    pendingUploadId: pending.pendingUploadId,
    mediaType: "text/plain",
    bodyBase64: bytes.toString("base64"),
    digestSha256
  });
  const finalized = finalizePendingAttachmentResponseSchema.parse(
    await invoke("finalizeCollaborationPendingAttachment", {
      operationScope: scopeA,
      pendingUploadId: pending.pendingUploadId,
      expectedDigestSha256: digestSha256
    })
  );
  const commentA = commentDisplayProjectionSchema.parse(
    await invoke("createCollaborationComment", {
      operationScope: scopeA,
      workItem,
      body: "stable A comment",
      attachments: [
        {
          pendingUploadId: finalized.pendingUploadId,
          digestSha256: finalized.digestSha256,
          sizeBytes: finalized.sizeBytes,
          mediaType: finalized.mediaType,
          fileName: finalized.fileName
        }
      ]
    })
  );
  expect(a.database.prepare("SELECT body FROM comments").all()).toEqual([
    { body: "stable A comment" }
  ]);
  expect(a.database.prepare("SELECT digest_sha256 FROM comment_attachment_bindings").all()).toEqual(
    [{ digest_sha256: digestSha256 }]
  );
  expect(
    await invoke("readCollaborationCommentAttachment", {
      operationScope: scopeA,
      commentId: commentA.commentId,
      digestSha256
    })
  ).toMatchObject({ bodyBase64: bytes.toString("base64") });
  const staged = pendingAttachmentViewSchema.parse(
    await invoke("createCollaborationPendingAttachment", {
      operationScope: scopeA,
      expectedSizeBytes: bytes.length,
      mediaType: "text/plain"
    })
  );
  const activate = createLocalCollaborationActivationCommand({
    service,
    coordinator: {
      currentSelection: () => ({ projectId: a.projectId, canvasId: "default" }),
      status: () => ({ state: "running" }),
      start: async () => ({ state: "running" }),
      currentSelectionIsTrusted: () => true,
      recognizesLocalProfile: (id) => profiles.has(id),
      setCurrentSelection: async () => undefined,
      clearCurrentSelection: async () => undefined,
      localProfile: () => profiles.get("profile-A"),
      localProfileForId: (id) => profiles.get(id),
      bootstrapLocalProfileOwner: () => {
        throw new Error("already_bootstrapped");
      },
      registerCurrentProject: () => ({ workspaceId: a.workspaceId }),
      registerLocalProfile: (id) => ({
        workspaceId: id === "profile-B" ? b.workspaceId : a.workspaceId
      })
    }
  });
  const rendererStatus = published;
  barrier = true;
  const switching = activate.activate({ profileId: "profile-B" });
  try {
    await entered.promise;
    expect(published).toBe(rendererStatus);
    const handler = ipc.handlers.get(collaborationInvokeChannels.createCollaborationComment)!;
    const result = await handler(
      {},
      {
        workItem: { kind: "block", canvasId: "default", blockRef: "T-001#B-001" },
        body: "A draft must never reach B",
        attachments: []
      }
    );
    expect(b.database.prepare("SELECT body FROM comments").all()).toEqual([]);
    expect(result).toMatchObject({ desktopCommandFailure: true });
    for (const [name, payload] of [
      ["createCollaborationComment", { workItem, body: "captured A", attachments: [] }],
      [
        "createCollaborationPendingAttachment",
        { expectedSizeBytes: bytes.length, mediaType: "text/plain" }
      ],
      [
        "uploadCollaborationPendingAttachment",
        {
          pendingUploadId: staged.pendingUploadId,
          mediaType: "text/plain",
          bodyBase64: bytes.toString("base64")
        }
      ],
      ["finalizeCollaborationPendingAttachment", { pendingUploadId: staged.pendingUploadId }],
      [
        "readCollaborationPendingAttachment",
        { pendingUploadId: pending.pendingUploadId, digestSha256 }
      ],
      ["readCollaborationCommentAttachment", { commentId: commentA.commentId, digestSha256 }],
      ["listCollaborationComments", { workItem }],
      ["listCollaborationActivity", { workItem }]
    ] as const) {
      expect(await invoke(name, { ...payload, operationScope: scopeA })).toMatchObject({
        desktopCommandFailure: true,
        error: { code: "collaboration_operation_scope_stale" }
      });
    }
    expect(b.database.prepare("SELECT body FROM comments").all()).toEqual([]);
    expect(
      b.database.prepare("SELECT pending_upload_id FROM comment_pending_uploads").all()
    ).toEqual([]);
    expect(
      b.database.prepare("SELECT digest_sha256 FROM comment_attachment_bindings").all()
    ).toEqual([]);
  } finally {
    release.resolve();
    await switching;
  }
  const scopeB = (await service.getStatus()).session.operationScope;
  if (!scopeB) throw new Error("verified_B_scope_missing");
  for (const operationScope of [
    scopeA,
    { ...scopeB, profileId: scopeA.profileId },
    { ...scopeB, projectId: scopeA.projectId },
    { ...scopeB, serverBaseUrl: scopeA.serverBaseUrl }
  ]) {
    expect(
      await invoke("createCollaborationComment", {
        operationScope,
        workItem,
        body: "wrong identity",
        attachments: []
      })
    ).toMatchObject({
      desktopCommandFailure: true,
      error: { code: "collaboration_operation_scope_stale" }
    });
  }
  commentDisplayProjectionSchema.parse(
    await invoke("createCollaborationComment", {
      operationScope: scopeB,
      workItem,
      body: "stable B comment",
      attachments: []
    })
  );
  expect(b.database.prepare("SELECT body FROM comments").all()).toEqual([
    { body: "stable B comment" }
  ]);
  await activate.activate({ profileId: "profile-A" });
  const returnedScopeA = (await service.getStatus()).session.operationScope;
  expect(returnedScopeA?.sessionId).not.toBe(scopeA.sessionId);
  expect(
    await invoke("uploadCollaborationPendingAttachment", {
      operationScope: scopeA,
      pendingUploadId: staged.pendingUploadId,
      mediaType: "text/plain",
      bodyBase64: bytes.toString("base64")
    })
  ).toMatchObject({
    desktopCommandFailure: true,
    error: { code: "collaboration_operation_scope_stale" }
  });
  expect(
    a.database
      .prepare("SELECT status FROM comment_pending_uploads WHERE pending_upload_id = ?")
      .get(staged.pendingUploadId)
  ).toEqual({ status: "pending" });
  await service.importDeviceCredential({
    profileId: "profile-A",
    deviceToken: a.credential.deviceToken,
    humanPrincipalId: a.credential.humanPrincipalId
  });
  await service.connectSession({ profileId: "profile-A" });
  const replacementScope = (await service.getStatus()).session.operationScope;
  expect(replacementScope?.sessionId).not.toBe(returnedScopeA?.sessionId);
  expect(
    await invoke("createCollaborationComment", {
      operationScope: returnedScopeA,
      workItem,
      body: "old credential generation",
      attachments: []
    })
  ).toMatchObject({
    desktopCommandFailure: true,
    error: { code: "collaboration_operation_scope_stale" }
  });
  commentDisplayProjectionSchema.parse(
    await invoke("createCollaborationComment", {
      operationScope: replacementScope,
      workItem,
      body: "current credential generation",
      attachments: []
    })
  );
  expect(a.database.prepare("SELECT body FROM comments ORDER BY rowid").all()).toEqual([
    { body: "stable A comment" },
    { body: "current credential generation" }
  ]);
}, 30000);

it.each([
  "responsibility",
  "reviewer"
] as const)("binds an admitted %s mutation to its verified credential while snapshot flush delays retirement", async (kind) => {
  const a = await serverFixture();
  const issued = await fetch(`${a.origin}api/v1/workspaces/${a.workspaceId}/setup-codes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${a.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "workspace-setup/v1", purpose: "device_session" })
  }).then((response) => response.json());
  const replacement = await fetch(`${a.origin}api/v1/setup-codes/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      setupCode: issued.setupCode,
      displayName: "Replacement owner"
    })
  }).then((response) => response.json());
  expect(replacement.humanPrincipalId).not.toBe(a.credential.humanPrincipalId);
  new ProjectAccessRepository(a.database).grant({
    workspaceId: a.workspaceId,
    projectId: a.projectId,
    canvasId: "default",
    humanPrincipalId: replacement.humanPrincipalId,
    role: "editor",
    grantedBy: { kind: "human", id: a.credential.humanPrincipalId }
  });
  const root = await mkdtemp(join(tmpdir(), "planweave-ipc-credential-race-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.PLANWEAVE_HOME = a.home;
  const registryEntered = deferred(),
    releaseRegistry = deferred(),
    flushEntered = deferred(),
    releaseFlush = deferred();
  const cache = new WorkspaceAuthoritativeSnapshotCache(join(root, "snapshots"));
  const realFlush = cache.flush.bind(cache);
  let hold = false;
  const mutationCredentials: string[] = [];
  const service = registerCollaborationHandlers({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStorePaths: { profilesPath: join(root, "workspaces.json") },
    credentialsPath: join(root, "credentials.json"),
    invitationsPath: join(root, "invitations.json"),
    exportedIdentityPath: join(root, "identity.json"),
    workspaceSnapshotCache: cache,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString()
    },
    request: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path.includes(`/assignments/${kind}`))
        mutationCredentials.push(new Headers(init.headers).get("authorization") ?? "missing");
      const response = await fetch(input, init);
      if (hold && path === "/api/v1/registry/projects") {
        registryEntered.resolve();
        await releaseRegistry.promise;
      }
      return response;
    }
  });
  const profile = {
    profileId: "credential-profile",
    projectId: a.projectId,
    displayName: "Credential boundary",
    serverBaseUrl: a.origin,
    allowInsecureTransport: true,
    endpoint: {
      topology: "loopback_http" as const,
      serverOrigin: a.origin,
      allowedClientOrigins: [a.origin],
      tlsTrust: "not_applicable" as const
    }
  };
  await service.upsertProfile(profile);
  await service.importDeviceCredential({
    profileId: profile.profileId,
    deviceToken: a.credential.deviceToken,
    humanPrincipalId: a.credential.humanPrincipalId
  });
  await service.connectSession({ profileId: profile.profileId });
  const operationScope = (await service.getStatus()).session.operationScope;
  if (!operationScope) throw new Error("verified_credential_scope_missing");
  vi.spyOn(cache, "flush").mockImplementation(async () => {
    flushEntered.resolve();
    await releaseFlush.promise;
    return realFlush();
  });
  hold = true;
  const handler = ipc.handlers.get(
    kind === "responsibility"
      ? collaborationInvokeChannels.updateCollaborationResponsibility
      : collaborationInvokeChannels.updateCollaborationReviewer
  );
  if (!handler) throw new Error("responsibility_handler_missing");
  const mutation = handler(
    {},
    {
      operationScope,
      workItem: { kind: "task", canvasId: "default", taskId: "T-001" },
      principal: { kind: "human", humanPrincipalId: a.credential.humanPrincipalId },
      expectedRevision: 0
    }
  );
  await registryEntered.promise;
  const importing = service.importDeviceCredential({
    profileId: profile.profileId,
    deviceToken: replacement.deviceToken,
    humanPrincipalId: replacement.humanPrincipalId
  });
  try {
    await flushEntered.promise;
    hold = false;
    releaseRegistry.resolve();
    const result = await mutation;
    const persisted = a.database
      .prepare(
        kind === "responsibility"
          ? "SELECT updated_by_id FROM responsibility_records"
          : "SELECT updated_by_id FROM review_assignment_records"
      )
      .all();
    expect(result).toMatchObject({ revision: 1 });
    expect(mutationCredentials).toEqual([`Bearer ${a.credential.deviceToken}`]);
    expect(persisted).toEqual([{ updated_by_id: a.credential.humanPrincipalId }]);
  } finally {
    hold = false;
    releaseRegistry.resolve();
    releaseFlush.resolve();
    await importing;
  }
}, 30000);
