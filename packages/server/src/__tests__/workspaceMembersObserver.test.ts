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
import { CollaborationWorkspaceConnectionFacade } from "../../../desktop/src/main/collaboration/collaborationWorkspaceConnectionFacade.js";
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
import { openServerDatabase, inWriteTransaction } from "../sqlite.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";

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
  const facade = new CollaborationWorkspaceConnectionFacade({
    connection,
    publishStatus: async () => {
      throw new Error("read_fixture_cannot_publish_status");
    },
    setSession: () => {
      throw new Error("read_fixture_cannot_mutate_session");
    }
  });
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
    facade,
    signals,
    invalidations,
    json,
    projectId,
    legacy,
    redeemed,
    origin,
    workspaceId,
    issueDevice: async (
      displayName: string,
      existingIdentityToken?: string,
      targetWorkspaceId = workspaceId
    ) => {
      const issued = setupCodeIssueResponseSchema.parse(
        await json(
          `/api/v1/workspaces/${targetWorkspaceId}/setup-codes`,
          {
            schemaVersion: "workspace-setup/v1",
            workspaceId: targetWorkspaceId,
            purpose: "device_session"
          },
          operatorToken
        )
      );
      return setupCodeRedeemDeviceResponseSchema.parse(
        await json("/api/v1/setup-codes/redeem", {
          schemaVersion: "workspace-setup/v1",
          purpose: "device_session",
          setupCode: issued.setupCode,
          displayName,
          ...(existingIdentityToken ? { existingIdentityToken } : {})
        })
      );
    },
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
it("refreshes real Desktop member devices when an existing identity adds a device", async () => {
  const f = await fixture();
  const before = await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 });
  expect(before.items).toHaveLength(1);
  expect(before.items[0]?.devices).toHaveLength(2);
  await f.issueDevice("Owner", f.redeemed.identityToken);
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(2));
  const after = await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 });
  expect(after.items).toHaveLength(1);
  expect(after.items[0]?.devices).toHaveLength(3);
  expect((await f.facade.getWorkspaceConnectionSelf()).deviceSessionId).toBe(
    f.redeemed.deviceSessionId
  );
});
it("invalidates the Desktop device directory after owner recovery without another membership transition", async () => {
  const f = await fixture();
  await f.json(
    `/api/v1/projects/${f.projectId}/human/devices/${f.legacy.device.deviceCredentialId}/revoke`,
    {},
    f.legacy.deviceToken
  );
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(2));
  const before = await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 });
  expect(before.items).toHaveLength(1);
  expect(before.items[0]?.devices).toHaveLength(1);
  const database = await openServerDatabase(f.config.databasePath, 5_000);
  try {
    database.exec(`CREATE TRIGGER fail_recovery_projection BEFORE INSERT ON workspace_device_sessions
      BEGIN SELECT RAISE(ABORT, 'recovery_projection_failed'); END`);
    await expect(
      f.json(`/api/v1/projects/${f.projectId}/human/bootstrap`, {
        humanPrincipalId: f.legacy.principal.humanPrincipalId,
        displayName: "Owner"
      })
    ).rejects.toThrow();
    expect(await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 })).toEqual(
      before
    );
    expect(f.invalidations()).toHaveLength(2);
  } finally {
    database.exec("DROP TRIGGER IF EXISTS fail_recovery_projection");
    database.close();
  }
  const recovered = humanBootstrapResponseSchema.parse(
    await f.json(`/api/v1/projects/${f.projectId}/human/bootstrap`, {
      humanPrincipalId: f.legacy.principal.humanPrincipalId,
      displayName: "Owner"
    })
  );
  expect(recovered.created).toBe(false);
  expect(recovered.deviceToken).toBeDefined();
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(3));
  const after = await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 });
  expect(after.items).toHaveLength(1);
  expect(after.items[0]?.devices).toHaveLength(2);
  expect((await f.facade.getWorkspaceConnectionSelf()).deviceSessionId).toBe(
    f.redeemed.deviceSessionId
  );
  const idempotent = humanBootstrapResponseSchema.parse(
    await f.json(`/api/v1/projects/${f.projectId}/human/bootstrap`, {
      humanPrincipalId: f.legacy.principal.humanPrincipalId,
      displayName: "Owner"
    })
  );
  expect(idempotent.deviceToken).toBeUndefined();
  expect(await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 })).toEqual(after);
  expect(f.invalidations()).toHaveLength(3);
});
it("refreshes real Desktop roster and device ownership after identity merge", async () => {
  const f = await fixture();
  const source = await f.issueDevice("Source");
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(2));
  expect(
    (await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 })).items
  ).toHaveLength(2);
  await f.json("/api/v1/human-identity/merge", {
    schemaVersion: "human-identity/v1",
    sourceIdentityToken: source.identityToken,
    canonicalIdentityToken: f.redeemed.identityToken
  });
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(3));
  const after = await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 });
  expect(after.items).toHaveLength(1);
  expect(after.items[0]?.humanPrincipalId).toBe(f.redeemed.humanPrincipalId);
  expect(after.items[0]?.devices).toHaveLength(3);
});
it("notifies every source/target/equivalent Workspace only after committed merge and suppresses failures and outer rollback", async () => {
  const f = await fixture();
  const database = await openServerDatabase(f.config.databasePath, 5_000);
  const repo = new WorkspaceIdentityRepository(database);
  const scopes = [
    "source-first",
    "source-second",
    "target-first",
    "target-second",
    "equivalent-only",
    "target-equivalent-only",
    "unrelated"
  ];
  const releases: (() => void)[] = [];
  try {
    for (const scope of scopes) repo.ensureConfiguredWorkspace(scope);
    const source = await f.issueDevice("Source", undefined, scopes[0]);
    await f.issueDevice("Source", source.identityToken, scopes[1]);
    const target = await f.issueDevice("Target", undefined, scopes[2]);
    await f.issueDevice("Target", target.identityToken, scopes[3]);
    await f.issueDevice("Source", source.identityToken, scopes[2]);
    await f.issueDevice("Source", source.identityToken, scopes[3]);
    const equivalent = await f.issueDevice("Equivalent", undefined, scopes[4]);
    const targetEquivalent = await f.issueDevice("Target equivalent", undefined, scopes[5]);
    const unrelated = await f.issueDevice("Unrelated", undefined, scopes[6]);
    const store = new HumanIdentityCredentialStore(
      database,
      () => new Date(),
      undefined,
      (workspaceId) => repo.invalidateMembers(workspaceId)
    );
    store.merge(equivalent.identityToken, source.identityToken);
    store.merge(targetEquivalent.identityToken, target.identityToken);
    await Promise.resolve();
    const notified: string[] = [];
    for (const scope of scopes)
      releases.push(repo.subscribeMembers(scope, () => notified.push(scope)));
    expect(() =>
      inWriteTransaction(database, () => {
        store.merge(source.identityToken, target.identityToken);
        expect(store.resolveCanonicalHumanPrincipalId(source.humanPrincipalId)).toBe(
          target.humanPrincipalId
        );
        throw new Error("abort_outer_transaction");
      })
    ).toThrow("abort_outer_transaction");
    await Promise.resolve();
    expect(notified).toEqual([]);
    expect(repo.findActiveMembership(scopes[0], source.humanPrincipalId)).not.toBeNull();
    expect(store.resolveCanonicalHumanPrincipalId(source.humanPrincipalId)).toBe(
      source.humanPrincipalId
    );
    database.exec(`CREATE TEMP TRIGGER fail_merge BEFORE INSERT ON human_principal_merges
      BEGIN SELECT RAISE(ABORT, 'merge_write_failed'); END`);
    expect(() => store.merge(source.identityToken, target.identityToken)).toThrow(
      "merge_write_failed"
    );
    database.exec("DROP TRIGGER fail_merge");
    await Promise.resolve();
    expect(notified).toEqual([]);
    store.merge(source.identityToken, target.identityToken);
    await Promise.resolve();
    // The target-only alias scope is scheduled too, but its committed authority is unchanged.
    expect(notified.sort()).toEqual(scopes.slice(0, 5).sort());
    for (const scope of scopes.slice(0, 6))
      expect(repo.findActiveMembership(scope, target.humanPrincipalId)).not.toBeNull();
    expect(repo.findActiveMembership(scopes[6], unrelated.humanPrincipalId)).not.toBeNull();
    notified.length = 0;
    expect(store.merge(equivalent.identityToken, target.identityToken).alreadyEquivalent).toBe(
      true
    );
    await Promise.resolve();
    expect(notified).toEqual([]);
  } finally {
    for (const release of releases) release();
    database.close();
  }
}, 20_000);
it("suppresses device invalidation when redemption writes roll back", async () => {
  const f = await fixture();
  const database = await openServerDatabase(f.config.databasePath, 5_000);
  try {
    const before = await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 });
    // A persistent trigger is required for the HTTP composition's independent connection.
    database.exec(`CREATE TRIGGER fail_identity_http BEFORE INSERT ON human_identity_credentials
      BEGIN SELECT RAISE(ABORT, 'identity_issue_failed'); END`);
    await expect(f.issueDevice("Owner", f.redeemed.identityToken)).rejects.toThrow();
    await Promise.resolve();
    expect(await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 })).toEqual(
      before
    );
    expect(f.invalidations()).toHaveLength(1);
  } finally {
    database.exec("DROP TRIGGER IF EXISTS fail_identity_http");
    database.close();
  }
});
it("delivers real Server rename/join/remove invalidation to a Workspace-only Desktop client and revalidates after reconnect", async () => {
  const f = await fixture();
  expect(
    (await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 })).items.map(
      (member) => member.displayName
    )
  ).toEqual(["Owner"]);
  await f.json(
    "/api/v1/workspace-connection/self",
    { schemaVersion: "workspace-setup/v1", displayName: "Renamed" },
    f.redeemed.deviceToken,
    "PATCH"
  );
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(2));
  expect((await f.facade.getWorkspaceConnectionSelf()).displayName).toBe("Renamed");
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
  expect(
    (await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 })).items
  ).toHaveLength(2);
  await f.json(
    `/api/v1/projects/${f.projectId}/human/members/${joined.principal.humanPrincipalId}/remove`,
    {},
    f.legacy.deviceToken
  );
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(4));
  expect(
    (await f.facade.listWorkspaceConnectionMembers({ cursor: 0, limit: 100 })).items.map(
      (member) => member.displayName
    )
  ).toEqual(["Renamed"]);
  for (let index = 0; index < 5; index++) await f.connection.buildView();
  expect(f.invalidations()).toHaveLength(4);
  await f.restart();
  await vi.waitFor(() => expect(f.invalidations()).toHaveLength(5));
  expect((await f.facade.getWorkspaceConnectionSelf()).displayName).toBe("Renamed");
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
