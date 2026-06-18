/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "../renderer/components/AgentSettingsPanel";
import { SettingsView } from "../renderer/views/SettingsView";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings, desktopSettingsKey, loadDesktopSettings } from "../renderer/settings";
import type { DesktopUiSettings } from "../renderer/types";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";

const settings: DesktopUiSettings = {
  runtimePath: "/tmp/project",
  defaultExecutor: "",
  appearance: "system",
  reducedMotion: false,
  language: "en",
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
    tmuxMonitoring: true
  },
  windowMaterial: {
    enabled: false
  },
  agents: {
    codex: {
      enabled: false,
      fullAccess: false
    },
    "claude-code": {
      enabled: false,
      fullAccess: false
    },
    opencode: {
      enabled: false,
      fullAccess: false
    },
    pi: {
      enabled: false,
      fullAccess: false
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
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: vi.fn(() => false) });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop renderer settings interactions", () => {
  it("defaults new task cards to implementation blocks only", () => {
    expect(defaultDesktopSettings.palette.defaultBlockSet).toEqual(["implementation"]);
  });

  it("falls back to defaults for invalid stored appearance and window material settings", () => {
    window.localStorage.setItem(
      desktopSettingsKey,
      JSON.stringify({
        appearance: "foo",
        reducedMotion: "yes",
        language: "en",
        windowMaterial: {
          enabled: "yes"
        }
      })
    );

    expect(loadDesktopSettings()).toMatchObject({
      appearance: "system",
      reducedMotion: false,
      language: "en",
      windowMaterial: {
        enabled: false
      }
    });
  });

  it("keeps valid stored appearance and window material settings", () => {
    window.localStorage.setItem(
      desktopSettingsKey,
      JSON.stringify({
        appearance: "dark",
        reducedMotion: true,
        windowMaterial: {
          enabled: true
        }
      })
    );

    expect(loadDesktopSettings()).toMatchObject({
      appearance: "dark",
      reducedMotion: true,
      windowMaterial: {
        enabled: true
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
    expect(screen.getByText("Native window material is not supported on this platform, so PlanWeave will keep solid surfaces.")).toBeInTheDocument();
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
          agentRefreshing: "Refreshing"
        }}
        refreshAgentDetections={refreshAgentDetections}
        settings={settings}
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
});
