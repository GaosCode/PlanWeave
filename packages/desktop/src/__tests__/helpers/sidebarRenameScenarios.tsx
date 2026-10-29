import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useEffect, useRef, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { desktopCommandBridge } from "../../renderer/desktopCommandBridge";
import { useDesktopProject } from "../../renderer/hooks/useDesktopProject";
import { useDesktopProjectSession } from "../../renderer/hooks/useDesktopProjectSession";
import { useDesktopProjectActions } from "../../renderer/hooks/useDesktopProjectActions";
import { ProjectSidebar } from "../../renderer/sidebar/ProjectSidebar";
import { createTranslator } from "../../renderer/i18n";
import type { AppView } from "../../renderer/types";
import { createDesktopBridgeMock } from "../desktopBridgeMock";
import { deferred, project, projectDiagnostics, projectSnapshot } from "./desktopProjectFixtures";

export type RenameBridgeState = { api: DesktopBridgeApi | null };
type RenameKind = "project" | "canvas";
const t = createTranslator("en");
const ignore = () => undefined;
const secondProject = {
  ...project,
  projectId: "P-002",
  name: "Other project",
  rootPath: "/tmp/other",
  workspaceRoot: "/tmp/other"
};
const secondCanvas = { ...project.taskCanvases[0], canvasId: "canvas-other", name: "Other canvas" };
const initialProject = { ...project, taskCanvases: [...project.taskCanvases, secondCanvas] };

type RenameSidebarProps = {
  targetProjectId?: string;
  targetCanvasId?: string;
  activeView?: AppView;
  onError: (error: string | null) => void;
};

function RenameSidebar({
  targetProjectId = project.projectId,
  targetCanvasId = "canvas-main",
  activeView = "graph",
  onError
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
    planweaveHome: "/tmp/sidebar-rename-test",
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
      targetProjectId === project.projectId ? initialProject : secondProject,
      targetCanvasId,
      { recordCanvasSelection: false }
    );
  }, [state.projects.length, targetProjectId, targetCanvasId]);
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
      <ProjectSidebar
        {...actions}
        activeView={activeView}
        collapsed={false}
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
    </>
  );
}

async function openRename(kind: RenameKind, target = "main") {
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

export function sidebarRenameScenarios(bridgeState: RenameBridgeState) {
  let database: DesktopProjectSummary[];
  let api: DesktopBridgeApi;
  const onError = vi.fn();
  const persistProject: DesktopBridgeApi["renameProject"] = async (projectId, name) => {
    const current = database.find((item) => item.projectId === projectId);
    if (!current) throw new Error("Unknown fixture project");
    const updated = { ...current, name };
    database = database.map((item) => (item === current ? updated : item));
    return updated;
  };
  const persistCanvas: DesktopBridgeApi["renameTaskCanvas"] = async (root, canvasId, name) => {
    const current = database.find((item) => item.rootPath === root);
    const canvas = current?.taskCanvases.find((item) => item.canvasId === canvasId);
    if (!current || !canvas) throw new Error("Unknown fixture canvas");
    const updated = { ...canvas, name };
    database = database.map((item) =>
      item === current
        ? {
            ...item,
            taskCanvases: item.taskCanvases.map((item) =>
              item.canvasId === canvasId ? updated : item
            )
          }
        : item
    );
    return updated;
  };
  const saveMock = (kind: RenameKind) =>
    kind === "project" ? vi.mocked(api.renameProject) : vi.mocked(api.renameTaskCanvas);
  const holdSave = (kind: RenameKind) => {
    const gate = deferred<void>();
    if (kind === "project")
      vi.mocked(api.renameProject).mockImplementationOnce(async (...args) => {
        await gate.promise;
        return persistProject(...args);
      });
    else
      vi.mocked(api.renameTaskCanvas).mockImplementationOnce(async (...args) => {
        await gate.promise;
        return persistCanvas(...args);
      });
    return gate;
  };
  beforeEach(() => {
    database = [initialProject, secondProject];
    onError.mockReset();
    api = createDesktopBridgeMock({
      listProjects: vi.fn(async () => database),
      renameProject: vi.fn(persistProject),
      renameTaskCanvas: vi.fn(persistCanvas),
      selectTaskCanvas: vi.fn(async (_root, id) => id),
      getDesktopProjectSnapshot: vi.fn(async () => projectSnapshot()),
      getDesktopGraphDiagnostics: vi.fn(async () => projectDiagnostics())
    });
    bridgeState.api = api;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  it.each([
    "project",
    "canvas"
  ] as const)("delivers package changes after the saved %s editor closes", async (kind) => {
    const listeners = new Set<(event: DesktopPackageFileChangeEvent) => void>();
    api.onPackageFileChanged = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api).onPackageFileChanged(observed);
    const view = render(<RenameSidebar onError={onError} />);
    try {
      const input = await openRename(kind);
      await userEvent.clear(input);
      await userEvent.type(input, "Saved with watcher{Enter}");
      await waitFor(() => expect(input).not.toBeInTheDocument());
      const reference = vi.mocked(api.watchPackageFiles).mock.calls.at(-1)?.[0];
      if (!reference) throw new Error("Expected a package watch after saving");
      const event = {
        ...reference,
        paths: ["package/manifest.json"],
        triggeredAt: "2026-10-29T12:00:00Z"
      };
      act(() => {
        for (const listener of listeners) listener(event);
      });
      expect(observed).toHaveBeenCalledExactlyOnceWith(event);
      view.unmount();
      act(() => {
        for (const listener of listeners) listener(event);
      });
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    "project",
    "canvas"
  ] as const)("keeps the %s draft on bridge rejection and closes only after retry succeeds", async (kind) => {
    saveMock(kind).mockRejectedValueOnce(new Error("Rename disk is read-only"));
    render(<RenameSidebar onError={onError} />);
    const input = await openRename(kind);
    await userEvent.clear(input);
    await userEvent.type(input, `Renamed ${kind}{Enter}`);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Rename disk is read-only")
    );
    expect(input).toHaveValue(`Renamed ${kind}`);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(
      onError.mock.calls.filter(([message]) => message === "Rename disk is read-only")
    ).toHaveLength(1);
    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(input).not.toBeInTheDocument());
    expect(saveMock(kind)).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", {
        name: kind === "project" ? "Renamed project" : /Renamed canvas\s*2/
      })
    ).toBeInTheDocument();
  });

  it.each([
    "project",
    "canvas"
  ] as const)("submits %s once while Enter and blur repeat during pending", async (kind) => {
    const gate = holdSave(kind);
    render(<RenameSidebar onError={onError} />);
    const input = await openRename(kind);
    await userEvent.clear(input);
    await userEvent.type(input, "Pending name{Enter}{Enter}");
    fireEvent.blur(input);
    expect(input).toHaveAttribute("readonly");
    expect(saveMock(kind)).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(input).not.toBeInTheDocument());
    expect(saveMock(kind)).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "project", draft: "", key: "{Enter}" },
    { kind: "canvas", draft: "   ", key: "{Enter}" },
    { kind: "project", draft: "Demo project", key: "{Enter}" },
    { kind: "canvas", draft: "Main canvas", key: "{Enter}" },
    { kind: "project", draft: "Cancelled", key: "{Escape}" },
    { kind: "canvas", draft: "Cancelled", key: "{Escape}" }
  ] as const)("cancels $kind draft '$draft' with $key without persistence", async ({
    kind,
    draft,
    key
  }) => {
    render(<RenameSidebar onError={onError} />);
    const input = await openRename(kind);
    await userEvent.clear(input);
    if (draft) await userEvent.type(input, draft);
    await userEvent.type(input, key);
    expect(input).not.toBeInTheDocument();
    expect(saveMock(kind)).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "project", completion: "reject", transition: "reopen" },
    { kind: "canvas", completion: "resolve", transition: "reopen" },
    { kind: "project", completion: "resolve", transition: "project" },
    { kind: "canvas", completion: "reject", transition: "canvas" },
    { kind: "project", completion: "reject", transition: "navigation" },
    { kind: "canvas", completion: "reject", transition: "unmount" }
  ] as const)("retires late $kind $completion after $transition", async ({
    kind,
    completion,
    transition
  }) => {
    const gate = holdSave(kind);
    const view = render(<RenameSidebar onError={onError} />);
    const input = await openRename(kind);
    await userEvent.clear(input);
    await userEvent.type(input, "Old request{Enter}");
    if (transition === "unmount") view.unmount();
    else if (transition === "reopen") await userEvent.type(input, "{Escape}");
    else if (transition === "project")
      view.rerender(<RenameSidebar onError={onError} targetProjectId="P-002" />);
    else if (transition === "canvas")
      view.rerender(<RenameSidebar onError={onError} targetCanvasId="canvas-other" />);
    else view.rerender(<RenameSidebar onError={onError} activeView="settings" />);
    let newInput: HTMLElement | null = null;
    if (transition !== "unmount" && transition !== "navigation") {
      await waitFor(() => expect(input).not.toBeInTheDocument());
      newInput = await openRename(
        kind,
        transition === "project" || transition === "canvas" ? "other" : "main"
      );
      await userEvent.clear(newInput);
      await userEvent.type(newInput, "New draft");
    }
    onError.mockClear();
    await act(async () => {
      if (completion === "resolve") gate.resolve();
      else gate.reject(new Error("Obsolete rename"));
    });
    if (newInput) expect(newInput).toHaveValue("New draft");
    expect(screen.queryByText("Obsolete rename")).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
    if (transition === "navigation") {
      view.rerender(<RenameSidebar onError={onError} />);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    }
  });

  it.each([
    "project",
    "canvas"
  ] as const)("keeps %s editor retryable when the bridge is unavailable", async (kind) => {
    render(<RenameSidebar onError={onError} />);
    const input = await openRename(kind);
    await userEvent.clear(input);
    await userEvent.type(input, "Offline draft");
    bridgeState.api = null;
    await userEvent.type(input, "{Enter}");
    expect(input).toHaveValue("Offline draft");
    expect(input).not.toHaveAttribute("readonly");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    bridgeState.api = api;
    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(input).not.toBeInTheDocument());
  });
}
