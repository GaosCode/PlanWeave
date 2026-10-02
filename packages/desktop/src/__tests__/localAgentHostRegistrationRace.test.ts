import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopLocalAgentHostProvisioner,
  type LocalAgentHostOperatorPort
} from "../main/operatorControl/localAgentHostProvisioner.js";
import { LocalAgentHostRegistrationStore } from "../main/operatorControl/localAgentHostRegistrationStore.js";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave-registration-race-"));
  roots.push(root);
  const path = join(root, "registrations.json");
  const store = new LocalAgentHostRegistrationStore(path, {
    now: () => new Date("2030-01-01T00:00:00.000Z")
  });
  await store.upsert("profile", { instanceKey: "instance-old", workspaceId: "workspace-old" });
  const agents = [
    {
      profileId: "codex-acp",
      agentId: "codex",
      displayName: "Codex",
      detected: true,
      exposed: true,
      ready: true
    }
  ];
  const operator = {
    enrollHandoff: vi.fn<LocalAgentHostOperatorPort["enrollHandoff"]>().mockResolvedValue({
      state: "ready",
      workspaceId: "instance-new",
      credential: "active",
      background: "running",
      configPath: join(root, "new.json"),
      agents,
      nextSteps: {
        listAgents: { command: "planweave", args: [] },
        exposeAgent: { command: "planweave", args: [] },
        hideAgent: { command: "planweave", args: [] },
        runManually: { command: "planweave", args: [] }
      }
    }),
    reconcileAgentExposure: vi
      .fn<LocalAgentHostOperatorPort["reconcileAgentExposure"]>()
      .mockResolvedValue({ agents, reload: "restarted" }),
    listAgents: vi.fn<LocalAgentHostOperatorPort["listAgents"]>().mockResolvedValue(agents),
    requireUsableCredential: vi
      .fn<LocalAgentHostOperatorPort["requireUsableCredential"]>()
      .mockResolvedValue(undefined),
    installBackground: vi
      .fn<LocalAgentHostOperatorPort["installBackground"]>()
      .mockResolvedValue({ state: "running", platform: "macos-launch-agent" }),
    backgroundStatus: vi
      .fn<LocalAgentHostOperatorPort["backgroundStatus"]>()
      .mockResolvedValue({ state: "running", platform: "macos-launch-agent" })
  };
  const provisioner = new DesktopLocalAgentHostProvisioner({
    platform: "darwin",
    launcher: { executablePath: "/test/host" },
    registrations: store,
    operator
  });
  return { root, path, store, operator, provisioner };
}

describe("Local Host registration identity across stale reads", () => {
  it.each([
    {
      boundary: "listAgents",
      failure: Object.assign(new Error("missing old config"), { code: "ENOENT" })
    },
    { boundary: "requireUsableCredential", failure: new Error("agent_host_credential_unavailable") }
  ] as const)("does not remove a new registration after deferred $boundary fails", async ({
    boundary,
    failure
  }) => {
    const f = await fixture();
    const entered = deferred<void>();
    const pending = deferred<never>();
    f.operator[boundary].mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const oldStatus = f.provisioner.status("profile");
    await entered.promise;
    await f.provisioner.register("profile", "opaque-handoff", ["codex-acp"]);
    const newRegistration = await f.store.get("profile");
    const newBytes = await readFile(f.path);
    pending.reject(failure);
    await oldStatus;
    expect(await new LocalAgentHostRegistrationStore(f.path).get("profile")).toEqual(
      newRegistration
    );
    expect(await readFile(f.path)).toEqual(newBytes);
    expect(f.operator.installBackground).toHaveBeenCalledOnce();
  });

  it("retains same-instance registration even at the same timestamp after an old credential failure", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const pending = deferred<void>();
    f.operator.requireUsableCredential.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const oldStatus = f.provisioner.status("profile");
    await entered.promise;
    f.operator.enrollHandoff.mockResolvedValueOnce({
      state: "ready",
      workspaceId: "instance-old",
      credential: "active",
      background: "running",
      configPath: join(f.root, "old.json"),
      agents: [],
      nextSteps: {
        listAgents: { command: "planweave", args: [] },
        exposeAgent: { command: "planweave", args: [] },
        hideAgent: { command: "planweave", args: [] },
        runManually: { command: "planweave", args: [] }
      }
    });
    await f.provisioner.register("profile", "opaque-handoff", []);
    const newBytes = await readFile(f.path);
    pending.reject(new Error("agent_host_credential_unavailable"));
    await oldStatus;
    expect(await readFile(f.path)).toEqual(newBytes);
    expect(await new LocalAgentHostRegistrationStore(f.path).get("profile")).not.toBeNull();
  });

  it.each([
    "reconcileAgentExposure",
    "installBackground"
  ] as const)("does not remove a new registration when old repair fails in %s", async (boundary) => {
    const f = await fixture();
    const entered = deferred<void>();
    const pending = deferred<never>();
    f.operator[boundary].mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const oldRepair = f.provisioner.repair("profile", ["codex-acp"]);
    await entered.promise;
    await f.provisioner.register("profile", "opaque-handoff", ["codex-acp"]);
    const newBytes = await readFile(f.path);
    pending.reject(new Error("agent_host_credential_unavailable"));
    await oldRepair;
    expect(await readFile(f.path)).toEqual(newBytes);
    expect(await new LocalAgentHostRegistrationStore(f.path).get("profile")).toMatchObject({
      instanceKey: "instance-new"
    });
  });

  it("preserves the new record through the Operator service status consumer", async () => {
    const f = await fixture();
    const profiles = new OperatorProfileStore({ profilesPath: join(f.root, "profiles.json") });
    const service = new OperatorControlService({
      profileStore: profiles,
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(f.root, "vault.json") },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error("not used");
          },
          decryptString: () => {
            throw new Error("not used");
          }
        }
      }),
      localAgentHost: f.provisioner
    });
    await service.upsertProfile({
      profileId: "profile",
      displayName: "Profile",
      serverBaseUrl: "https://server.example",
      allowInsecureTransport: false
    });
    const entered = deferred<void>();
    const pending = deferred<never>();
    f.operator.listAgents.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const status = service.getLocalAgentHostStatus({ profileId: "profile" });
    await entered.promise;
    await f.provisioner.register("profile", "opaque-handoff", []);
    const bytes = await readFile(f.path);
    pending.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await status;
    expect(await readFile(f.path)).toEqual(bytes);
  });
  it("serializes concurrent store instances and rejects removal with an obsolete generation", async () => {
    const f = await fixture();
    const old = await f.store.get("profile");
    if (!old) throw new Error("fixture registration missing");
    const reopened = new LocalAgentHostRegistrationStore(f.path, {
      now: () => new Date(old.updatedAt)
    });
    const fresh = reopened.upsert("profile", { instanceKey: old.instanceKey });
    const staleRemoval = f.store.removeIfCurrent(old);
    const [next, removed] = await Promise.all([fresh, staleRemoval]);
    expect(removed).toBe(false);
    expect(next.updatedAt).toBe(old.updatedAt);
    expect(next.generation).not.toBe(old.generation);
    expect(await f.store.removeIfCurrent({ ...next, instanceKey: "different-instance" })).toBe(
      false
    );
    expect(await f.store.get("profile")).toEqual(next);
    await Promise.all([
      f.store.upsert("other-a", { instanceKey: "a" }),
      reopened.upsert("other-b", { instanceKey: "b" })
    ]);
    expect(await new LocalAgentHostRegistrationStore(f.path).get("other-a")).toMatchObject({
      instanceKey: "a"
    });
    expect(await new LocalAgentHostRegistrationStore(f.path).get("other-b")).toMatchObject({
      instanceKey: "b"
    });
    expect(await reopened.removeIfCurrent(next)).toBe(true);
    expect(await f.store.get("profile")).toBeNull();
  });

  it("keeps the committed record after a write failure and permits a later retry", async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    await mkdir(`${f.path}.tmp`);
    await expect(f.store.upsert("profile", { instanceKey: "failed" })).rejects.toThrow();
    expect(await readFile(f.path)).toEqual(before);
    await rm(`${f.path}.tmp`, { recursive: true });
    const fresh = await f.store.upsert("profile", { instanceKey: "retried" });
    expect(await new LocalAgentHostRegistrationStore(f.path).get("profile")).toEqual(fresh);
    await mkdir(`${f.path}.tmp`);
    await expect(f.store.removeIfCurrent(fresh)).rejects.toThrow();
    expect(await new LocalAgentHostRegistrationStore(f.path).get("profile")).toEqual(fresh);
    await rm(`${f.path}.tmp`, { recursive: true });
    expect(await f.store.removeIfCurrent(fresh)).toBe(true);
    expect(await new LocalAgentHostRegistrationStore(f.path).get("profile")).toBeNull();
  });

  it("migrates v2 once with a stable persisted generation and preserves Workspace identity", async () => {
    const f = await fixture();
    await writeFile(
      f.path,
      JSON.stringify({
        version: 2,
        registrations: [
          {
            profileId: "legacy",
            instanceKey: "instance",
            workspaceId: "workspace",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ]
      })
    );
    const migrated = await f.store.get("legacy");
    expect(migrated).toMatchObject({
      profileId: "legacy",
      instanceKey: "instance",
      workspaceId: "workspace",
      generation: expect.any(String)
    });
    const bytes = await readFile(f.path);
    expect(await new LocalAgentHostRegistrationStore(f.path).get("legacy")).toEqual(migrated);
    expect(await readFile(f.path)).toEqual(bytes);
    expect(JSON.parse(bytes.toString()).version).toBe(3);
  });

  it.each([
    "config",
    "credential",
    "repair"
  ] as const)("still cleans the current invalid %s registration", async (stage) => {
    const f = await fixture();
    if (stage === "config")
      f.operator.listAgents.mockRejectedValueOnce(
        Object.assign(new Error("missing"), { code: "ENOENT" })
      );
    if (stage === "credential")
      f.operator.requireUsableCredential.mockRejectedValueOnce(
        new Error("agent_host_credential_unavailable")
      );
    if (stage === "repair")
      f.operator.reconcileAgentExposure.mockRejectedValueOnce(
        new Error("agent_host_credential_unavailable")
      );
    expect(
      await (stage === "repair"
        ? f.provisioner.repair("profile", [])
        : f.provisioner.status("profile"))
    ).toMatchObject({ state: "not_registered" });
    expect(await new LocalAgentHostRegistrationStore(f.path).get("profile")).toBeNull();
  });
});
