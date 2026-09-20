import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  CollaborationCredentialVault,
  CollaborationProfileStore,
  CollaborationService,
  WorkspaceConnectionProfileStore
} from "../main/collaboration/index.js";

describe("live Server registry session failures", () => {
  it.each([
    ["cursor", "live_registry_pagination_invalid", 2],
    ["limit", "live_registry_page_limit_exceeded", 100],
    ["http", "http_503", 2],
    ["protocol", "collaboration_response_invalid", 2],
    ["network", "collaboration_offline", 2]
  ] as const)("does not persist a partial binding on %s failure", async (failure, code, calls) => {
    const root = await mkdtemp(join(tmpdir(), "planweave-registry-session-"));
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    };
    const profiles = new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") });
    const workspaceProfiles = new WorkspaceConnectionProfileStore({
      profilesPath: join(root, "workspaces.json")
    });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage
    });
    const origin = "https://workspace.example.test/";
    await workspaceProfiles.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-live",
        displayName: "Team",
        serverBaseUrl: origin,
        workspaceId: "workspace-target",
        allowInsecureTransport: false
      },
      workspaceDisplayName: "Team",
      membershipRole: "owner",
      membershipActive: true
    });
    await vault.setDeviceToken("profile-live", exampleHumanDeviceToken, {
      deviceCredentialId: "device-owner",
      humanPrincipalId: "human-owner"
    });
    const upsert = vi.spyOn(profiles, "upsert");
    let registryCalls = 0;
    const service = new CollaborationService({
      profileStore: profiles,
      workspaceProfileStore: workspaceProfiles,
      vault,
      safeStorage,
      request: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/workspace-connection")
          return Response.json({
            schemaVersion: "workspace-setup/v1",
            items: [
              {
                schemaVersion: "workspace-setup/v1",
                workspaceId: "workspace-target",
                displayName: "Team",
                role: "owner",
                archivedAt: null,
                membershipActive: true
              }
            ],
            nextCursor: null
          });
        expect(url.pathname).toBe("/api/v1/registry/projects");
        registryCalls += 1;
        if (registryCalls > 1) {
          if (failure === "http") return new Response("unavailable", { status: 503 });
          if (failure === "protocol") return Response.json({ items: [], nextCursor: "invalid" });
          if (failure === "network") throw new TypeError("network failed");
        }
        return Response.json({
          items: [
            {
              schemaVersion: "project-access/v1",
              registry: {
                projectRegistryId: "registry-partial",
                workspaceId: "workspace-target",
                projectId: "partial-project"
              },
              visibility: "shared",
              acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
              owner: "human-owner",
              updatedAt: "2030-01-01T00:00:00.000Z"
            }
          ],
          nextCursor: failure === "cursor" ? 50 : registryCalls * 50
        });
      }
    });
    try {
      const status = await service.connectExistingServerByOrigin({ serverBaseUrl: origin });
      expect(status.workspaceConnection.status).toBe("connected");
      expect(status.session).toMatchObject({
        phase: "error",
        detail: "live_session_bind_failed",
        lastErrorCode: code
      });
      expect(status.activeProfileId).toBeNull();
      expect(registryCalls).toBe(calls);
      expect(upsert).not.toHaveBeenCalled();
      expect(await profiles.list()).toEqual([]);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
