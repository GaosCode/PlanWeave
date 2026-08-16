import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpProfileRevisionConflictError,
  AcpProfileStore,
  type AcpProfileStoreLockOptions
} from "../acpProfile/store.js";
import type { AcpProfileDescriptor } from "../acpProfile/schema.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(lock?: AcpProfileStoreLockOptions) {
  const root = await mkdtemp(join(tmpdir(), "planweave-acp-profile-store-"));
  roots.push(root);
  const catalogPath = join(root, "config", "acp-profiles.json");
  return { root, catalogPath, store: new AcpProfileStore({ catalogPath, lock }) };
}

function profile(id: string, args: readonly string[] = []): AcpProfileDescriptor {
  return {
    version: "planweave.acp-profile/v1",
    id,
    agentId: "custom-agent",
    displayName: "Custom Agent",
    host: { kind: "native" },
    launch: { command: "/opt/custom/bin/custom-acp", args },
    environment: [],
    shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1_000 },
    capabilities: { required: ["session", "prompt"], optional: [] },
    connection: { mode: "dedicated" }
  };
}

describe("AcpProfileStore", () => {
  it("treats a missing file as revision zero and writes a private atomic catalog", async () => {
    const { root, catalogPath, store } = await setup();
    await expect(store.read()).resolves.toEqual({
      version: "planweave.acp-profile-catalog/v1",
      revision: 0,
      profiles: []
    });

    await expect(
      store.register({ expectedRevision: 0, profile: profile("Custom-ACP") })
    ).resolves.toMatchObject({ revision: 1, profiles: [{ id: "custom-acp" }] });
    expect(JSON.parse(await readFile(catalogPath, "utf8"))).toMatchObject({ revision: 1 });
    expect((await stat(catalogPath)).mode & 0o777).toBe(
      process.platform === "win32" ? expect.any(Number) : 0o600
    );
    expect(await readFile(join(root, "config", "acp-profiles.json"), "utf8")).not.toContain(
      "secret-value"
    );
  });

  it("serializes concurrent writers and returns a structured revision conflict", async () => {
    const { store } = await setup();
    const results = await Promise.allSettled([
      store.register({ expectedRevision: 0, profile: profile("first-acp") }),
      store.register({ expectedRevision: 0, profile: profile("second-acp") })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        code: "acp_profile_revision_conflict",
        expectedRevision: 0,
        actualRevision: 1
      })
    });
    expect(rejected && rejected.status === "rejected" && rejected.reason).toBeInstanceOf(
      AcpProfileRevisionConflictError
    );
  });

  it("updates and removes by CAS without last-write-wins behavior", async () => {
    const { store } = await setup();
    await store.register({ expectedRevision: 0, profile: profile("custom-acp") });
    await expect(
      store.update({
        expectedRevision: 1,
        profileId: "CUSTOM-ACP",
        profile: profile("custom-acp", ["serve"])
      })
    ).resolves.toMatchObject({ revision: 2, profiles: [{ launch: { args: ["serve"] } }] });
    await expect(
      store.remove({ expectedRevision: 1, profileId: "custom-acp" })
    ).rejects.toBeInstanceOf(AcpProfileRevisionConflictError);
    await expect(store.remove({ expectedRevision: 2, profileId: "Custom-Acp" })).resolves.toEqual({
      version: "planweave.acp-profile-catalog/v1",
      revision: 3,
      profiles: []
    });
  });

  it("validates lock option boundaries before filesystem access", async () => {
    const invalidOptions: AcpProfileStoreLockOptions[] = [
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001].map((timeoutMs) => ({
        timeoutMs
      })),
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001].map((staleMs) => ({
        staleMs
      })),
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_001].map((retryDelayMs) => ({
        retryDelayMs
      })),
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648].map((pid) => ({ pid })),
      { timeoutMs: 10, retryDelayMs: 11 }
    ];
    for (const lock of invalidOptions) {
      expect(() => new AcpProfileStore({ catalogPath: "/unused/catalog.json", lock })).toThrow();
    }
  });

  it("rejects structured credential arguments without echoing or persisting their value", async () => {
    const { catalogPath, store } = await setup();
    const credentialProfile = profile("credential-acp", ["--token=secret-token-marker"]);
    try {
      await store.register({ expectedRevision: 0, profile: credentialProfile });
      throw new Error("credential-like profile unexpectedly registered");
    } catch (error) {
      expect(String(error)).toContain("credential");
      expect(String(error)).not.toContain("secret-token-marker");
    }
    await expect(readFile(catalogPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails visibly for corrupt JSON", async () => {
    const { catalogPath, store } = await setup();
    await mkdir(dirname(catalogPath), { recursive: true });
    await writeFile(catalogPath, '{"value":"synthetic-secret-marker",', "utf8");
    try {
      await store.read();
      throw new Error("corrupt catalog unexpectedly parsed");
    } catch (error) {
      expect(String(error)).toContain("invalid JSON");
      expect(String(error)).not.toContain("synthetic-secret-marker");
    }
  });

  it("times out on a live holder and reclaims a stale lock only when the owner is dead", async () => {
    const active = await setup({
      timeoutMs: 20,
      staleMs: 1,
      retryDelayMs: 2,
      isPidAlive: () => true
    });
    await mkdir(dirname(active.store.lockPath), { recursive: true });
    await writeFile(
      active.store.lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(0).toISOString(),
        ownerToken: "active-token"
      }),
      "utf8"
    );
    await expect(
      active.store.register({ expectedRevision: 0, profile: profile("blocked-acp") })
    ).rejects.toThrow("Timed out acquiring ACP profile catalog lock");

    const stale = await setup({
      timeoutMs: 100,
      staleMs: 1,
      retryDelayMs: 2,
      isPidAlive: () => false
    });
    await mkdir(dirname(stale.store.lockPath), { recursive: true });
    await writeFile(
      stale.store.lockPath,
      JSON.stringify({
        pid: 999_999,
        createdAt: new Date(0).toISOString(),
        ownerToken: "stale-token"
      }),
      "utf8"
    );
    await expect(
      stale.store.register({ expectedRevision: 0, profile: profile("recovered-acp") })
    ).resolves.toMatchObject({ revision: 1 });

    const unknown = await setup({
      timeoutMs: 20,
      staleMs: 1,
      retryDelayMs: 2,
      isPidAlive: () => false
    });
    await mkdir(dirname(unknown.store.lockPath), { recursive: true });
    await writeFile(unknown.store.lockPath, "unreadable-holder", "utf8");
    await expect(
      unknown.store.register({ expectedRevision: 0, profile: profile("unknown-owner-acp") })
    ).rejects.toThrow("Timed out acquiring ACP profile catalog lock");
  });
});
