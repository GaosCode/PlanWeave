import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import {
  humanBootstrapResponseSchema,
  humanCreateInvitationResponseSchema,
  humanConsumeInvitationResponseSchema
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  setupCodeIssueResponseSchema,
  setupCodeRedeemDeviceResponseSchema
} from "@planweave-ai/collaboration-protocol/setup";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CollaborationWorkspaceConnection } from "../../../desktop/src/main/collaboration/collaborationWorkspaceConnection.js";
import { WorkspaceConnectionProfileStore } from "../../../desktop/src/main/collaboration/workspaceConnectionProfileStore.js";
import { CollaborationCredentialVault } from "../../../desktop/src/main/collaboration/collaborationCredentialVault.js";
import type { CollaborationObserverSignal } from "../../../desktop/src/shared/collaborationReadModels.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import { parseServerConfig } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";

const roots: string[] = [];
const servers: Server[] = [];
const compositions: DistributedServerComposition[] = [];
const connections: CollaborationWorkspaceConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.stopMembersObserver();
  for (const composition of compositions.splice(0)) await composition.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const workspace = await createTestWorkspace();
  roots.push(workspace.root, workspace.home);
  const server = createServer();
  servers.push(server);
  const operatorToken = `pw_operator_${"O".repeat(43)}`;
  const workspaceId = "members-workspace";
  const projectId = workspace.init.workspace.id;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    deployment: {
      topology: "loopback_http",
      serverOrigin: "http://127.0.0.1:7443",
      tlsTrust: "not_applicable",
      allowedClientOrigins: ["http://127.0.0.1:7443"]
    },
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [{ workspaceId, projectId, canvasId: "default", projectRoot: workspace.root }],
    operatorCredentials: [
      {
        operatorId: "members-admin",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  let composition = await createDistributedServerComposition({ httpServer: server, config });
  compositions.push(composition);
  await seedOperatorSessions(config.databasePath, config.operatorCredentials);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_http_address");
  const origin = `http://127.0.0.1:${address.port}`;
  // Origin is configured independently from bind's ephemeral test port.
  const json = async (path: string, body: unknown, token?: string, method = "POST") => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
    const result: unknown = await response.json();
    expect(response.status, JSON.stringify(result)).toBeLessThan(300);
    return result;
  };
  const legacy = humanBootstrapResponseSchema.parse(
    await json(`/api/v1/projects/${projectId}/human/bootstrap`, { displayName: "Owner" })
  );
  const issued = setupCodeIssueResponseSchema.parse(
    await json(
      `/api/v1/workspaces/${workspaceId}/setup-codes`,
      { schemaVersion: "workspace-setup/v1", workspaceId, purpose: "device_session" },
      operatorToken
    )
  );
  const redeemed = setupCodeRedeemDeviceResponseSchema.parse(
    await json("/api/v1/setup-codes/redeem", {
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      setupCode: issued.setupCode,
      displayName: "Owner",
      existingDeviceToken: legacy.deviceToken
    })
  );
  const store = new WorkspaceConnectionProfileStore({
    profilesPath: join(workspace.root, "workspace-profiles.json")
  });
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(workspace.root, "credentials.json") },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ""
    }
  });
  const profile = {
    ...redeemed.connectionProfile,
    profileId: "members-desktop",
    serverBaseUrl: origin
  };
  await store.upsert({ profile, workspaceDisplayName: "Team", membershipRole: "owner" });
  await store.setActiveProfileId(profile.profileId);
  await vault.setDeviceToken(profile.profileId, redeemed.deviceToken);
  const signals: CollaborationObserverSignal[] = [];
  const connection = new CollaborationWorkspaceConnection({
    store,
    vault,
    exportedIdentityPath: join(workspace.root, "exported.json"),
    onObserverSignal: (signal) => signals.push(signal)
  });
  connections.push(connection);
  // Match the exact Desktop origin used in the real WS handshake.
  config.allowedClientOrigins = [origin];
  config.deployment.allowedClientOrigins = [origin];
  await composition.close();
  compositions.splice(compositions.indexOf(composition), 1);
  composition = await createDistributedServerComposition({ httpServer: server, config });
  compositions.push(composition);
  await connection.hydrate();
  await connection.connectActiveProfile();
  const invalidations = () =>
    signals.filter((signal) => signal.type === "workspace.members.invalidated");
  await vi.waitFor(() => expect(invalidations()).toHaveLength(1));
  return {
    workspace,
    server,
    config,
    connection,
    signals,
    invalidations,
    json,
    projectId,
    legacy,
    redeemed,
    origin,
    workspaceId,
    restart: async () => {
      await composition.close();
      compositions.splice(compositions.indexOf(composition), 1);
      await vi.waitFor(() =>
        expect(signals.some((signal) => signal.type === "workspace.members.observer_error")).toBe(
          true
        )
      );
      composition = await createDistributedServerComposition({ httpServer: server, config });
      compositions.push(composition);
    }
  };
}
it("delivers real Server rename/join/remove invalidation to a Workspace-only Desktop client and revalidates after reconnect", async () => {
  const f = await fixture();
  expect(
    (await f.connection.listMembers(0, 100)).items.map((member) => member.displayName)
  ).toEqual(["Owner"]);
  await f.json(
    "/api/v1/workspace-connection/self",
    { schemaVersion: "workspace-setup/v1", displayName: "Renamed" },
    f.redeemed.deviceToken,
    "PATCH"
  );
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(2));
  expect((await f.connection.getSelf()).displayName).toBe("Renamed");
  const invitation = humanCreateInvitationResponseSchema.parse(
    await f.json(`/api/v1/projects/${f.projectId}/human/invitations`, {}, f.legacy.deviceToken)
  );
  const joined = humanConsumeInvitationResponseSchema.parse(
    await f.json(`/api/v1/projects/${f.projectId}/human/invitations/consume`, {
      invitationToken: invitation.invitationToken,
      displayName: "Joined"
    })
  );
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(3));
  expect((await f.connection.listMembers(0, 100)).items).toHaveLength(2);
  await f.json(
    `/api/v1/projects/${f.projectId}/human/members/${joined.principal.humanPrincipalId}/remove`,
    {},
    f.legacy.deviceToken
  );
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(4));
  expect(
    (await f.connection.listMembers(0, 100)).items.map((member) => member.displayName)
  ).toEqual(["Renamed"]);
  for (let index = 0; index < 5; index++) await f.connection.buildView();
  expect(f.invalidations()).toHaveLength(4);
  await f.restart();
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(5));
  expect((await f.connection.getSelf()).displayName).toBe("Renamed");
  for (const signal of f.invalidations())
    expect(Object.keys(signal).sort()).toEqual([
      "profileId",
      "schemaVersion",
      "serverBaseUrl",
      "type",
      "workspaceId"
    ]);
}, 20_000);
it("rejects unauthenticated and disallowed-Origin upgrades without admitting another Workspace scope", async () => {
  const f = await fixture();
  const status = async (token?: string, origin = f.origin) =>
    new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        `${f.origin.replace("http:", "ws:")}/api/v1/workspace-connection/members/observe`,
        { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }
      );
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
        socket.terminate();
      });
      socket.on("open", () => {
        socket.close();
        reject(new Error("unexpected_admission"));
      });
      socket.on("error", () => {});
    });
  expect(await status()).toBe(401);
  expect(await status(f.redeemed.deviceToken, "http://untrusted.example")).toBe(403);
  expect(f.invalidations()).toHaveLength(1);
});
