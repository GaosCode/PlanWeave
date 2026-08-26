import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { CollaborationWorkspaceConnection } from "../main/collaboration/collaborationWorkspaceConnection.js";
import { CollaborationWorkspaceConnectionFacade } from "../main/collaboration/collaborationWorkspaceConnectionFacade.js";
import { WorkspaceConnectionProfileStore } from "../main/collaboration/workspaceConnectionProfileStore.js";
import type { CollaborationSessionPhase, CollaborationStatus } from "../shared/collaboration.js";

const directories: string[] = [];
const origin = "http://127.0.0.1:8787/";
const now = new Date("2030-06-01T00:00:00.000Z");
const secret = (fill: string) => fill.repeat(43);
const deviceToken = (fill: string) => `pw_hdev_${secret(fill)}`;
const identityToken = (fill: string) => `pw_hid_${secret(fill)}`;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function mockSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8")
  };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-identity-repair-"));
  directories.push(directory);
  const store = new WorkspaceConnectionProfileStore({
    profilesPath: join(directory, "workspace-profiles.json")
  });
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(directory, "credentials.json") },
    safeStorage: mockSafeStorage()
  });
  return { directory, store, vault };
}

async function addPrincipal(
  store: WorkspaceConnectionProfileStore,
  vault: CollaborationCredentialVault,
  input: {
    profileId: string;
    humanPrincipalId: string;
    deviceFill: string;
    identityFill: string;
    identityExpiresAt: string;
  }
) {
  await store.upsert({
    profile: {
      schemaVersion: "workspace-identity/v1",
      profileId: input.profileId,
      displayName: input.humanPrincipalId,
      serverBaseUrl: origin,
      workspaceId: "workspace-1",
      allowInsecureTransport: true
    },
    workspaceDisplayName: input.humanPrincipalId,
    membershipRole: "member",
    membershipActive: true
  });
  await vault.setDeviceToken(input.profileId, deviceToken(input.deviceFill), {
    humanPrincipalId: input.humanPrincipalId,
    identityToken: identityToken(input.identityFill),
    identityCredentialId: `identity-${input.profileId}`,
    identityExpiresAt: input.identityExpiresAt
  });
}

function dummyStatus(session: {
  phase: CollaborationSessionPhase;
  detail: string | null;
}): CollaborationStatus {
  return {
    profiles: [],
    activeProfileId: null,
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: session.phase,
      activeProfileId: null,
      detail: session.detail,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: {
      schemaVersion: "workspace-setup/v1",
      items: [],
      nextCursor: null
    },
    updatedAt: now.toISOString()
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

describe("identity repair connection", () => {
  it("recovers an expired identity token instead of treating it as proof", async () => {
    const { store, vault } = await setup();
    await addPrincipal(store, vault, {
      profileId: "profile-a",
      humanPrincipalId: "human-a",
      deviceFill: "A",
      identityFill: "A",
      identityExpiresAt: "2030-01-01T00:00:00.000Z"
    });
    await addPrincipal(store, vault, {
      profileId: "profile-b",
      humanPrincipalId: "human-b",
      deviceFill: "B",
      identityFill: "B",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    const recoveredToken = identityToken("C");
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/human-identity/recover")) {
        return jsonResponse(200, {
          schemaVersion: "human-identity/v1",
          humanPrincipalId: "human-a",
          identityCredentialId: "identity-recovered-a",
          identityToken: recoveredToken,
          identityExpiresAt: "2031-01-01T00:00:00.000Z"
        });
      }
      throw new Error(`unexpected_request:${url}`);
    });
    const connection = new CollaborationWorkspaceConnection({
      store,
      vault,
      request: request as typeof fetch,
      clock: { now: () => now }
    });
    const remaining = await connection.recoverHistoricalIdentities({
      serverBaseUrl: origin,
      allowInsecureTransport: true
    });
    expect(request).toHaveBeenCalled();
    expect(await vault.getIdentityToken("profile-a")).toBe(recoveredToken);
    expect(remaining?.principals).toHaveLength(2);
    expect(remaining?.principals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: "human-a", hasIdentityToken: true }),
        expect.objectContaining({ humanPrincipalId: "human-b", hasIdentityToken: true })
      ])
    );
  });

  it("keeps repair required after merging one of three principals", async () => {
    const { store, vault } = await setup();
    await addPrincipal(store, vault, {
      profileId: "profile-a",
      humanPrincipalId: "human-a",
      deviceFill: "A",
      identityFill: "A",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    await addPrincipal(store, vault, {
      profileId: "profile-b",
      humanPrincipalId: "human-b",
      deviceFill: "B",
      identityFill: "B",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    await addPrincipal(store, vault, {
      profileId: "profile-c",
      humanPrincipalId: "human-c",
      deviceFill: "C",
      identityFill: "C",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/human-identity/merge")) {
        return jsonResponse(200, {
          schemaVersion: "human-identity/v1",
          mergeId: "identity-merge-test",
          sourceHumanPrincipalId: "human-a",
          canonicalHumanPrincipalId: "human-c",
          mergedAt: now.toISOString()
        });
      }
      throw new Error(`unexpected_request:${url}`);
    });
    const connection = new CollaborationWorkspaceConnection({
      store,
      vault,
      request: request as typeof fetch,
      clock: { now: () => now }
    });
    let session: { phase: CollaborationSessionPhase; detail: string | null } = {
      phase: "error",
      detail: "identity_repair_required"
    };
    const facade = new CollaborationWorkspaceConnectionFacade({
      connection,
      publishStatus: async () => dummyStatus(session),
      setSession: (phase, detail) => {
        session = { phase, detail };
      }
    });
    await facade.confirmIdentityMerge({
      serverBaseUrl: origin,
      allowInsecureTransport: true,
      sourceHumanPrincipalId: "human-a",
      canonicalHumanPrincipalId: "human-c",
      confirmation: "merge"
    });
    expect(session).toEqual({ phase: "error", detail: "identity_repair_required" });
    expect(connection.identityRepairView()?.principals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: "human-b" }),
        expect.objectContaining({ humanPrincipalId: "human-c" })
      ])
    );
    expect(connection.identityRepairView()?.principals).toHaveLength(2);
  });

  it("recovers a revoked identity token once and retries merge", async () => {
    const { store, vault } = await setup();
    await addPrincipal(store, vault, {
      profileId: "profile-a",
      humanPrincipalId: "human-a",
      deviceFill: "A",
      identityFill: "A",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    await addPrincipal(store, vault, {
      profileId: "profile-b",
      humanPrincipalId: "human-b",
      deviceFill: "B",
      identityFill: "B",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    let mergeAttempts = 0;
    const recoveredA = identityToken("D");
    const recoveredB = identityToken("E");
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/human-identity/merge")) {
        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          return jsonResponse(403, { error: "identity_credential_revoked" });
        }
        return jsonResponse(200, {
          schemaVersion: "human-identity/v1",
          mergeId: "identity-merge-retry",
          sourceHumanPrincipalId: "human-a",
          canonicalHumanPrincipalId: "human-b",
          mergedAt: now.toISOString()
        });
      }
      if (url.includes("/api/v1/human-identity/recover")) {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { existingDeviceToken?: string };
        const forA = parsed.existingDeviceToken === deviceToken("A");
        return jsonResponse(200, {
          schemaVersion: "human-identity/v1",
          humanPrincipalId: forA ? "human-a" : "human-b",
          identityCredentialId: forA ? "identity-recovered-a" : "identity-recovered-b",
          identityToken: forA ? recoveredA : recoveredB,
          identityExpiresAt: "2031-06-01T00:00:00.000Z"
        });
      }
      throw new Error(`unexpected_request:${url}`);
    });
    const connection = new CollaborationWorkspaceConnection({
      store,
      vault,
      request: request as typeof fetch,
      clock: { now: () => now }
    });
    const remaining = await connection.confirmIdentityMerge({
      serverBaseUrl: origin,
      allowInsecureTransport: true,
      sourceHumanPrincipalId: "human-a",
      canonicalHumanPrincipalId: "human-b",
      confirmation: "merge"
    });
    expect(mergeAttempts).toBe(2);
    expect(remaining).toBeNull();
    expect(connection.identityRepairView()).toBeNull();
  });

  it("rewrites both presented principals to the server canonical after a transitive merge", async () => {
    const { store, vault } = await setup();
    await addPrincipal(store, vault, {
      profileId: "profile-a",
      humanPrincipalId: "human-a",
      deviceFill: "A",
      identityFill: "A",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    await addPrincipal(store, vault, {
      profileId: "profile-c",
      humanPrincipalId: "human-c",
      deviceFill: "C",
      identityFill: "C",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/human-identity/merge")) {
        return jsonResponse(200, {
          schemaVersion: "human-identity/v1",
          mergeId: "identity-merge-transitive",
          sourceHumanPrincipalId: "human-a",
          canonicalHumanPrincipalId: "human-c",
          mergedAt: now.toISOString()
        });
      }
      throw new Error(`unexpected_request:${url}`);
    });
    const connection = new CollaborationWorkspaceConnection({
      store,
      vault,
      request: request as typeof fetch,
      clock: { now: () => now }
    });
    const remaining = await connection.confirmIdentityMerge({
      serverBaseUrl: origin,
      allowInsecureTransport: true,
      sourceHumanPrincipalId: "human-c",
      canonicalHumanPrincipalId: "human-a",
      confirmation: "merge"
    });
    expect(remaining).toBeNull();
    expect(await vault.getMetadata("profile-a")).toMatchObject({
      humanPrincipalId: "human-c"
    });
    expect(await vault.getMetadata("profile-c")).toMatchObject({
      humanPrincipalId: "human-c"
    });
  });
});
