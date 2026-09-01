import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ownerCanvasMaterializationUploadMediaType } from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import { captureAuthorizedCanvasContent } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";
import { openServerDatabase } from "../sqlite.js";
import { ensureTestHumanPrincipal } from "./support/remoteAgentOwnerFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import {
  adminToken,
  addSecondaryCanvas,
  configureAutomaticExecutionTarget,
  jsonHeaders,
  remoteManifest
} from "./support/serverCompositionFixture.js";

const httpServers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];

async function recoverHumanIdentity(origin: string, deviceToken: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/human-identity/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "human-identity/v1",
      existingDeviceToken: deviceToken
    })
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { identityToken: string }).identityToken;
}

function operatorOwnerHeaders(identityToken: string): Record<string, string> {
  return {
    ...jsonHeaders(adminToken),
    "x-planweave-human-identity": `Bearer ${identityToken}`
  };
}

async function materializeOwnerCanvas(input: {
  origin: string;
  identityToken: string;
  projectRoot: string;
  projectId: string;
  canvasId: string;
  humanPrincipalId: string;
}) {
  const captured = await captureAuthorizedCanvasContent({
    projectRoot: input.projectRoot,
    canvasId: input.canvasId,
    authorityProjectId: input.projectId
  });
  const metadata = {
    schemaVersion: "owner-canvas-materialization/v1",
    materializationId: `runtime-canvas-${input.canvasId}`,
    scope: {
      ownerHumanPrincipalId: input.humanPrincipalId,
      projectId: input.projectId,
      canvasId: input.canvasId
    },
    expectedHead: { kind: "absent" }
  } as const;
  const frames = [
    { type: "header", request: metadata },
    ...captured.content.members.map((member, index) => ({ type: "member", index, member })),
    {
      type: "complete",
      canonicalDigest: captured.content.canonicalDigest,
      totalBytes: captured.content.totalBytes,
      memberCount: captured.content.members.length
    }
  ];
  const response = await fetch(`${input.origin}/api/v1/owner-canvas-materializations`, {
    method: "POST",
    headers: {
      ...operatorOwnerHeaders(input.identityToken),
      "content-type": ownerCanvasMaterializationUploadMediaType
    },
    body: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`
  });
  const body = (await response.json()) as {
    contentRevision?: string;
    graphFingerprint?: string;
    error?: string;
  };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.contentRevision).toBeTypeOf("string");
  expect(body.graphFingerprint).toBeTypeOf("string");
  return {
    contentRevision: body.contentRevision!,
    graphFingerprint: body.graphFingerprint!
  };
}

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("distributed server composition", () => {
  it("registers every Runtime canvas from one trusted entry and ignores undeclared paths", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const dataDirectory = join(workspace.root, "multi-canvas-server-data");
    const httpServer = createServer();
    httpServers.push(httpServer);
    const projectId = workspace.init.workspace.id;
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          workspaceId: "workspace-server",
          projectId,
          projectRoot: workspace.root,
          trustAllDeclaredCanvases: true
        }
      ],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(adminToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const composition = await createDistributedServerComposition({ httpServer, config });
    compositions.push(composition);
    const executionTargetRevision = await configureAutomaticExecutionTarget({
      databasePath: config.databasePath,
      workspaceId: "workspace-server",
      projectId,
      canvasId: "secondary",
      blockRef: "T-001#B-001"
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
    });
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    const identityToken = await recoverHumanIdentity(origin, deviceToken);
    const canvases = await fetch(`${origin}/api/v1/registry/projects/${projectId}/canvases`, {
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "default" })
        }),
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "secondary" })
        })
      ])
    });
    const runtimeAvailability = await fetch(
      `${origin}/api/v1/projects/${projectId}/canvases/default/runtime-availability`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(runtimeAvailability.status).toBe(200);
    await expect(runtimeAvailability.json()).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-view/v1",
      state: { kind: "uninitialized" },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "available",
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope: { workspaceId: "workspace-server", projectId, canvasId: "default" }
        }
      }
    });
    const legacyRuntimeStatus = await fetch(
      `${origin}/api/v1/projects/${projectId}/canvases/default/runtime-status`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(legacyRuntimeStatus.status).toBe(404);
    const secondaryDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: operatorOwnerHeaders(identityToken),
      body: JSON.stringify({
        schemaVersion: "remote-run/v2",
        projectId,
        canvasId: "secondary",
        blockRef: "T-001#B-001",
        idempotencyKey: "secondary-dispatch",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: executionTargetRevision
      })
    });
    expect(secondaryDispatch.status).toBe(400);
    await expect(secondaryDispatch.json()).resolves.toEqual({
      error: "remote_run_v3_required",
      serverBuildRevision: "development"
    });
  });

  it("does not expose secondary canvases through legacy canvas trust", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const dataDirectory = join(workspace.root, "legacy-canvas-scope-server-data");
    const httpServer = createServer();
    httpServers.push(httpServer);
    const projectId = workspace.init.workspace.id;
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          workspaceId: "workspace-server",
          projectId,
          projectRoot: workspace.root,
          canvasId: "default"
        }
      ],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(adminToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const composition = await createDistributedServerComposition({ httpServer, config });
    compositions.push(composition);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
    });
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    const identityToken = await recoverHumanIdentity(origin, deviceToken);
    const canvases = await fetch(`${origin}/api/v1/registry/projects/${projectId}/canvases`, {
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "default" })
        })
      ]
    });
    const secondaryDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: operatorOwnerHeaders(identityToken),
      body: JSON.stringify({
        projectId,
        canvasId: "secondary",
        blockRef: "T-001#B-001",
        idempotencyKey: "legacy-secondary-dispatch"
      })
    });
    expect(secondaryDispatch.status).not.toBe(202);
  });

  it("keeps collaboration canvas trust exact while Owner runtime accepts another declared canvas", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const dataDirectory = join(workspace.root, "owner-runtime-canvas-server-data");
    const projectId = workspace.init.workspace.id;
    const workspaceId = "workspace-server";
    const createConfig = (trustedProjects: unknown[]) =>
      parseServerConfig({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port: 7_443 },
        publicUrl: "http://127.0.0.1:7443",
        allowInsecureDevelopment: true,
        dataDirectory,
        trustedProjects,
        operatorCredentials: [
          {
            operatorId: "admin",
            tokenSha256: hashOperatorToken(adminToken),
            projectIds: [],
            serverAdmin: true
          }
        ]
      });
    const startAndClose = async (config: ReturnType<typeof parseServerConfig>) => {
      const seedServer = createServer();
      httpServers.push(seedServer);
      const seedComposition = await createDistributedServerComposition({
        httpServer: seedServer,
        config
      });
      await seedComposition.close();
    };
    await startAndClose(
      createConfig([
        {
          workspaceId,
          projectId,
          projectRoot: workspace.root,
          trustAllDeclaredCanvases: true
        }
      ])
    );
    const config = createConfig([
      { workspaceId, projectId, projectRoot: workspace.root, canvasId: "default" }
    ]);
    await startAndClose(config);
    const httpServer = createServer();
    httpServers.push(httpServer);
    const composition = await createDistributedServerComposition({
      httpServer,
      config,
      ownerTrustedProjects: [
        {
          workspaceId: "workspace-owner-runtime",
          projectId,
          projectRoot: workspace.root,
          trustAllDeclaredCanvases: true
        }
      ]
    });
    compositions.push(composition);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;

    const bootstrap = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
    });
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    const identityToken = await recoverHumanIdentity(origin, deviceToken);
    const canvases = await fetch(`${origin}/api/v1/registry/projects/${projectId}/canvases`, {
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({ registry: expect.objectContaining({ canvasId: "default" }) })
      ]
    });
    const ownerAuthority = await materializeOwnerCanvas({
      origin,
      identityToken,
      projectRoot: workspace.root,
      projectId,
      canvasId: "secondary",
      humanPrincipalId: "trusted-owner"
    });

    const ownerDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: operatorOwnerHeaders(identityToken),
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId,
        canvasId: "secondary",
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-not-enrolled",
        idempotencyKey: "owner-secondary-dispatch",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0,
        ...ownerAuthority,
        humanPrincipalId: "trusted-owner"
      })
    });
    await expect(ownerDispatch.json()).resolves.toEqual({
      error: "remote_agent_not_found",
      serverBuildRevision: "development"
    });
    expect(ownerDispatch.status).toBe(404);
  });

  it("dispatches through the Owner runtime with no collaboration Workspace configured", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const projectId = workspace.init.workspace.id;
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "owner-only-server-data"),
      trustedProjects: [],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(adminToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const httpServer = createServer();
    httpServers.push(httpServer);
    const composition = await createDistributedServerComposition({
      httpServer,
      config,
      ownerTrustedProjects: [
        {
          workspaceId: "workspace-owner-runtime",
          projectId,
          projectRoot: workspace.root,
          canvasId: "default"
        }
      ]
    });
    compositions.push(composition);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");

    const database = await openServerDatabase(config.databasePath, 5_000);
    ensureTestHumanPrincipal(database, "owner-runtime", "Owner Runtime");
    const identityToken = new HumanIdentityCredentialStore(database, () => new Date()).issue(
      "owner-runtime"
    ).identityToken;
    database.close();
    const ownerOrigin = `http://127.0.0.1:${address.port}`;
    const ownerAuthority = await materializeOwnerCanvas({
      origin: ownerOrigin,
      identityToken,
      projectRoot: workspace.root,
      projectId,
      canvasId: "default",
      humanPrincipalId: "owner-runtime"
    });

    const dispatch = await fetch(`${ownerOrigin}/api/v1/remote-operations`, {
      method: "POST",
      headers: operatorOwnerHeaders(identityToken),
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId,
        canvasId: "default",
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-not-enrolled",
        idempotencyKey: "owner-only-dispatch",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0,
        ...ownerAuthority,
        humanPrincipalId: "owner-runtime"
      })
    });

    expect(dispatch.status).toBe(404);
    await expect(dispatch.json()).resolves.toEqual({
      error: "remote_agent_not_found",
      serverBuildRevision: "development"
    });
  });
});
