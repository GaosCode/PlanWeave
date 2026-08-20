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
import {
  agentEndpointPreferenceKey,
  clearAgentEndpointPreference,
  selectedAgentEndpointId,
  updateAgentEndpointPreferences
} from "../renderer/collaboration/agentEndpointPreferences";

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
      mcpTunnelDownloadsDir: join(home, "desktop", "mcp-tunnel", "downloads"),
      collaborationDir: join(home, "desktop", "collaboration"),
      collaborationProfilesFile: join(home, "desktop", "collaboration", "profiles.json"),
      collaborationCredentialsFile: join(home, "desktop", "collaboration", "credentials.json"),
      collaborationInvitationsFile: join(home, "desktop", "collaboration", "invitations.json"),
      collaborationContentReplicasFile: join(
        home,
        "desktop",
        "collaboration",
        "content-replicas.json"
      ),
      collaborationRuntimeStatusFile: join(home, "desktop", "collaboration", "runtime-status.json"),
      collaborationRuntimeAvailabilityFile: join(
        home,
        "desktop",
        "collaboration",
        "runtime-availability.json"
      ),
      localCollaborationScopesFile: join(home, "desktop", "collaboration", "local-scopes.json"),
      localCollaborationNetworkFile: join(home, "desktop", "collaboration", "local-network.json"),
      exportedServerDataIdentityFile: join(
        home,
        "desktop",
        "collaboration",
        "exported-server-data-identity.json"
      ),
      localCollaborationServerDir: join(home, "desktop", "local-collaboration-server"),
      operatorControlDir: join(home, "desktop", "operator-control"),
      operatorProfilesFile: join(home, "desktop", "operator-control", "profiles.json"),
      operatorCredentialsFile: join(home, "desktop", "operator-control", "credentials.json"),
      operatorLocalAgentHostsFile: join(
        home,
        "desktop",
        "operator-control",
        "local-agent-hosts.json"
      )
    });
  });

  it("returns default settings when the store file does not exist", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    await expect(store.read()).resolves.toEqual(defaultDesktopSettings);
    await expect(exists(store.settingsFile)).resolves.toBe(false);
    expect(defaultDesktopSettings.developerMode).toBe(false);
  });

  it("persists developer mode without changing other settings", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    await store.mergePatch({ developerMode: true });

    await expect(store.read()).resolves.toEqual({
      ...defaultDesktopSettings,
      developerMode: true
    });
  });

  it("persists concrete remote Agent Endpoint preferences separately from executors", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));
    const key = JSON.stringify(["/projects/demo", "canvas-main", "block", "T-001#B-001"]);

    await store.mergePatch({
      execution: {
        agentEndpointPreferences: {
          [key]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
        }
      }
    });

    await expect(store.read()).resolves.toMatchObject({
      execution: {
        agentEndpointPreferences: {
          [key]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
        }
      }
    });
  });

  it("migrates legacy remote Agent Endpoint preferences on read", async () => {
    const home = await tempHome();
    const settingsFile = join(home, "desktop-settings.json");
    const store = testStore(settingsFile);
    const key = JSON.stringify(["/projects/demo", "canvas-main", "block", "T-001#B-001"]);

    await writeFile(
      settingsFile,
      JSON.stringify({
        execution: {
          agentEndpointPreferences: {
            [key]: { executorName: "codex", remoteEndpointId: "endpoint-windows" }
          }
        }
      })
    );

    await expect(store.read()).resolves.toMatchObject({
      execution: {
        agentEndpointPreferences: {
          [key]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
        }
      }
    });
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

  it("persists collaboration scope disclosure settings", async () => {
    expect(defaultDesktopSettings.layout.collaborationScope).toEqual({
      collapsed: true,
      expandedProjectIds: []
    });

    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    await store.mergePatch({
      layout: {
        collaborationScope: {
          collapsed: true,
          expandedProjectIds: ["project-a", "project-a", "project-b"]
        }
      }
    });

    await expect(store.read()).resolves.toMatchObject({
      layout: {
        collaborationScope: {
          collapsed: true,
          expandedProjectIds: ["project-a", "project-b"]
        }
      }
    });
  });

  it("resets the superseded disclosure shape to the all-collapsed default", async () => {
    const home = await tempHome();
    const settingsFile = join(home, "desktop-settings.json");
    await writeFile(
      settingsFile,
      JSON.stringify({
        ...defaultDesktopSettings,
        layout: {
          ...defaultDesktopSettings.layout,
          collaborationScope: {
            collapsed: false,
            collapsedProjectIds: []
          }
        }
      })
    );

    await expect(testStore(settingsFile).read()).resolves.toMatchObject({
      layout: {
        collaborationScope: {
          collapsed: true,
          expandedProjectIds: []
        }
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
      execution: {
        tmuxMonitoring: true,
        agentTransport: "acp",
        agentHost: { kind: "native" }
      }
    });

    const patched = await store.mergePatch({ execution: { agentTransport: "cli" } });
    expect(patched.execution).toEqual({
      ...defaultDesktopSettings.execution,
      agentTransport: "cli"
    });

    await writeFile(
      store.settingsFile,
      JSON.stringify({ execution: { tmuxMonitoring: false, agentTransport: "invalid" } })
    );
    await expect(store.read()).resolves.toMatchObject({
      execution: {
        tmuxMonitoring: false,
        agentTransport: "acp",
        agentHost: { kind: "native" }
      }
    });
  });

  it("persists a trimmed WSL host and rejects incomplete host settings", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    const patched = await store.mergePatch({
      execution: { agentHost: { kind: "wsl", distribution: " Ubuntu " } }
    });
    expect(patched.execution.agentHost).toEqual({ kind: "wsl", distribution: "Ubuntu" });

    await writeFile(
      store.settingsFile,
      JSON.stringify({ execution: { agentHost: { kind: "wsl", distribution: "  " } } })
    );
    await expect(store.read()).resolves.toMatchObject({
      execution: { agentHost: { kind: "native" } }
    });
  });

  it("persists typed ACP defaults per agent and option id", async () => {
    const home = await tempHome();
    const store = testStore(join(home, "config", "desktop-settings.json"));

    const patched = await store.mergePatch({
      agents: {
        grok: {
          acp: {
            modeId: "grok-default",
            configOptions: {
              model: "grok-4",
              "fast-mode": true
            }
          }
        }
      }
    });

    expect(patched.agents.grok.acp).toEqual({
      modeId: "grok-default",
      configOptions: {
        model: "grok-4",
        "fast-mode": true
      }
    });
    await expect(store.read()).resolves.toMatchObject({ agents: { grok: patched.agents.grok } });
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

describe("Agent Endpoint preferences", () => {
  const key = agentEndpointPreferenceKey({
    projectRoot: "/workspace/project",
    canvasId: "default",
    scope: { kind: "block", blockRef: "T-001#B-001" }
  });
  const localCodex = {
    id: "local:codex",
    source: "local" as const,
    executorName: "codex",
    displayName: "Codex",
    locationName: "",
    available: true,
    unavailableReason: null,
    capabilities: ["acp.codex"],
    localExecutorName: "codex"
  };
  const remoteWindows = {
    id: "remote:endpoint-windows",
    source: "remote" as const,
    executorName: "codex",
    displayName: "Codex",
    locationName: "LINANIML",
    available: true,
    unavailableReason: null,
    capabilities: ["acp.codex"],
    remoteEndpointId: "endpoint-windows"
  };

  it("persists only the concrete remote Endpoint beside the logical executor", () => {
    const preferences = updateAgentEndpointPreferences({
      current: {},
      key,
      endpoint: remoteWindows
    });

    expect(preferences[key]).toEqual({
      kind: "remote",
      remoteEndpointId: "endpoint-windows"
    });
    expect(
      selectedAgentEndpointId({
        executorName: "codex",
        preference: preferences[key],
        endpoints: [localCodex, remoteWindows]
      })
    ).toEqual({ kind: "endpoint", id: "remote:endpoint-windows" });
  });

  it("records an explicit local Endpoint instead of deleting the preference", () => {
    const preferences = updateAgentEndpointPreferences({
      current: { [key]: { kind: "remote", remoteEndpointId: "endpoint-windows" } },
      key,
      endpoint: localCodex
    });

    expect(preferences[key]).toEqual({
      kind: "local",
      executorName: "codex"
    });
    expect(
      selectedAgentEndpointId({
        executorName: "codex",
        preference: preferences[key],
        endpoints: [localCodex, remoteWindows]
      })
    ).toEqual({ kind: "endpoint", id: "local:codex" });
  });

  it("defaults to local when preference was never set", () => {
    expect(
      selectedAgentEndpointId({
        executorName: "codex",
        preference: undefined,
        endpoints: [localCodex, remoteWindows]
      })
    ).toEqual({ kind: "default_local", id: "local:codex" });
  });

  it("clears an explicit Block preference when the Block returns to inheritance", () => {
    expect(
      clearAgentEndpointPreference(
        { [key]: { kind: "remote", remoteEndpointId: "endpoint-windows" } },
        key
      )
    ).toEqual({});
  });
});
