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
import { graph } from "./graphFixtures";
import type { AppView } from "../../renderer/types";
import { createDesktopBridgeMock } from "../desktopBridgeMock";
import {
  deferred,
  layout,
  project,
  projectDiagnostics,
  projectSnapshot
} from "./desktopProjectFixtures";

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
const thirdProject = {
  ...secondProject,
  projectId: "P-003",
  name: "Third project",
  rootPath: "/tmp/third",
  workspaceRoot: "/tmp/third"
};
const secondCanvas = { ...project.taskCanvases[0], canvasId: "canvas-other", name: "Other canvas" };
const initialProject = { ...project, taskCanvases: [...project.taskCanvases, secondCanvas] };

type RenameSidebarProps = {
  targetProjectId?: string;
  targetCanvasId?: string;
  activeView?: AppView;
  onError: (error: string | null) => void;
  initialSelection?: DesktopProjectSummary;
};

function RenameSidebar({
  targetProjectId = project.projectId,
  targetCanvasId = "canvas-main",
  activeView = "graph",
  onError,
  initialSelection = initialProject
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
      <output data-testid="rename-project-state">
        {JSON.stringify({
          selected: state.selectedProject?.projectId,
          graph: state.graph?.projectTitle ?? null,
          layout: state.layout?.projectId ?? null,
          prompt: state.projectPromptMarkdown,
          loading: state.projectLoading,
          refreshing: state.projectRefreshing
        })}
      </output>
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
  let listeners: Set<(event: DesktopPackageFileChangeEvent) => void>;
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
    listeners = new Set();
    onError.mockReset();
    api = createDesktopBridgeMock({
      listProjects: vi.fn(async () => database),
      onPackageFileChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
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
    "selected managed",
    "unselected"
  ] as const)("restores the graph after renaming the %s project", async (target) => {
    const managed = {
      ...initialProject,
      kind: "managed" as const,
      sourceRoot: null,
      rootPath: "/tmp/sidebar-rename-test/projects/P-001",
      workspaceRoot: "/tmp/sidebar-rename-test/projects/P-001"
    };
    database[0] = managed;
    render(<RenameSidebar onError={onError} initialSelection={managed} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const oldReference = vi.mocked(api.watchPackageFiles).mock.calls.at(-1)?.[0];
    if (!oldReference) throw new Error("Expected initial watch");
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api).onPackageFileChanged(observed);
    const input = await openRename("project", target === "unselected" ? "other" : "main");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api.getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    if (target === "selected managed") {
      vi.mocked(api.renameProject).mockImplementationOnce(async (_id, name) => {
        const updated = {
          ...managed,
          projectId: "managed-renamed",
          name,
          rootPath: "/tmp/sidebar-rename-test/projects/managed-renamed",
          workspaceRoot: "/tmp/sidebar-rename-test/projects/managed-renamed"
        };
        database[0] = updated;
        return updated;
      });
    }
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed project{Enter}");
    const selected = target === "unselected" ? secondProject.projectId : "managed-renamed";
    await waitFor(() => expect(output).toHaveTextContent(`"selected":"${selected}"`));
    const event = {
      ...oldReference,
      paths: ["package/manifest.json"],
      triggeredAt: "2026-10-30T00:00:00Z"
    };
    act(() => {
      for (const listener of listeners) listener(event);
    });
    expect(observed).not.toHaveBeenCalled();
    await act(async () =>
      gate.resolve(
        projectSnapshot({
          graph: { ...graph, projectId: selected, projectTitle: "Renamed graph" },
          layout: { ...layout, projectId: selected },
          projectPromptMarkdown: "# Renamed prompt"
        })
      )
    );
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Renamed graph"'));
    expect(output).toHaveTextContent(`"layout":"${selected}"`);
    expect(output).toHaveTextContent('"prompt":"# Renamed prompt"');
    expect(output).toHaveTextContent('"loading":false');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const reference = vi.mocked(api.watchPackageFiles).mock.calls.at(-1)?.[0];
    expect(reference).toMatchObject({
      projectRoot: target === "unselected" ? secondProject.rootPath : database[0].rootPath,
      canvasId: "canvas-main"
    });
    if (!reference) throw new Error("Expected migrated watch");
    act(() => {
      for (const listener of listeners) listener({ ...event, ...reference });
    });
    expect(observed).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it.each([
    { transition: "project", completion: "resolve" },
    { transition: "project", completion: "reject" },
    { transition: "refresh", completion: "resolve" },
    { transition: "refresh", completion: "reject" },
    { transition: "rename", completion: "resolve" },
    { transition: "rename", completion: "reject" },
    { transition: "canvas-rename", completion: "resolve" },
    { transition: "canvas-rename", completion: "reject" },
    { transition: "navigation", completion: "resolve" },
    { transition: "navigation", completion: "reject" },
    { transition: "unmount", completion: "resolve" },
    { transition: "unmount", completion: "reject" }
  ] as const)("retires saved rename snapshot $completion after $transition", async ({
    transition,
    completion
  }) => {
    database.push(thirdProject);
    const view = render(<RenameSidebar onError={onError} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const input = await openRename("project", "other");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api.getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed other{Enter}");
    await waitFor(() => expect(output).toHaveTextContent('"selected":"P-002"'));
    let newInput: HTMLElement | null = null;
    if (transition === "project") {
      vi.mocked(api.getDesktopProjectSnapshot).mockResolvedValueOnce(
        projectSnapshot({
          graph: { ...graph, projectTitle: "Current third graph" }
        })
      );
      view.rerender(<RenameSidebar onError={onError} targetProjectId="P-003" />);
      await waitFor(() => expect(output).toHaveTextContent('"graph":"Current third graph"'));
    } else if (transition === "refresh") {
      vi.mocked(api.getDesktopProjectSnapshot).mockResolvedValueOnce(
        projectSnapshot({
          graph: { ...graph, projectTitle: "Current refreshed graph" }
        })
      );
      await userEvent.click(screen.getByRole("button", { name: "Refresh projects" }));
      await waitFor(() => expect(output).toHaveTextContent('"graph":"Current refreshed graph"'));
    } else if (transition === "canvas-rename") {
      const canvasInput = await openRename("canvas");
      vi.mocked(api.getDesktopProjectSnapshot).mockResolvedValueOnce(
        projectSnapshot({
          graph: { ...graph, projectTitle: "Current canvas rename graph" }
        })
      );
      await userEvent.clear(canvasInput);
      await userEvent.type(canvasInput, "Replacement canvas{Enter}");
      await waitFor(() =>
        expect(output).toHaveTextContent('"graph":"Current canvas rename graph"')
      );
    } else if (transition === "rename") {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Renamed other" }));
      await userEvent.click(await screen.findByText("Rename project"));
      newInput = screen.getByRole("textbox", { name: "Project name" });
      await userEvent.clear(newInput);
      await userEvent.type(newInput, "New draft");
      if (transition === "rename") {
        vi.mocked(api.getDesktopProjectSnapshot).mockResolvedValueOnce(
          projectSnapshot({
            graph: { ...graph, projectTitle: "Current rename graph" }
          })
        );
        await userEvent.type(newInput, "{Enter}");
        await waitFor(() => expect(output).toHaveTextContent('"graph":"Current rename graph"'));
        newInput = null;
      }
    } else if (transition === "navigation") {
      view.rerender(<RenameSidebar onError={onError} activeView="settings" />);
    } else view.unmount();
    const currentState = output.textContent;
    onError.mockClear();
    await act(async () => {
      if (completion === "resolve")
        gate.resolve(projectSnapshot({ graph: { ...graph, projectTitle: "Obsolete graph" } }));
      else gate.reject(new Error("Obsolete snapshot failure"));
    });
    if (
      transition === "project" ||
      transition === "refresh" ||
      transition === "rename" ||
      transition === "canvas-rename"
    )
      expect(output.textContent).toBe(currentState);
    if (transition !== "unmount") expect(output).toHaveTextContent('"loading":false');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
    if (newInput) expect(newInput).toHaveValue("New draft");
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("finishes the admitted snapshot %s while a new editor keeps its own draft", async (completion) => {
    const view = render(<RenameSidebar onError={onError} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const input = await openRename("project", "other");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api.getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed other{Enter}");
    await waitFor(() => expect(output).toHaveTextContent('"selected":"P-002"'));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Renamed other" }));
    await userEvent.click(await screen.findByText("Rename project"));
    const nextInput = screen.getByRole("textbox", { name: "Project name" });
    await userEvent.clear(nextInput);
    await userEvent.type(nextInput, "New draft");
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api).onPackageFileChanged(observed);
    await act(async () => {
      if (completion === "resolve") {
        gate.resolve(
          projectSnapshot({
            graph: {
              ...graph,
              projectId: secondProject.projectId,
              projectTitle: "Current B graph"
            },
            layout: { ...layout, projectId: secondProject.projectId },
            projectPromptMarkdown: "# Current B prompt"
          })
        );
      } else gate.reject(new Error("Current B snapshot failure"));
    });
    expect(nextInput).toHaveValue("New draft");
    expect(nextInput).not.toHaveAttribute("readonly");
    expect(nextInput).not.toHaveAttribute("aria-invalid", "true");
    expect(output).toHaveTextContent('"selected":"P-002"');
    expect(output).toHaveTextContent('"loading":false');
    expect(output).toHaveTextContent('"refreshing":false');
    if (completion === "resolve") {
      expect(output).toHaveTextContent('"graph":"Current B graph"');
      expect(output).toHaveTextContent('"layout":"P-002"');
      expect(output).toHaveTextContent('"prompt":"# Current B prompt"');
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      const reference = vi.mocked(api.watchPackageFiles).mock.calls.at(-1)?.[0];
      expect(reference).toMatchObject({
        projectRoot: secondProject.rootPath,
        canvasId: "canvas-main"
      });
      if (!reference) throw new Error("Expected a current B watch");
      const event = {
        ...reference,
        paths: ["package/manifest.json"],
        triggeredAt: "2026-10-30T00:00:00Z"
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
    } else {
      expect(screen.getByRole("alert")).toHaveTextContent("Current B snapshot failure");
      expect(output).toHaveTextContent('"graph":null');
      expect(output).toHaveTextContent('"layout":null');
      expect(output).toHaveTextContent('"prompt":null');
    }
    unsubscribe();
  });

  it("keeps the newer refresh error when an older rename snapshot resolves", async () => {
    render(<RenameSidebar onError={onError} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const input = await openRename("project");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api.getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed selected{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Project name" })).toHaveAttribute("readonly")
    );
    vi.mocked(api.listProjects).mockRejectedValueOnce(new Error("Newer refresh failed"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh projects" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Newer refresh failed")
    );
    await act(async () =>
      gate.resolve(projectSnapshot({ graph: { ...graph, projectTitle: "Obsolete graph" } }))
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Newer refresh failed");
    expect(output).toHaveTextContent('"graph":"Demo project"');
    expect(output).toHaveTextContent('"loading":false');
  });

  it("shows an admitted rename snapshot failure and ends loading", async () => {
    render(<RenameSidebar onError={onError} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const input = await openRename("project", "other");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api.getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed other{Enter}");
    await waitFor(() => expect(output).toHaveTextContent('"selected":"P-002"'));
    await act(async () => gate.reject(new Error("Current snapshot failure")));
    expect(screen.getByRole("alert")).toHaveTextContent("Current snapshot failure");
    expect(output).toHaveTextContent('"loading":false');
    expect(output).toHaveTextContent('"refreshing":false');
    expect(output).toHaveTextContent('"graph":null');
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
