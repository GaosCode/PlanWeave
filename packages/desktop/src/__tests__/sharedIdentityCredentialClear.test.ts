import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleHumanDeviceToken,
  exampleHumanIdentityToken
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { CollaborationIdentityCredentialClient } from "../main/collaboration/collaborationIdentityCredentialClient.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { EXPORTED_SERVER_DATA_PROFILE_ID } from "../main/collaboration/exportedServerDataIdentity.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("shared identity credential clear", () => {
  it("clears copied identity tokens in other profiles after one profile revokes them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-shared-identity-clear-"));
    directories.push(directory);
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(directory, "credentials.json") },
      safeStorage: mockSafeStorage()
    });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({
        profilesPath: join(directory, "profiles.json")
      }),
      vault,
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          dispose: vi.fn(),
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });
    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-a",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://collab.example.com/",
        allowedClientOrigins: ["https://collab.example.com/"],
        tlsTrust: "system_ca"
      }
    });
    const copyDeviceToken = `pw_hdev_${"B".repeat(43)}`;
    await vault.setDeviceToken("profile-a", exampleHumanDeviceToken, {
      deviceCredentialId: "device-a",
      humanPrincipalId: "human-1",
      identityToken: exampleHumanIdentityToken,
      identityCredentialId: "identity-shared-1",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    await vault.setDeviceToken(EXPORTED_SERVER_DATA_PROFILE_ID, copyDeviceToken, {
      deviceCredentialId: "device-export",
      humanPrincipalId: "human-1",
      identityToken: exampleHumanIdentityToken,
      identityCredentialId: "identity-shared-1",
      identityExpiresAt: "2031-01-01T00:00:00.000Z"
    });
    const revoke = vi
      .spyOn(CollaborationIdentityCredentialClient.prototype, "revoke")
      .mockResolvedValue({
        schemaVersion: "human-identity/v1",
        humanPrincipalId: "human-1",
        identityCredentialId: "identity-shared-1",
        revokedAt: "2030-06-01T00:00:00.000Z"
      });

    await service.clearDeviceCredential({ profileId: "profile-a" });

    expect(revoke).toHaveBeenCalledWith(exampleHumanIdentityToken, "device_credential_cleared");
    expect(await vault.getDeviceToken("profile-a")).toBeUndefined();
    expect(await vault.getDeviceToken(EXPORTED_SERVER_DATA_PROFILE_ID)).toBe(copyDeviceToken);
    expect(await vault.getIdentityToken(EXPORTED_SERVER_DATA_PROFILE_ID)).toBeUndefined();
    expect(await vault.getMetadata(EXPORTED_SERVER_DATA_PROFILE_ID)).toMatchObject({
      identityCredentialId: null,
      identityExpiresAt: null
    });
  });
});
