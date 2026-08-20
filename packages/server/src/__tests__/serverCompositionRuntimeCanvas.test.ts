import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
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
    const runtimeStatus = await fetch(
      `${origin}/api/v1/projects/${projectId}/canvases/default/runtime-status`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(runtimeStatus.status).toBe(200);
    await expect(runtimeStatus.json()).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "workspace-server", projectId, canvasId: "default" }
    });
    const secondaryDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
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
    await expect(secondaryDispatch.json()).resolves.toEqual({ error: "remote_run_v3_required" });
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
      headers: jsonHeaders(adminToken),
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
    const canvases = await fetch(`${origin}/api/v1/registry/projects/${projectId}/canvases`, {
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({ registry: expect.objectContaining({ canvasId: "default" }) })
      ]
    });

    const ownerDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId,
        canvasId: "secondary",
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-not-enrolled",
        idempotencyKey: "owner-secondary-dispatch",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0
      })
    });
    await expect(ownerDispatch.json()).resolves.toEqual({ error: "agent_endpoint_unknown" });
    expect(ownerDispatch.status).toBe(409);
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

    const dispatch = await fetch(`http://127.0.0.1:${address.port}/api/v1/remote-operations`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId,
        canvasId: "default",
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-not-enrolled",
        idempotencyKey: "owner-only-dispatch",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0
      })
    });

    expect(dispatch.status).toBe(409);
    await expect(dispatch.json()).resolves.toEqual({ error: "agent_endpoint_unknown" });
  });
});
