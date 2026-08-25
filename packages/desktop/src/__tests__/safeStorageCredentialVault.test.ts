import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleHumanDeviceToken,
  exampleHumanIdentityToken,
  exampleInvitationToken
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { CollaborationInvitationVault } from "../main/collaboration/collaborationInvitationVault.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault.js";

const roots: string[] = [];
const operatorToken = "operator_a_token_abcdefghijklmnopqrstuvwxyz_1234";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function availableSafeStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8"))
  };
}

function deniedSafeStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn(() => {
      const error = new Error("userCanceledErr");
      Object.assign(error, { code: -128 });
      throw error;
    })
  };
}

function unavailableSafeStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8"))
  };
}

function invalidPlaintextSafeStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn(() => "invalid-decrypted-credential")
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("safeStorage credential access", () => {
  it("reads collaboration credential status without decrypting and preserves denied ciphertext", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-keychain-");
    const credentialsPath = join(directory, "credentials.json");
    const writer = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: availableSafeStorage()
    });
    await writer.setDeviceToken("profile-1", exampleHumanDeviceToken, {
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });

    const denied = deniedSafeStorage();
    const reader = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: denied
    });

    await expect(reader.persistenceFor("profile-1")).resolves.toBe("persisted");
    await expect(reader.getMetadata("profile-1")).resolves.toMatchObject({
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });
    expect(denied.decryptString).not.toHaveBeenCalled();

    await expect(reader.getDeviceToken("profile-1")).rejects.toThrow(
      "Configured credential storage could not decrypt the collaboration credential."
    );
    expect(
      JSON.parse(await readFile(credentialsPath, "utf8")).credentials["profile-1"]
    ).toBeDefined();
  });

  it("encrypts invitation secrets and restores them only for the owning profile", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-invitations-");
    const invitationsPath = join(directory, "invitations.json");
    const safeStorage = availableSafeStorage();
    const invitation = {
      invitation: {
        invitationId: "invitation-2",
        projectId: "project-1",
        role: "member" as const,
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-02T00:00:00.000Z"
      },
      invitationToken: exampleInvitationToken
    };

    const first = new CollaborationInvitationVault({ path: invitationsPath, safeStorage });
    await expect(first.set("profile-1", invitation)).resolves.toBe("persisted");
    expect(await readFile(invitationsPath, "utf8")).not.toContain(exampleInvitationToken);

    const reopened = new CollaborationInvitationVault({ path: invitationsPath, safeStorage });
    await expect(reopened.get("profile-1", "invitation-2")).resolves.toEqual(invitation);
    await expect(reopened.get("profile-2", "invitation-2")).resolves.toBeNull();
  });

  it("keeps invitation secrets in memory when safeStorage is unavailable", async () => {
    const directory = await temporaryDirectory("planweave-session-invitations-");
    const invitationsPath = join(directory, "invitations.json");
    const invitation = {
      invitation: {
        invitationId: "invitation-3",
        projectId: "project-1",
        role: "member" as const,
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-02T00:00:00.000Z"
      },
      invitationToken: exampleInvitationToken
    };
    const vault = new CollaborationInvitationVault({
      path: invitationsPath,
      safeStorage: unavailableSafeStorage()
    });

    await expect(vault.set("profile-1", invitation)).resolves.toBe("session-only");
    await expect(vault.get("profile-1", "invitation-3")).resolves.toEqual(invitation);
    await expect(readFile(invitationsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists profiles without secrets and encrypts device tokens", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-profile-");
    const profilesPath = join(directory, "profiles.json");
    const credentialsPath = join(directory, "credentials.json");
    const safeStorage = availableSafeStorage();
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage
    });
    const store = new CollaborationProfileStore({ profilesPath });

    await store.upsert({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://collab.example.com/",
        allowedClientOrigins: ["https://collab.example.com/"],
        tlsTrust: "system_ca"
      }
    });
    await vault.setDeviceToken("profile-1", exampleHumanDeviceToken, {
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });

    const profileRaw = await readFile(profilesPath, "utf8");
    expect(profileRaw).not.toContain(exampleHumanDeviceToken);
    expect(profileRaw).not.toContain("encryptedDeviceToken");
    expect(profileRaw).toContain("profile-1");

    const credentialRaw = await readFile(credentialsPath, "utf8");
    expect(credentialRaw).not.toContain(exampleHumanDeviceToken);
    expect(credentialRaw).toContain("encryptedDeviceToken");
    expect(await vault.getDeviceToken("profile-1")).toBe(exampleHumanDeviceToken);
    expect(await vault.persistenceFor("profile-1")).toBe("persisted");
    expect((await stat(profilesPath)).mode & 0o777).toBe(0o600);
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
  });

  it("persists identity expiry and preserves omitted device metadata on rotation", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-identity-expiry-");
    const credentialsPath = join(directory, "credentials.json");
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: availableSafeStorage()
    });
    const identityExpiresAt = "2031-01-01T00:00:00.000Z";
    await vault.setDeviceToken("profile-1", exampleHumanDeviceToken, {
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1",
      identityToken: exampleHumanIdentityToken,
      identityCredentialId: "identity-1",
      identityExpiresAt
    });
    await vault.setDeviceToken("profile-1", exampleHumanDeviceToken, {
      identityToken: exampleHumanIdentityToken,
      identityCredentialId: "identity-2",
      identityExpiresAt: "2031-06-01T00:00:00.000Z"
    });
    expect(await vault.getIdentityToken("profile-1")).toBe(exampleHumanIdentityToken);
    expect(await vault.getMetadata("profile-1")).toMatchObject({
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1",
      identityCredentialId: "identity-2",
      identityExpiresAt: "2031-06-01T00:00:00.000Z"
    });
  });

  it("keeps device tokens session-only when safeStorage is unavailable", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-session-");
    const credentialsPath = join(directory, "credentials.json");
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: unavailableSafeStorage()
    });

    await expect(vault.setDeviceToken("profile-1", exampleHumanDeviceToken)).resolves.toBe(
      "session-only"
    );
    await expect(vault.getDeviceToken("profile-1")).resolves.toBe(exampleHumanDeviceToken);
    await expect(vault.hasAnySessionOnlyCredential()).resolves.toBe(true);
    await expect(readFile(credentialsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("purges decrypted plaintext that is not a valid credential", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-invalid-token-");
    const credentialsPath = join(directory, "credentials.json");
    const writer = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: availableSafeStorage()
    });
    await writer.setDeviceToken("profile-1", exampleHumanDeviceToken);

    const reader = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: invalidPlaintextSafeStorage()
    });
    await expect(reader.getDeviceToken("profile-1")).resolves.toBeUndefined();
    await expect(reader.persistenceFor("profile-1")).resolves.toBe("missing");
    expect(
      JSON.parse(await readFile(credentialsPath, "utf8")).credentials["profile-1"]
    ).toBeUndefined();
  });

  it("clears revoked credentials from memory and disk", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-revoke-");
    const credentialsPath = join(directory, "credentials.json");
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: availableSafeStorage()
    });
    await vault.setDeviceToken("profile-1", exampleHumanDeviceToken);
    await vault.clear("profile-1");

    await expect(vault.getDeviceToken("profile-1")).resolves.toBeUndefined();
    expect(
      JSON.parse(await readFile(credentialsPath, "utf8")).credentials["profile-1"]
    ).toBeUndefined();
  });

  it("rejects unsupported or malformed persisted credential documents", async () => {
    const directory = await temporaryDirectory("planweave-collaboration-invalid-store-");
    const profilesPath = join(directory, "profiles.json");
    const credentialsPath = join(directory, "credentials.json");

    await writeFile(
      profilesPath,
      JSON.stringify({ version: 4, profiles: [], activeProfileId: null }),
      "utf8"
    );
    await expect(new CollaborationProfileStore({ profilesPath }).read()).rejects.toThrow(
      "Invalid collaboration profiles JSON."
    );

    await writeFile(credentialsPath, JSON.stringify({ version: 1, credentials: [] }), "utf8");
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: availableSafeStorage()
    });
    await expect(vault.getDeviceToken("profile-1")).rejects.toThrow(
      "Invalid collaboration credentials JSON."
    );
  });

  it("reads operator credential status without decrypting and preserves denied ciphertext", async () => {
    const directory = await temporaryDirectory("planweave-operator-keychain-");
    const credentialsPath = join(directory, "credentials.json");
    const writer = new OperatorCredentialVault({
      paths: { credentialsPath },
      safeStorage: availableSafeStorage()
    });
    await writer.setOperatorToken("profile-1", operatorToken, "operator-1");

    const denied = deniedSafeStorage();
    const reader = new OperatorCredentialVault({
      paths: { credentialsPath },
      safeStorage: denied
    });

    await expect(reader.persistenceFor("profile-1")).resolves.toBe("persisted");
    await expect(reader.getMetadata("profile-1")).resolves.toMatchObject({
      operatorId: "operator-1"
    });
    expect(denied.decryptString).not.toHaveBeenCalled();

    await expect(reader.getOperatorToken("profile-1")).rejects.toThrow(
      "Configured credential storage could not decrypt the operator credential."
    );
    expect(
      JSON.parse(await readFile(credentialsPath, "utf8")).credentials["profile-1"]
    ).toBeDefined();
  });

  it("preserves a saved invitation when Keychain access is denied", async () => {
    const directory = await temporaryDirectory("planweave-invitation-keychain-");
    const invitationsPath = join(directory, "invitations.json");
    const invitation = {
      invitation: {
        invitationId: "invitation-1",
        projectId: "project-1",
        role: "member" as const,
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-02T00:00:00.000Z"
      },
      invitationToken: exampleInvitationToken
    };
    const writer = new CollaborationInvitationVault({
      path: invitationsPath,
      safeStorage: availableSafeStorage()
    });
    await writer.set("profile-1", invitation);

    const reader = new CollaborationInvitationVault({
      path: invitationsPath,
      safeStorage: deniedSafeStorage()
    });
    await expect(reader.get("profile-1", "invitation-1")).rejects.toThrow(
      "Configured credential storage could not decrypt the collaboration invitation."
    );
    expect(
      JSON.parse(await readFile(invitationsPath, "utf8")).invitations["profile-1"]["invitation-1"]
    ).toBeDefined();
  });
});
