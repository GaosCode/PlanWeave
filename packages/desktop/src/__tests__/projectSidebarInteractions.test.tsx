/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { ProjectSidebar } from "../renderer/sidebar/ProjectSidebar";
import { orderProjectsByPinnedIds } from "../renderer/settings";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function replaceNavigatorForTest(value: { language?: string; platform?: string; userAgent?: string }): () => void {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value
  });
  return () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator
    });
  };
}

describe("desktop renderer component interactions", () => {
  it("keeps sidebar tree labels visible while right-side controls collapse rows", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const project: DesktopProjectSummary = {
      projectId: "P-001",
      name: "frontend-example",
      rootPath: "/tmp/frontend-example",
      workspaceRoot: "/tmp/frontend-example",
      activeCanvasId: "default",
      taskCanvases: [
        {
          canvasId: "default",
          name: "frontend-example",
          taskCount: 2,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z"
        }
      ]
    };
    const graph: DesktopGraphViewModel = {
      projectId: project.projectId,
      projectTitle: project.name,
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: ["manual"],
      tasks: [
        {
          taskId: "T-TASK",
          title: "新",
          status: "ready",
          executor: null,
          executorLabel: "inherit",
          promptMarkdown: "# 新 Task",
          promptPreview: "新 Task",
          blocks: [],
          blockPreview: [],
          hiddenBlockRefs: [],
          overflowBlockCount: 0,
          exceptions: []
        },
        {
          taskId: "T-002",
          title: "新 Task",
          status: "ready",
          executor: null,
          executorLabel: "inherit",
          promptMarkdown: "# 新 Task",
          promptPreview: "新 Task",
          blocks: [],
          blockPreview: [],
          hiddenBlockRefs: [],
          overflowBlockCount: 0,
          exceptions: []
        }
      ],
      edges: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={project.projectId}
        graph={graph}
        handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRefreshProjects={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleRevealProject={vi.fn().mockResolvedValue(undefined)}
        handleTaskPanelSelect={vi.fn()}
        loadProject={vi.fn().mockResolvedValue(undefined)}
        notificationItems={[]}
        onToggleSidebar={vi.fn()}
        onTogglePinnedProject={vi.fn()}
        pinnedProjectIds={new Set()}
        projectRefreshing={false}
        projects={[project]}
        resetLayout={vi.fn().mockResolvedValue(undefined)}
        selectedProject={project}
        selectedCanvasId={null}
        selectedTaskPanelId={null}
        setActiveView={vi.fn()}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.getByRole("button", { name: "frontend-example" })).toBeVisible();
    expect(screen.getByRole("button", { name: /frontend-example\s*2/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "收起任务画布" })).toBeVisible();
    expect(screen.getByRole("button", { name: /新\s*T-TASK/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /新 Task\s*T-002/ })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "收起项目" }));

    expect(screen.getByRole("button", { name: "frontend-example" })).toBeVisible();
    expect(screen.getByRole("button", { name: "展开项目" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /frontend-example\s*2/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新\s*T-TASK/ })).not.toBeInTheDocument();
  });

  it("routes project refresh from the sidebar header", async () => {
    const project: DesktopProjectSummary = {
      projectId: "P-REFRESH",
      name: "refresh-example",
      rootPath: "/tmp/refresh-example",
      workspaceRoot: "/tmp/refresh-example",
      activeCanvasId: "default",
      taskCanvases: [
        {
          canvasId: "default",
          name: "refresh-example",
          taskCount: 0,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z"
        }
      ]
    };
    const handleRefreshProjects = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={project.projectId}
        graph={null}
        handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRefreshProjects={handleRefreshProjects}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleRevealProject={vi.fn().mockResolvedValue(undefined)}
        handleTaskPanelSelect={vi.fn()}
        loadProject={vi.fn().mockResolvedValue(undefined)}
        notificationItems={[]}
        onToggleSidebar={vi.fn()}
        onTogglePinnedProject={vi.fn()}
        pinnedProjectIds={new Set()}
        projectRefreshing={false}
        projects={[project]}
        resetLayout={vi.fn().mockResolvedValue(undefined)}
        selectedProject={project}
        selectedCanvasId="default"
        selectedTaskPanelId={null}
        setActiveView={vi.fn()}
        t={createTranslator("zh-CN")}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "刷新项目" }));

    expect(handleRefreshProjects).toHaveBeenCalledTimes(1);
  });

  it("uses platform-aware file manager labels in project context menus", async () => {
    const restoreNavigator = replaceNavigatorForTest({
      language: "zh-CN",
      platform: "Win32",
      userAgent: "Windows NT"
    });
    const project: DesktopProjectSummary = {
      projectId: "P-FILE-MANAGER",
      name: "windows-example",
      rootPath: "/tmp/windows-example",
      workspaceRoot: "/tmp/windows-example/.planweave",
      kind: "managed",
      sourceRoot: "/tmp/windows-example/source",
      activeCanvasId: "default",
      taskCanvases: [
        {
          canvasId: "default",
          name: "windows-example",
          taskCount: 0,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z"
        }
      ]
    };

    try {
      render(
        <ProjectSidebar
          activeView="graph"
          collapsed={false}
          expandedProjectId={project.projectId}
          graph={null}
          handleBindSourceRoot={vi.fn().mockResolvedValue(undefined)}
          handleCopyCanvasToNewProject={vi.fn().mockResolvedValue(null)}
          handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
          handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
          handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
          handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
          handleDropSourceRoot={vi.fn().mockResolvedValue(undefined)}
          handleOpenProject={vi.fn().mockResolvedValue(undefined)}
          handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
          handleRefreshProjects={vi.fn().mockResolvedValue(undefined)}
          handleRenameProject={vi.fn().mockResolvedValue(undefined)}
          handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
          handleRevealPlanWorkspace={vi.fn().mockResolvedValue(undefined)}
          handleRevealProject={vi.fn().mockResolvedValue(undefined)}
          handleRevealSourceRoot={vi.fn().mockResolvedValue(undefined)}
          handleRevealTaskCanvas={vi.fn().mockResolvedValue(undefined)}
          handleUnlinkSourceRoot={vi.fn().mockResolvedValue(undefined)}
          handleTaskPanelSelect={vi.fn()}
          loadProject={vi.fn().mockResolvedValue(undefined)}
          notificationItems={[]}
          onToggleSidebar={vi.fn()}
          onTogglePinnedProject={vi.fn()}
          pinnedProjectIds={new Set()}
          projectRefreshing={false}
          projects={[project]}
          resetLayout={vi.fn().mockResolvedValue(undefined)}
          selectedProject={project}
          selectedCanvasId="default"
          selectedTaskPanelId={null}
          setActiveView={vi.fn()}
          t={createTranslator("zh-CN")}
        />
      );

      fireEvent.contextMenu(screen.getByRole("button", { name: "windows-example" }));

      expect(await screen.findByText("在文件资源管理器中打开计划工作区")).toBeInTheDocument();
      expect(screen.getByText("在文件资源管理器中打开代码仓库")).toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
  });

  it("reveals a task canvas workspace from its context menu", async () => {
    const restoreNavigator = replaceNavigatorForTest({
      language: "zh-CN",
      platform: "MacIntel",
      userAgent: "Mac OS X"
    });
    const project: DesktopProjectSummary = {
      projectId: "P-OPEN",
      name: "open-example",
      rootPath: "/tmp/open-example",
      workspaceRoot: "/tmp/open-example",
      activeCanvasId: "canvas-main",
      taskCanvases: [
        {
          canvasId: "canvas-main",
          name: "Main canvas",
          taskCount: 0,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z"
        }
      ]
    };
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const handleRevealTaskCanvas = vi.fn().mockResolvedValue(undefined);

    try {
      render(
        <ProjectSidebar
          activeView="canvas-map"
          collapsed={false}
          expandedProjectId={project.projectId}
          graph={null}
          handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
          handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
          handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
          handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
          handleOpenProject={vi.fn().mockResolvedValue(undefined)}
          handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
          handleRefreshProjects={vi.fn().mockResolvedValue(undefined)}
          handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
          handleRevealProject={vi.fn().mockResolvedValue(undefined)}
          handleRevealTaskCanvas={handleRevealTaskCanvas}
          handleTaskPanelSelect={vi.fn()}
          loadProject={loadProject}
          notificationItems={[]}
          onToggleSidebar={vi.fn()}
          onTogglePinnedProject={vi.fn()}
          pinnedProjectIds={new Set()}
          projectRefreshing={false}
          projects={[project]}
          resetLayout={vi.fn().mockResolvedValue(undefined)}
          selectedProject={project}
          selectedCanvasId={null}
          selectedTaskPanelId={null}
          setActiveView={vi.fn()}
          t={createTranslator("zh-CN")}
        />
      );

      fireEvent.contextMenu(screen.getByRole("button", { name: /Main canvas\s*0/ }));
      await userEvent.click(await screen.findByText("在 Finder 中打开任务画布"));

      expect(handleRevealTaskCanvas).toHaveBeenCalledWith(project, "canvas-main");
      expect(loadProject).not.toHaveBeenCalled();
    } finally {
      restoreNavigator();
    }
  });

  it("orders pinned projects before unpinned projects without changing unpinned order", () => {
    const projects = [
      { projectId: "P-1", name: "first" },
      { projectId: "P-2", name: "second" },
      { projectId: "P-3", name: "third" }
    ];

    expect(orderProjectsByPinnedIds(projects, ["P-3", "P-1"]).map((project) => project.projectId)).toEqual(["P-3", "P-1", "P-2"]);
  });
});
