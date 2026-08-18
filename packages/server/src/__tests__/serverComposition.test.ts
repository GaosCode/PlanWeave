import { createServer, type Server as HttpServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  loadProjectGraph,
  projectCanvasWorkspace,
  writeProjectGraph
} from "../../../runtime/src/projectGraph/index.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { aclMigrationIdFor, applyMigrations, projectRegistryIdFor } from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import {
  adminToken,
  addSecondaryCanvas,
  configureAutomaticExecutionTarget,
  jsonHeaders,
  remoteManifest,
  setupServerCompositionFixture
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

async function setup() {
  return setupServerCompositionFixture({ directories, httpServers, compositions });
}

describe("distributed server composition", () => {
  it("starts a collaboration Server before any trusted project is configured", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const httpServer = createServer();
    httpServers.push(httpServer);
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "empty-collaboration-server-data"),
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
    const composition = await createDistributedServerComposition({ httpServer, config });
    compositions.push(composition);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");

    expect(composition.trustedProjectControl.listTrustedProjectScopes()).toEqual([]);
    const origin = `http://127.0.0.1:${address.port}`;
    const readiness = await fetch(`${origin}/readyz`);
    expect(readiness.status).toBe(200);
    const issued = await fetch(`${origin}/api/v1/setup-codes`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session"
      })
    });
    expect(issued.status).toBe(201);
    await expect(issued.json()).resolves.toMatchObject({
      grant: { workspaceId: "workspace-self-host", purpose: "device_session" },
      displayOnce: true
    });
  });

  it("exposes active trusted project scopes with WorkspaceIdentity-derived workspace IDs", async () => {
    const fixture = await setup();
    const scopes = fixture.composition.trustedProjectControl.listTrustedProjectScopes();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ projectId: fixture.projectId, canvasId: "default" });
    expect(JSON.stringify(scopes)).not.toMatch(/path|package|tmp/);

    const database = await openServerDatabase(fixture.databasePath, 5_000);
    try {
      expect(fixture.workspaceId).toBe(scopes[0].workspaceId);
      expect(
        fixture.composition.trustedProjectControl.resolveTrustedProjectScope({
          workspaceId: "workspace-other-001",
          projectId: fixture.projectId,
          canvasId: "default"
        })
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("keeps identical project and canvas IDs isolated across configured Workspace sessions", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const httpServer = createServer();
    httpServers.push(httpServer);
    const projectId = workspace.init.workspace.id;
    const workspaceA = "workspace-scope-a";
    const workspaceB = "workspace-scope-b";
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "same-id-server-data"),
      trustedProjects: [
        {
          workspaceId: workspaceA,
          projectId,
          trustAllDeclaredCanvases: true,
          projectRoot: workspace.root
        },
        {
          workspaceId: workspaceB,
          projectId,
          trustAllDeclaredCanvases: true,
          projectRoot: workspace.root
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

    const redeemDevice = async (
      workspaceId: string,
      displayName: string
    ): Promise<{ token: string; humanPrincipalId: string }> => {
      const issue = await fetch(`${origin}/api/v1/workspaces/${workspaceId}/setup-codes`, {
        method: "POST",
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ schemaVersion: "workspace-setup/v1", purpose: "device_session" })
      });
      expect(issue.status).toBe(201);
      const issued = (await issue.json()) as { setupCode: string };
      const redeem = await fetch(`${origin}/api/v1/setup-codes/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "workspace-setup/v1",
          purpose: "device_session",
          setupCode: issued.setupCode,
          displayName
        })
      });
      expect(redeem.status).toBe(200);
      const redeemed = (await redeem.json()) as {
        deviceToken: string;
        humanPrincipalId: string;
      };
      return { token: redeemed.deviceToken, humanPrincipalId: redeemed.humanPrincipalId };
    };

    const [deviceA, deviceB] = await Promise.all([
      redeemDevice(workspaceA, "Workspace A Owner"),
      redeemDevice(workspaceB, "Workspace B Owner")
    ]);
    const tokenA = deviceA.token;
    const tokenB = deviceB.token;
    const [connectionA, connectionB] = await Promise.all([
      fetch(`${origin}/api/v1/workspace-connection`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      }),
      fetch(`${origin}/api/v1/workspace-connection`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      })
    ]);
    expect(connectionA.status).toBe(200);
    expect(connectionB.status).toBe(200);
    await expect(connectionA.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ workspaceId: workspaceA })]
    });
    await expect(connectionB.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ workspaceId: workspaceB })]
    });
    const accessUrl = `${origin}/api/v1/projects/${projectId}/canvases/default/access`;
    const [accessA, accessB] = await Promise.all([
      fetch(accessUrl, { headers: { Authorization: `Bearer ${tokenA}` } }),
      fetch(accessUrl, { headers: { Authorization: `Bearer ${tokenB}` } })
    ]);
    expect(accessA.status).toBe(200);
    expect(accessB.status).toBe(200);
    await expect(accessA.json()).resolves.toMatchObject({
      scope: { workspaceId: workspaceA, projectId, canvasId: "default" }
    });
    await expect(accessB.json()).resolves.toMatchObject({
      scope: { workspaceId: workspaceB, projectId, canvasId: "default" }
    });

    const deviceAViewer = await redeemDevice(workspaceA, "Workspace A Viewer");
    const assignmentsUrl = `${origin}/api/v1/projects/${projectId}/assignments`;
    const legacyTask = { kind: "task", canvasId: "default", taskId: "T-001" };
    const legacyTaskQuery = `?workItem=${encodeURIComponent(JSON.stringify(legacyTask))}`;
    const privateAssignmentRead = await fetch(`${assignmentsUrl}${legacyTaskQuery}`, {
      headers: { Authorization: `Bearer ${deviceAViewer.token}` }
    });
    expect(privateAssignmentRead.status).toBe(403);

    const viewerGrant = await fetch(accessUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({
        operation: "grant",
        scope: { scopeKind: "canvas", workspaceId: workspaceA, projectId, canvasId: "default" },
        expectedAclRevision: 0,
        humanPrincipalId: deviceAViewer.humanPrincipalId,
        role: "viewer"
      })
    });
    expect(viewerGrant.status).toBe(200);
    const viewerAssignmentRead = await fetch(`${assignmentsUrl}${legacyTaskQuery}`, {
      headers: { Authorization: `Bearer ${deviceAViewer.token}` }
    });
    expect(viewerAssignmentRead.status).toBe(200);
    const accessWithGrant = (await (
      await fetch(accessUrl, {
        headers: { Authorization: `Bearer ${tokenA}` }
      })
    ).json()) as {
      people: Array<{ humanPrincipalId: string; grants: Array<{ grantId: string }> }>;
    };
    const viewerGrantId = accessWithGrant.people.find(
      (person) => person.humanPrincipalId === deviceAViewer.humanPrincipalId
    )?.grants[0]?.grantId;
    if (!viewerGrantId) throw new Error("Expected viewer grant");
    const revokeViewerGrant = await fetch(accessUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({
        operation: "revoke",
        scope: { scopeKind: "canvas", workspaceId: workspaceA, projectId, canvasId: "default" },
        expectedAclRevision: 1,
        grantId: viewerGrantId
      })
    });
    expect(revokeViewerGrant.status).toBe(200);
    const revokedAssignmentRead = await fetch(`${assignmentsUrl}${legacyTaskQuery}`, {
      headers: { Authorization: `Bearer ${deviceAViewer.token}` }
    });
    expect(revokedAssignmentRead.status).toBe(403);
    const privateTargetAssignment = await fetch(assignmentsUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({
        workItem: legacyTask,
        target: { kind: "human", humanPrincipalId: deviceAViewer.humanPrincipalId },
        expectedRevision: 0
      })
    });
    expect(privateTargetAssignment.status).toBe(403);

    const [legacyAssignmentA, legacyAssignmentB] = await Promise.all([
      fetch(assignmentsUrl, {
        method: "POST",
        headers: jsonHeaders(tokenA),
        body: JSON.stringify({
          workItem: legacyTask,
          target: { kind: "human", humanPrincipalId: deviceA.humanPrincipalId },
          expectedRevision: 0
        })
      }),
      fetch(assignmentsUrl, {
        method: "POST",
        headers: jsonHeaders(tokenB),
        body: JSON.stringify({
          workItem: legacyTask,
          target: { kind: "human", humanPrincipalId: deviceB.humanPrincipalId },
          expectedRevision: 0
        })
      })
    ]);
    expect(legacyAssignmentA.status).toBe(200);
    expect(legacyAssignmentB.status).toBe(200);
    const [legacyReadA, legacyReadB] = await Promise.all([
      fetch(`${assignmentsUrl}${legacyTaskQuery}`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      }),
      fetch(`${assignmentsUrl}${legacyTaskQuery}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      })
    ]);
    expect(legacyReadA.status).toBe(200);
    expect(legacyReadB.status).toBe(200);
    await expect(legacyReadA.json()).resolves.toMatchObject({
      target: { kind: "human", humanPrincipalId: deviceA.humanPrincipalId }
    });
    await expect(legacyReadB.json()).resolves.toMatchObject({
      target: { kind: "human", humanPrincipalId: deviceB.humanPrincipalId }
    });
    const listQuery = `?workItems=${encodeURIComponent(JSON.stringify([legacyTask]))}`;
    const [legacyListA, legacyListB, eligibleA, eligibleB] = await Promise.all([
      fetch(`${assignmentsUrl}/list${listQuery}`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      }),
      fetch(`${assignmentsUrl}/list${listQuery}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      }),
      fetch(`${assignmentsUrl}/eligible-assignees${legacyTaskQuery}`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      }),
      fetch(`${assignmentsUrl}/eligible-assignees${legacyTaskQuery}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      })
    ]);
    expect(legacyListA.status).toBe(200);
    expect(legacyListB.status).toBe(200);
    expect(eligibleA.status).toBe(200);
    expect(eligibleB.status).toBe(200);
    await expect(legacyListA.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          target: { kind: "human", humanPrincipalId: deviceA.humanPrincipalId }
        })
      ]
    });
    await expect(legacyListB.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          target: { kind: "human", humanPrincipalId: deviceB.humanPrincipalId }
        })
      ]
    });
    const eligibleABody = (await eligibleA.json()) as {
      humans: Array<{ humanPrincipalId: string }>;
    };
    const eligibleBBody = (await eligibleB.json()) as {
      humans: Array<{ humanPrincipalId: string }>;
    };
    expect(eligibleABody.humans.map((human) => human.humanPrincipalId)).toEqual([
      deviceA.humanPrincipalId
    ]);
    expect(eligibleBBody.humans.map((human) => human.humanPrincipalId)).toEqual([
      deviceB.humanPrincipalId
    ]);

    const secondaryTask = { kind: "task", canvasId: "secondary", taskId: "T-001" };
    const secondaryAssignment = await fetch(assignmentsUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({
        workItem: secondaryTask,
        target: { kind: "human", humanPrincipalId: deviceA.humanPrincipalId },
        expectedRevision: 0
      })
    });
    expect(secondaryAssignment.status).toBe(200);
    const secondaryQuery = `?workItem=${encodeURIComponent(JSON.stringify(secondaryTask))}`;
    const [secondaryReadA, secondaryReadB] = await Promise.all([
      fetch(`${assignmentsUrl}${secondaryQuery}`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      }),
      fetch(`${assignmentsUrl}${secondaryQuery}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      })
    ]);
    expect(secondaryReadA.status).toBe(200);
    expect(secondaryReadB.status).toBe(200);
    await expect(secondaryReadA.json()).resolves.toMatchObject({
      target: { kind: "human", humanPrincipalId: deviceA.humanPrincipalId }
    });
    await expect(secondaryReadB.json()).resolves.toMatchObject({ target: { kind: "unassigned" } });

    const restoreViewerGrant = await fetch(accessUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({
        operation: "grant",
        scope: { scopeKind: "canvas", workspaceId: workspaceA, projectId, canvasId: "default" },
        expectedAclRevision: 2,
        humanPrincipalId: deviceAViewer.humanPrincipalId,
        role: "viewer"
      })
    });
    expect(restoreViewerGrant.status).toBe(200);
    const viewerAllAssignments = await fetch(`${assignmentsUrl}/list`, {
      headers: { Authorization: `Bearer ${deviceAViewer.token}` }
    });
    expect(viewerAllAssignments.status).toBe(200);
    const viewerAllAssignmentsBody = (await viewerAllAssignments.json()) as {
      items: Array<{ workItem: { canvasId: string } }>;
      nextCursor: number | null;
    };
    expect(viewerAllAssignmentsBody.items).toHaveLength(1);
    expect(viewerAllAssignmentsBody.items[0]?.workItem.canvasId).toBe("default");
    expect(viewerAllAssignmentsBody.nextCursor).toBeNull();

    const mutateA = await fetch(accessUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({
        operation: "visibility",
        scope: { scopeKind: "canvas", workspaceId: workspaceA, projectId, canvasId: "default" },
        expectedAclRevision: 3,
        visibility: "shared"
      })
    });
    expect(mutateA.status).toBe(200);
    const forgedWorkspace = await fetch(accessUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({
        operation: "visibility",
        scope: { scopeKind: "canvas", workspaceId: workspaceB, projectId, canvasId: "default" },
        expectedAclRevision: 0,
        visibility: "shared"
      })
    });
    expect(forgedWorkspace.status).toBe(403);
    await expect(forgedWorkspace.json()).resolves.toEqual({ error: "cross_workspace" });

    const commentsUrl = `${origin}/api/v1/projects/${projectId}/comments`;
    const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };
    const createdComment = await fetch(commentsUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({ workItem, body: "Workspace A only" })
    });
    expect(createdComment.status).toBe(201);
    const commentQuery = `?workItem=${encodeURIComponent(JSON.stringify(workItem))}`;
    const [commentsA, commentsB] = await Promise.all([
      fetch(`${commentsUrl}${commentQuery}`, { headers: { Authorization: `Bearer ${tokenA}` } }),
      fetch(`${commentsUrl}${commentQuery}`, { headers: { Authorization: `Bearer ${tokenB}` } })
    ]);
    expect(commentsA.status).toBe(200);
    expect(commentsB.status).toBe(200);
    await expect(commentsA.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ body: "Workspace A only" })]
    });
    await expect(commentsB.json()).resolves.toMatchObject({ items: [] });

    const responsibilityUrl = `${origin}/api/v1/projects/${projectId}/assignments/responsibility`;
    const responsibilityScopeA = {
      kind: "block",
      workspaceId: workspaceA,
      projectId,
      canvasId: "default",
      blockRef: "T-001#B-001"
    };
    const assignedA = await fetch(responsibilityUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({
        schemaVersion: "responsibility/v1",
        scope: responsibilityScopeA,
        principal: { kind: "human", humanPrincipalId: deviceA.humanPrincipalId },
        expectedRevision: 0
      })
    });
    expect(assignedA.status).toBe(200);
    const responsibilityScopeB = { ...responsibilityScopeA, workspaceId: workspaceB };
    const authorityB = await fetch(
      `${responsibilityUrl}?scope=${encodeURIComponent(JSON.stringify(responsibilityScopeB))}`,
      { headers: { Authorization: `Bearer ${tokenB}` } }
    );
    expect(authorityB.status).toBe(200);
    await expect(authorityB.json()).resolves.toBeNull();
    const forgedAssignment = await fetch(responsibilityUrl, {
      method: "POST",
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({
        schemaVersion: "responsibility/v1",
        scope: responsibilityScopeB,
        principal: { kind: "human", humanPrincipalId: deviceB.humanPrincipalId },
        expectedRevision: 0
      })
    });
    expect(forgedAssignment.status).toBe(403);

    const taskScopeA = {
      kind: "task",
      workspaceId: workspaceA,
      projectId,
      canvasId: "default",
      taskId: "T-001"
    };
    const taskScopeB = { ...taskScopeA, workspaceId: workspaceB };
    const [taskAssignmentA, taskAssignmentB] = await Promise.all([
      fetch(responsibilityUrl, {
        method: "POST",
        headers: jsonHeaders(tokenA),
        body: JSON.stringify({
          schemaVersion: "responsibility/v1",
          scope: taskScopeA,
          principal: { kind: "human", humanPrincipalId: deviceA.humanPrincipalId },
          expectedRevision: 0
        })
      }),
      fetch(responsibilityUrl, {
        method: "POST",
        headers: jsonHeaders(tokenB),
        body: JSON.stringify({
          schemaVersion: "responsibility/v1",
          scope: taskScopeB,
          principal: { kind: "human", humanPrincipalId: deviceB.humanPrincipalId },
          expectedRevision: 0
        })
      })
    ]);
    expect(taskAssignmentA.status).toBe(200);
    expect(taskAssignmentB.status).toBe(200);
    const taskQueryA = `${responsibilityUrl}?scope=${encodeURIComponent(JSON.stringify(taskScopeA))}`;
    const taskQueryB = `${responsibilityUrl}?scope=${encodeURIComponent(JSON.stringify(taskScopeB))}`;
    const [taskReadA, taskReadB] = await Promise.all([
      fetch(taskQueryA, { headers: { Authorization: `Bearer ${tokenA}` } }),
      fetch(taskQueryB, { headers: { Authorization: `Bearer ${tokenB}` } })
    ]);
    expect(taskReadA.status).toBe(200);
    expect(taskReadB.status).toBe(200);
    await expect(taskReadA.json()).resolves.toMatchObject({
      scope: taskScopeA,
      principal: { humanPrincipalId: deviceA.humanPrincipalId }
    });
    await expect(taskReadB.json()).resolves.toMatchObject({
      scope: taskScopeB,
      principal: { humanPrincipalId: deviceB.humanPrincipalId }
    });

    const executionTargetUrl = `${origin}/api/v1/projects/${projectId}/assignments/execution-target`;
    const executionScopeA = responsibilityScopeA;
    const executionScopeB = responsibilityScopeB;
    const [blockAssignmentA, blockAssignmentB] = await Promise.all([
      fetch(executionTargetUrl, {
        method: "POST",
        headers: jsonHeaders(tokenA),
        body: JSON.stringify({
          schemaVersion: "execution-target/v1",
          scope: executionScopeA,
          target: { kind: "automatic_host" },
          expectedRevision: 0
        })
      }),
      fetch(executionTargetUrl, {
        method: "POST",
        headers: jsonHeaders(tokenB),
        body: JSON.stringify({
          schemaVersion: "execution-target/v1",
          scope: executionScopeB,
          target: { kind: "unassigned" },
          expectedRevision: 0
        })
      })
    ]);
    expect(blockAssignmentA.status).toBe(400);
    expect(blockAssignmentB.status).toBe(400);
    await expect(blockAssignmentA.json()).resolves.toEqual({ error: "execution_target_read_only" });
    await expect(blockAssignmentB.json()).resolves.toEqual({ error: "execution_target_read_only" });
    const blockQueryA = `${executionTargetUrl}?scope=${encodeURIComponent(JSON.stringify(executionScopeA))}`;
    const blockQueryB = `${executionTargetUrl}?scope=${encodeURIComponent(JSON.stringify(executionScopeB))}`;
    const [blockReadA, blockReadB] = await Promise.all([
      fetch(blockQueryA, { headers: { Authorization: `Bearer ${tokenA}` } }),
      fetch(blockQueryB, { headers: { Authorization: `Bearer ${tokenB}` } })
    ]);
    expect(blockReadA.status).toBe(200);
    expect(blockReadB.status).toBe(200);
    await expect(blockReadA.json()).resolves.toBeNull();
    await expect(blockReadB.json()).resolves.toBeNull();
    const [crossTaskRead, crossBlockWrite] = await Promise.all([
      fetch(taskQueryB, { headers: { Authorization: `Bearer ${tokenA}` } }),
      fetch(executionTargetUrl, {
        method: "POST",
        headers: jsonHeaders(tokenA),
        body: JSON.stringify({
          schemaVersion: "execution-target/v1",
          scope: executionScopeB,
          target: { kind: "automatic_host" },
          expectedRevision: 1
        })
      })
    ]);
    expect(crossTaskRead.status).toBe(403);
    expect(crossBlockWrite.status).toBe(403);

    const reconnectUrl = `${origin}/api/v1/projects/${projectId}/canvases/default/reconnect`;
    const [reconnectA, reconnectB] = await Promise.all([
      fetch(reconnectUrl, {
        method: "POST",
        headers: jsonHeaders(tokenA),
        body: JSON.stringify({ afterRevision: 0 })
      }),
      fetch(reconnectUrl, {
        method: "POST",
        headers: jsonHeaders(tokenB),
        body: JSON.stringify({ afterRevision: 0 })
      })
    ]);
    expect(reconnectA.status).toBe(200);
    expect(reconnectB.status).toBe(200);

    const contentHeadUrl = `${origin}/api/v1/projects/${projectId}/canvases/default/content/head`;
    const [headA, headB] = await Promise.all([
      fetch(contentHeadUrl, {
        method: "POST",
        headers: jsonHeaders(tokenA),
        body: JSON.stringify({ localReplica: null, knownRevision: null })
      }),
      fetch(contentHeadUrl, {
        method: "POST",
        headers: jsonHeaders(tokenB),
        body: JSON.stringify({ localReplica: null, knownRevision: null })
      })
    ]);
    expect(headA.status).toBe(200);
    expect(headB.status).toBe(200);
    expect(
      composition.trustedProjectControl.resolveTrustedProjectScope({
        workspaceId: workspaceA,
        projectId,
        canvasId: "default"
      })
    ).toMatchObject({ workspaceId: workspaceA });
    expect(
      composition.trustedProjectControl.resolveTrustedProjectScope({
        workspaceId: workspaceB,
        projectId,
        canvasId: "default"
      })
    ).toMatchObject({ workspaceId: workspaceB });
  });

  it("materializes trusted registry owners during bootstrap for listing and management", async () => {
    const fixture = await setup();
    const bootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
      }
    );
    expect(bootstrap.status).toBe(201);
    const bootstrapBody = (await bootstrap.json()) as { deviceToken: string };
    const headers = { Authorization: `Bearer ${bootstrapBody.deviceToken}` };

    const projects = await fetch(`${fixture.origin}/api/v1/registry/projects`, { headers });
    expect(projects.status).toBe(200);
    await expect(projects.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ projectId: fixture.projectId }),
          owner: "trusted-owner"
        })
      ]
    });

    const canvases = await fetch(
      `${fixture.origin}/api/v1/registry/projects/${fixture.projectId}/canvases`,
      { headers }
    );
    expect(canvases.status).toBe(200);
    const canvasesBody = (await canvases.json()) as {
      items: Array<{ registry: { canvasId: string }; owner: string; acl: { revision: number } }>;
    };
    expect(canvasesBody.items).toEqual([
      expect.objectContaining({
        registry: expect.objectContaining({ canvasId: "default" }),
        owner: "trusted-owner",
        acl: { revision: 0, updatedAt: expect.any(String) }
      })
    ]);

    const snapshot = await fetch(
      `${fixture.origin}/api/v1/registry/projects/${fixture.projectId}/canvases/default/snapshots`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: fixture.projectId,
          canvasId: "default",
          expectedAclRevision: canvasesBody.items[0].acl.revision
        })
      }
    );
    expect(snapshot.status).toBe(201);
  });

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

  it("binds an unbound legacy registry row without rewriting package/state/results", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const dataDirectory = join(workspace.root, "legacy-server-data");
    const databasePath = join(dataDirectory, "planweave-server.sqlite");
    const database = await openServerDatabase(databasePath, 5_000);
    applyMigrations(database);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(
      workspace.init.workspace.id
    );
    const at = "2026-01-01T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO project_registry(project_registry_id,workspace_id,project_id,project_root_internal,visibility,owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at) VALUES(?,?,?,NULL,'private',NULL,0,?,?,NULL)`
      )
      .run(
        projectRegistryIdFor(workspaceId, workspace.init.workspace.id),
        workspaceId,
        workspace.init.workspace.id,
        at,
        at
      );
    database
      .prepare(
        `INSERT INTO acl_registry_migrations(migration_id,workspace_id,project_id,canvas_id,source_kind,marker,status,failure_code,updated_at) VALUES(?,?,?,NULL,'legacy_project','project_registered','pending',NULL,?)`
      )
      .run(
        aclMigrationIdFor("legacy_project", workspaceId, workspace.init.workspace.id),
        workspaceId,
        workspace.init.workspace.id,
        at
      );
    const beforeManifest = await readFile(workspace.init.workspace.manifestFile);
    const beforeState = await readFile(workspace.init.workspace.stateFile);
    const resultsFile = join(workspace.init.workspace.resultsDir, "existing-result.json");
    await writeFile(resultsFile, '{"result":"preserve"}\n', "utf8");
    const beforeResults = await readFile(resultsFile);
    database.close();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          workspaceId,
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          projectRoot: workspace.root
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
    const reopened = await openServerDatabase(databasePath, 5_000);
    expect(
      reopened
        .prepare("SELECT project_root_internal FROM project_registry WHERE project_id=?")
        .get(workspace.init.workspace.id)?.project_root_internal
    ).toBe(workspace.root);
    expect(
      reopened
        .prepare(
          "SELECT status,marker FROM acl_registry_migrations WHERE workspace_id=? AND project_id=? AND source_kind='legacy_project'"
        )
        .get(workspaceId, workspace.init.workspace.id)
    ).toEqual({ status: "completed", marker: "cutover_complete" });
    expect(await readFile(workspace.init.workspace.manifestFile)).toEqual(beforeManifest);
    expect(await readFile(workspace.init.workspace.stateFile)).toEqual(beforeState);
    expect(await readFile(resultsFile)).toEqual(beforeResults);
    reopened.close();
  });

  it("revokes Runtime canvases removed between composition startups", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "reconcile-server-data");
    const loaded = await loadProjectGraph(workspace.root);
    const secondaryCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "secondary");
    if (!secondaryCanvas) throw new Error("Expected secondary canvas");
    const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
    const secondaryManifestBefore = await readFile(secondaryWorkspace.manifestFile);
    const secondaryResultPath = join(secondaryWorkspace.resultsDir, "existing-result.json");
    await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
    await writeFile(secondaryResultPath, '{"result":"preserve"}\n', "utf8");
    const secondaryResultsBefore = await readFile(secondaryResultPath);

    const startComposition = async () => {
      const httpServer = createServer();
      httpServers.push(httpServer);
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
      return composition;
    };

    const first = await startComposition();
    await first.close();
    compositions.splice(compositions.indexOf(first), 1);
    const current = await loadProjectGraph(workspace.root);
    const defaultCanvas = current.manifest.canvases.find((canvas) => canvas.id === "default");
    if (!defaultCanvas) throw new Error("Expected default canvas");
    await writeProjectGraph(current.workspace, {
      version: "plan-project/v1",
      canvases: [defaultCanvas],
      edges: [],
      crossTaskEdges: []
    });

    const second = await startComposition();
    await second.close();
    compositions.splice(compositions.indexOf(second), 1);
    const database = await openServerDatabase(
      join(dataDirectory, "planweave-server.sqlite"),
      5_000
    );
    const workspaceId = "workspace-server";
    expect(
      database
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .get(workspaceId, projectId, "default")
    ).toMatchObject({ revoked_at: null });
    expect(
      database
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .get(workspaceId, projectId, "secondary")
    ).toMatchObject({ revoked_at: expect.any(String) });
    const access = new ProjectAccessRepository(database);
    expect(() =>
      access.registry.resolveCanvasPath({
        workspaceId,
        projectId,
        canvasId: "secondary"
      })
    ).toThrow("runtime_canvas_revoked");
    database.close();
    expect(await readFile(secondaryWorkspace.manifestFile)).toEqual(secondaryManifestBefore);
    expect(await readFile(secondaryResultPath)).toEqual(secondaryResultsBefore);
  });
});
