/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../renderer/App";
import { createTranslator } from "../renderer/i18n";
import { available, downloaded, updateBridge } from "./helpers/appUpdateFixture";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const settingsRouteModule = vi.hoisted(() => {
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    ready,
    resolve() {
      if (!resolveReady) {
        throw new Error("Settings route module resolver is unavailable.");
      }
      resolveReady();
    }
  };
});
const useAppViewHistory = vi.hoisted(() => vi.fn());
const useDesktopSettingsBridge = vi.hoisted(() => vi.fn());
const useDesktopSettingsEffects = vi.hoisted(() => vi.fn());
const useDetectedAgents = vi.hoisted(() => vi.fn());
const useProjectWorkspace = vi.hoisted(() => vi.fn());
const useResizableSidebarLayout = vi.hoisted(() => vi.fn());
const useRuntimeTools = vi.hoisted(() => vi.fn());
const bridgeMock = vi.hoisted(() => ({
  readGlobalPrompt: vi.fn().mockResolvedValue(""),
  updateGlobalPrompt: vi.fn(async (markdown: string) => markdown)
}));

vi.mock("../renderer/AppSettingsRoute", async () => {
  await settingsRouteModule.ready;
  return {
    AppSettingsRoute: () => <div data-testid="settings-route">Settings route</div>
  };
});
vi.mock("../renderer/bridge", () => ({ bridge: bridgeMock }));
vi.mock("../renderer/rendererPlatform", () => ({ detectRendererPlatform: () => "darwin" }));
vi.mock("../renderer/hooks/useAppViewHistory", () => ({ useAppViewHistory }));
vi.mock("../renderer/hooks/useDesktopSettingsBridge", () => ({ useDesktopSettingsBridge }));
vi.mock("../renderer/hooks/useDesktopSettingsEffects", () => ({ useDesktopSettingsEffects }));
vi.mock("../renderer/hooks/useDetectedAgents", () => ({ useDetectedAgents }));
vi.mock("../renderer/hooks/useResizableSidebarLayout", () => ({ useResizableSidebarLayout }));
vi.mock("../renderer/hooks/useRuntimeTools", () => ({ useRuntimeTools }));
vi.mock("../renderer/ProjectWorkspaceProvider", () => ({
  ProjectWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  useProjectWorkspace
}));
vi.mock("../renderer/sidebar/ProjectSidebar", () => ({ ProjectSidebar: () => null }));
vi.mock("../renderer/views/WorkspaceTabs", () => ({ WorkspaceTabs: () => null }));
vi.mock("../renderer/AppSidebars", () => ({
  CollapsedSidebarControls: () => null,
  RightPaletteSidebar: () => null
}));

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.clearAllMocks();
});

const en = createTranslator("en");

describe("App settings lazy route", () => {
  it("keeps update overlays available during settings loading and preserves a dismissal across navigation", async () => {
    const user = userEvent.setup();
    const bridge = updateBridge(available);
    useDesktopSettingsBridge.mockReturnValue({
      settings: { language: "en" },
      updateLayoutSettings: vi.fn(),
      updateSettings: vi.fn(),
      updateSettingsAndWait: vi.fn().mockResolvedValue(undefined)
    });
    useAppViewHistory.mockReturnValue(["graph", vi.fn(), { historyError: null }]);
    useDetectedAgents.mockReturnValue({
      agentDetectionRefreshing: false,
      agentDetections: [],
      refreshAgentDetections: vi.fn().mockResolvedValue(undefined)
    });
    useRuntimeTools.mockReturnValue({
      refreshRuntimeTools: vi.fn().mockResolvedValue(undefined),
      runtimeTools: {}
    });
    useResizableSidebarLayout.mockReturnValue({
      leftSidebarCollapsed: false,
      leftSidebarWidth: 240,
      rightSidebarCollapsed: false,
      rightSidebarWidth: 320,
      setLeftSidebarCollapsedPreference: vi.fn(),
      setRightSidebarCollapsedPreference: vi.fn(),
      startSidebarResize: vi.fn()
    });
    useProjectWorkspace.mockReturnValue({
      settingsRouteProps: {},
      shell: { activeView: "task-workspace" }
    });

    const app = render(<App />);
    const toast = await screen.findByRole("complementary");
    await user.click(within(toast).getByRole("button", { name: "Close" }));

    useAppViewHistory.mockReturnValue(["settings", vi.fn(), { historyError: null }]);
    await act(async () => app.rerender(<App />));
    expect(screen.getByText(en("loadingProject"))).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    act(() => bridge.publish(downloaded));
    expect(within(screen.getByRole("complementary")).getByText("Update downloaded")).toBeVisible();

    settingsRouteModule.resolve();

    expect(await screen.findByTestId("settings-route")).toBeInTheDocument();
  });
});
