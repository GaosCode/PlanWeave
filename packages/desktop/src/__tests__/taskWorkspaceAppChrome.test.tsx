/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings } from "../renderer/settings";
import { AppWorkspaceChrome } from "../renderer/App";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const useProjectWorkspace = vi.hoisted(() => vi.fn());

vi.mock("../renderer/ProjectWorkspaceProvider", () => ({
  ProjectWorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
  useProjectWorkspace
}));
vi.mock("../renderer/sidebar/ProjectSidebar", () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar">Project sidebar</div>
}));
vi.mock("../renderer/views/WorkspaceTabs", () => ({
  WorkspaceTabs: () => <div data-testid="workspace-tabs">Workspace tabs</div>
}));
vi.mock("../renderer/AppSidebars", () => ({
  CollapsedSidebarControls: () => <div data-testid="collapsed-sidebar-controls" />,
  RightPaletteSidebar: () => <div data-testid="right-palette-sidebar" />
}));

afterEach(cleanupRendererTestEnvironment);

function renderChrome(activeView: "graph" | "task-workspace") {
  const setLeftSidebarCollapsedPreference = vi.fn();
  const setRightSidebarCollapsedPreference = vi.fn();
  useProjectWorkspace.mockReturnValue({
    palette: {
      addPaletteComponent: vi.fn(),
      handlePaletteDragStart: vi.fn()
    },
    projectSidebar: {},
    shell: { activeView, t: (key: string) => key }
  });
  render(
    <AppWorkspaceChrome
      leftSidebarCollapsed={false}
      leftSidebarWidth={280}
      rightSidebarCollapsed={false}
      rightSidebarWidth={300}
      setLeftSidebarCollapsedPreference={setLeftSidebarCollapsedPreference}
      setRightSidebarCollapsedPreference={setRightSidebarCollapsedPreference}
      settings={defaultDesktopSettings}
      startSidebarResize={vi.fn()}
    />
  );
  return { setLeftSidebarCollapsedPreference, setRightSidebarCollapsedPreference };
}

describe("Task Workspace app chrome", () => {
  it("hides project/palette sidebars without mutating global sidebar preferences", () => {
    const setters = renderChrome("task-workspace");

    expect(screen.getByTestId("workspace-tabs")).toBeInTheDocument();
    expect(screen.queryByTestId("project-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-palette-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("collapsed-sidebar-controls")).not.toBeInTheDocument();
    expect(setters.setLeftSidebarCollapsedPreference).not.toHaveBeenCalled();
    expect(setters.setRightSidebarCollapsedPreference).not.toHaveBeenCalled();
  });

  it("keeps existing Graph chrome behavior unchanged", () => {
    renderChrome("graph");

    expect(screen.getByTestId("project-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("right-palette-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("collapsed-sidebar-controls")).toBeInTheDocument();
  });
});
