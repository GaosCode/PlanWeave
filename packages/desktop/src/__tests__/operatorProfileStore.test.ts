import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OperatorControlService } from "../main/operatorControl/operatorControlService";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore";

const roots: string[] = [];
const services: OperatorControlService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const authorization = {
  operatorId: "admin",
  expiresAt: "2099-02-01T00:00:00.000Z",
  renewAfter: "2099-01-22T00:00:00.000Z"
};
const deviceId = "c28d8f73-0881-4a71-b21d-2a69f223aabc";
const profile = (profileId: string) => ({
  profileId,
  displayName: profileId,
  operatorId: "admin",
  serverBaseUrl: `https://${profileId}.example/`,
  allowInsecureTransport: false
});
async function fixture(topology = "tailscale_https") {
  const root = await mkdtemp(join(tmpdir(), "operator-profile-init-"));
  roots.push(root);
  const paths = { profilesPath: join(root, "profiles.json") };
  const legacy = {
    version: 1,
    activeProfileId: "a",
    profiles: ["a", "b"].map((id) => ({
      ...profile(id),
      updatedAt: "2030-01-01T00:00:00.000Z",
      endpoint: {
        topology,
        serverOrigin: profile(id).serverBaseUrl,
        allowedClientOrigins: [profile(id).serverBaseUrl],
        tlsTrust: "system_ca"
      }
    }))
  };
  await writeFile(paths.profilesPath, JSON.stringify(legacy));
  return {
    root,
    paths,
    legacy,
    store: new OperatorProfileStore(paths),
    reload: () => new OperatorProfileStore(paths)
  };
}

it.each([
  "tailscale_https",
  "lan_https"
])("single-flights cold %s migration across ten status reads and two profile checks", async (topology) => {
  const f = await fixture(topology);
  const vault = new OperatorCredentialVault({
    paths: { credentialsPath: join(f.root, "credentials.json") }
  });
  await Promise.all(
    ["a", "b"].map((id) => vault.setOperatorToken(id, `pw_operator_${"A".repeat(43)}`, "admin"))
  );
  const service = new OperatorControlService({
    profileStore: f.store,
    vault,
    localOperatorBackend: null,
    request: async (url) => {
      const action = String(url).split("/").at(-1);
      const body =
        action === "device-enroll"
          ? {
              deviceId,
              deviceName: "Test",
              operatorId: "admin",
              createdAt: "2030-01-01T00:00:00Z",
              lastUsedAt: "2030-01-01T00:00:00Z",
              revokedAt: null
            }
          : action === "device-list"
            ? []
            : action === "device-refresh"
              ? { ...authorization, deviceId }
              : authorization;
      return new Response(JSON.stringify(body));
    }
  });
  services.push(service);
  const statuses = Array.from({ length: 10 }, () => service.getStatus());
  const checks = ["a", "b"].map((profileId) => service.getManagementAuthorization({ profileId }));
  const [views, management] = await Promise.all([Promise.all(statuses), Promise.all(checks)]);
  expect(views).toHaveLength(10);
  expect(
    views.every(
      (view) =>
        view.profiles.length === 2 &&
        view.profiles.every((item) => item.endpoint?.topology === "private_https")
    )
  ).toBe(true);
  expect(management.every((view) => view.errorCode === null)).toBe(true);
  const restarted = await f.reload().read();
  expect(restarted.profiles.map((item) => item.profileId)).toEqual(["a", "b"]);
  expect(restarted.profiles.every((item) => item.endpoint?.topology === "private_https")).toBe(
    true
  );
});

it("orders initialization migration, concurrent upserts and active selection without losing updates on restart", async () => {
  const f = await fixture();
  const reading = f.store.read();
  const upserts = [f.store.upsert(profile("c")), f.store.upsert(profile("d"))];
  const selecting = f.store.setActiveProfileId("d");
  await Promise.all([reading, ...upserts, selecting]);
  const restarted = await f.reload().read();
  expect(restarted.profiles.map((item) => item.profileId)).toEqual(["a", "b", "c", "d"]);
  expect(restarted.activeProfileId).toBe("d");
  expect(restarted.profiles[0].endpoint?.topology).toBe("private_https");
  const external = await f.store.read();
  external.profiles.length = 0;
  expect(await f.store.list()).toHaveLength(4);
});

it("orders a full-document write after an in-flight migration", async () => {
  const f = await fixture();
  const reading = f.store.read();
  const replacement = {
    version: 1 as const,
    activeProfileId: "new",
    profiles: [{ ...profile("new"), updatedAt: "2031-01-01T00:00:00.000Z" }]
  };
  const writing = f.store.write(replacement);
  await Promise.all([reading, writing]);
  expect(await f.reload().read()).toEqual(replacement);
  expect(await f.store.read()).toEqual(replacement);
});

it("retries failed migration without publishing its cache and preserves subsequent writes", async () => {
  const f = await fixture();
  await mkdir(`${f.paths.profilesPath}.tmp`);
  const failed = await Promise.allSettled([
    f.store.read(),
    f.store.get("a"),
    f.store.upsert(profile("c"))
  ]);
  expect(failed.every((result) => result.status === "rejected")).toBe(true);
  expect(JSON.parse(await readFile(f.paths.profilesPath, "utf8"))).toEqual(f.legacy);
  await rename(`${f.paths.profilesPath}.tmp`, join(f.root, "blocked-temp"));
  await Promise.all([f.store.read(), f.store.upsert(profile("c"))]);
  expect((await f.reload().read()).profiles.map((item) => item.profileId)).toEqual(["a", "b", "c"]);
  expect((await f.store.get("a"))?.endpoint?.topology).toBe("private_https");
});

it("keeps committed profile state after failed mutations and permits retry", async () => {
  const f = await fixture();
  const before = await f.store.read();
  await mkdir(`${f.paths.profilesPath}.tmp`);
  await expect(f.store.upsert(profile("c"))).rejects.toThrow();
  await expect(f.store.remove("a")).rejects.toThrow();
  await expect(f.store.setActiveProfileId("b")).rejects.toThrow();
  expect(await f.store.read()).toEqual(before);
  expect(await f.reload().read()).toEqual(before);
  await rename(`${f.paths.profilesPath}.tmp`, join(f.root, "blocked-temp"));
  await f.store.upsert(profile("c"));
  expect((await f.reload().read()).profiles).toHaveLength(3);
});
