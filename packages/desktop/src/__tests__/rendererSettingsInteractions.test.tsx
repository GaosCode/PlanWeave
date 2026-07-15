/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "../renderer/components/AgentSettingsPanel";
import { SettingsView } from "../renderer/views/SettingsView";
import { createTranslator } from "../renderer/i18n";
import {
  defaultDesktopSettings,
  normalizeLegacyDesktopSettingsPayload
} from "../renderer/settings";
import type { DesktopUiSettings } from "../renderer/types";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";

const settings: DesktopUiSettings = {
  runtimePath: "/tmp/project",
  defaultExecutor: "",
  appearance: "system",
  reducedMotion: false,
  language: "en",
  pinnedProjectIds: [],
  readNotificationIds: [],
  notifications: {
    autoRunFailure: true,
    graphExceptions: true,
    dirtyPrompts: true,
    fileSyncConflict: true
  },
  palette: {
    visible: {
      task: true,
      implementation: true,
      review: true
    },
    defaultBlockSet: ["implementation", "review"],
    dragHint: true
  },
  review: {
    autoAppendReviewBlock: true,
    feedbackLoop: true,
    pipelineEnabled: true,
    strictReview: true
  },
  execution: {
    tmuxMonitoring: true,
    agentTransport: "cli"
  },
  windowMaterial: {
    enabled: false
  },
  layout: {
    leftSidebar: {
      collapsed: false,
      width: 280
    },
    rightSidebar: {
      collapsed: false,
      width: 300
    },
    autoRunControl: {
      position: null
    }
  },
  agents: {
    codex: {
      enabled: false,
      fullAccess: false,
      acp: { modeId: null, configOptions: {} }
    },
    "claude-code": {
      enabled: false,
      fullAccess: false,
      acp: { modeId: null, configOptions: {} }
    },
    opencode: {
      enabled: false,
      fullAccess: false,
      acp: { modeId: null, configOptions: {} }
    },
    pi: {
      enabled: false,
      fullAccess: false,
      acp: { modeId: null, configOptions: {} }
    }
  }
};

const projectA: DesktopProjectSummary = {
  projectId: "project-a",
  name: "Project A",
  rootPath: "/tmp/project-a",
  workspaceRoot: "/tmp/.planweave/project-a",
  activeCanvasId: "default",
  taskCanvases: []
};

const projectB: DesktopProjectSummary = {
  projectId: "project-b",
  name: "Project B",
  rootPath: "/tmp/project-b",
  workspaceRoot: "/tmp/.planweave/project-b",
  activeCanvasId: "default",
  taskCanvases: []
};

function stubLayoutApis() {
  class ResizeObserverMock {
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false)
  });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
}

function stubLocalStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    })
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage
  });
}

beforeEach(() => {
  stubLocalStorage();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "localStorage");
  Reflect.deleteProperty(window, "planweaveWindow");
  Reflect.deleteProperty(window, "planweaveMcpTunnel");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop renderer settings interactions", () => {
  it("defaults new task cards to implementation blocks only", () => {
    expect(defaultDesktopSettings.palette.defaultBlockSet).toEqual(["implementation"]);
    expect(defaultDesktopSettings.layout).toEqual({
      leftSidebar: {
        collapsed: false,
        width: 280
      },
      rightSidebar: {
        collapsed: false,
        width: 300
      },
      autoRunControl: {
        position: null
      }
    });
  });

  it("keeps the settings content inside a bounded scroll area", () => {
    stubLayoutApis();

    const { container } = render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={vi.fn()}
      />
    );

    expect(container.querySelector('[data-slot="scroll-area"]')).toHaveClass("min-h-0", "flex-1");
    expect(container.querySelector('[data-slot="scroll-area-viewport"]')).toHaveClass("h-full");
  });

  it("normalizes invalid legacy migration appearance and window material settings", () => {
    expect(
      normalizeLegacyDesktopSettingsPayload(
        JSON.stringify({
          appearance: "foo",
          reducedMotion: "yes",
          language: "en",
          windowMaterial: {
            enabled: "yes"
          }
        })
      )
    ).toMatchObject({
      appearance: "system",
      reducedMotion: false,
      language: "en",
      windowMaterial: {
        enabled: false
      }
    });
  });

  it("keeps valid legacy migration appearance and window material settings", () => {
    expect(
      normalizeLegacyDesktopSettingsPayload({
        appearance: "dark",
        reducedMotion: true,
        windowMaterial: {
          enabled: true
        }
      })
    ).toMatchObject({
      appearance: "dark",
      reducedMotion: true,
      windowMaterial: {
        enabled: true
      }
    });
  });

  it("ignores legacy renderer terminal preferences from migration payloads", () => {
    const loadedSettings = normalizeLegacyDesktopSettingsPayload({
      appearance: "dark",
      terminal: {
        defaultTerminalAppId: "ghostty"
      }
    });
    expect(loadedSettings).toMatchObject({
      appearance: "dark"
    });
    expect(loadedSettings).not.toHaveProperty("terminal");
  });

  it("uses default layout settings when legacy migration settings predate layout preferences", () => {
    expect(
      normalizeLegacyDesktopSettingsPayload({
        appearance: "dark",
        notifications: {
          autoRunFailure: false
        }
      })
    ).toMatchObject({
      appearance: "dark",
      notifications: {
        autoRunFailure: false
      },
      layout: defaultDesktopSettings.layout
    });
  });

  it("normalizes legacy migration layout widths and ignores invalid floating control coordinates", () => {
    const migrated = normalizeLegacyDesktopSettingsPayload({
      layout: {
        leftSidebar: {
          collapsed: "yes",
          width: -1
        },
        rightSidebar: {
          collapsed: true,
          width: 99999
        },
        autoRunControl: {
          position: {
            left: -20,
            top: "30"
          }
        }
      }
    });

    expect(migrated.layout).toEqual({
      ...defaultDesktopSettings.layout,
      rightSidebar: {
        collapsed: true,
        width: 520
      }
    });
  });

  it("clamps positive legacy migration layout widths below sidebar minimums", () => {
    expect(
      normalizeLegacyDesktopSettingsPayload({
        notifications: {
          dirtyPrompts: false
        },
        layout: {
          leftSidebar: {
            collapsed: true,
            width: 1
          },
          rightSidebar: {
            collapsed: false,
            width: 2
          }
        }
      })
    ).toMatchObject({
      notifications: {
        dirtyPrompts: false,
        autoRunFailure: true
      },
      layout: {
        leftSidebar: {
          collapsed: true,
          width: 220
        },
        rightSidebar: {
          collapsed: false,
          width: 240
        },
        autoRunControl: defaultDesktopSettings.layout.autoRunControl
      }
    });
  });

  it("deep merges valid legacy migration layout preferences with other settings", () => {
    expect(
      normalizeLegacyDesktopSettingsPayload({
        notifications: {
          autoRunFailure: false
        },
        palette: {
          visible: {
            review: false
          },
          defaultBlockSet: ["review"],
          dragHint: false
        },
        agents: {
          codex: {
            enabled: true
          }
        },
        layout: {
          leftSidebar: {
            collapsed: true,
            width: 360
          },
          autoRunControl: {
            position: {
              left: 48,
              top: 96
            }
          }
        }
      })
    ).toMatchObject({
      notifications: {
        autoRunFailure: false,
        graphExceptions: true
      },
      palette: {
        visible: {
          task: true,
          implementation: true,
          review: false
        },
        defaultBlockSet: ["review"],
        dragHint: false
      },
      agents: {
        codex: {
          enabled: true,
          fullAccess: false
        }
      },
      layout: {
        leftSidebar: {
          collapsed: true,
          width: 360
        },
        rightSidebar: defaultDesktopSettings.layout.rightSidebar,
        autoRunControl: {
          position: {
            left: 48,
            top: 96
          }
        }
      }
    });
  });

  it("renders the interface language setting as a dropdown select", async () => {
    stubLayoutApis();
    const updateSettings = vi.fn();

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="zh-CN"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={{ ...settings, language: "zh-CN" }}
        t={createTranslator("zh-CN")}
        updateSettings={updateSettings}
      />
    );

    expect(screen.queryByRole("switch", { name: "语言" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "语言" }));
    await userEvent.click(screen.getByRole("option", { name: "English" }));

    expect(updateSettings).toHaveBeenCalledWith({ language: "en" });
  });

  it("opens the MCP Tunnel settings section without persisting API keys", async () => {
    stubLayoutApis();
    Object.defineProperty(window, "planweaveMcpTunnel", {
      configurable: true,
      value: {
        getMcpTunnelStatus: vi.fn().mockResolvedValue({
          binary: {
            path: null,
            available: false,
            source: null,
            assetName: null,
            assetSha256: null,
            sha256: null,
            version: null,
            verified: false,
            error: "Tunnel client binary path is not configured."
          },
          download: {
            phase: "idle",
            assetName: null,
            error: null
          },
          localMcp: {
            phase: "stopped",
            endpoint: null,
            host: "127.0.0.1",
            port: 8787,
            pid: null,
            planweaveHome: "/Users/example/.planweave",
            planweaveHomeFromEnv: false,
            healthy: false,
            error: null
          },
          tunnel: {
            phase: "running",
            profile: "planweave-local-http",
            tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
            pid: 123,
            healthUrl: "http://127.0.0.1:58902",
            ready: true,
            error: null
          },
          config: {
            tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
            hasRuntimeApiKey: true,
            runtimeApiKeyPersistence: "persisted",
            runtimeApiKeyStorage: "available",
            autoStart: true
          },
          downloadUrl: "https://github.com/openai/tunnel-client/releases/latest",
          updatedAt: "2026-06-19T00:00:00.000Z"
        }),
        onMcpTunnelChanged: vi.fn(() => () => undefined),
        downloadTunnelClient: vi.fn(),
        setTunnelClientPath: vi.fn(),
        setTunnelAutoStart: vi.fn().mockResolvedValue(undefined),
        startLocalMcp: vi.fn(),
        stopLocalMcp: vi.fn(),
        startTunnel: vi.fn(),
        stopTunnel: vi.fn()
      }
    });

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("settings-nav-mcp"));

    expect(screen.getByTestId("settings-section-mcp")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MCP Tunnel" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Tunnel ID" })).toHaveValue(
        "tunnel_0123456789abcdef0123456789abcdef"
      )
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Runtime API key")).toHaveAttribute("placeholder", "Saved key")
    );
    expect(
      screen.getByText("A saved runtime API key will be used if this field is left blank.")
    ).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("Ready: http://127.0.0.1:58902")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Start tunnel when PlanWeave opens" })).toBeChecked();
    expect(screen.getByRole("link", { name: "Open release page" })).toHaveAttribute(
      "href",
      "https://github.com/openai/tunnel-client/releases/latest"
    );
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Runtime API key")
    );
  });

  it("reports MCP tunnel status load failures instead of leaving the settings UI idle", async () => {
    stubLayoutApis();
    const setError = vi.fn();
    Object.defineProperty(window, "planweaveMcpTunnel", {
      configurable: true,
      value: {
        getMcpTunnelStatus: vi
          .fn()
          .mockRejectedValue(new Error("Invalid MCP tunnel config JSON at /tmp/config.json")),
        onMcpTunnelChanged: vi.fn(() => () => undefined),
        downloadTunnelClient: vi.fn(),
        setTunnelClientPath: vi.fn(),
        setTunnelAutoStart: vi.fn(),
        startLocalMcp: vi.fn(),
        stopLocalMcp: vi.fn(),
        startTunnel: vi.fn(),
        stopTunnel: vi.fn()
      }
    });

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        setError={setError}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("settings-nav-mcp"));

    await waitFor(() =>
      expect(setError).toHaveBeenCalledWith("Invalid MCP tunnel config JSON at /tmp/config.json")
    );
  });

  it("disables MCP tunnel auto-start when the runtime API key is session-only", async () => {
    stubLayoutApis();
    Object.defineProperty(window, "planweaveMcpTunnel", {
      configurable: true,
      value: {
        getMcpTunnelStatus: vi.fn().mockResolvedValue({
          binary: {
            path: null,
            available: false,
            source: null,
            assetName: null,
            assetSha256: null,
            sha256: null,
            version: null,
            verified: false,
            error: "Tunnel client binary path is not configured."
          },
          download: {
            phase: "idle",
            assetName: null,
            error: null
          },
          localMcp: {
            phase: "stopped",
            endpoint: null,
            host: "127.0.0.1",
            port: 8787,
            pid: null,
            planweaveHome: "/Users/example/.planweave",
            planweaveHomeFromEnv: false,
            healthy: false,
            error: null
          },
          tunnel: {
            phase: "stopped",
            profile: "planweave-local-http",
            tunnelId: null,
            pid: null,
            healthUrl: null,
            ready: false,
            error: null
          },
          config: {
            tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
            hasRuntimeApiKey: true,
            runtimeApiKeyPersistence: "session-only",
            runtimeApiKeyStorage: "unavailable",
            autoStart: false
          },
          downloadUrl: "https://github.com/openai/tunnel-client/releases/latest",
          updatedAt: "2026-06-19T00:00:00.000Z"
        }),
        onMcpTunnelChanged: vi.fn(() => () => undefined),
        downloadTunnelClient: vi.fn(),
        setTunnelClientPath: vi.fn(),
        setTunnelAutoStart: vi.fn(),
        startLocalMcp: vi.fn(),
        stopLocalMcp: vi.fn(),
        startTunnel: vi.fn(),
        stopTunnel: vi.fn()
      }
    });

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("settings-nav-mcp"));

    expect(
      await screen.findByText("Stored only for this PlanWeave process. It will not be saved.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Auto-start requires a runtime API key that can be restored from secure storage."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Start tunnel when PlanWeave opens" })
    ).toBeDisabled();
    expect(screen.getByLabelText("Runtime API key")).not.toHaveAttribute(
      "placeholder",
      "Saved key"
    );
  });

  it("lets users choose system, light, and dark appearance modes", async () => {
    stubLayoutApis();
    const updateSettings = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    expect(screen.queryByRole("switch", { name: "Appearance mode" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Appearance mode" }));
    await user.click(screen.getByRole("option", { name: "Light" }));
    expect(updateSettings).toHaveBeenCalledWith({ appearance: "light" });

    rerender(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={{ ...settings, appearance: "light" }}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Appearance mode" }));
    await user.click(screen.getByRole("option", { name: "Dark" }));
    expect(updateSettings).toHaveBeenCalledWith({ appearance: "dark" });

    rerender(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={{ ...settings, appearance: "dark" }}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Appearance mode" }));
    await user.click(screen.getByRole("option", { name: "System" }));
    expect(updateSettings).toHaveBeenCalledWith({ appearance: "system" });
  });

  it("lets users toggle enhanced window material", async () => {
    stubLayoutApis();
    const updateSettings = vi.fn();

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    await userEvent.click(screen.getByRole("switch", { name: "Enhanced window material" }));

    expect(updateSettings).toHaveBeenCalledWith({ windowMaterial: { enabled: true } });
  });

  it("disables enhanced window material when native material is unsupported", async () => {
    stubLayoutApis();
    const updateSettings = vi.fn();
    Object.defineProperty(window, "planweaveWindow", {
      configurable: true,
      value: {
        getWindowMaterialCapabilities: vi.fn().mockResolvedValue({
          platform: "linux",
          reason: "unsupported-platform",
          supported: false
        }),
        setWindowMaterial: vi.fn()
      }
    });

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={{ ...settings, windowMaterial: { enabled: true } }}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    const switchControl = screen.getByRole("switch", { name: "Enhanced window material" });

    await waitFor(() => expect(switchControl).toBeDisabled());
    expect(switchControl).not.toBeChecked();
    expect(
      screen.getByText(
        "Native window material is not supported on this platform, so PlanWeave will keep solid surfaces."
      )
    ).toBeInTheDocument();
  });

  it("lets users toggle reduced motion", async () => {
    stubLayoutApis();
    const updateSettings = vi.fn();

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    await userEvent.click(screen.getByRole("switch", { name: "Reduced motion" }));

    expect(updateSettings).toHaveBeenCalledWith({ reducedMotion: true });
  });

  it("only enables tmux monitoring when the runtime tool is detected", async () => {
    stubLayoutApis();
    const refreshRuntimeTools = vi.fn().mockResolvedValue(undefined);
    const updateSettings = vi.fn();

    const { rerender } = render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={refreshRuntimeTools}
        runtimeTools={{ tmux: { available: false, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    const unavailableSwitch = screen.getByRole("switch", { name: "tmux monitoring" });
    expect(unavailableSwitch).toBeDisabled();
    expect(unavailableSwitch).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Refresh tools" }));
    expect(refreshRuntimeTools).toHaveBeenCalledTimes(1);

    rerender(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={refreshRuntimeTools}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={{ ...settings, execution: { tmuxMonitoring: false } }}
        t={createTranslator("en")}
        updateSettings={updateSettings}
      />
    );

    await userEvent.click(screen.getByRole("switch", { name: "tmux monitoring" }));
    expect(updateSettings).toHaveBeenCalledWith({ execution: { tmuxMonitoring: true } });
  });

  it("lets the current project disable inherited global prompt policy", async () => {
    stubLayoutApis();
    const updateProjectPromptPolicy = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        projectPromptPolicy={{ includeGlobalPrompt: true }}
        selectedProject={projectA}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateProjectPromptPolicy={updateProjectPromptPolicy}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("switch", { name: "Inherit global prompt" }));

    expect(updateProjectPromptPolicy).toHaveBeenCalledWith({ includeGlobalPrompt: false });
  });

  it("switches the project whose prompt policy is edited", async () => {
    stubLayoutApis();
    const loadProject = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        projectPromptPolicy={{ includeGlobalPrompt: true }}
        projects={[projectA, projectB]}
        selectedProject={projectA}
        loadProject={loadProject}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateProjectPromptPolicy={vi.fn().mockResolvedValue(undefined)}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
    await userEvent.click(screen.getByRole("option", { name: "Project B" }));

    expect(loadProject).toHaveBeenCalledWith(projectB);
  });

  it("shows and saves the current project canvas prompt", async () => {
    stubLayoutApis();
    const updateProjectPrompt = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        projectPromptMarkdown={"# Project/Canvas Prompt\n\nVisible policy."}
        projectPromptPolicy={{ includeGlobalPrompt: true }}
        selectedProject={projectA}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateProjectPrompt={updateProjectPrompt}
        updateProjectPromptPolicy={vi.fn().mockResolvedValue(undefined)}
        updateSettings={vi.fn()}
      />
    );

    const editor = screen.getByRole("textbox", { name: "Project/Canvas Prompt" });
    expect(editor).toHaveValue("# Project/Canvas Prompt\n\nVisible policy.");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Updated project policy.");
    await userEvent.click(screen.getByRole("button", { name: "Save Project/Canvas Prompt" }));

    expect(updateProjectPrompt).toHaveBeenCalledWith("Updated project policy.");
  });

  it("keeps project prompt editable while prompt markdown is loading", async () => {
    stubLayoutApis();
    const updateProjectPrompt = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        language="en"
        projectPromptMarkdown={null}
        projectPromptPolicy={{ includeGlobalPrompt: true }}
        selectedProject={projectA}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        refreshRuntimeTools={vi.fn().mockResolvedValue(undefined)}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[projectA]}
        setActiveView={vi.fn()}
        settings={settings}
        t={createTranslator("en")}
        updateProjectPrompt={updateProjectPrompt}
        updateProjectPromptPolicy={vi.fn().mockResolvedValue(undefined)}
        updateSettings={vi.fn()}
      />
    );

    const editor = screen.getByRole("textbox", { name: "Project/Canvas Prompt" });
    expect(editor).toBeEnabled();
    await userEvent.type(editor, "Policy while graph is unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Save Project/Canvas Prompt" }));

    expect(updateProjectPrompt).toHaveBeenCalledWith("Policy while graph is unavailable.");
  });

  it("disables agent switches when the CLI is not detected", async () => {
    const refreshAgentDetections = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentSettingsPanel
        agentDetectionRefreshing={false}
        agents={[
          {
            runnerKind: "cli",
            kind: "codex",
            name: "Codex",
            command: "codex",
            versionArgs: ["--version"],
            execArgs: ["exec", "-"],
            fullAccessArgs: ["exec", "--sandbox", "danger-full-access", "-"],
            installed: false,
            version: null,
            unavailableReason: "not found"
          }
        ]}
        labels={{
          agentDetected: "CLI detected",
          agentEnableDescription: "Run {command}",
          agentFullAccess: "Full access",
          agentFullAccessDescription: "Run {command}",
          agentInstallStatus: "Local agent installation status",
          agentMissing: "CLI not detected",
          agentRefresh: "Refresh",
          agentRefreshing: "Refreshing",
          acpModelManaged: "Model is managed by the agent configuration.",
          acpPermissionsManaged: "Permissions are managed by the agent configuration.",
          acpSessionMode: "Session mode",
          acpNotProbed: "Run executor preflight to discover ACP options.",
          acpProbing: "Testing..."
        }}
        refreshAgentDetections={refreshAgentDetections}
        settings={settings}
        t={createTranslator("en")}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshAgentDetections).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("switch", { name: "Codex" })).toBeDisabled();
    expect(screen.queryByText("Full access")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Codex options" }));
    expect(screen.getByRole("switch", { name: "Full access" })).toBeDisabled();
  });

  it("expands ACP agents and reports an unavailable desktop bridge inline", async () => {
    render(
      <AgentSettingsPanel
        agentDetectionRefreshing={false}
        agents={[
          {
            runnerKind: "acp",
            kind: "codex",
            name: "Codex",
            command: "codex-acp",
            versionArgs: ["--version"],
            execArgs: [],
            fullAccessArgs: [],
            installed: true,
            version: "1.0.0",
            unavailableReason: null
          }
        ]}
        labels={{
          agentDetected: "Agent detected",
          agentEnableDescription: "Run {command}",
          agentFullAccess: "Full access",
          agentFullAccessDescription: "Run {command}",
          agentInstallStatus: "Agent installation status",
          agentMissing: "Agent not detected",
          agentRefresh: "Refresh",
          agentRefreshing: "Refreshing",
          acpModelManaged: "Model is managed by the agent configuration.",
          acpPermissionsManaged: "Permissions are managed by the agent configuration.",
          acpSessionMode: "Session mode",
          acpNotProbed: "Run executor preflight to discover ACP options.",
          acpProbing: "Testing..."
        }}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={{ ...settings, execution: { ...settings.execution, agentTransport: "acp" } }}
        t={createTranslator("en")}
        updateSettings={vi.fn()}
      />
    );

    expect(screen.getByRole("switch", { name: "Codex" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Codex options" }));
    expect(screen.getByText("Desktop bridge unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("Full access")).not.toBeInTheDocument();
  });
});
