import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  CollaborationClient,
  type CollaborationWebSocketConstructor
} from "../main/collaboration/CollaborationClient.js";
import { CollaborationCanvasCommandFacade } from "../main/collaboration/collaborationCanvasCommands.js";
import { CanvasReplicaStore } from "../main/collaboration/CanvasReplicaStore.js";
import type { CollaborationCanvasReplicaProjection } from "../shared/canvasReplicaIpc.js";
import {
  configureWorkspaceAccess,
  deviceToken,
  issueDeviceSetupCode,
  redeemDesktop,
  setupSelfHostedTwoClientFixture
} from "./support/selfHostedTwoClientE2E.js";

function waitFor(predicate: () => boolean, detail: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timeout:${detail}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("authoritative canvas replica two-client live E2E", () => {
  it("projects an accepted owner edit into the member replica without reconnect", async () => {
    const fixture = await setupSelfHostedTwoClientFixture();
    const owner = await redeemDesktop({
      home: fixture.home,
      name: "Live Owner",
      origin: fixture.origin,
      setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
    });
    const member = await redeemDesktop({
      home: fixture.home,
      name: "Live Member",
      origin: fixture.origin,
      setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
    });
    const ownerProfileId = owner.view.profile?.profileId;
    const memberProfileId = member.view.profile?.profileId;
    const ownerCredential = await owner.vault.getMetadata(ownerProfileId ?? "");
    const memberCredential = await member.vault.getMetadata(memberProfileId ?? "");
    if (
      !ownerProfileId ||
      !memberProfileId ||
      !ownerCredential?.humanPrincipalId ||
      !memberCredential?.humanPrincipalId
    ) {
      throw new Error("workspace_principal_missing");
    }
    const configured = await configureWorkspaceAccess({
      databasePath: fixture.databasePath,
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      ownerId: ownerCredential.humanPrincipalId,
      memberId: memberCredential.humanPrincipalId
    });
    const clients: CollaborationClient[] = [];
    const facades: CollaborationCanvasCommandFacade[] = [];
    try {
      const createClient = async (profileId: string, token: string) => {
        const client = new CollaborationClient({
          profile: {
            profileId,
            displayName: profileId,
            serverBaseUrl: `${fixture.origin}/`,
            projectId: fixture.projectId,
            allowInsecureTransport: true,
            endpoint: {
              topology: "loopback_http",
              serverOrigin: `${fixture.origin}/`,
              allowedClientOrigins: [`${fixture.origin}/`],
              tlsTrust: "not_applicable"
            }
          },
          credential: { getDeviceToken: () => token },
          WebSocketImpl: WebSocket as unknown as CollaborationWebSocketConstructor,
          limits: { requestTimeoutMs: 5_000, jsonBodyMaxBytes: 256_000 }
        });
        clients.push(client);
        return client;
      };
      const ownerClient = await createClient(ownerProfileId, await deviceToken(owner));
      const memberClient = await createClient(memberProfileId, await deviceToken(member));
      const ownerProjections: CollaborationCanvasReplicaProjection[] = [];
      const memberProjections: CollaborationCanvasReplicaProjection[] = [];

      const createFacade = (
        client: CollaborationClient,
        authorityId: string,
        projections: CollaborationCanvasReplicaProjection[]
      ) => {
        const facade = new CollaborationCanvasCommandFacade({
          resolveClient: () => client,
          resolveCanvasBinding: async () => ({
            kind: "local" as const,
            localProjectId: fixture.projectId,
            canvasId: "default",
            remoteProjectId: fixture.projectId,
            remoteCanvasId: "default"
          }),
          resolveCanvasScope: async () => ({
            workspaceId: fixture.workspaceId,
            projectId: fixture.projectId,
            canvasId: "default"
          }),
          resolveAuthorityId: () => authorityId,
          store: new CanvasReplicaStore((projection) => projections.push(projection))
        });
        facades.push(facade);
        return facade;
      };
      const ownerFacade = createFacade(ownerClient, "owner-authority", ownerProjections);
      const memberFacade = createFacade(memberClient, "member-authority", memberProjections);
      const bindInput = {
        kind: "local" as const,
        localProjectId: fixture.projectId,
        canvasId: "default"
      };
      await ownerFacade.bind(bindInput);
      await memberFacade.bind(bindInput);
      await waitFor(
        () =>
          ownerClient.liveSyncState().state === "connected" &&
          memberClient.liveSyncState().state === "connected",
        "both-live-sockets-connected"
      );

      const intent: CanvasCommandIntent = {
        kind: "update_layout",
        nodes: [{ nodeId: "T-001", x: 321, y: 123 }],
        updatedAt: "2026-08-02T12:00:00.000Z"
      };
      const result = await ownerFacade.submit({ canvasId: "default", intent });
      expect(result.outcome.type).toBe("canvas.command.accepted");
      await waitFor(
        () => memberProjections.some((projection) => projection.revision === 1),
        "member-live-projection-revision-1"
      );
      const memberProjection = memberProjections.at(-1);
      expect(memberProjection?.content.layout.nodes).toContainEqual({
        nodeId: "T-001",
        x: 321,
        y: 123
      });
    } finally {
      for (const facade of facades) facade.clearAllSessions();
      for (const client of clients) client.dispose();
      configured.database.close();
    }
  });
});
