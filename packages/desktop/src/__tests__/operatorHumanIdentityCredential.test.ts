import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleHumanDeviceToken,
  exampleHumanIdentityToken
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import {
  recoverActiveOperatorHumanIdentity,
  resolveOperatorHumanIdentityCredential
} from "../main/collaboration/operatorHumanIdentityCredential.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";

const tempRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-operator-human-"));
  tempRoots.push(root);
  return root;
}

const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
  decryptString: vi.fn((value: Buffer) => value.toString("utf8"))
};

function profile(profileId: string, projectId: string) {
  const serverOrigin = "https://operator.example.test/";
  return {
    profileId,
    displayName: profileId,
    serverBaseUrl: serverOrigin,
    projectId,
    allowInsecureTransport: false,
    endpoint: {
      topology: "public_https" as const,
      serverOrigin,
      allowedClientOrigins: [serverOrigin],
      tlsTrust: "system_ca" as const
    }
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveOperatorHumanIdentityCredential", () => {
  it("resolves the Human by Server origin without depending on the active Workspace", async () => {
    const root = await temporaryDirectory();
    const profiles = new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    await profiles.upsert(profile("workspace-a", "project-a"));
    await profiles.upsert(profile("workspace-b", "project-b"));
    await profiles.setActiveProfileId("workspace-b");
    await vault.setDeviceToken("workspace-a", exampleHumanDeviceToken, {
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken
    });

    await expect(
      resolveOperatorHumanIdentityCredential({
        profiles,
        vault,
        serverBaseUrl: "https://operator.example.test/",
        humanPrincipalId: "human-owner-1"
      })
    ).resolves.toEqual({
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken
    });
  });

  it("fails closed when a Server origin has credentials for multiple Humans", async () => {
    const root = await temporaryDirectory();
    const profiles = new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    await profiles.upsert(profile("workspace-a", "project-a"));
    await profiles.upsert(profile("workspace-b", "project-b"));
    await vault.setDeviceToken("workspace-a", exampleHumanDeviceToken, {
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken
    });
    await vault.setDeviceToken("workspace-b", `pw_hdev_${"B".repeat(43)}`, {
      humanPrincipalId: "human-owner-2",
      identityToken: `pw_hid_${"B".repeat(43)}`
    });

    await expect(
      resolveOperatorHumanIdentityCredential({
        profiles,
        vault,
        serverBaseUrl: "https://operator.example.test/"
      })
    ).resolves.toBeNull();
  });

  it("uses the signed-in collaboration profile when several Humans share a Server origin", async () => {
    const root = await temporaryDirectory();
    const profiles = new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    await profiles.upsert(profile("workspace-a", "project-a"));
    await profiles.upsert(profile("workspace-b", "project-b"));
    await profiles.setActiveProfileId("workspace-a");
    await vault.setDeviceToken("workspace-a", exampleHumanDeviceToken, {
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken
    });
    await vault.setDeviceToken("workspace-b", `pw_hdev_${"B".repeat(43)}`, {
      humanPrincipalId: "human-owner-2",
      identityToken: `pw_hid_${"B".repeat(43)}`
    });

    await expect(
      resolveOperatorHumanIdentityCredential({
        profiles,
        vault,
        serverBaseUrl: "https://operator.example.test/"
      })
    ).resolves.toEqual({
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken
    });
  });
});

describe("recoverActiveOperatorHumanIdentity", () => {
  it("recovers and persists the signed-in profile identity when the vault has only a device token", async () => {
    const root = await temporaryDirectory();
    const profiles = new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    await profiles.upsert(profile("workspace-a", "project-a"));
    await profiles.setActiveProfileId("workspace-a");
    await vault.setDeviceToken("workspace-a", exampleHumanDeviceToken, {
      humanPrincipalId: "human-owner-1"
    });
    const recover = vi.fn(async () => ({
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken,
      identityCredentialId: "identity-recovered-1",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    }));

    await expect(
      recoverActiveOperatorHumanIdentity({
        profiles,
        vault,
        serverBaseUrl: "https://operator.example.test/",
        recover
      })
    ).resolves.toEqual({
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken
    });
    expect(recover).toHaveBeenCalledWith(exampleHumanDeviceToken);
    await expect(vault.getIdentityToken("workspace-a")).resolves.toBe(exampleHumanIdentityToken);
    await expect(
      resolveOperatorHumanIdentityCredential({
        profiles,
        vault,
        serverBaseUrl: "https://operator.example.test/"
      })
    ).resolves.toEqual({
      humanPrincipalId: "human-owner-1",
      identityToken: exampleHumanIdentityToken
    });
  });

  it("prefers the signed-in same-origin profile when recovering among several device tokens", async () => {
    const root = await temporaryDirectory();
    const profiles = new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    await profiles.upsert(profile("workspace-a", "project-a"));
    await profiles.upsert(profile("workspace-b", "project-b"));
    await profiles.setActiveProfileId("workspace-b");
    await vault.setDeviceToken("workspace-a", exampleHumanDeviceToken, {
      humanPrincipalId: "human-owner-1"
    });
    const activeDeviceToken = `pw_hdev_${"C".repeat(43)}`;
    const activeIdentityToken = `pw_hid_${"C".repeat(43)}`;
    await vault.setDeviceToken("workspace-b", activeDeviceToken, {
      humanPrincipalId: "human-owner-2"
    });
    const recover = vi.fn(async () => ({
      humanPrincipalId: "human-owner-2",
      identityToken: activeIdentityToken,
      identityCredentialId: "identity-recovered-2",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    }));

    await expect(
      recoverActiveOperatorHumanIdentity({
        profiles,
        vault,
        serverBaseUrl: "https://operator.example.test/",
        recover
      })
    ).resolves.toEqual({
      humanPrincipalId: "human-owner-2",
      identityToken: activeIdentityToken
    });
    expect(recover).toHaveBeenCalledWith(activeDeviceToken);
    await expect(vault.getIdentityToken("workspace-b")).resolves.toBe(activeIdentityToken);
  });

  it("returns null when no same-origin ready profile has a device token", async () => {
    const root = await temporaryDirectory();
    const profiles = new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    await profiles.upsert(profile("workspace-a", "project-a"));
    await profiles.setActiveProfileId("workspace-a");
    const recover = vi.fn();

    await expect(
      recoverActiveOperatorHumanIdentity({
        profiles,
        vault,
        serverBaseUrl: "https://operator.example.test/",
        recover
      })
    ).resolves.toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });
});
