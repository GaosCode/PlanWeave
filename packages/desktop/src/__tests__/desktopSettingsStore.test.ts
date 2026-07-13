import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import {
  DesktopSettingsStore,
  DesktopSettingsStoreError,
  applyPersistedPlanweaveHomeSetting
} from "../main/desktopSettingsStore";
import { desktopHomePaths } from "../main/planweaveHomePaths";

const tempRoots: string[] = [];
const originalPlanweaveHome = process.env.PLANWEAVE_HOME;

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-desktop-settings-"));
  tempRoots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function testStore(settingsFile: string): DesktopSettingsStore {
  return new DesktopSettingsStore({ settingsFile, platform: "linux" });
}

afterEach(async () => {
  if (originalPlanweaveHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = originalPlanweaveHome;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DesktopSettingsStore", () => {
  it("keeps desktop settings in the default home while runtime paths follow PlanWeave Home", async () => {
    const home = await tempHome();
    process.env.PLANWEAVE_HOME = home;

    expect(desktopHomePaths()).toEqual({
      planweaveHome: home,
      desktopSettingsFile: join(homedir(), ".planweave", "config", "desktop-settings.json"),
      terminalPreferencesFile: join(home, "config", "terminal-preferences.json"),
      mcpTunnelDir: join(home, "desktop", "mcp-tunnel"),
      mcpTunnelConfigFile: join(home, "desktop", "mcp-tunnel", "config.json"),
      mcpTunnelDownloadsDir: join(home, "desktop", "mcp-tunnel", "downloads")
    });
  });

  it("returns default settings when the store file does not exist", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    await expect(store.read()).resolves.toEqual(defaultDesktopSettings);
    await expect(exists(store.settingsFile)).resolves.toBe(false);
  });

  it("enables macOS window material when a settings file has not been initialized yet", async () => {
    const home = await tempHome();
    const store = new DesktopSettingsStore({
      settingsFile: join(home, "config", "desktop-settings.json"),
      platform: "darwin"
    });

    await expect(store.read()).resolves.toEqual({
      ...defaultDesktopSettings,
      windowMaterial: {
        enabled: true
      }
    });
    await expect(exists(store.settingsFile)).resolves.toBe(false);
  });

  it("writes normalized settings and reads them back", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    const written = await store.write({
      ...defaultDesktopSettings,
      appearance: "dark",
      runtimePath: "/tmp/project",
      layout: {
        ...defaultDesktopSettings.layout,
        leftSidebar: {
          collapsed: true,
          width: 360
        }
      }
    });

    await expect(store.read()).resolves.toEqual(written);
    expect(JSON.parse(await readFile(store.settingsFile, "utf8"))).toMatchObject({
      appearance: "dark",
      runtimePath: "/tmp/project",
      layout: {
        leftSidebar: {
          collapsed: true,
          width: 360
        },
        rightSidebar: defaultDesktopSettings.layout.rightSidebar
      }
    });
  });

  it("normalizes and applies PlanWeave Home settings", async () => {
    const home = await tempHome();
    const configuredHome = join(home, "custom-home");
    const store = testStore(join(home, "config", "desktop-settings.json"));

    const written = await store.write({
      ...defaultDesktopSettings,
      planweaveHome: ` ${configuredHome} `
    });

    expect(written.planweaveHome).toBe(configuredHome);
    expect(process.env.PLANWEAVE_HOME).toBe(configuredHome);
    delete process.env.PLANWEAVE_HOME;

    applyPersistedPlanweaveHomeSetting(store.settingsFile);

    expect(process.env.PLANWEAVE_HOME).toBe(configuredHome);
  });

  it("restores the startup PlanWeave Home baseline when the setting is cleared", async () => {
    const home = await tempHome();
    const baselineHome = join(home, "baseline-home");
    const configuredHome = join(home, "custom-home");
    const store = new DesktopSettingsStore({
      settingsFile: join(home, "config", "desktop-settings.json"),
      platform: "linux",
      planweaveHomeBaseline: baselineHome
    });

    await store.write({
      ...defaultDesktopSettings,
      planweaveHome: configuredHome
    });
    expect(process.env.PLANWEAVE_HOME).toBe(configuredHome);

    const cleared = await store.mergePatch({ planweaveHome: "" });

    expect(cleared.planweaveHome).toBe("");
    expect(process.env.PLANWEAVE_HOME).toBe(baselineHome);
  });

  it("clears PLANWEAVE_HOME when the setting is blank and there is no startup baseline", async () => {
    const home = await tempHome();
    const configuredHome = join(home, "custom-home");
    const store = new DesktopSettingsStore({
      settingsFile: join(home, "config", "desktop-settings.json"),
      platform: "linux",
      planweaveHomeBaseline: null
    });

    await store.write({
      ...defaultDesktopSettings,
      planweaveHome: configuredHome
    });
    expect(process.env.PLANWEAVE_HOME).toBe(configuredHome);

    await store.mergePatch({ planweaveHome: "" });

    expect(process.env.PLANWEAVE_HOME).toBeUndefined();
  });

  it("does not treat persisted PlanWeave Home as a startup baseline when no startup baseline exists", async () => {
    const home = await tempHome();
    const configuredHome = join(home, "custom-home");
    const settingsFile = join(home, "config", "desktop-settings.json");
    const persistedStore = new DesktopSettingsStore({
      settingsFile,
      platform: "linux",
      planweaveHomeBaseline: null
    });

    await persistedStore.write({
      ...defaultDesktopSettings,
      planweaveHome: configuredHome
    });
    delete process.env.PLANWEAVE_HOME;

    const planweaveHomeBaseline = process.env.PLANWEAVE_HOME;
    applyPersistedPlanweaveHomeSetting(settingsFile, planweaveHomeBaseline);
    expect(process.env.PLANWEAVE_HOME).toBe(configuredHome);

    const store = new DesktopSettingsStore({
      settingsFile,
      platform: "linux",
      planweaveHomeBaseline: planweaveHomeBaseline ?? null
    });

    await store.mergePatch({ planweaveHome: "" });

    expect(process.env.PLANWEAVE_HOME).toBeUndefined();
  });

  it("does not restore an inherited PlanWeave Home after packaged startup clears the environment", async () => {
    const home = await tempHome();
    process.env.PLANWEAVE_HOME = join(home, "inherited-home");
    vi.resetModules();
    const module = await import("../main/desktopSettingsStore");
    delete process.env.PLANWEAVE_HOME;

    const store = new module.DesktopSettingsStore({
      settingsFile: join(home, "config", "desktop-settings.json"),
      platform: "linux"
    });

    await expect(store.read()).resolves.toEqual(defaultDesktopSettings);
    expect(process.env.PLANWEAVE_HOME).toBeUndefined();
  });

  it("expands tilde in PlanWeave Home before applying the runtime environment", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    const written = await store.write({
      ...defaultDesktopSettings,
      planweaveHome: "~/planweave-home"
    });

    expect(written.planweaveHome).toBe("~/planweave-home");
    expect(process.env.PLANWEAVE_HOME).toBe(join(homedir(), "planweave-home"));
  });

  it("deep merges patches without dropping nested settings", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));
    await store.write({
      ...defaultDesktopSettings,
      notifications: {
        ...defaultDesktopSettings.notifications,
        autoRunFailure: false
      },
      layout: {
        ...defaultDesktopSettings.layout,
        leftSidebar: {
          collapsed: true,
          width: 360
        }
      }
    });

    const patched = await store.mergePatch({
      layout: {
        rightSidebar: {
          collapsed: true,
          width: 480
        }
      }
    });

    expect(patched.notifications).toEqual({
      ...defaultDesktopSettings.notifications,
      autoRunFailure: false
    });
    expect(patched.layout).toEqual({
      ...defaultDesktopSettings.layout,
      leftSidebar: {
        collapsed: true,
        width: 360
      },
      rightSidebar: {
        collapsed: true,
        width: 480
      }
    });
  });

  it("defaults, normalizes, and merges the agent transport", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    await expect(store.read()).resolves.toMatchObject({
      execution: { tmuxMonitoring: true, agentTransport: "cli" }
    });

    const patched = await store.mergePatch({ execution: { agentTransport: "acp" } });
    expect(patched.execution).toEqual({ tmuxMonitoring: true, agentTransport: "acp" });

    await writeFile(
      store.settingsFile,
      JSON.stringify({ execution: { tmuxMonitoring: false, agentTransport: "invalid" } })
    );
    await expect(store.read()).resolves.toMatchObject({
      execution: { tmuxMonitoring: false, agentTransport: "cli" }
    });
  });

  it("normalizes and migrates legacy localStorage payloads", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    const migrated = await store.migrateLegacy(
      JSON.stringify({
        appearance: "dark",
        language: "en",
        notifications: {
          autoRunFailure: false
        },
        layout: {
          leftSidebar: {
            collapsed: true,
            width: 1
          },
          rightSidebar: {
            width: 99999
          }
        },
        agents: {
          codex: {
            enabled: true
          }
        },
        terminal: {
          defaultTerminalAppId: "ghostty"
        }
      })
    );

    expect(migrated).toMatchObject({
      appearance: "dark",
      language: "en",
      notifications: {
        autoRunFailure: false,
        graphExceptions: true
      },
      layout: {
        leftSidebar: {
          collapsed: true,
          width: 220
        },
        rightSidebar: {
          collapsed: false,
          width: 520
        }
      },
      agents: {
        codex: {
          enabled: true,
          fullAccess: false
        }
      }
    });
    expect(migrated).not.toHaveProperty("terminal");
    await expect(store.read()).resolves.toEqual(migrated);
  });

  it("applies the macOS window material default when legacy settings do not include a material preference", async () => {
    const home = await tempHome();
    const store = new DesktopSettingsStore({
      settingsFile: join(home, "config", "desktop-settings.json"),
      platform: "darwin"
    });

    const migrated = await store.migrateLegacy(JSON.stringify({ appearance: "dark" }));

    expect(migrated).toMatchObject({
      appearance: "dark",
      windowMaterial: {
        enabled: true
      }
    });
    await expect(store.read()).resolves.toEqual(migrated);
  });

  it("preserves an explicit legacy macOS window material opt-out", async () => {
    const home = await tempHome();
    const store = new DesktopSettingsStore({
      settingsFile: join(home, "config", "desktop-settings.json"),
      platform: "darwin"
    });

    const migrated = await store.migrateLegacy(
      JSON.stringify({
        windowMaterial: {
          enabled: false
        }
      })
    );

    expect(migrated.windowMaterial.enabled).toBe(false);
    await expect(store.read()).resolves.toEqual(migrated);
  });

  it("reports invalid JSON without overwriting the existing settings file", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));
    await writeFile(store.settingsFile, "{", "utf8").catch(async () => {
      await store.write(defaultDesktopSettings);
      await writeFile(store.settingsFile, "{", "utf8");
    });

    await expect(store.read()).rejects.toMatchObject({
      code: "invalid_json",
      settingsFile: store.settingsFile
    });
    await expect(store.mergePatch({ appearance: "dark" })).rejects.toBeInstanceOf(
      DesktopSettingsStoreError
    );
    await expect(readFile(store.settingsFile, "utf8")).resolves.toBe("{");
  });

  it("does not overwrite settings when legacy payload JSON is invalid", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));
    await store.write({
      ...defaultDesktopSettings,
      appearance: "light"
    });

    await expect(store.migrateLegacy("{")).rejects.toMatchObject({
      code: "invalid_legacy_payload",
      settingsFile: store.settingsFile
    });
    await expect(store.read()).resolves.toMatchObject({
      appearance: "light"
    });
  });
});
