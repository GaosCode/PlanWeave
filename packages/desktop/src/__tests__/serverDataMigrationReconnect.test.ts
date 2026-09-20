import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationWorkspaceConnection } from "../main/collaboration/collaborationWorkspaceConnection.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { WorkspaceConnectionProfileStore } from "../main/collaboration/workspaceConnectionProfileStore.js";
import { ExportedServerDataIdentityStore } from "../main/collaboration/exportedServerDataIdentity.js";
import { findServerMigrationIdentity } from "../main/collaboration/serverDataMigrationCandidate.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const token = `pw_hdev_${"A".repeat(43)}`;
const staleToken = `pw_hdev_${"B".repeat(43)}`;
const sourceId = "planweave-exported-server-data-source";
const baseUrl = "https://restored.example/";
const item = {
  schemaVersion: "workspace-setup/v1",
  workspaceId: "workspace-original",
  displayName: "Authoritative name",
  role: "member",
  archivedAt: null,
  membershipActive: true
};
function response(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      schemaVersion: "workspace-setup/v1",
      items: [{ ...item, ...overrides }],
      nextCursor: null
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
async function fixture(withActive = false) {
  const root = await mkdtemp(join(tmpdir(), "planweave-migration-reconnect-"));
  roots.push(root);
  const profilesPath = join(root, "profiles.json");
  const credentialsPath = join(root, "credentials.json");
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (data: Buffer) => data.toString()
  };
  const store = new WorkspaceConnectionProfileStore({ profilesPath });
  const vault = new CollaborationCredentialVault({ paths: { credentialsPath }, safeStorage });
  const identityPath = join(root, "identity.json");
  const identityStore = new ExportedServerDataIdentityStore(identityPath);
  await vault.setDeviceToken(sourceId, token, {
    humanPrincipalId: "human-original",
    deviceCredentialId: "device-original"
  });
  await identityStore.write({
    schemaVersion: "exported-server-data-identity/v2",
    credentialProfileId: sourceId,
    workspaceId: item.workspaceId,
    workspaceDisplayName: "Snapshot name",
    membershipRole: "owner",
    updatedAt: "2030-01-01T00:00:00.000Z"
  });
  async function addProfile(profileId: string, serverBaseUrl: string, deviceToken = staleToken) {
    await store.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId,
        serverBaseUrl,
        workspaceId: "workspace-old",
        displayName: "Old",
        allowInsecureTransport: serverBaseUrl.startsWith("http:")
      },
      workspaceDisplayName: "Old",
      membershipRole: "owner",
      membershipActive: true
    });
    await vault.setDeviceToken(profileId, deviceToken);
  }
  if (withActive) {
    await addProfile("profile-original", "https://original.example/");
    await store.setActiveProfileId("profile-original");
  }
  const connection = (request: typeof fetch) =>
    new CollaborationWorkspaceConnection({
      store,
      vault,
      exportedIdentityStore: identityStore,
      request
    });
  return {
    root,
    store,
    vault,
    identityStore,
    identityPath,
    profilesPath,
    credentialsPath,
    safeStorage,
    addProfile,
    connection
  };
}

describe("Server migration reconnect", () => {
  it("validates an exported identity against a new HTTPS origin with an empty store, persists and reloads", async () => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toContain(baseUrl);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return response();
    });
    const connection = f.connection(request);
    expect(await connection.tryReconnectByOrigin(baseUrl)).toBe(true);
    const view = await connection.buildView();
    expect(view.status).toBe("connected");
    expect(view.workspaceDisplayName).toBe("Authoritative name");
    const saved = (await f.store.list())[0]!;
    expect(saved.profileId).toMatch(/^profile-[a-f0-9]{24}$/);
    expect(saved.profileId).not.toBe(sourceId);
    expect(saved.membershipRole).toBe("member");
    expect(saved.allowInsecureTransport).toBe(false);
    const freshStore = new WorkspaceConnectionProfileStore({ profilesPath: f.profilesPath });
    const freshVault = new CollaborationCredentialVault({
      paths: { credentialsPath: f.credentialsPath },
      safeStorage: f.safeStorage
    });
    const fresh = new CollaborationWorkspaceConnection({
      store: freshStore,
      vault: freshVault,
      exportedIdentityPath: f.identityPath,
      request
    });
    expect(await fresh.tryReconnectByOrigin(baseUrl)).toBe(true);
    expect(await freshStore.list()).toHaveLength(1);
    expect(await freshVault.getDeviceToken(saved.profileId)).toBe(token);
    expect(await freshVault.getDeviceToken(sourceId)).toBe(token);
  });

  it("reuses a stale target profile after rejecting its credentials and uses authoritative metadata", async () => {
    const f = await fixture(true);
    await f.addProfile("profile-stale", baseUrl);
    const request = vi.fn<typeof fetch>(async (_url, init) =>
      new Headers(init?.headers).get("authorization") === `Bearer ${staleToken}`
        ? new Response(JSON.stringify({ error: "workspace_connection_unauthorized" }), {
            status: 401
          })
        : response()
    );
    expect(await f.connection(request).tryReconnectByOrigin(baseUrl)).toBe(true);
    expect(await f.store.getActiveProfileId()).toBe("profile-stale");
    expect((await f.store.get("profile-stale"))?.workspaceDisplayName).toBe("Authoritative name");
    expect(await f.vault.getDeviceToken("profile-stale")).toBe(token);
    expect(await f.vault.getDeviceToken(sourceId)).toBe(token);
  });

  it.each([
    "401",
    "403",
    "mismatch",
    "revoked",
    "archived",
    "network",
    "tls"
  ])("preserves active profile and storage after %s verification failure", async (mode) => {
    const f = await fixture(true);
    const request = vi.fn<typeof fetch>(async () => {
      if (mode === "401" || mode === "403")
        return new Response(JSON.stringify({ error: "rejected" }), { status: Number(mode) });
      if (mode === "network" || mode === "tls")
        throw new TypeError(mode === "tls" ? "certificate verify failed" : "network unavailable");
      return response(
        mode === "mismatch"
          ? { workspaceId: "workspace-other" }
          : mode === "revoked"
            ? { membershipActive: false }
            : { archivedAt: "2030-01-01T00:00:00.000Z" }
      );
    });
    const connection = f.connection(request);
    await connection.hydrate();
    const beforeView = await connection.buildView();
    const before = await readFile(f.profilesPath, "utf8");
    const credentials = await readFile(f.credentialsPath, "utf8");
    if (mode === "network" || mode === "tls")
      await expect(connection.tryReconnectByOrigin(baseUrl)).rejects.toThrow();
    else expect(await connection.tryReconnectByOrigin(baseUrl)).toBe(false);
    expect(await connection.buildView()).toEqual(beforeView);
    expect(await readFile(f.profilesPath, "utf8")).toBe(before);
    expect(await readFile(f.credentialsPath, "utf8")).toBe(credentials);
  });

  it.each([
    "http://public.example/",
    "http://192.168.1.23/"
  ])("does not inherit local HTTP permission for %s", async (url) => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>(async () => response());
    await expect(f.connection(request).tryReconnectByOrigin(url)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(await f.store.list()).toEqual([]);
  });

  it.each([
    "profile",
    "vault",
    "preference",
    "active"
  ])("compensates %s writes even when they committed before throwing, then retries without duplication", async (boundary) => {
    const f = await fixture(true);
    await f.addProfile("profile-stale", baseUrl);
    const request: typeof fetch = async (_url, init) =>
      new Headers(init?.headers).get("authorization") === `Bearer ${staleToken}`
        ? new Response(JSON.stringify({ error: "rejected" }), { status: 401 })
        : response();
    const connection = f.connection(request);
    await connection.hydrate();
    const previous = structuredClone(await f.store.read());
    const view = await connection.buildView();
    if (boundary === "profile") {
      const original = f.store.upsert.bind(f.store);
      vi.spyOn(f.store, "upsert").mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error("write failed");
      });
    }
    if (boundary === "vault") {
      const original = f.vault.setDeviceToken.bind(f.vault);
      vi.spyOn(f.vault, "setDeviceToken").mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("write failed");
      });
    }
    if (boundary === "preference") {
      const original = f.store.setLastConnection.bind(f.store);
      vi.spyOn(f.store, "setLastConnection").mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error("write failed");
      });
    }
    if (boundary === "active") {
      const original = f.store.setActiveProfileId.bind(f.store);
      vi.spyOn(f.store, "setActiveProfileId").mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error("write failed");
      });
    }
    await expect(connection.tryReconnectByOrigin(baseUrl)).rejects.toMatchObject({
      code: "server_migration_persistence_failed"
    });
    expect(await f.store.read()).toEqual(previous);
    expect(await connection.buildView()).toEqual(view);
    expect(
      await new WorkspaceConnectionProfileStore({ profilesPath: f.profilesPath }).read()
    ).toEqual(previous);
    expect(
      await new CollaborationCredentialVault({
        paths: { credentialsPath: f.credentialsPath },
        safeStorage: f.safeStorage
      }).getDeviceToken("profile-stale")
    ).toBe(staleToken);
    expect(await f.vault.getDeviceToken(sourceId)).toBe(token);
    expect(await connection.tryReconnectByOrigin(baseUrl)).toBe(true);
    expect(await f.store.list()).toHaveLength(2);
  });

  it("removes a newly created profile and copied credential when active selection fails", async () => {
    const f = await fixture();
    const request: typeof fetch = async () => response();
    const verified = await findServerMigrationIdentity({
      serverBaseUrl: baseUrl,
      profiles: [],
      identityStore: f.identityStore,
      vault: f.vault,
      request
    });
    if (!verified) throw new Error("Missing candidate");
    vi.spyOn(f.store, "setActiveProfileId").mockRejectedValueOnce(new Error("active failed"));
    await expect(f.connection(request).tryReconnectByOrigin(baseUrl)).rejects.toMatchObject({
      code: "server_migration_persistence_failed"
    });
    expect(await f.store.list()).toEqual([]);
    expect(await f.vault.getDeviceToken(verified.profile.profileId)).toBeUndefined();
    expect(await f.connection(request).tryReconnectByOrigin(baseUrl)).toBe(true);
    expect((await f.store.list())[0]?.profileId).toBe(verified.profile.profileId);
  });

  it("reports compensation failure explicitly and retains source identity", async () => {
    const f = await fixture();
    const request: typeof fetch = async () => response();
    vi.spyOn(f.store, "setActiveProfileId").mockRejectedValueOnce(new Error("active failed"));
    vi.spyOn(f.vault, "clear").mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(f.connection(request).tryReconnectByOrigin(baseUrl)).rejects.toMatchObject({
      code: "server_migration_rollback_failed",
      retryable: false
    });
    expect(await f.vault.getDeviceToken(sourceId)).toBe(token);
    expect(await f.identityStore.read()).not.toBeNull();
    expect(await f.store.getActiveProfileId()).toBeNull();
  });

  it("reports store compensation failure after active was committed and keeps retries on the same profile", async () => {
    const f = await fixture(true);
    const connection = f.connection(async () => response());
    await connection.hydrate();
    let activeCommitted = false;
    const originalWrite = f.store.write.bind(f.store);
    const originalActive = f.store.setActiveProfileId.bind(f.store);
    vi.spyOn(f.store, "write").mockImplementation(async (document) => {
      if (activeCommitted) throw new Error("rollback write failed");
      return originalWrite(document);
    });
    vi.spyOn(f.store, "setActiveProfileId").mockImplementationOnce(async (id) => {
      await originalActive(id);
      activeCommitted = true;
      throw new Error("active committed then failed");
    });
    await expect(connection.tryReconnectByOrigin(baseUrl)).rejects.toMatchObject({
      code: "server_migration_rollback_failed"
    });
    expect((await connection.buildView()).profile?.profileId).toBe("profile-original");
    expect(await f.vault.getDeviceToken(sourceId)).toBe(token);
    vi.restoreAllMocks();
    expect(await connection.tryReconnectByOrigin(baseUrl)).toBe(true);
    expect(await f.store.list()).toHaveLength(2);
  });

  it("keeps existing-origin reconnect independent of an unused damaged snapshot", async () => {
    const f = await fixture();
    await f.addProfile("profile-known", baseUrl, token);
    await f.store.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-known",
        displayName: "Known",
        serverBaseUrl: baseUrl,
        workspaceId: item.workspaceId,
        allowInsecureTransport: false
      },
      workspaceDisplayName: "Known"
    });
    await writeFile(f.identityPath, "broken");
    expect(await f.connection(async () => response()).tryReconnectByOrigin(baseUrl)).toBe(true);
  });

  it("diagnoses a snapshot with missing vault credentials without creating a profile", async () => {
    const f = await fixture();
    await f.vault.clear(sourceId);
    await expect(
      f.connection(async () => response()).tryReconnectByOrigin(baseUrl)
    ).rejects.toMatchObject({ code: "server_migration_credential_not_persisted" });
    expect(await f.store.list()).toEqual([]);
  });

  it("does not publish cache mutations on real profile and vault I/O failures", async () => {
    const f = await fixture(true);
    const before = structuredClone(await f.store.read());
    await mkdir(`${f.profilesPath}.tmp`);
    await mkdir(`${f.credentialsPath}.tmp`);
    await expect(f.store.setActiveProfileId(null)).rejects.toThrow();
    expect(await f.store.read()).toEqual(before);
    await expect(f.vault.setDeviceToken("profile-original", token)).rejects.toThrow();
    expect(await f.vault.getDeviceToken("profile-original")).toBe(staleToken);
    expect(
      await f.vault.verifyPersistedCredential("profile-original", {
        deviceToken: staleToken,
        identityToken: null
      })
    ).toBe(true);
  });

  it("uses a real HTTP redirect response without contacting its destination", async () => {
    const f = await fixture();
    let destinationHits = 0;
    const destination = createServer((_request, res) => {
      destinationHits++;
      res.end("unexpected");
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationAddress = destination.address();
    if (!destinationAddress || typeof destinationAddress === "string")
      throw new Error("Missing address");
    const redirector = createServer((_request, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${destinationAddress.port}/` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const address = redirector.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    try {
      await expect(
        f.connection(fetch).tryReconnectByOrigin(`http://127.0.0.1:${address.port}/`)
      ).rejects.toThrow();
      expect(destinationHits).toBe(0);
      expect(await f.store.list()).toEqual([]);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => redirector.close(() => resolve())),
        new Promise<void>((resolve) => destination.close(() => resolve()))
      ]);
    }
  });
});
