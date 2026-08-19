import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_REQUEST_TIMEOUT_MS } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  exampleBootstrapResponse,
  exampleHumanDeviceToken,
  exampleInvitationToken,
  exampleObserverCatchupRequired,
  exampleObserverEvent,
  exampleSetupCode,
  exampleSetupCodeRedeemDeviceResponse
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  CollaborationClientError,
  CollaborationCredentialVault,
  CollaborationProfileStore,
  CollaborationService,
  CollaborationWorkspaceConnection,
  WorkspaceConnectionProfileStore
} from "../main/collaboration/index.js";
import { ExportedServerDataIdentityStore } from "../main/collaboration/exportedServerDataIdentity.js";
import { COLLABORATION_SESSION_ONLY_WARNING } from "../shared/collaboration.js";

const tempRoots: string[] = [];

function publicEndpoint(serverOrigin: string) {
  return {
    topology: "public_https" as const,
    serverOrigin,
    allowedClientOrigins: [serverOrigin],
    tlsTrust: "system_ca" as const
  };
}

function loopbackEndpoint(serverOrigin: string) {
  return {
    topology: "loopback_http" as const,
    serverOrigin,
    allowedClientOrigins: [serverOrigin],
    tlsTrust: "not_applicable" as const
  };
}

function lanEndpoint(serverOrigin: string) {
  return {
    topology: "lan_http" as const,
    serverOrigin,
    allowedClientOrigins: [serverOrigin],
    tlsTrust: "not_applicable" as const
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function mockSafeStorage(options?: { available?: boolean }): {
  isEncryptionAvailable: ReturnType<typeof vi.fn>;
  encryptString: ReturnType<typeof vi.fn>;
  decryptString: ReturnType<typeof vi.fn>;
} {
  const available = options?.available ?? true;
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8"))
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength
  });
  res.end(bytes);
}

function workspaceConnectionPage() {
  return {
    schemaVersion: "workspace-setup/v1",
    items: [
      {
        schemaVersion: "workspace-setup/v1",
        workspaceId: exampleSetupCodeRedeemDeviceResponse.connectionProfile.workspaceId,
        displayName: "Authoritative Workspace",
        role: "owner",
        archivedAt: null,
        membershipActive: true
      }
    ],
    nextCursor: null
  };
}

function collaborationOriginResponseBody(url: string) {
  if (url.includes("/registry/projects")) {
    return { items: [], nextCursor: null };
  }
  if (url.includes("/workspace-connection")) {
    return workspaceConnectionPage();
  }
  return exampleSetupCodeRedeemDeviceResponse;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "test_handler_failed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CollaborationService IPC trust boundary", () => {
  async function serviceWithRoot(root: string, available = true) {
    const safeStorage = mockSafeStorage({ available });
    return new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage
    });
  }

  it("surfaces session-only warning and never returns tokens from status", async () => {
    const root = await tempDir("planweave-collab-status-");
    const service = await serviceWithRoot(root, false);
    await service.upsertProfile({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false,
      endpoint: publicEndpoint("https://collab.example.com/")
    });
    await service.importDeviceCredential({
      profileId: "profile-1",
      deviceToken: exampleHumanDeviceToken,
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });

    const status = await service.getStatus();
    expect(status.credentialStorage).toBe("unavailable");
    expect(status.nonPersistenceWarning).toBe(COLLABORATION_SESSION_ONLY_WARNING);
    expect(status.profiles[0]?.deviceCredentialPersistence).toBe("session-only");
    expect(status.profiles[0]?.hasDeviceCredential).toBe(true);
    expect(JSON.stringify(status)).not.toContain(exampleHumanDeviceToken);
    expect(JSON.stringify(status)).not.toContain("encryptedDeviceToken");
    expect(JSON.stringify(status)).not.toContain(join(root, "credentials.json"));
  });

  it("migrates the legacy local credential only to a profile for the same project", async () => {
    const root = await tempDir("planweave-collab-local-profile-migration-");
    const service = await serviceWithRoot(root);
    const baseProfile = {
      displayName: "Local",
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      endpoint: loopbackEndpoint("http://127.0.0.1:8787/")
    };
    await service.upsertProfile({
      ...baseProfile,
      profileId: "planweave-local-loopback",
      projectId: "project-a"
    });
    await service.upsertProfile({
      ...baseProfile,
      profileId: "planweave-local-project-a",
      projectId: "project-a"
    });
    await service.upsertProfile({
      ...baseProfile,
      profileId: "planweave-local-project-b",
      projectId: "project-b"
    });
    await service.importDeviceCredential({
      profileId: "planweave-local-loopback",
      deviceToken: exampleHumanDeviceToken,
      deviceCredentialId: "device-a",
      humanPrincipalId: "owner-a"
    });

    await service.migrateLocalProfileCredential(
      "planweave-local-loopback",
      "planweave-local-project-a"
    );
    await service.migrateLocalProfileCredential(
      "planweave-local-loopback",
      "planweave-local-project-b"
    );

    const status = await service.getStatus();
    const profileA = status.profiles.find(
      (profile) => profile.profileId === "planweave-local-project-a"
    );
    const profileB = status.profiles.find(
      (profile) => profile.profileId === "planweave-local-project-b"
    );
    expect(profileA).toMatchObject({
      hasDeviceCredential: true,
      deviceCredentialId: "device-a",
      humanPrincipalId: "owner-a"
    });
    expect(profileB?.hasDeviceCredential).toBe(false);
  });

  it("publishes only the final non-empty profile during a nested activation transaction", async () => {
    const root = await tempDir("planweave-collab-activation-publication-");
    const publishedActiveProfileIds: Array<string | null> = [];
    const safeStorage = mockSafeStorage({ available: true });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage,
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          dispose: vi.fn(),
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never,
      onStatusChange: (status) => publishedActiveProfileIds.push(status.activeProfileId)
    });
    const baseProfile = {
      displayName: "Local",
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      endpoint: loopbackEndpoint("http://127.0.0.1:8787/")
    };
    await service.upsertProfile({
      ...baseProfile,
      profileId: "profile-stable",
      projectId: "project-stable"
    });
    await service.upsertProfile({
      ...baseProfile,
      profileId: "profile-next",
      projectId: "project-next"
    });
    await service.importDeviceCredential({
      profileId: "profile-next",
      deviceToken: exampleHumanDeviceToken,
      humanPrincipalId: "human-owner"
    });
    await service.setActiveProfile({ profileId: "profile-stable" });
    publishedActiveProfileIds.length = 0;

    await service.runStatusPublicationTransaction(async () => {
      await service.upsertProfile({
        ...baseProfile,
        profileId: "profile-next",
        projectId: "project-next"
      });
      await service.runStatusPublicationTransaction(async () => {
        await service.setActiveProfile({ profileId: "profile-next" });
        await service.connectSession({ profileId: "profile-next" });
      });
    });

    expect(publishedActiveProfileIds).toEqual(["profile-next"]);
  });

  it("publishes the restored stable profile after an activation transaction fails", async () => {
    const root = await tempDir("planweave-collab-activation-rollback-");
    const publishedActiveProfileIds: Array<string | null> = [];
    const safeStorage = mockSafeStorage({ available: true });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage,
      onStatusChange: (status) => publishedActiveProfileIds.push(status.activeProfileId)
    });
    await service.upsertProfile({
      profileId: "profile-stable",
      displayName: "Stable",
      serverBaseUrl: "http://127.0.0.1:8787/",
      projectId: "project-stable",
      allowInsecureTransport: true,
      endpoint: loopbackEndpoint("http://127.0.0.1:8787/")
    });
    await service.setActiveProfile({ profileId: "profile-stable" });
    publishedActiveProfileIds.length = 0;

    await expect(
      service.runStatusPublicationTransaction(async () => {
        await service.clearActiveProfile();
        await service.setActiveProfile({ profileId: "profile-stable" });
        throw new Error("activation_failed");
      })
    ).rejects.toThrow("activation_failed");

    expect(publishedActiveProfileIds).toEqual(["profile-stable"]);
  });

  it("redeems a setup code in main and exposes only a redacted Workspace connection", async () => {
    const root = await tempDir("planweave-collab-workspace-setup-");
    const request = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify(collaborationOriginResponseBody(String(_input))), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      request
    });

    const status = await service.redeemSetupCode({
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      setupCode: exampleSetupCode,
      displayName: "Ada"
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(status.workspaceConnection.status).toBe("connected");
    expect(status.workspaceConnection.workspaceId).toBe(
      exampleSetupCodeRedeemDeviceResponse.connectionProfile.workspaceId
    );
    const statusJson = JSON.stringify(status);
    expect(statusJson).not.toContain(exampleSetupCode);
    expect(statusJson).not.toContain(exampleSetupCodeRedeemDeviceResponse.deviceToken);
    expect(statusJson).not.toContain("encryptedDeviceToken");

    const profileJson = await readFile(join(root, "workspace-profiles.json"), "utf8");
    expect(profileJson).not.toContain(exampleSetupCodeRedeemDeviceResponse.deviceToken);
    await service.disconnectWorkspaceConnection();
    expect((await service.getStatus()).workspaceConnection.status).toBe("local_only");
  });

  it("remembers a connected Server after disconnect and reconnects it as the last remote", async () => {
    const root = await tempDir("planweave-collab-remembered-server-");
    const request = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify(collaborationOriginResponseBody(String(_input))), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const serviceOptions = {
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      request
    };
    const service = new CollaborationService(serviceOptions);
    await service.redeemSetupCode({
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      setupCode: exampleSetupCode,
      displayName: "Ada"
    });

    const remembered = await service.listRememberedServerConnections();
    expect(remembered).toEqual([
      expect.objectContaining({
        profileId: exampleSetupCodeRedeemDeviceResponse.connectionProfile.profileId,
        serverBaseUrl: exampleSetupCodeRedeemDeviceResponse.connectionProfile.serverBaseUrl,
        hasDeviceCredential: true
      })
    ]);
    expect(JSON.stringify(remembered)).not.toContain(
      exampleSetupCodeRedeemDeviceResponse.deviceToken
    );
    expect(await service.peekPersistedRemoteProfileId()).toBe(
      exampleSetupCodeRedeemDeviceResponse.connectionProfile.profileId
    );

    await service.disconnectWorkspaceConnection();
    expect(await service.peekPersistedRemoteProfileId()).toBeNull();
    expect(await service.listRememberedServerConnections()).toHaveLength(1);

    const restarted = new CollaborationService(serviceOptions);
    expect(await restarted.peekPersistedRemoteProfileId()).toBeNull();
    expect(await restarted.listRememberedServerConnections()).toHaveLength(1);
  });

  it("reconnects the last remote Server after a process restart", async () => {
    const root = await tempDir("planweave-collab-restore-remote-");
    const request = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify(collaborationOriginResponseBody(String(_input))), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const serviceOptions = {
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      request
    };
    const service = new CollaborationService(serviceOptions);
    await service.redeemSetupCode({
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      setupCode: exampleSetupCode,
      displayName: "Ada"
    });

    const restarted = new CollaborationService(serviceOptions);
    expect(await restarted.peekPersistedRemoteProfileId()).toBe(
      exampleSetupCodeRedeemDeviceResponse.connectionProfile.profileId
    );
    const status = await restarted.restorePersistedRemoteServerConnection(
      exampleSetupCodeRedeemDeviceResponse.connectionProfile.profileId
    );
    expect(status.workspaceConnection.status).toBe("connected");
    expect(status.workspaceConnection.profile?.profileId).toBe(
      exampleSetupCodeRedeemDeviceResponse.connectionProfile.profileId
    );
  });

  it("keeps the last remote Server after a local canvas steals activeProfileId", async () => {
    const root = await tempDir("planweave-collab-last-connection-steal-");
    const request = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify(collaborationOriginResponseBody(String(_input))), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const serviceOptions = {
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      request
    };
    const service = new CollaborationService(serviceOptions);
    await service.redeemSetupCode({
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      setupCode: exampleSetupCode,
      displayName: "Ada"
    });
    const remoteProfileId = exampleSetupCodeRedeemDeviceResponse.connectionProfile.profileId;
    const localProfileId = "planweave-local-d5e342216f40e0632c512d0d";
    await service.upsertProfile({
      profileId: localProfileId,
      displayName: "This computer",
      serverBaseUrl: "http://127.0.0.1:8787/",
      projectId: "desktop-project",
      allowInsecureTransport: true,
      endpoint: loopbackEndpoint("http://127.0.0.1:8787/")
    });
    await service.adoptWorkspaceAuthority({
      profileId: localProfileId,
      workspaceId: "workspace-local-001",
      membershipRole: "owner"
    });

    expect(await service.peekPersistedRemoteProfileId()).toBe(remoteProfileId);
    const persisted = JSON.parse(await readFile(join(root, "workspace-profiles.json"), "utf8")) as {
      activeProfileId: string;
      lastConnection?: { kind: string; profileId?: string };
    };
    expect(persisted.activeProfileId).toBe(localProfileId);
    expect(persisted.lastConnection).toEqual({ kind: "remote", profileId: remoteProfileId });

    const restarted = new CollaborationService(serviceOptions);
    expect(await restarted.peekPersistedRemoteProfileId()).toBe(remoteProfileId);
  });

  it("repairs a stolen workspace-profiles.json that never stored lastConnection", async () => {
    const root = await tempDir("planweave-collab-last-connection-repair-");
    const profilesPath = join(root, "workspace-profiles.json");
    await writeFile(
      profilesPath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: [
            {
              schemaVersion: "workspace-identity/v1",
              profileId: "planweave-local-d5e342216f40e0632c512d0d",
              displayName: "This computer",
              serverBaseUrl: "https://mrbrainmacbook-air.tailb06a1e.ts.net/",
              workspaceId: "workspace-local-001",
              allowInsecureTransport: false,
              workspaceDisplayName: "This computer",
              membershipRole: "owner",
              membershipActive: true,
              updatedAt: "2026-08-19T04:18:26.897Z"
            },
            {
              schemaVersion: "workspace-identity/v1",
              profileId: "profile-a30ac80f13f64bf7133c64cc",
              displayName: "Configured workspace",
              serverBaseUrl: "https://vm-0-3-ubuntu.tailb06a1e.ts.net/",
              workspaceId: "workspace-demo-001",
              allowInsecureTransport: false,
              workspaceDisplayName: "Configured workspace",
              membershipRole: "owner",
              membershipActive: true,
              updatedAt: "2026-08-19T04:18:26.137Z"
            }
          ],
          activeProfileId: "planweave-local-d5e342216f40e0632c512d0d"
        },
        null,
        2
      )}\n`
    );
    const restarted = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      })
    });
    expect(await restarted.peekPersistedRemoteProfileId()).toBe("profile-a30ac80f13f64bf7133c64cc");
    const persisted = JSON.parse(await readFile(profilesPath, "utf8")) as {
      lastConnection?: { kind: string; profileId?: string };
    };
    expect(persisted.lastConnection).toEqual({
      kind: "remote",
      profileId: "profile-a30ac80f13f64bf7133c64cc"
    });
  });

  it("forgets a remembered Server and drops its stored credential", async () => {
    const root = await tempDir("planweave-collab-forget-server-");
    const request = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify(collaborationOriginResponseBody(String(_input))), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage: mockSafeStorage({ available: true })
    });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault,
      request
    });
    await service.redeemSetupCode({
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      setupCode: exampleSetupCode,
      displayName: "Ada"
    });
    const profileId = exampleSetupCodeRedeemDeviceResponse.connectionProfile.profileId;
    expect(await vault.getDeviceToken(profileId)).toBeTruthy();

    const status = await service.forgetRememberedServerConnection({ profileId });
    expect(status.workspaceConnection.status).toBe("local_only");
    expect(await service.listRememberedServerConnections()).toEqual([]);
    expect(await service.peekPersistedRemoteProfileId()).toBeNull();
    expect(await vault.getDeviceToken(profileId)).toBeUndefined();
  });

  it("returns the missing-credential status instead of throwing again when retry is stale", async () => {
    const root = await tempDir("planweave-collab-workspace-missing-credential-");
    const service = await serviceWithRoot(root);
    await service.upsertProfile({
      profileId: "profile-without-credential",
      displayName: "Configured Workspace",
      serverBaseUrl: "http://127.0.0.1:8787/",
      projectId: "project-1",
      allowInsecureTransport: true,
      endpoint: loopbackEndpoint("http://127.0.0.1:8787/")
    });
    await service.adoptWorkspaceAuthority({
      profileId: "profile-without-credential",
      workspaceId: "workspace-1",
      membershipRole: "member"
    });

    await expect(service.connectWorkspaceConnection()).rejects.toMatchObject({
      code: "collaboration_credential_missing"
    });
    await expect(service.retryWorkspaceConnection()).resolves.toMatchObject({
      workspaceConnection: {
        status: "error",
        error: {
          code: "collaboration_credential_missing",
          retryable: false
        }
      },
      session: {
        phase: "error",
        detail: "workspace_retry_failed",
        lastErrorCode: "collaboration_credential_missing"
      }
    });
  });

  it.each([
    ["offline", () => Promise.reject(new TypeError("network unavailable")), "SERVER_UNREACHABLE"],
    [
      "revoked",
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "workspace_connection_unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" }
          })
        ),
      "WORKSPACE_UNAUTHORIZED"
    ],
    [
      "cross-workspace",
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: "workspace-setup/v1",
              items: [
                {
                  schemaVersion: "workspace-setup/v1",
                  workspaceId: "workspace-other",
                  displayName: "Other Workspace",
                  role: "member",
                  archivedAt: null,
                  membershipActive: true
                }
              ],
              nextCursor: null
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        ),
      "WORKSPACE_FORBIDDEN"
    ]
  ])("fails closed when Workspace readiness is %s", async (_name, workspaceResponse, code) => {
    const root = await tempDir("planweave-collab-workspace-readiness-");
    let requestCount = 0;
    const request = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify(exampleSetupCodeRedeemDeviceResponse), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return workspaceResponse();
    });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      request
    });

    await expect(
      service.redeemSetupCode({
        serverBaseUrl: "http://127.0.0.1:8787/",
        allowInsecureTransport: true,
        setupCode: exampleSetupCode,
        displayName: "Ada"
      })
    ).rejects.toMatchObject({ code });
    const status = await service.getStatus();
    expect(status.workspaceConnection.status).toBe("error");
    expect(status.workspaceConnection.error?.code).toBe(code);
  });

  it("bootstraps owner through main, stores token, and strips deviceToken from handoff", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/human/bootstrap");
      expect(req.headers.authorization).toBeUndefined();
      await readBody(req);
      json(res, 200, exampleBootstrapResponse);
    });
    try {
      const root = await tempDir("planweave-collab-bootstrap-");
      const service = await serviceWithRoot(root, true);
      await service.upsertProfile({
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: fixture.origin,
        projectId: "project-demo-001",
        allowInsecureTransport: true,
        endpoint: loopbackEndpoint(fixture.origin)
      });

      const handoff = await service.bootstrapOwner({
        profileId: "profile-1",
        request: { displayName: "Owner" }
      });

      expect(handoff.deviceCredentialPersistence).toBe("persisted");
      expect(handoff.principal.displayName).toBe("Owner");
      expect(JSON.stringify(handoff)).not.toContain(exampleHumanDeviceToken);
      expect((handoff as { deviceToken?: string }).deviceToken).toBeUndefined();

      const status = await service.getStatus();
      expect(status.profiles[0]?.hasDeviceCredential).toBe(true);
      expect(status.activeProfileId).toBe("profile-1");
      expect(status.workspaceConnection).toMatchObject({
        status: "connected",
        workspaceId: "workspace-demo-001",
        profile: { profileId: "profile-1" }
      });

      await service.shutdown();
      const restarted = await serviceWithRoot(root, true);
      const restoredStatus = await restarted.getStatus();
      expect(restoredStatus.workspaceConnection).toMatchObject({
        status: "disconnected",
        workspaceId: "workspace-demo-001",
        profile: { profileId: "profile-1" }
      });
      await restarted.shutdown();
    } finally {
      await fixture.close();
    }
  });

  it("promotes an invitation join into the canonical Workspace connection", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/human/invitations/consume");
      await readBody(req);
      json(res, 200, {
        workspaceId: "workspace-demo-001",
        principal: {
          humanPrincipalId: "human-member-001",
          displayName: "Member",
          createdAt: "2030-01-01T00:00:00.000Z"
        },
        membership: {
          membershipId: "membership-member-001",
          projectId: "project-demo-001",
          humanPrincipalId: "human-member-001",
          displayName: "Member",
          role: "member",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        },
        device: {
          deviceCredentialId: "device-member-001",
          humanPrincipalId: "human-member-001",
          mintedForProjectId: "project-demo-001",
          createdAt: "2030-01-01T00:00:00.000Z"
        },
        deviceToken: exampleHumanDeviceToken,
        invitation: {
          invitationId: "invitation-001",
          projectId: "project-demo-001",
          role: "member",
          createdByHumanPrincipalId: "human-owner-001",
          createdAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-02T00:00:00.000Z",
          consumedAt: "2030-01-01T00:00:00.000Z"
        },
        principalCreated: true
      });
    });
    try {
      const root = await tempDir("planweave-collab-consume-");
      const service = await serviceWithRoot(root, true);
      await service.upsertProfile({
        profileId: "profile-member",
        displayName: "Demo",
        serverBaseUrl: fixture.origin,
        projectId: "project-demo-001",
        allowInsecureTransport: true,
        endpoint: loopbackEndpoint(fixture.origin)
      });

      const handoff = await service.consumeInvitation({
        profileId: "profile-member",
        request: { invitationToken: exampleInvitationToken, displayName: "Member" }
      });

      expect(handoff.workspaceId).toBe("workspace-demo-001");
      const status = await service.getStatus();
      expect(status.workspaceConnection).toMatchObject({
        status: "connected",
        workspaceId: "workspace-demo-001",
        profile: { profileId: "profile-member" }
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects existingDeviceToken from renderer on consumeInvitation", async () => {
    const root = await tempDir("planweave-collab-consume-reject-");
    const service = await serviceWithRoot(root);
    await service.upsertProfile({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false,
      endpoint: publicEndpoint("https://collab.example.com/")
    });

    await expect(
      service.consumeInvitation({
        profileId: "profile-1",
        existingDeviceToken: exampleHumanDeviceToken,
        request: {
          invitationToken: exampleInvitationToken,
          displayName: "Member"
        }
      })
    ).rejects.toThrow(/existingDeviceToken/);
  });

  it("disposes the live session on project switch, logout, and shutdown", async () => {
    const root = await tempDir("planweave-collab-cleanup-");
    const dispose = vi.fn();
    const stopObserver = vi.fn();
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: vi.fn(),
          stopObserver,
          dispose,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A",
      serverBaseUrl: "https://a.example.com/",
      projectId: "project-a",
      allowInsecureTransport: false,
      endpoint: publicEndpoint("https://a.example.com/")
    });
    await service.upsertProfile({
      profileId: "profile-b",
      displayName: "B",
      serverBaseUrl: "https://b.example.com/",
      projectId: "project-b",
      allowInsecureTransport: false,
      endpoint: publicEndpoint("https://b.example.com/")
    });
    await service.importDeviceCredential({
      profileId: "profile-a",
      deviceToken: exampleHumanDeviceToken
    });
    await service.importDeviceCredential({
      profileId: "profile-b",
      deviceToken: exampleHumanDeviceToken
    });

    await service.connectSession({ profileId: "profile-a" });
    expect(dispose).not.toHaveBeenCalled();

    await service.setActiveProfile({ profileId: "profile-b" });
    expect(stopObserver).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();

    dispose.mockClear();
    stopObserver.mockClear();
    await service.connectSession({ profileId: "profile-b" });
    await service.clearDeviceCredential({ profileId: "profile-b" });
    expect(dispose).toHaveBeenCalled();

    dispose.mockClear();
    await service.importDeviceCredential({
      profileId: "profile-a",
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: "profile-a" });
    await service.shutdown();
    expect(dispose).toHaveBeenCalled();
    await expect(service.getStatus()).rejects.toThrow(/shut down/);
  });

  it("keeps the connected client when activation upserts an unchanged active profile", async () => {
    const root = await tempDir("planweave-collab-idempotent-profile-activation-");
    const dispose = vi.fn();
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          stopPresence: vi.fn(),
          dispose,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });
    const profile = {
      profileId: "profile-stable",
      displayName: "Stable local profile",
      serverBaseUrl: "http://127.0.0.1:8787/",
      projectId: "project-stable",
      allowInsecureTransport: true,
      endpoint: loopbackEndpoint("http://127.0.0.1:8787/")
    };
    await service.upsertProfile(profile);
    await service.importDeviceCredential({
      profileId: profile.profileId,
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: profile.profileId });

    const status = await service.upsertProfile(profile);

    expect(dispose).not.toHaveBeenCalled();
    expect(status.session.phase).toBe("connected");
    await service.shutdown();
  });

  it("keeps authenticated HTTP reads available when the observer times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await tempDir("planweave-collab-observer-timeout-");
    const stopObserver = vi.fn();
    const dispose = vi.fn();
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: (handlers: {
            onStatus?: (status: { state: "connecting"; attempt: number }) => void;
          }) => handlers.onStatus?.({ state: "connecting", attempt: 1 }),
          stopObserver,
          stopPresence: vi.fn(),
          dispose,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    try {
      await service.upsertProfile({
        profileId: "profile-timeout",
        displayName: "Windows test",
        serverBaseUrl: "http://192.168.123.23:62060/",
        projectId: "project-timeout",
        allowInsecureTransport: true,
        endpoint: lanEndpoint("http://192.168.123.23:62060/")
      });
      await service.importDeviceCredential({
        profileId: "profile-timeout",
        deviceToken: exampleHumanDeviceToken
      });

      const connecting = await service.connectSession({ profileId: "profile-timeout" });
      expect(connecting.session.phase).toBe("connected");

      await vi.advanceTimersByTimeAsync(COLLABORATION_REQUEST_TIMEOUT_MS + 1);
      const timedOut = await service.getStatus();

      expect(timedOut.session).toMatchObject({
        phase: "connected",
        detail: "observer:connect_timeout",
        lastErrorCode: "collaboration_observer_connect_timeout"
      });
      expect(stopObserver).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      vi.useRealTimers();
    }
  });

  it("creates a fresh client when retrying a failed observer session", async () => {
    const root = await tempDir("planweave-collab-observer-failed-retry-");
    const createClient = vi.fn(
      () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: (handlers: {
            onStatus?: (status: { state: "failed"; code: string }) => void;
          }) =>
            handlers.onStatus?.({
              state: "failed",
              code: "collaboration_observer_http_403"
            }),
          stopObserver: vi.fn(),
          stopPresence: vi.fn(),
          dispose: vi.fn(),
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    );
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient
    });

    await service.upsertProfile({
      profileId: "profile-retry",
      displayName: "Windows test",
      serverBaseUrl: "http://192.168.123.23:50653/",
      projectId: "project-retry",
      allowInsecureTransport: true,
      endpoint: lanEndpoint("http://192.168.123.23:50653/")
    });
    await service.importDeviceCredential({
      profileId: "profile-retry",
      deviceToken: exampleHumanDeviceToken
    });

    expect((await service.connectSession({ profileId: "profile-retry" })).session).toMatchObject({
      phase: "connected",
      lastErrorCode: "WORKSPACE_FORBIDDEN",
      lastErrorMessage:
        "Realtime updates are unavailable because this member does not have project read access. Ask an owner to share the project or grant this member project access."
    });
    await service.connectSession({ profileId: "profile-retry" });

    expect(createClient).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it("rejects an invalid credential during HTTP preflight before starting the observer", async () => {
    const root = await tempDir("planweave-collab-session-preflight-");
    const startObserver = vi.fn();
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockRejectedValue(
            new CollaborationClientError({
              kind: "auth",
              code: "human_auth_unauthenticated",
              message: "Unauthorized",
              httpStatus: 401
            })
          ),
          startObserver,
          stopObserver: vi.fn(),
          stopPresence: vi.fn(),
          dispose: vi.fn(),
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    await service.upsertProfile({
      profileId: "profile-preflight",
      displayName: "Windows test",
      serverBaseUrl: "http://192.168.123.23:50653/",
      projectId: "project-preflight",
      allowInsecureTransport: true,
      endpoint: lanEndpoint("http://192.168.123.23:50653/")
    });
    await service.importDeviceCredential({
      profileId: "profile-preflight",
      deviceToken: exampleHumanDeviceToken
    });

    await expect(service.connectSession({ profileId: "profile-preflight" })).rejects.toMatchObject({
      code: "WORKSPACE_UNAUTHORIZED",
      httpStatus: 401
    });
    expect(startObserver).not.toHaveBeenCalled();
    expect((await service.getStatus()).session).toMatchObject({
      phase: "error",
      detail: "connect_preflight_failed",
      lastErrorCode: "WORKSPACE_UNAUTHORIZED"
    });
    expect(
      (await service.getStatus()).profiles.find(
        (profile) => profile.profileId === "profile-preflight"
      )?.hasDeviceCredential
    ).toBe(false);
    await service.shutdown();
  });

  it("also bounds reconnecting after an established observer loses its socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await tempDir("planweave-collab-observer-reconnect-timeout-");
    const stopObserver = vi.fn();
    const dispose = vi.fn();
    let onStatus:
      | ((
          status:
            | { state: "connected"; cursor: number; connectedAt: string }
            | { state: "reconnecting"; attempt: number; delayMs: number }
        ) => void)
      | undefined;
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: (handlers: { onStatus?: typeof onStatus }) => {
            onStatus = handlers.onStatus;
            onStatus?.({
              state: "connected",
              cursor: 4,
              connectedAt: "2030-01-01T00:00:00.000Z"
            });
          },
          stopObserver,
          stopPresence: vi.fn(),
          dispose,
          lastObserverCursor: () => 4,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    try {
      await service.upsertProfile({
        profileId: "profile-reconnect-timeout",
        displayName: "Windows test",
        serverBaseUrl: "http://192.168.123.23:62060/",
        projectId: "project-timeout",
        allowInsecureTransport: true,
        endpoint: lanEndpoint("http://192.168.123.23:62060/")
      });
      await service.importDeviceCredential({
        profileId: "profile-reconnect-timeout",
        deviceToken: exampleHumanDeviceToken
      });

      const connected = await service.connectSession({ profileId: "profile-reconnect-timeout" });
      expect(connected.session.phase).toBe("connected");

      onStatus?.({ state: "reconnecting", attempt: 1, delayMs: 500 });
      expect((await service.getStatus()).session.phase).toBe("connected");
      await vi.advanceTimersByTimeAsync(COLLABORATION_REQUEST_TIMEOUT_MS + 1);

      expect((await service.getStatus()).session.lastErrorCode).toBe(
        "collaboration_observer_connect_timeout"
      );
      expect((await service.getStatus()).session.phase).toBe("connected");
      expect(stopObserver).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      vi.useRealTimers();
    }
  });

  it("preserves validated observer cursor across dispose and resumes startObserver", async () => {
    const root = await tempDir("planweave-collab-cursor-");
    const startObserver = vi.fn();
    const observerHandlers: Array<{
      onStatus?: (status: unknown) => void;
      onEvent?: (event: typeof exampleObserverEvent) => void;
      onCatchupRequired?: (message: typeof exampleObserverCatchupRequired) => void;
    }> = [];
    let observerCursor = 0;
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: (
            handlers: {
              onStatus?: (status: unknown) => void;
              onEvent?: (event: typeof exampleObserverEvent) => void;
              onCatchupRequired?: (message: typeof exampleObserverCatchupRequired) => void;
            },
            options?: { cursor?: number }
          ) => {
            startObserver(handlers, options);
            observerHandlers.push(handlers);
            if (options?.cursor !== undefined) {
              observerCursor = options.cursor;
            }
            handlers.onStatus?.({
              state: "connected",
              cursor: observerCursor > 0 ? observerCursor : 42,
              connectedAt: "2030-01-01T00:00:00.000Z"
            });
            observerCursor = observerCursor > 0 ? observerCursor : 42;
          },
          stopObserver: vi.fn(),
          dispose: vi.fn(),
          lastObserverCursor: () => observerCursor,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A",
      serverBaseUrl: "https://a.example.com/",
      projectId: "project-a",
      allowInsecureTransport: false,
      endpoint: publicEndpoint("https://a.example.com/")
    });
    await service.importDeviceCredential({
      profileId: "profile-a",
      deviceToken: exampleHumanDeviceToken
    });

    await service.connectSession({ profileId: "profile-a" });
    expect(startObserver).toHaveBeenCalledWith(expect.any(Object), { cursor: 0 });

    await service.disconnectSession();
    startObserver.mockClear();
    observerCursor = 0;

    await service.connectSession({ profileId: "profile-a" });
    expect(startObserver).toHaveBeenCalledWith(expect.any(Object), { cursor: 42 });

    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A moved",
      serverBaseUrl: "https://moved.example.com/",
      projectId: "project-moved",
      allowInsecureTransport: false,
      endpoint: publicEndpoint("https://moved.example.com/")
    });
    observerHandlers.at(-1)?.onStatus?.({
      state: "connected",
      cursor: 88,
      connectedAt: "2030-01-01T00:00:00.000Z"
    });
    observerHandlers.at(-1)?.onCatchupRequired?.({
      ...exampleObserverCatchupRequired,
      resumeCursor: 98
    });
    observerHandlers.at(-1)?.onEvent?.({
      ...exampleObserverEvent,
      cursor: 99,
      previousCursor: 42
    });
    startObserver.mockClear();
    observerCursor = 0;

    await service.connectSession({ profileId: "profile-a" });
    expect(startObserver).toHaveBeenCalledWith(expect.any(Object), { cursor: 0 });

    await service.shutdown();
  });

  it("reconnects a restored Server origin with this computer's local Workspace credential", async () => {
    const root = await tempDir("planweave-collab-restore-origin-");
    const localToken = exampleHumanDeviceToken;
    const staleToken = `pw_hdev_${"B".repeat(43)}`;
    const localWorkspaceId = "workspace-local-d5e342216f40e0632c512d0d61b94e71";
    const store = new WorkspaceConnectionProfileStore({
      profilesPath: join(root, "workspace-profiles.json")
    });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage: mockSafeStorage({ available: true })
    });
    await store.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "planweave-local-d5e342216f40e0632c512d0d",
        displayName: "Local collaboration server",
        serverBaseUrl: "http://127.0.0.1:9999/",
        workspaceId: localWorkspaceId,
        allowInsecureTransport: true
      },
      workspaceDisplayName: "Local collaboration server",
      membershipRole: "owner",
      membershipActive: true
    });
    await store.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-remote-origin",
        displayName: "Configured workspace",
        serverBaseUrl: "http://127.0.0.1:8787/",
        workspaceId: "workspace-self-host",
        allowInsecureTransport: true
      },
      workspaceDisplayName: "Configured workspace",
      membershipRole: "member",
      membershipActive: true
    });
    await vault.setDeviceToken("planweave-local-d5e342216f40e0632c512d0d", localToken, {
      deviceCredentialId: "device-local-001",
      humanPrincipalId: "human-owner-001"
    });
    await vault.setDeviceToken("profile-remote-origin", staleToken, {
      deviceCredentialId: "device-stale-001",
      humanPrincipalId: "human-stale-001"
    });
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization =
        init && typeof init.headers === "object" && !Array.isArray(init.headers)
          ? String((init.headers as Record<string, string>).authorization ?? "")
          : "";
      if (authorization === `Bearer ${staleToken}`) {
        return new Response(JSON.stringify({ error: "workspace_connection_unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      expect(authorization).toBe(`Bearer ${localToken}`);
      expect(String(input)).toContain("http://127.0.0.1:8787/");
      return new Response(
        JSON.stringify({
          schemaVersion: "workspace-setup/v1",
          items: [
            {
              schemaVersion: "workspace-setup/v1",
              workspaceId: localWorkspaceId,
              displayName: "Local collaboration server",
              role: "owner",
              archivedAt: null,
              membershipActive: true
            }
          ],
          nextCursor: null
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const connection = new CollaborationWorkspaceConnection({
      store,
      vault,
      request,
      exportedIdentityPath: join(root, "exported-server-data-identity.json")
    });
    expect(await connection.tryReconnectByOrigin("http://127.0.0.1:8787/")).toBe(true);
    const view = await connection.buildView();
    expect(view.status).toBe("connected");
    expect(view.workspaceId).toBe(localWorkspaceId);
    expect(view.profile?.serverBaseUrl).toBe("http://127.0.0.1:8787/");
    expect(view.profile?.profileId).toBe("profile-remote-origin");
    expect(await vault.getDeviceToken("profile-remote-origin")).toBe(localToken);
    const local = await store.get("planweave-local-d5e342216f40e0632c512d0d");
    expect(local?.serverBaseUrl).toBe("http://127.0.0.1:9999/");
  });

  it("reconnects from the exported identity snapshot after local Server profiles are gone", async () => {
    const root = await tempDir("planweave-collab-restore-exported-");
    const localToken = exampleHumanDeviceToken;
    const staleToken = `pw_hdev_${"B".repeat(43)}`;
    const localWorkspaceId = "workspace-local-d5e342216f40e0632c512d0d61b94e71";
    const store = new WorkspaceConnectionProfileStore({
      profilesPath: join(root, "workspace-profiles.json")
    });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage: mockSafeStorage({ available: true })
    });
    await store.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-remote-origin",
        displayName: "Configured workspace",
        serverBaseUrl: "http://127.0.0.1:8787/",
        workspaceId: "workspace-self-host",
        allowInsecureTransport: true
      },
      workspaceDisplayName: "Configured workspace",
      membershipRole: "member",
      membershipActive: true
    });
    await vault.setDeviceToken("profile-remote-origin", staleToken, {
      deviceCredentialId: "device-stale-001",
      humanPrincipalId: "human-stale-001"
    });
    const identity = new ExportedServerDataIdentityStore(
      join(root, "exported-server-data-identity.json")
    );
    await identity.write({
      schemaVersion: "exported-server-data-identity/v1",
      workspaceId: localWorkspaceId,
      workspaceDisplayName: "Local collaboration server",
      membershipRole: "owner",
      updatedAt: "2030-01-01T00:00:00.000Z"
    });
    await vault.setDeviceToken("planweave-exported-server-data", localToken, {
      deviceCredentialId: "device-local-001",
      humanPrincipalId: "human-owner-001"
    });
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization =
        init && typeof init.headers === "object" && !Array.isArray(init.headers)
          ? String((init.headers as Record<string, string>).authorization ?? "")
          : "";
      if (authorization === `Bearer ${staleToken}`) {
        return new Response(JSON.stringify({ error: "workspace_connection_unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      expect(authorization).toBe(`Bearer ${localToken}`);
      return new Response(
        JSON.stringify({
          schemaVersion: "workspace-setup/v1",
          items: [
            {
              schemaVersion: "workspace-setup/v1",
              workspaceId: localWorkspaceId,
              displayName: "Local collaboration server",
              role: "owner",
              archivedAt: null,
              membershipActive: true
            }
          ],
          nextCursor: null
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const connection = new CollaborationWorkspaceConnection({
      store,
      vault,
      request,
      exportedIdentityStore: identity
    });
    expect(await connection.tryReconnectByOrigin("http://127.0.0.1:8787/")).toBe(true);
    const view = await connection.buildView();
    expect(view.status).toBe("connected");
    expect(view.workspaceId).toBe(localWorkspaceId);
    expect(await store.get("planweave-local-d5e342216f40e0632c512d0d")).toBeNull();
  });
});

describe("CollaborationService live Server binding", () => {
  it("connects the collaboration session to the same origin as the live Server", async () => {
    const root = await tempDir("planweave-collab-live-server-");
    const localWorkspaceId = "workspace-local-d5e342216f40e0632c512d0d61b94e71";
    const localToken = exampleHumanDeviceToken;
    const staleToken = `pw_hdev_${"B".repeat(43)}`;
    const connectedOrigins: string[] = [];
    const liveOperatorOrigins: string[] = [];
    const server = await listen(async (req, res) => {
      const authorization = String(req.headers.authorization ?? "");
      if (authorization === `Bearer ${staleToken}`) {
        json(res, 401, { error: "workspace_connection_unauthorized" });
        return;
      }
      if (authorization !== `Bearer ${localToken}`) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/v1/workspace-connection") {
        json(res, 200, {
          schemaVersion: "workspace-setup/v1",
          items: [
            {
              schemaVersion: "workspace-setup/v1",
              workspaceId: localWorkspaceId,
              displayName: "Local collaboration server",
              role: "owner",
              archivedAt: null,
              membershipActive: true
            }
          ],
          nextCursor: null
        });
        return;
      }
      if (url.pathname === "/api/v1/registry/projects") {
        json(res, 200, {
          items: [
            {
              schemaVersion: "project-access/v1",
              registry: {
                projectRegistryId: "registry-project-live",
                workspaceId: localWorkspaceId,
                projectId: "project-live-001"
              },
              visibility: "private",
              acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
              owner: "human-owner-001",
              updatedAt: "2030-01-01T00:00:00.000Z"
            }
          ],
          nextCursor: null
        });
        return;
      }
      json(res, 404, { error: "not_found" });
    });
    const safeStorage = mockSafeStorage({ available: true });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    const workspaceStore = new WorkspaceConnectionProfileStore({
      profilesPath: join(root, "workspace-profiles.json")
    });
    await workspaceStore.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "planweave-local-d5e342216f40e0632c512d0d",
        displayName: "Local collaboration server",
        serverBaseUrl: "http://127.0.0.1:9999/",
        workspaceId: localWorkspaceId,
        allowInsecureTransport: true
      },
      workspaceDisplayName: "Local collaboration server",
      membershipRole: "owner",
      membershipActive: true
    });
    await workspaceStore.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-remote-origin",
        displayName: "Configured workspace",
        serverBaseUrl: server.origin,
        workspaceId: "workspace-self-host",
        allowInsecureTransport: true
      },
      workspaceDisplayName: "Configured workspace",
      membershipRole: "member",
      membershipActive: true
    });
    await vault.setDeviceToken("planweave-local-d5e342216f40e0632c512d0d", localToken, {
      deviceCredentialId: "device-local-001",
      humanPrincipalId: "human-owner-001"
    });
    await vault.setDeviceToken("profile-remote-origin", staleToken, {
      deviceCredentialId: "device-stale-001",
      humanPrincipalId: "human-stale-001"
    });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault,
      workspaceProfileStore: workspaceStore,
      safeStorage,
      request: fetch,
      bindLiveOperatorToOrigin: async (serverBaseUrl) => {
        liveOperatorOrigins.push(serverBaseUrl);
      },
      createClient: (options) =>
        ({
          verifyAccess: async () => {
            connectedOrigins.push(options.profile.serverBaseUrl);
          },
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          dispose: vi.fn(),
          lastObserverCursor: () => 0
        }) as never
    });
    await service.upsertProfile({
      profileId: "planweave-local-d5e342216f40e0632c512d0d",
      displayName: "Local collaboration server",
      serverBaseUrl: "http://127.0.0.1:9999/",
      projectId: "project-stale-local",
      allowInsecureTransport: true,
      endpoint: loopbackEndpoint("http://127.0.0.1:9999/")
    });
    await service.setActiveProfile({ profileId: "planweave-local-d5e342216f40e0632c512d0d" });

    const status = await service.connectExistingServerByOrigin({ serverBaseUrl: server.origin });
    await server.close();

    expect(status.workspaceConnection.status).toBe("connected");
    expect(status.workspaceConnection.profile?.serverBaseUrl).toBe(server.origin);
    expect(status.activeProfileId).toBe("profile-remote-origin");
    expect(status.session.phase).toBe("connected");
    expect(connectedOrigins).toEqual([server.origin]);
    expect(liveOperatorOrigins).toEqual([server.origin]);
    const liveProfile = status.profiles.find(
      (profile) => profile.profileId === "profile-remote-origin"
    );
    expect(liveProfile?.projectId).toBe("project-live-001");
    expect(liveProfile?.serverBaseUrl).toBe(server.origin);
  });
});
