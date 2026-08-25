import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  CollaborationClient,
  type CollaborationObserverHandlers,
  type CollaborationWebSocketConstructor
} from "../main/collaboration/CollaborationClient.js";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../../../server/src/config.js";
import { hashOperatorToken } from "../../../server/src/operatorAuth.js";
import { ProjectAccessRepository } from "../../../server/src/projectAccessRepository.js";
import { WorkspaceIdentityRepository } from "../../../server/src/identity/workspaceRepository.js";
import { openServerDatabase } from "../../../server/src/sqlite.js";
import { legacyWorkspaceIdForProject } from "../../../server/src/__tests__/support/legacyWorkspaceId.js";
import { seedOperatorSessions } from "../../../server/src/__tests__/support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../../server/src/serverComposition.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const clients: CollaborationClient[] = [];
const hostSockets: WebSocket[] = [];
const compositionAdminToken = `pw_operator_${"D".repeat(43)}`;

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const socket of hostSockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  return manifest;
}

async function setup() {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const projectId = workspace.init.workspace.id;
  const httpServer = createServer();
  servers.push(httpServer);
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      {
        workspaceId: legacyWorkspaceIdForProject(projectId),
        projectId,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "desktop-e2e-admin",
        tokenSha256: hashOperatorToken(compositionAdminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const composition = await createDistributedServerComposition({
    httpServer,
    config
  });
  compositions.push(composition);
  await seedOperatorSessions(config.databasePath, config.operatorCredentials);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    projectId,
    workspaceId: legacyWorkspaceIdForProject(projectId),
    projectRoot: workspace.root,
    databasePath: config.databasePath,
    origin: `http://127.0.0.1:${address.port}`,
    adminToken: compositionAdminToken
  };
}

function clientFor(origin: string, projectId: string, token?: string): CollaborationClient {
  const client = new CollaborationClient({
    profile: {
      profileId: `desktop-e2e-${token ? "authenticated" : "anonymous"}`,
      displayName: "Desktop E2E",
      serverBaseUrl: `${origin}/`,
      projectId,
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable"
      }
    },
    credential: { getDeviceToken: () => token },
    WebSocketImpl: WebSocket as unknown as CollaborationWebSocketConstructor
  });
  clients.push(client);
  return client;
}

async function redeemWorkspaceDevice(input: {
  origin: string;
  adminToken: string;
  workspaceId: string;
  displayName: string;
}): Promise<{ token: string; humanPrincipalId: string; identityToken: string }> {
  const issue = await fetch(
    `${input.origin}/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/setup-codes`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "workspace-setup/v1", purpose: "device_session" })
    }
  );
  expect(issue.status).toBe(201);
  const issued = (await issue.json()) as { setupCode: string };
  const redeem = await fetch(`${input.origin}/api/v1/setup-codes/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      setupCode: issued.setupCode,
      displayName: input.displayName
    })
  });
  expect(redeem.status).toBe(200);
  const redeemed = (await redeem.json()) as {
    deviceToken: string;
    humanPrincipalId: string;
    identityToken: string;
  };
  expect(redeemed.identityToken).toMatch(/^pw_hid_/);
  return {
    token: redeemed.deviceToken,
    humanPrincipalId: redeemed.humanPrincipalId,
    identityToken: redeemed.identityToken
  };
}

function createHostMessageInbox(socket: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const waiters: Array<{
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (!waiter) {
      messages.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  socket.on("error", (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  return {
    next(): Promise<Record<string, unknown>> {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("host_message_timeout"));
        }, 5_000);
        waiters.push({ resolve, reject, timer });
      });
    }
  };
}

async function nextHostMessageOfType(
  nextMessage: () => Promise<Record<string, unknown>>,
  expectedType: string
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const message = await nextMessage();
    if (message.type === expectedType) return message;
    if (message.type === "protocol.error") {
      throw new Error(`host_protocol_error:${String(message.code)}`);
    }
  }
  throw new Error(`host_message_type_timeout:${expectedType}`);
}

async function connectEnrolledHost(input: {
  origin: string;
  adminToken: string;
  workspaceId: string;
  ownerHumanPrincipalId: string;
  accessMode?: "unrestricted" | "workspace_restricted";
  createWorkspaceGrant?: boolean;
}) {
  const grantResponse = await fetch(`${input.origin}/api/v1/host-enrollments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      ownerHumanPrincipalId: input.ownerHumanPrincipalId,
      accessMode: input.accessMode ?? "workspace_restricted",
      ...(input.createWorkspaceGrant === false ? {} : { createWorkspaceGrant: true })
    })
  });
  expect(grantResponse.status).toBe(201);
  const grant = (await grantResponse.json()) as { enrollmentCode: string; workspaceId: string };
  expect(grant.workspaceId).toBe(input.workspaceId);
  const credentialToken = `pw_host_${"D".repeat(43)}`;
  const enrollmentRequest = {
    type: "host.enrollment.request",
    protocolVersion: 1,
    enrollmentCode: grant.enrollmentCode,
    enrollmentAttemptId: "desktop-e2e-host-enrollment",
    installationId: "21fb9ea9-4e0d-49fb-a06c-a0fc71e7341e",
    credentialToken,
    displayName: "Desktop E2E Host",
    capabilities: ["acp.codex", "acp.session.load"],
    capacity: 1
  };
  const exchangeResponse = await fetch(`${input.origin}/agent-hosts/enrollments/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(enrollmentRequest)
  });
  expect(exchangeResponse.status).toBe(200);
  const exchange = (await exchangeResponse.json()) as { hostId: string };
  const socket = new WebSocket(
    `${input.origin.replace(/^http:/, "ws:")}/agent-hosts/${exchange.hostId}/connect?workspaceId=${encodeURIComponent(grant.workspaceId)}`,
    { headers: { Authorization: `Bearer ${credentialToken}` } }
  );
  hostSockets.push(socket);
  const inbox = createHostMessageInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const welcomePromise = inbox.next();
  socket.send(
    JSON.stringify({
      type: "host.hello",
      protocolVersion: 1,
      lastAcknowledgedSequence: 0,
      capabilities: enrollmentRequest.capabilities,
      capacity: 1,
      readiness: {
        workspaceMappings: [{ workspaceId: grant.workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Test Agent",
            status: "ready",
            capabilities: enrollmentRequest.capabilities
          }
        ]
      }
    })
  );
  await expect(welcomePromise).resolves.toMatchObject({ type: "host.welcome" });
  return {
    socket,
    hostId: exchange.hostId,
    workspaceId: grant.workspaceId,
    next: (expectedType: string) => nextHostMessageOfType(() => inbox.next(), expectedType)
  };
}

function startObserverAndWait(
  client: CollaborationClient,
  handlers: CollaborationObserverHandlers = {},
  options?: { cursor?: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("observer_status_timeout")), 5_000);
    client.startObserver(
      {
        ...handlers,
        onStatus: (status) => {
          handlers.onStatus?.(status);
          if (status.state === "connected") {
            clearTimeout(timer);
            resolve();
          } else if (status.state === "auth_expired" || status.state === "failed") {
            clearTimeout(timer);
            reject(new Error(`observer_${status.state}_${status.code}`));
          }
        }
      },
      options
    );
  });
}

async function createIdentityFixture() {
  const fixture = await setup();
  const anonymous = clientFor(fixture.origin, fixture.projectId);
  const ownerBootstrap = await anonymous.bootstrapOwner({
    displayName: "Desktop Owner",
    humanPrincipalId: "desktop-e2e-owner"
  });
  if (!ownerBootstrap.deviceToken) throw new Error("owner_bootstrap_missing_device_token");
  const owner = clientFor(fixture.origin, fixture.projectId, ownerBootstrap.deviceToken);
  const invitation = await owner.createInvitation();
  const memberBootstrap = await anonymous.consumeInvitation({
    invitationToken: invitation.invitationToken,
    displayName: "Desktop Member"
  });
  const member = clientFor(fixture.origin, fixture.projectId, memberBootstrap.deviceToken);
  return { fixture, anonymous, owner, member, ownerBootstrap, memberBootstrap };
}

async function configureWorkspaceWorkAccess(input: {
  fixture: Awaited<ReturnType<typeof setup>>;
  ownerBootstrap: Awaited<ReturnType<CollaborationClient["bootstrapOwner"]>>;
}) {
  const workspaceOwner = await redeemWorkspaceDevice({
    origin: input.fixture.origin,
    adminToken: input.fixture.adminToken,
    workspaceId: input.fixture.workspaceId,
    displayName: "Desktop Workspace Owner"
  });
  const workspaceMember = await redeemWorkspaceDevice({
    origin: input.fixture.origin,
    adminToken: input.fixture.adminToken,
    workspaceId: input.fixture.workspaceId,
    displayName: "Desktop Workspace Member"
  });
  const database = await openServerDatabase(input.fixture.databasePath, 5_000);
  try {
    const access = new ProjectAccessRepository(database);
    for (const humanPrincipalId of [
      workspaceOwner.humanPrincipalId,
      workspaceMember.humanPrincipalId
    ]) {
      access.grant({
        workspaceId: input.fixture.workspaceId,
        projectId: input.fixture.projectId,
        canvasId: "default",
        humanPrincipalId,
        role: "editor",
        grantedBy: { kind: "human", id: input.ownerBootstrap.principal.humanPrincipalId }
      });
    }
  } finally {
    database.close();
  }
  const workspaceConnection = await fetch(`${input.fixture.origin}/api/v1/workspace-connection`, {
    headers: { Authorization: `Bearer ${workspaceOwner.token}` }
  });
  expect(workspaceConnection.status).toBe(200);
  return {
    workspaceOwner: clientFor(input.fixture.origin, input.fixture.projectId, workspaceOwner.token),
    workspaceMember,
    workspaceOwnerHumanPrincipalId: workspaceOwner.humanPrincipalId,
    workspaceOwnerToken: workspaceOwner.token,
    workspaceOwnerIdentityToken: workspaceOwner.identityToken
  };
}

const blockWorkItem = {
  kind: "block" as const,
  canvasId: "default",
  blockRef: "T-001#B-001"
};

describe("Desktop CollaborationClient against the Server composition", () => {
  it("covers identity, membership, assignment, and comment mutations", async () => {
    const { fixture, owner, member, ownerBootstrap, memberBootstrap } =
      await createIdentityFixture();

    const revocableInvitation = await owner.createInvitation();
    const openInvitations = await owner.listInvitations({ openOnly: true });
    expect(openInvitations.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invitationId: revocableInvitation.invitation.invitationId })
      ])
    );
    const revokedInvitation = await owner.revokeInvitation(
      revocableInvitation.invitation.invitationId
    );
    expect(revokedInvitation.revokedAt).toBeDefined();

    expect((await member.listMembers()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: memberBootstrap.principal.humanPrincipalId })
      ])
    );
    expect((await owner.listMembers()).items.map((item) => item.humanPrincipalId)).toEqual(
      expect.arrayContaining([
        ownerBootstrap.principal.humanPrincipalId,
        memberBootstrap.principal.humanPrincipalId
      ])
    );
    const projectDevices = await owner.listDevices({ scope: "project" });
    expect(projectDevices.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceCredentialId: memberBootstrap.device.deviceCredentialId })
      ])
    );
    await owner.revokeDevice(memberBootstrap.device.deviceCredentialId);
    expect(
      (await owner.listDevices({ scope: "project" })).items.find(
        (device) => device.deviceCredentialId === memberBootstrap.device.deviceCredentialId
      )?.revokedAt
    ).toBeDefined();
    await expect(member.listAssignments({ canvasId: "default" })).rejects.toMatchObject({
      kind: "auth",
      code: "work_auth_unauthenticated",
      httpStatus: 401
    });
    const { workspaceOwner, workspaceMember } = await configureWorkspaceWorkAccess({
      fixture,
      ownerBootstrap
    });

    const assignment = await workspaceOwner.updateAssignment({
      workItem: blockWorkItem,
      target: { kind: "human", humanPrincipalId: workspaceMember.humanPrincipalId },
      expectedRevision: 0,
      reason: "Desktop network assignment"
    });
    expect(assignment.revision).toBe(1);
    expect((await workspaceOwner.getAssignment(blockWorkItem)).target).toEqual(assignment.target);
    expect((await workspaceOwner.listAssignments({ canvasId: "default" })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ workItem: blockWorkItem, revision: 1 })])
    );
    expect((await workspaceOwner.listEligibleAssignees(blockWorkItem)).humans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanPrincipalId: workspaceMember.humanPrincipalId,
          membershipActive: true
        })
      ])
    );
    await expect(
      workspaceOwner.updateAssignment({
        workItem: blockWorkItem,
        target: { kind: "unassigned" },
        expectedRevision: 0
      })
    ).rejects.toMatchObject({ kind: "conflict", httpStatus: 409 });

    const comment = await workspaceOwner.createComment({
      workItem: blockWorkItem,
      body: "Desktop network comment"
    });
    const edited = await workspaceOwner.editComment({
      commentId: comment.commentId,
      body: "Desktop edited comment",
      expectedRevision: 1
    });
    expect(edited.revision).toBe(2);
    expect(edited.body).toBe("Desktop edited comment");
    const tombstoned = await workspaceOwner.tombstoneComment({
      commentId: comment.commentId,
      expectedRevision: 2,
      reason: "Desktop test tombstone"
    });
    expect(tombstoned.tombstoned).toBe(true);
    expect(
      (await workspaceOwner.listComments({ workItem: blockWorkItem, limit: 50 })).items
    ).toEqual([]);
    expect(
      (
        await workspaceOwner.listComments({
          workItem: blockWorkItem,
          limit: 50,
          includeTombstoned: true
        })
      ).items
    ).toEqual(expect.arrayContaining([expect.objectContaining({ tombstoned: true })]));
    expect(
      (await workspaceOwner.listActivity({ workItem: blockWorkItem, limit: 50 })).items
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "comment_tombstoned",
          summary: expect.objectContaining({ commentId: comment.commentId })
        })
      ])
    );

    await owner.promoteOwner(memberBootstrap.principal.humanPrincipalId);
    expect(
      (await owner.listMembers()).items.find(
        (item) => item.humanPrincipalId === memberBootstrap.principal.humanPrincipalId
      )?.role
    ).toBe("owner");
    await owner.demoteOwner(memberBootstrap.principal.humanPrincipalId);
    expect(
      (await owner.listMembers()).items.find(
        (item) => item.humanPrincipalId === memberBootstrap.principal.humanPrincipalId
      )?.role
    ).toBe("member");
    await owner.removeMember(memberBootstrap.principal.humanPrincipalId);
    expect((await owner.listMembers()).items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: memberBootstrap.principal.humanPrincipalId })
      ])
    );
  });

  it("maps remote action, event, interaction, and error routes through the client", async () => {
    const { fixture, ownerBootstrap } = await createIdentityFixture();
    const { workspaceOwner, workspaceOwnerHumanPrincipalId } = await configureWorkspaceWorkAccess({
      fixture,
      ownerBootstrap
    });
    const host = await connectEnrolledHost({
      origin: fixture.origin,
      adminToken: fixture.adminToken,
      workspaceId: fixture.workspaceId,
      ownerHumanPrincipalId: workspaceOwnerHumanPrincipalId
    });
    const endpointPage = await workspaceOwner.listAgentEndpoints({
      workspaceId: fixture.workspaceId,
      canvasId: blockWorkItem.canvasId
    });
    const agentEndpointId = endpointPage.items.find(
      (endpoint) => endpoint.status === "available"
    )?.endpointId;
    expect(agentEndpointId).toBeTruthy();
    const remoteDispatch = workspaceOwner.dispatchRemoteOperation({
      schemaVersion: "remote-run/v3",
      projectId: fixture.projectId,
      canvasId: blockWorkItem.canvasId,
      blockRef: blockWorkItem.blockRef,
      agentEndpointId: agentEndpointId!,
      idempotencyKey: "desktop-e2e-remote-operation",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0
    });
    const execute = await host.next("mailbox.message");
    expect(execute.type).toBe("mailbox.message");
    const command = execute.command as {
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    };
    const sequence = execute.sequence as number;
    host.socket.send(
      JSON.stringify({
        type: "mailbox.ack",
        protocolVersion: 1,
        messageId: "desktop-e2e-mailbox-ack",
        sequence
      })
    );
    await expect(host.next("host.event_ack")).resolves.toMatchObject({ type: "host.event_ack" });
    host.socket.send(
      JSON.stringify({
        type: "dispatch.accepted",
        protocolVersion: 1,
        messageId: "desktop-e2e-dispatch-accepted",
        dispatchId: command.dispatchId,
        leaseId: command.leaseId,
        executionAttemptId: command.executionAttemptId
      })
    );
    await expect(host.next("host.event_ack")).resolves.toMatchObject({ type: "host.event_ack" });
    host.socket.send(
      JSON.stringify({
        type: "acp.events",
        protocolVersion: 1,
        messageId: "desktop-e2e-acp-events",
        dispatchId: command.dispatchId,
        leaseId: command.leaseId,
        executionAttemptId: command.executionAttemptId,
        acpSessionId: "desktop-e2e-acp-session",
        afterCursor: 0,
        cursor: 1,
        events: [{ cursor: 1, kind: "agent_message", text: "desktop e2e event" }]
      })
    );
    await expect(host.next("host.event_ack")).resolves.toMatchObject({ type: "host.event_ack" });
    const remote = await remoteDispatch;
    expect((await workspaceOwner.observeRemoteOperation(remote.operationId)).operationId).toBe(
      remote.operationId
    );

    const replayedEvents = await workspaceOwner.replayRemoteOperationEvents(remote.operationId, {
      afterCursor: 0
    });
    expect(replayedEvents.afterCursor).toBe(0);
    expect(replayedEvents.cursor).toBe(1);
    expect(replayedEvents.highWatermark).toBe(1);
    expect(replayedEvents.events).toEqual([
      expect.objectContaining({
        cursor: 1,
        kind: "agent_message",
        text: "desktop e2e event"
      })
    ]);
    const events = await workspaceOwner.replayRemoteOperationEvents(remote.operationId, {
      afterCursor: 1
    });
    expect(events).toMatchObject({ afterCursor: 1, cursor: 1, events: [], hasMore: false });
    const interactions = await workspaceOwner.listRemoteOperationInteractions(remote.operationId, {
      cursor: 0,
      limit: 50
    });
    expect(interactions).toEqual({ items: [], nextCursor: null });

    await expect(
      workspaceOwner.executeRemoteOperationAction(remote.operationId, {
        kind: "cancel",
        actionId: "desktop-e2e-cancel",
        operationId: remote.operationId,
        dispatchId: remote.dispatchId,
        executionAttemptId: remote.executionAttemptId,
        expectedAttemptVersion: remote.attempt.stateVersion,
        leaseId: "desktop-e2e-stale-lease",
        reason: "No active host lease in composition fixture"
      })
    ).rejects.toMatchObject({ kind: "conflict", httpStatus: 409 });
    await expect(
      workspaceOwner.settleRemoteOperationInteraction(remote.operationId, {
        type: "interaction.authentication_action",
        action: "cancel",
        actionId: "desktop-e2e-interaction",
        dispatchId: remote.dispatchId,
        executionAttemptId: remote.executionAttemptId,
        leaseId: "desktop-e2e-stale-lease",
        acpSessionId: "desktop-e2e-acp-session"
      })
    ).rejects.toMatchObject({ kind: "not_found", httpStatus: 404 });
    await expect(workspaceOwner.observeRemoteOperation("missing-operation")).rejects.toMatchObject({
      kind: "not_found",
      httpStatus: 404
    });
  });

  it("lets the same workspace human keep an unrestricted agent after joining another workspace", async () => {
    const { fixture, ownerBootstrap } = await createIdentityFixture();
    const { workspaceOwner, workspaceOwnerHumanPrincipalId, workspaceOwnerIdentityToken } =
      await configureWorkspaceWorkAccess({
        fixture,
        ownerBootstrap
      });
    await connectEnrolledHost({
      origin: fixture.origin,
      adminToken: fixture.adminToken,
      workspaceId: fixture.workspaceId,
      ownerHumanPrincipalId: workspaceOwnerHumanPrincipalId,
      accessMode: "unrestricted",
      createWorkspaceGrant: false
    });
    const localCatalog = await workspaceOwner.listAgentEndpoints({
      canvasId: blockWorkItem.canvasId
    });
    expect(localCatalog.items.some((endpoint) => endpoint.status === "available")).toBe(true);

    const databaseForWorkspace = await openServerDatabase(fixture.databasePath, 5_000);
    const workspaceB = new WorkspaceIdentityRepository(
      databaseForWorkspace
    ).ensureWorkspaceForLegacyProject(`${fixture.projectId}-second`);
    databaseForWorkspace.close();
    const issued = await fetch(
      `${fixture.origin}/api/v1/workspaces/${encodeURIComponent(workspaceB)}/setup-codes`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ schemaVersion: "workspace-setup/v1", purpose: "device_session" })
      }
    );
    expect(issued.status).toBe(201);
    const setupCode = ((await issued.json()) as { setupCode: string }).setupCode;
    const second = await fetch(`${fixture.origin}/api/v1/setup-codes/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode,
        displayName: "Second Workspace",
        existingIdentityToken: workspaceOwnerIdentityToken
      })
    });
    expect(second.status).toBe(200);
    const redeemed = (await second.json()) as {
      humanPrincipalId: string;
      deviceToken: string;
    };
    expect(redeemed.humanPrincipalId).toBe(workspaceOwnerHumanPrincipalId);

    const database = await openServerDatabase(fixture.databasePath, 5_000);
    try {
      const access = new ProjectAccessRepository(database);
      access.registerProjectInternal({
        workspaceId: workspaceB,
        projectId: fixture.projectId,
        projectRoot: fixture.projectRoot
      });
      access.initializeProjectOwner(workspaceB, fixture.projectId, redeemed.humanPrincipalId);
      access.registerCanvasInternal({
        workspaceId: workspaceB,
        projectId: fixture.projectId,
        canvasId: "default",
        packageDir: join(fixture.projectRoot, "package")
      });
      access.initializeCanvasOwner(
        workspaceB,
        fixture.projectId,
        "default",
        redeemed.humanPrincipalId
      );
    } finally {
      database.close();
    }

    const workspaceBOwner = clientFor(fixture.origin, fixture.projectId, redeemed.deviceToken);
    const workspaceBCatalog = await workspaceBOwner.listAgentEndpoints({
      workspaceId: workspaceB,
      canvasId: blockWorkItem.canvasId
    });
    expect(workspaceBCatalog.items.some((endpoint) => endpoint.status === "available")).toBe(true);
  });

  it("replays only disconnected observer events and reports catchup before refetch", async () => {
    const { owner } = await createIdentityFixture();
    await startObserverAndWait(owner);
    const cursorBeforeDisconnect = owner.lastObserverCursor();
    owner.stopObserver();

    const disconnectedComment = await owner.createComment({
      workItem: blockWorkItem,
      body: "Desktop disconnected observer comment"
    });
    const replayedEvents: Array<{
      cursor: number;
      previousCursor: number;
      kind: string;
      commentId?: string;
    }> = [];
    let replayResolve: ((events: typeof replayedEvents) => void) | undefined;
    let replayTimer: ReturnType<typeof setTimeout> | undefined;
    const replayPromise = new Promise<typeof replayedEvents>((resolve, reject) => {
      replayResolve = resolve;
      replayTimer = setTimeout(() => reject(new Error("observer_replay_timeout")), 5_000);
    });
    await startObserverAndWait(
      owner,
      {
        onEvent: (event) => {
          replayedEvents.push(event);
          if (replayedEvents.length === 2) {
            if (replayTimer) clearTimeout(replayTimer);
            replayResolve?.(replayedEvents);
          }
        }
      },
      { cursor: cursorBeforeDisconnect }
    );
    const replay = await replayPromise;
    expect(replay.map((event) => event.cursor)).toEqual([
      cursorBeforeDisconnect + 1,
      cursorBeforeDisconnect + 2
    ]);
    expect(replay.map((event) => event.previousCursor)).toEqual([
      cursorBeforeDisconnect,
      cursorBeforeDisconnect + 1
    ]);
    expect(replay.every((event) => event.commentId === disconnectedComment.commentId)).toBe(true);
    owner.stopObserver();

    const catchupPromise = new Promise<{
      reason: string;
      resumeCursor: number;
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("observer_catchup_timeout")), 5_000);
      owner.startObserver(
        {
          onCatchupRequired: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          onStatus: (status) => {
            if (status.state === "auth_expired" || status.state === "failed") {
              clearTimeout(timer);
              reject(new Error(`observer_${status.state}_${status.code}`));
            }
          }
        },
        { cursor: owner.lastObserverCursor() + 100 }
      );
    });
    const catchup = await catchupPromise;
    expect(catchup.reason).toBe("cursor_ahead");
    owner.stopObserver();

    const comments = await owner.listComments({ workItem: blockWorkItem, limit: 50 });
    expect(comments.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commentId: disconnectedComment.commentId })
      ])
    );
    const activity = await owner.listActivity({ workItem: blockWorkItem, limit: 50 });
    expect(activity.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "comment_created",
          summary: expect.objectContaining({ commentId: disconnectedComment.commentId })
        })
      ])
    );
  });
});
