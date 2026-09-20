import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import {
  ExportedServerDataIdentityStore,
  exportedIdentityCredentialProfileId
} from "../main/collaboration/exportedServerDataIdentity.js";
import { snapshotServerDataIdentity } from "../main/collaboration/serverDataMigrationIdentity.js";
import type { StoredWorkspaceConnectionProfile } from "../main/collaboration/workspaceConnectionProfileStore.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const profile: StoredWorkspaceConnectionProfile = {
  schemaVersion: "workspace-identity/v1",
  profileId: "planweave-local-test",
  displayName: "Local",
  serverBaseUrl: "http://127.0.0.1:8787/",
  workspaceId: "workspace-test",
  allowInsecureTransport: true,
  workspaceDisplayName: "Local",
  membershipRole: "owner",
  membershipActive: true,
  updatedAt: "2030-01-01T00:00:00.000Z"
};
const token = `pw_hdev_${"A".repeat(43)}`;
const prior = {
  schemaVersion: "exported-server-data-identity/v1" as const,
  workspaceId: "workspace-prior",
  workspaceDisplayName: "Prior",
  membershipRole: "owner" as const,
  updatedAt: "2029-01-01T00:00:00.000Z"
};
async function fixture(available = true) {
  const root = await mkdtemp(join(tmpdir(), "planweave-snapshot-"));
  roots.push(root);
  const paths = { credentialsPath: join(root, "credentials.json") };
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (value: Buffer) => value.toString()
  };
  const vault = new CollaborationCredentialVault({ paths, safeStorage });
  const identityPath = join(root, "identity.json");
  const identityStore = new ExportedServerDataIdentityStore(identityPath);
  const save = () =>
    snapshotServerDataIdentity({
      profiles: [profile],
      vault,
      identityStore,
      now: () => profile.updatedAt
    });
  return { root, vault, identityStore, identityPath, save, paths, safeStorage };
}
describe("Server data identity snapshots", () => {
  it("reloads a saved locator and durable credentials in new store instances", async () => {
    const f = await fixture();
    await f.vault.setDeviceToken(profile.profileId, token);
    expect(await f.save()).toEqual({ status: "saved" });
    const restored = await new ExportedServerDataIdentityStore(f.identityPath).read();
    expect(restored?.schemaVersion).toBe("exported-server-data-identity/v2");
    if (!restored) throw new Error("Missing snapshot");
    const reloadedVault = new CollaborationCredentialVault({
      paths: f.paths,
      safeStorage: f.safeStorage
    });
    expect(await reloadedVault.getDeviceToken(exportedIdentityCredentialProfileId(restored))).toBe(
      token
    );
    expect(await readFile(f.identityPath, "utf8")).not.toContain(token);
  });
  it("returns missing identity and does not reuse an older snapshot as success", async () => {
    const f = await fixture();
    await f.identityStore.write(prior);
    expect(await f.save()).toEqual({ status: "unavailable", reason: "missing_identity" });
    expect(await f.identityStore.read()).toEqual(prior);
  });
  it("rejects session-only credentials without replacing the old snapshot", async () => {
    const f = await fixture(false);
    await f.identityStore.write(prior);
    await f.vault.setDeviceToken(profile.profileId, token);
    expect(await f.save()).toEqual({ status: "unavailable", reason: "nonpersistent_credentials" });
    expect(await f.identityStore.read()).toEqual(prior);
  });
  it.each([
    "vault",
    "locator"
  ] as const)("preserves prior locator and credentials after %s write failure", async (boundary) => {
    const f = await fixture();
    await f.identityStore.write(prior);
    const oldToken = `pw_hdev_${"B".repeat(43)}`;
    await f.vault.setDeviceToken("planweave-exported-server-data", oldToken);
    await f.vault.setDeviceToken(profile.profileId, token);
    if (boundary === "vault")
      vi.spyOn(f.vault, "setDeviceToken").mockRejectedValueOnce(new Error("write failed"));
    else vi.spyOn(f.identityStore, "write").mockRejectedValueOnce(new Error("write failed"));
    expect(await f.save()).toEqual({ status: "unavailable", reason: "snapshot_failed" });
    expect(await f.identityStore.read()).toEqual(prior);
    const reloadedVault = new CollaborationCredentialVault({
      paths: f.paths,
      safeStorage: f.safeStorage
    });
    expect(await reloadedVault.getDeviceToken("planweave-exported-server-data")).toBe(oldToken);
    expect(await reloadedVault.getDeviceToken(profile.profileId)).toBe(token);
  });
  it("keeps the prior snapshot when the real locator temporary file cannot be written", async () => {
    const f = await fixture();
    await f.identityStore.write(prior);
    await f.vault.setDeviceToken(profile.profileId, token);
    await mkdir(`${f.identityPath}.tmp`);
    expect(await f.save()).toEqual({ status: "unavailable", reason: "snapshot_failed" });
    expect(await new ExportedServerDataIdentityStore(f.identityPath).read()).toEqual(prior);
  });

  it("detects durable credentials that disagree with the cached session", async () => {
    const f = await fixture();
    await f.identityStore.write(prior);
    await f.vault.setDeviceToken(profile.profileId, token);
    await writeFile(f.paths.credentialsPath, JSON.stringify({ version: 2, credentials: {} }));
    expect(await f.save()).toEqual({ status: "unavailable", reason: "snapshot_failed" });
    expect(await f.identityStore.read()).toEqual(prior);
  });

  it("preserves original durable credentials after a real vault write failure", async () => {
    const f = await fixture();
    await f.identityStore.write(prior);
    await f.vault.setDeviceToken(profile.profileId, token);
    const before = await readFile(f.paths.credentialsPath, "utf8");
    await mkdir(`${f.paths.credentialsPath}.tmp`);
    expect(await f.save()).toEqual({ status: "unavailable", reason: "snapshot_failed" });
    expect(await readFile(f.paths.credentialsPath, "utf8")).toBe(before);
    expect(await f.identityStore.read()).toEqual(prior);
  });

  it("reads v1 locators with their historical vault key", async () => {
    const f = await fixture();
    await f.identityStore.write(prior);
    const read = await f.identityStore.read();
    expect(read).toEqual(prior);
    expect(read && exportedIdentityCredentialProfileId(read)).toBe(
      "planweave-exported-server-data"
    );
  });
  it("only treats absent files as missing; corruption and I/O failures are explicit", async () => {
    const f = await fixture();
    expect(await f.identityStore.read()).toBeNull();
    await writeFile(f.identityPath, "not json");
    await expect(f.identityStore.read()).rejects.toThrow(
      "Could not read exported Server identity snapshot."
    );
    expect(await f.save()).toEqual({ status: "unavailable", reason: "snapshot_failed" });
    await expect(new ExportedServerDataIdentityStore(f.root).read()).rejects.toThrow(
      "Could not read exported Server identity snapshot."
    );
  });
});
