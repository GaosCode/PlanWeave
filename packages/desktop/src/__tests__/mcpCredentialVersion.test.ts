import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApplicationCredentialStorage,
  type DesktopCredentialStorage
} from "../main/credentialStorage/applicationCredentialStorage.js";
import { migrateCredentialStorage } from "../main/credentialStorage/credentialStorageMigration.js";
import type { CredentialStoragePaths } from "../main/credentialStorage/credentialStoragePaths.js";
import { createTunnelClientConfigController } from "../main/mcpTunnel/tunnelClientConfigController.js";
import {
  readTunnelClientConfig,
  writeTunnelClientConfig,
  type TunnelClientConfig
} from "../main/mcpTunnel/tunnelClientStore.js";
import type { CredentialStorageMode } from "../shared/credentialStorageSettings.js";

const faults = vi.hoisted(() => ({ renameTarget: "", nextRenameTarget: "", chmodTarget: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (String(args[0]) === faults.chmodTarget) throw new Error("fixture chmod failed");
      return actual.chmod(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === faults.renameTarget) {
        faults.renameTarget = faults.nextRenameTarget;
        faults.nextRenameTarget = "";
        throw new Error(`fixture rename failed: ${String(args[1])}`);
      }
      return actual.rename(...args);
    }
  };
});
const ipc = vi.hoisted(() => new Map<string, (_event: unknown, input?: unknown) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (_event: unknown, input?: unknown) => unknown) =>
      ipc.set(channel, handler)
  }
}));
import { CredentialStoragePreferenceStore } from "../main/credentialStorage/credentialStoragePreferenceStore.js";
import { registerCredentialStorageSettingsHandlers } from "../main/credentialStorage/credentialStorageSettingsHandlers.js";
import { credentialStorageSettingsInvokeChannels } from "../shared/credentialStorageSettings.js";

const roots: string[] = [];
beforeEach(() => {
  faults.renameTarget = "";
  faults.nextRenameTarget = "";
  faults.chmodTarget = "";
  ipc.clear();
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function credentialPaths(root: string, mode: CredentialStorageMode): CredentialStoragePaths {
  return {
    preferenceFile: join(root, "preference.json"),
    applicationKeyFile: join(root, `${mode}.key`),
    collaborationCredentialsFile: join(root, `collaboration.${mode}.json`),
    collaborationInvitationsFile: join(root, `invitations.${mode}.json`),
    coordinatorCredentialsFile: join(root, `coordinator.${mode}.json`),
    operatorCredentialsFile: join(root, `operator.${mode}.json`)
  };
}

async function fixture(mode: CredentialStorageMode) {
  const root = await mkdtemp(join(tmpdir(), "pw-mcp-key-version-"));
  roots.push(root);
  const storages: Record<CredentialStorageMode, DesktopCredentialStorage> = {
    application: createApplicationCredentialStorage({ keyPath: join(root, "application.key") }),
    system: createApplicationCredentialStorage({ keyPath: join(root, "system-fixture.key") })
  };
  const paths = { configPath: join(root, "mcp.json") };
  let activeMode = mode;
  const options = {
    read: () => readTunnelClientConfig(paths),
    write: (config: TunnelClientConfig) => writeTunnelClientConfig(config, paths),
    storage: () => storages[activeMode],
    mode: () => activeMode,
    storageForMode: (requested: CredentialStorageMode) => storages[requested]
  };
  const controller = () => createTunnelClientConfigController(options);
  let owner = controller();
  const migrate = (targetMode: CredentialStorageMode) =>
    migrateCredentialStorage({
      sourceMode: activeMode,
      targetMode,
      sourcePaths: credentialPaths(root, activeMode),
      targetPaths: credentialPaths(root, targetMode),
      sourceStorage: storages[activeMode],
      targetStorage: storages[targetMode],
      mcpTunnelPaths: paths,
      commitMcpConfig: async (update) => {
        await owner.update((current) => ({ ...current, config: update(current.config) }));
      }
    });
  const restart = (nextMode: CredentialStorageMode) => {
    activeMode = nextMode;
    owner = controller();
    return owner;
  };
  return {
    root,
    paths,
    storages,
    get owner() {
      return owner;
    },
    migrate,
    restart
  };
}

for (const initial of ["application", "system"] as const) {
  const other = initial === "application" ? "system" : "application";
  describe(`MCP credential version from ${initial}`, () => {
    it("rotates both existing representations and restores only the latest key after restart", async () => {
      const f = await fixture(initial);
      await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "key-zero" });
      await f.migrate(other);
      f.restart(other);
      await f.owner.prepareStart({ runtimeApiKey: "key-one" });
      const restored = await f.restart(initial).read();
      expect(restored.runtimeApiKey).toBe("key-one");
      expect(f.owner.persistence(restored)).toBe("persisted");
      const config = await readTunnelClientConfig(f.paths);
      for (const mode of ["application", "system"] as const) {
        const cipher = config.encryptedRuntimeApiKeys?.[mode];
        expect(cipher).toBeTruthy();
        expect(f.storages[mode].decryptString(Buffer.from(cipher!, "base64"))).toBe("key-one");
      }
      expect(await readFile(f.paths.configPath, "utf8")).not.toContain("key-one");
    });

    it("replaces an existing stale migration target using the current source authority", async () => {
      const f = await fixture(initial);
      await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "key-one" });
      await f.owner.update((state) => ({
        ...state,
        config: {
          ...state.config,
          encryptedRuntimeApiKeys: {
            ...state.config.encryptedRuntimeApiKeys,
            [other]: f.storages[other].encryptString("key-zero").toString("base64")
          }
        }
      }));
      const receipt = await f.migrate(other);
      expect(receipt.counts.mcpRuntimeApiKey).toBe(1);
      expect((await f.restart(other).read()).runtimeApiKey).toBe("key-one");
    });

    it("keeps a pending-restart target current when the active-mode key rotates again", async () => {
      const f = await fixture(initial);
      await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "key-zero" });
      await f.migrate(other);
      await f.owner.prepareStart({ runtimeApiKey: "key-one" });
      const restored = await f.restart(other).read();
      expect(restored.runtimeApiKey).toBe("key-one");
      expect(f.owner.persisted(restored)).toBe(true);
    });
  });
}

it("repairs a corrupt target representation without trusting it over the valid source", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "latest" });
  await f.owner.update((state) => ({
    ...state,
    config: {
      ...state.config,
      encryptedRuntimeApiKeys: { ...state.config.encryptedRuntimeApiKeys, system: "corrupt" }
    }
  }));
  await f.migrate("system");
  expect((await f.restart("system").read()).runtimeApiKey).toBe("latest");
});

it("rejects a corrupt source even when a usable old target exists", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "latest" });
  await f.migrate("system");
  const config = await readTunnelClientConfig(f.paths);
  await writeTunnelClientConfig(
    {
      ...config,
      encryptedRuntimeApiKeys: {
        ...config.encryptedRuntimeApiKeys,
        application: "corrupt"
      }
    },
    f.paths
  );
  const before = await readFile(f.paths.configPath, "utf8");
  await expect(f.migrate("system")).rejects.toThrow("could not decrypt");
  expect(await readFile(f.paths.configPath, "utf8")).toBe(before);
});

it("retains committed memory and disk on encryption or atomic rename failure, then retries", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "committed" });
  await f.migrate("system");
  const previous = f.owner.current;
  const before = await readFile(f.paths.configPath, "utf8");
  const system = f.storages.system;
  f.storages.system = {
    ...system,
    encryptString: () => {
      throw new Error("encryption failed");
    }
  };
  await expect(f.owner.prepareStart({ runtimeApiKey: "rejected" })).rejects.toThrow(
    "encryption failed"
  );
  expect(f.owner.current).toBe(previous);
  expect(await readFile(f.paths.configPath, "utf8")).toBe(before);
  f.storages.system = system;
  faults.renameTarget = f.paths.configPath;
  await expect(f.owner.prepareStart({ runtimeApiKey: "rejected" })).rejects.toThrow(
    "fixture rename failed"
  );
  expect(f.owner.current).toBe(previous);
  expect(await readFile(f.paths.configPath, "utf8")).toBe(before);
  faults.renameTarget = "";
  await f.owner.prepareStart({ runtimeApiKey: "accepted" });
  expect((await f.restart("system").read()).runtimeApiKey).toBe("accepted");
});

it("invalidates an unavailable old mode without claiming its stale key as persisted after restart", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "old" });
  await f.migrate("system");
  const system = f.storages.system;
  f.storages.system = { ...system, isEncryptionAvailable: () => false };
  await f.owner.prepareStart({ runtimeApiKey: "latest" });
  expect(f.owner.persistence(await f.owner.read())).toBe("persisted");
  f.storages.system = system;
  const restored = await f.restart("system").read();
  expect(restored.runtimeApiKey).toBeNull();
  expect(f.owner.persistence(restored)).toBe("missing");
});

it("keeps a session-only rotation from leaving persisted old replicas or enabling auto-start", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "old" });
  await f.migrate("system");
  f.storages.application = { ...f.storages.application, isEncryptionAvailable: () => false };
  const state = await f.owner.prepareStart({ runtimeApiKey: "session" });
  expect(f.owner.persistence(state)).toBe("session-only");
  expect(f.owner.sessionKey(state)).toBe("session");
  expect(state.config.autoStart).toBe(false);
  const restored = await f.restart("system").read();
  expect(restored.runtimeApiKey).toBeNull();
  expect(f.owner.persistence(restored)).toBe("missing");
});

it("rolls back only the failed mode-switch replica, preserving independent config writes", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "committed" });
  const before = await readTunnelClientConfig(f.paths);
  const receipt = await f.migrate("system");
  await f.owner.update((state) => ({
    ...state,
    config: { ...state.config, tunnelClientPath: "/independent" }
  }));
  await receipt.rollbackSharedFiles();
  const restored = await readTunnelClientConfig(f.paths);
  expect(restored.encryptedRuntimeApiKeys).toEqual(before.encryptedRuntimeApiKeys);
  expect(restored.encryptedRuntimeApiKey).toBe(before.encryptedRuntimeApiKey);
  expect(restored.tunnelClientPath).toBe("/independent");
});

it("does not roll an older migration receipt back over a later key rotation", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "old" });
  const receipt = await f.migrate("system");
  await f.owner.prepareStart({ runtimeApiKey: "new" });
  await receipt.rollbackSharedFiles();
  expect((await f.restart("system").read()).runtimeApiKey).toBe("new");
});

it("uses real settings preference writes and the config queue for rollback and pending-restart rotation", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "old" });
  const preference = new CredentialStoragePreferenceStore(join(f.root, "preference.json"));
  registerCredentialStorageSettingsHandlers({
    store: preference,
    activeMode: "application",
    migration: { migrate: f.migrate }
  });
  const configure = ipc.get(credentialStorageSettingsInvokeChannels.configure);
  if (!configure) throw new Error("Missing production settings handler");
  faults.renameTarget = preference.path;
  await expect(configure({}, { mode: "system" })).rejects.toThrow("fixture rename failed");
  expect((await preference.read()).mode).toBe("application");
  expect((await readTunnelClientConfig(f.paths)).encryptedRuntimeApiKeys?.system).toBeUndefined();
  faults.renameTarget = "";
  await configure({}, { mode: "system" });
  expect((await preference.read()).mode).toBe("system");
  await f.owner.prepareStart({ runtimeApiKey: "new" });
  expect((await f.restart("system").read()).runtimeApiKey).toBe("new");
});

it("does not report failed preference after its rename commit or roll back the matching MCP replica", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "latest" });
  const preference = new CredentialStoragePreferenceStore(join(f.root, "preference.json"));
  registerCredentialStorageSettingsHandlers({
    store: preference,
    activeMode: "application",
    migration: { migrate: f.migrate }
  });
  const configure = ipc.get(credentialStorageSettingsInvokeChannels.configure);
  if (!configure) throw new Error("Missing production settings handler");
  faults.chmodTarget = preference.path;
  await expect(configure({}, { mode: "system" })).resolves.toMatchObject({
    configuredMode: "system"
  });
  expect((await preference.read()).mode).toBe("system");
  expect((await f.restart("system").read()).runtimeApiKey).toBe("latest");
  if (process.platform !== "win32") expect((await stat(preference.path)).mode & 0o777).toBe(0o600);
});

it("prepares preference permissions before commit and keeps mode/key aligned on chmod failure", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "latest" });
  const preference = new CredentialStoragePreferenceStore(join(f.root, "preference.json"));
  await preference.write({ mode: "application" });
  const before = await readFile(preference.path, "utf8");
  registerCredentialStorageSettingsHandlers({
    store: preference,
    activeMode: "application",
    migration: { migrate: f.migrate }
  });
  const configure = ipc.get(credentialStorageSettingsInvokeChannels.configure);
  if (!configure) throw new Error("Missing production settings handler");
  faults.chmodTarget = `${preference.path}.${process.pid}.tmp`;
  await expect(configure({}, { mode: "system" })).rejects.toThrow("fixture chmod failed");
  expect(await readFile(preference.path, "utf8")).toBe(before);
  expect((await readTunnelClientConfig(f.paths)).encryptedRuntimeApiKeys?.system).toBeUndefined();
  expect((await f.restart("application").read()).runtimeApiKey).toBe("latest");
});

it("preserves both preference and rollback errors instead of hiding the original failure", async () => {
  const f = await fixture("application");
  await f.owner.prepareStart({ tunnelId: "fixture", runtimeApiKey: "latest" });
  const preference = new CredentialStoragePreferenceStore(join(f.root, "preference.json"));
  registerCredentialStorageSettingsHandlers({
    store: preference,
    activeMode: "application",
    migration: { migrate: f.migrate }
  });
  const configure = ipc.get(credentialStorageSettingsInvokeChannels.configure);
  if (!configure) throw new Error("Missing production settings handler");
  faults.renameTarget = preference.path;
  faults.nextRenameTarget = f.paths.configPath;
  const failure: unknown = await Promise.resolve(configure({}, { mode: "system" })).then(
    () => null,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Missing aggregate failure");
  expect(failure.errors).toHaveLength(2);
  expect(String(failure.errors[0])).toContain(preference.path);
  expect(String(failure.errors[1])).toContain(f.paths.configPath);
  expect((await preference.read()).mode).toBe("application");
  expect((await f.owner.read()).runtimeApiKey).toBe("latest");
});
