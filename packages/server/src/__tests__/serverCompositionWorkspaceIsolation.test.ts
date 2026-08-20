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
});
