import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { applyDefaultCanvasWorkspaceMigration, initWorkspace } from "@planweave-ai/runtime";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { writeJsonFile } from "../../../runtime/src/json.js";
import { parseServerConfig } from "../../../server/src/config.js";
import { hashOperatorToken } from "../../../server/src/operatorAuth.js";
import { legacyWorkspaceIdForProject } from "../../../server/src/__tests__/support/legacyWorkspaceId.js";
import { seedOperatorSessions } from "../../../server/src/__tests__/support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../../server/src/serverComposition.js";
import {
  CollaborationClient,
  type CollaborationWebSocketConstructor
} from "../main/collaboration/CollaborationClient.js";
import {
  WorkspaceCanvasPresenceController,
  type CanvasPresenceBridge,
  type CanvasPresenceLabels
} from "../renderer/collaboration/WorkspaceCanvasPresenceController.js";
import type { CollaborationPresenceSignal } from "../shared/collaboration.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const clients: CollaborationClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const labels: CanvasPresenceLabels = {
  error: (code) => `presence:${code}`
};

async function setup() {
  const first = await createTestWorkspace(basicManifest());
  const secondRoot = await mkdtemp(join(tmpdir(), "planweave-project-"));
  const secondInit = await initWorkspace({ projectRoot: secondRoot, projectGraph: true });
  const secondManifest = basicManifest();
  await writeJsonFile(secondInit.workspace.manifestFile, secondManifest);
  await writePromptFiles(secondInit.workspace.packageDir, secondManifest);
  directories.push(first.home, first.root, secondRoot);
  await applyDefaultCanvasWorkspaceMigration(first.init.workspace);
  await applyDefaultCanvasWorkspaceMigration(secondInit.workspace);
  const firstProjectId = first.init.workspace.id;
  const secondProjectId = secondInit.workspace.id;
  const httpServer = createServer();
  servers.push(httpServer);
  const adminToken = `pw_operator_${"E".repeat(43)}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(first.root, "server-data"),
    trustedProjects: [
      {
        workspaceId: legacyWorkspaceIdForProject(firstProjectId),
        projectId: firstProjectId,
        canvasId: "default",
        projectRoot: first.root
      },
      {
        workspaceId: legacyWorkspaceIdForProject(secondProjectId),
        projectId: secondProjectId,
        canvasId: "default",
        projectRoot: secondRoot
      }
    ],
    operatorCredentials: [
      {
        operatorId: "presence-e2e-admin",
        tokenSha256: hashOperatorToken(adminToken),
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
    origin: `http://127.0.0.1:${address.port}`,
    firstProjectId,
    secondProjectId
  };
}

async function bootstrap(origin: string, projectId: string, displayName: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName })
  });
  const body = await response.text();
  expect(response.status, body).toBe(201);
  return JSON.parse(body) as { deviceToken: string };
}

async function inviteMember(origin: string, projectId: string, ownerToken: string) {
  const invitationResponse = await fetch(
    `${origin}/api/v1/projects/${projectId}/human/invitations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    }
  );
  const invitationBody = await invitationResponse.text();
  expect(invitationResponse.status, invitationBody).toBe(201);
  const invitation = JSON.parse(invitationBody) as { invitationToken: string };
  const memberResponse = await fetch(
    `${origin}/api/v1/projects/${projectId}/human/invitations/consume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitationToken: invitation.invitationToken,
        displayName: "Desktop Member"
      })
    }
  );
  const memberBody = await memberResponse.text();
  expect(memberResponse.status, memberBody).toBe(201);
  return JSON.parse(memberBody) as { deviceToken: string };
}

function createClient(
  origin: string,
  projectId: string,
  profileId: string,
  token: string,
  limits?: { reconnectInitialDelayMs?: number; reconnectMaxDelayMs?: number }
) {
  const client = new CollaborationClient({
    profile: {
      profileId,
      displayName: profileId,
      serverBaseUrl: `${origin}/`,
      projectId,
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: `${origin}/`,
        allowedClientOrigins: [`${origin}/`],
        tlsTrust: "not_applicable"
      }
    },
    credential: { getDeviceToken: () => token },
    WebSocketImpl: WebSocket as unknown as CollaborationWebSocketConstructor,
    random: () => 0,
    limits: {
      reconnectInitialDelayMs: limits?.reconnectInitialDelayMs ?? 50,
      reconnectMaxDelayMs: limits?.reconnectMaxDelayMs ?? 100
    }
  });
  clients.push(client);
  return client;
}

function bridgeFor(client: CollaborationClient, profileId: string): CanvasPresenceBridge {
  let listener: ((signal: CollaborationPresenceSignal) => void) | null = null;
  return {
    startCollaborationPresence: ({ canvasId }) =>
      new Promise<void>((resolve, reject) => {
        client.startPresence(canvasId, {
          onSnapshot: (message) => {
            listener?.({ profileId, message });
            resolve();
          },
          onUpdate: (message) => listener?.({ profileId, message }),
          onLeave: (message) => listener?.({ profileId, message }),
          onError: (message) => {
            listener?.({ profileId, message });
            reject(new Error(`presence:${message.code}`));
          },
          onStatus: (status) => {
            if (status.state === "reconnecting") {
              listener?.({
                profileId,
                reset: { canvasId, reason: "disconnected" }
              });
            }
          }
        });
      }),
    stopCollaborationPresence: async () => client.stopPresence(),
    publishCollaborationPresence: async (input) => client.publishPresence(input),
    onCollaborationPresenceSignal: (callback) => {
      listener = callback;
      return () => {
        if (listener === callback) listener = null;
      };
    }
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}

describe("real Desktop canvas presence clients", () => {
  it("exchanges cursor state and isolates canvas/project scopes with leave cleanup", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.firstProjectId, "Desktop Owner");
    const member = await inviteMember(fixture.origin, fixture.firstProjectId, owner.deviceToken);
    const otherOwner = await bootstrap(
      fixture.origin,
      fixture.secondProjectId,
      "Other Project Owner"
    );
    expect(owner.deviceToken).not.toBe(exampleHumanDeviceToken);

    const ownerProfileId = "owner-profile";
    const memberProfileId = "member-profile";
    const otherProfileId = "other-project-profile";
    const ownerClient = createClient(
      fixture.origin,
      fixture.firstProjectId,
      ownerProfileId,
      owner.deviceToken
    );
    const memberClient = createClient(
      fixture.origin,
      fixture.firstProjectId,
      memberProfileId,
      member.deviceToken
    );
    const otherClient = createClient(
      fixture.origin,
      fixture.secondProjectId,
      otherProfileId,
      otherOwner.deviceToken
    );
    const ownerController = new WorkspaceCanvasPresenceController({
      api: bridgeFor(ownerClient, ownerProfileId),
      labels
    });
    const memberController = new WorkspaceCanvasPresenceController({
      api: bridgeFor(memberClient, memberProfileId),
      labels
    });
    const otherController = new WorkspaceCanvasPresenceController({
      api: bridgeFor(otherClient, otherProfileId),
      labels
    });

    await ownerController.start({ profileId: ownerProfileId, canvasId: "default" });
    await memberController.start({ profileId: memberProfileId, canvasId: "default" });
    await otherController.start({ profileId: otherProfileId, canvasId: "default" });
    await memberController.publish({ pointer: { x: 20, y: 30 }, selectionIds: ["T-001"] });
    await waitFor(() =>
      expect(ownerController.getSnapshot().sessions).toEqual([
        expect.objectContaining({ pointer: { x: 20, y: 30 }, selectionIds: ["T-001"] })
      ])
    );
    expect(otherController.getSnapshot().sessions).toEqual([]);

    // Pointer leave must propagate as null while the session stays connected.
    await memberController.publish({ pointer: null, selectionIds: ["T-001"] });
    await waitFor(() =>
      expect(ownerController.getSnapshot().sessions).toEqual([
        expect.objectContaining({ pointer: null, selectionIds: ["T-001"] })
      ])
    );

    await memberController.stop();
    await waitFor(() => expect(ownerController.getSnapshot().sessions).toEqual([]));
    const rejectedCanvas = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("canvas_isolation_timeout")), 3_000);
      memberClient.startPresence("other", {
        onStatus: (status) => {
          if (status.state === "reconnecting") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    await rejectedCanvas;
    memberClient.stopPresence();
    expect(ownerController.getSnapshot().sessions).toEqual([]);
    expect(otherController.getSnapshot().sessions).toEqual([]);

    await Promise.all([ownerController.stop(), memberController.stop(), otherController.stop()]);
  });

  it("re-publishes last pointer after presence disconnect and automatic reconnect", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.firstProjectId, "Owner Reconnect");
    const member = await inviteMember(fixture.origin, fixture.firstProjectId, owner.deviceToken);
    const ownerProfileId = "owner-reconnect";
    const memberProfileId = "member-reconnect";
    const ownerClient = createClient(
      fixture.origin,
      fixture.firstProjectId,
      ownerProfileId,
      owner.deviceToken
    );
    const memberClient = createClient(
      fixture.origin,
      fixture.firstProjectId,
      memberProfileId,
      member.deviceToken
    );
    const ownerController = new WorkspaceCanvasPresenceController({
      api: bridgeFor(ownerClient, ownerProfileId),
      labels
    });
    const memberController = new WorkspaceCanvasPresenceController({
      api: bridgeFor(memberClient, memberProfileId),
      labels
    });

    await ownerController.start({ profileId: ownerProfileId, canvasId: "default" });
    await memberController.start({ profileId: memberProfileId, canvasId: "default" });
    await memberController.publish({ pointer: { x: 7, y: 9 }, selectionIds: ["T-002"] });
    await waitFor(() =>
      expect(ownerController.getSnapshot().sessions).toEqual([
        expect.objectContaining({ pointer: { x: 7, y: 9 }, selectionIds: ["T-002"] })
      ])
    );

    // Force the member transport to drop; client must auto-reconnect and re-announce.
    const memberPresence = (
      memberClient as unknown as {
        presence: { socket?: { close(code?: number, reason?: string): void } };
      }
    ).presence;
    expect(memberPresence.socket).toBeDefined();
    memberPresence.socket!.close(4000, "test forced disconnect");
    await waitFor(() => expect(ownerController.getSnapshot().sessions).toEqual([]));

    // After reconnect + snapshot, last local pointer must reappear without a new UI gesture.
    await waitFor(() =>
      expect(ownerController.getSnapshot().sessions).toEqual([
        expect.objectContaining({ pointer: { x: 7, y: 9 }, selectionIds: ["T-002"] })
      ])
    );

    await Promise.all([ownerController.stop(), memberController.stop()]);
  });
});
