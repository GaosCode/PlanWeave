import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CollaborationWorkspaceConnection } from "../main/collaboration/collaborationWorkspaceConnection.js";
import { WorkspaceConnectionProfileStore } from "../main/collaboration/workspaceConnectionProfileStore.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pw-workspace-selection-"));
  roots.push(root);
  const store = new WorkspaceConnectionProfileStore({ profilesPath: join(root, "profiles.json") });
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(root, "credentials.json") },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ""
    }
  });
  for (const [profileId, serverBaseUrl] of [
    ["local-old", "https://old.example/"],
    ["remote", "https://remote.example/"]
  ] as const) {
    await store.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId,
        displayName: profileId,
        serverBaseUrl,
        workspaceId: "workspace-shared-id",
        allowInsecureTransport: false
      },
      workspaceDisplayName: "Team",
      membershipRole: "owner"
    });
    await vault.setDeviceToken(profileId, `pw_hdev_${"A".repeat(43)}`);
  }
  await store.setActiveProfileId("remote");
  const request = vi.fn<typeof fetch>(async (url) => {
    if (String(url).startsWith("https://old.example/")) throw new TypeError("fetch failed");
    if (String(url).includes("/registry/projects"))
      return new Response(JSON.stringify({ items: [], nextCursor: null }));
    return new Response(
      JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        items: ["workspace-shared-id", "workspace-second"].map((workspaceId) => ({
          schemaVersion: "workspace-setup/v1",
          workspaceId,
          displayName: workspaceId,
          role: "owner",
          archivedAt: null,
          membershipActive: true
        })),
        nextCursor: null
      }),
      { headers: { "content-type": "application/json" } }
    );
  });
  const connection = new CollaborationWorkspaceConnection({
    store,
    vault,
    request,
    exportedIdentityPath: join(root, "exported.json")
  });
  await connection.hydrate();
  await connection.connectActiveProfile();
  return { connection, store, request };
}

it("keeps the selected Server when another origin has the same Workspace ID", async () => {
  const { connection, store } = await fixture();
  await connection.selectWorkspaceByWorkspaceId("workspace-shared-id");
  expect((await connection.buildView()).profile?.profileId).toBe("remote");
  expect(await store.getActiveProfileId()).toBe("remote");
});

it("preserves a working connection and its persisted selection when switching fails", async () => {
  const { connection, store } = await fixture();
  const before = await connection.buildView();
  await expect(connection.selectWorkspace("local-old")).rejects.toMatchObject({ kind: "offline" });
  expect(await connection.buildView()).toEqual(before);
  expect(await store.getActiveProfileId()).toBe("remote");
  expect(await store.getLastConnection()).toEqual({ kind: "remote", profileId: "remote" });
});

it("switches to a Server-authorized Workspace that has no separate saved profile", async () => {
  const { connection } = await fixture();
  const result = await connection.selectWorkspaceByWorkspaceId("workspace-second");
  expect(result.workspaceId).toBe("workspace-second");
  expect(result.profile?.serverBaseUrl).toBe("https://remote.example/");
});

it("reads the Workspace directory without any selected project session", async () => {
  const { connection, request } = await fixture();
  const page = await connection.readDirectory((directory) => directory.listProjects({ limit: 10 }));
  expect(page.items).toEqual([]);
  expect(String(request.mock.calls.at(-1)?.[0])).toContain(
    "https://remote.example/api/v1/registry/projects"
  );
});
