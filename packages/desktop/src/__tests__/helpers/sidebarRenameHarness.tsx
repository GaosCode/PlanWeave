import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useEffect, useRef, useState } from "react";
import { expect, vi } from "vitest";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { useDesktopProject } from "../../renderer/hooks/useDesktopProject";
import { useDesktopProjectSession } from "../../renderer/hooks/useDesktopProjectSession";
import { useDesktopProjectActions } from "../../renderer/hooks/useDesktopProjectActions";
import { ProjectSidebar } from "../../renderer/sidebar/ProjectSidebar";
import { createTranslator } from "../../renderer/i18n";
import type { AppView } from "../../renderer/types";
import { project } from "./desktopProjectFixtures";

export type RenameKind = "project" | "canvas";
const t = createTranslator("en");
const ignore = () => undefined;
export const secondProject = {
  ...project,
  projectId: "P-002",
  name: "Other project",
  rootPath: "/tmp/other",
  workspaceRoot: "/tmp/other"
};
export const thirdProject = {
  ...secondProject,
  projectId: "P-003",
  name: "Third project",
  rootPath: "/tmp/third",
  workspaceRoot: "/tmp/third"
};
const secondCanvas = { ...project.taskCanvases[0], canvasId: "canvas-other", name: "Other canvas" };
export const initialProject = { ...project, taskCanvases: [...project.taskCanvases, secondCanvas] };

type RenameSidebarProps = {
  targetProjectId?: string;
  targetCanvasId?: string;
  activeView?: AppView;
  collapsed?: boolean;
  sidebarVisible?: boolean;
  onError: (error: string | null) => void;
  initialSelection?: DesktopProjectSummary;
  home?: string;
};

export function RenameSidebar({
  targetProjectId = project.projectId,
  targetCanvasId = "canvas-main",
  activeView = "graph",
  collapsed = false,
  sidebarVisible = true,
  onError,
  initialSelection = initialProject,
  home = "/tmp/sidebar-rename-test"
}: RenameSidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const publishError = useCallback(
    (message: string | null) => {
      setError(message);
      onError(message);
    },
    [onError]
  );
  const state = useDesktopProject({
    planweaveHome: home,
    autoSelectInitialProject: false,
    setError: publishError,
    t,
    updateSettings: ignore
  });
  const session = useDesktopProjectSession({
    projectState: state,
    language: "en",
    setError: publishError,
    clearSelectedBlockRecords: ignore,
    selectBlock: vi.fn(),
    setActiveView: ignore,
    setBlockInspectorOpen: ignore,
    setSelectedBlock: ignore,
    setSelectedRunRecord: ignore
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    if (state.projects.length === 0) return;
    void sessionRef.current.openProject(
      targetProjectId === project.projectId
        ? initialSelection
        : targetProjectId === secondProject.projectId
          ? secondProject
          : thirdProject,
      targetCanvasId,
      { recordCanvasSelection: false }
    );
  }, [initialSelection, state.projects.length, targetProjectId, targetCanvasId]);
  const actions = useDesktopProjectActions({
    clearReviewTaskSelection: ignore,
    createTaskCanvas: session.createTaskCanvas,
    createProjectFromTaskCanvas: session.createProjectFromTaskCanvas,
    deleteTaskCanvas: session.deleteTaskCanvas,
    duplicateTaskCanvas: session.duplicateTaskCanvas,
    renameTaskCanvas: session.renameTaskCanvas,
    captureProjectSelection: state.captureProjectSelection,
    refreshProjects: state.refreshProjects,
    updateSettings: ignore,
    refreshProjectSummary: state.refreshProjectSummary,
    removeProject: state.removeProject,
    setActiveView: ignore,
    setError: publishError,
    t
  });
  return (
    <>
      {error ? <div role="alert">{error}</div> : null}
      <button
        type="button"
        onClick={() =>
          void state.refreshProjectDerivedState({ includeLayout: true, includePrompt: true })
        }
      >
        Refresh canvas data
      </button>
      <output data-testid="rename-project-state">
        {JSON.stringify({
          selected: state.selectedProject?.projectId,
          graph: state.graph?.projectTitle ?? null,
          layout: state.layout?.projectId ?? null,
          layoutUpdatedAt: state.layout?.updatedAt ?? null,
          prompt: state.projectPromptMarkdown,
          loading: state.projectLoading,
          refreshing: state.projectRefreshing
        })}
      </output>
      {sidebarVisible ? (
        <ProjectSidebar
          {...actions}
          activeView={activeView}
          collapsed={collapsed}
          expandedProjectId={state.selectedProject?.projectId ?? null}
          graph={null}
          handleDeleteTaskNode={vi.fn()}
          handleOpenProject={state.handleOpenProject}
          handleRefreshProjects={state.refreshProjects}
          handleRevealTaskNode={ignore}
          handleTaskPanelSelect={ignore}
          loadProject={session.openProject}
          notificationItems={[]}
          onToggleSidebar={ignore}
          onTogglePinnedProject={ignore}
          pinnedProjectIds={new Set()}
          projectRefreshing={state.projectRefreshing}
          projects={state.projects}
          resetLayout={vi.fn()}
          selectedProject={state.selectedProject}
          selectedCanvasId={state.selectedCanvasId}
          selectedTaskPanelId={null}
          setActiveView={ignore}
          t={t}
        />
      ) : null}
    </>
  );
}

export async function openRename(kind: RenameKind, target = "main") {
  const label = kind === "project" ? "Project name" : "Task canvas name";
  const name =
    kind === "project"
      ? target === "main"
        ? "Demo project"
        : "Other project"
      : target === "main"
        ? /Main canvas\s*2/
        : /Other canvas\s*2/;
  fireEvent.contextMenu(await screen.findByRole("button", { name }));
  await userEvent.click(
    await screen.findByText(kind === "project" ? "Rename project" : "Rename task canvas")
  );
  const input = screen.getByRole("textbox", { name: label });
  await waitFor(() => expect(input).toHaveFocus());
  return input;
}
