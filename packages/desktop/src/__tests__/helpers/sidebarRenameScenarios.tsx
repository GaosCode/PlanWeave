import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { desktopCommandBridge } from "../../renderer/desktopCommandBridge";
import { graph } from "./graphFixtures";
import { createDesktopBridgeMock } from "../desktopBridgeMock";
import { deferred, layout, projectDiagnostics, projectSnapshot } from "./desktopProjectFixtures";

import {
  initialProject,
  secondProject,
  thirdProject,
  RenameSidebar,
  openRename,
  type RenameKind
} from "./sidebarRenameHarness";

import { sidebarCanvasRenameScenarios } from "./sidebarCanvasRenameScenarios";

export type RenameBridgeState = { api: DesktopBridgeApi | null };
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
  sidebarCanvasRenameScenarios({ api: () => api, listeners: () => listeners, onError });

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
    "project",
    "canvas"
  ] as const)("finishes the admitted snapshot after a later %s write fails and permits retry", async (kind) => {
    render(<RenameSidebar onError={onError} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const input = await openRename("project", "other");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api.getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed other{Enter}");
    await waitFor(() => expect(output).toHaveTextContent('"selected":"P-002"'));
    let nextInput: HTMLElement;
    if (kind === "project") {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Renamed other" }));
      await userEvent.click(await screen.findByText("Rename project"));
      nextInput = screen.getByRole("textbox", { name: "Project name" });
    } else nextInput = await openRename("canvas");
    saveMock(kind).mockRejectedValueOnce(new Error("Second write failed"));
    await userEvent.clear(nextInput);
    await userEvent.type(nextInput, "Second draft{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Second write failed"));
    expect(nextInput).toHaveValue("Second draft");
    expect(nextInput).not.toHaveAttribute("readonly");
    await act(async () =>
      gate.resolve(
        projectSnapshot({
          graph: { ...graph, projectId: "P-002", projectTitle: "Current B graph" },
          layout: { ...layout, projectId: "P-002" },
          projectPromptMarkdown: "# Current B prompt"
        })
      )
    );
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Current B graph"'));
    expect(output).toHaveTextContent('"layout":"P-002"');
    expect(output).toHaveTextContent('"prompt":"# Current B prompt"');
    expect(output).toHaveTextContent('"loading":false');
    expect(output).toHaveTextContent('"refreshing":false');
    expect(screen.getByRole("alert")).toHaveTextContent("Second write failed");
    expect(nextInput).toHaveValue("Second draft");
    expect(nextInput).not.toHaveAttribute("readonly");
    const reference = vi.mocked(api.watchPackageFiles).mock.calls.at(-1)?.[0];
    if (!reference) throw new Error("Expected current B watch after failed write");
    expect(reference).toMatchObject({
      projectRoot: secondProject.rootPath,
      canvasId: "canvas-main"
    });
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api).onPackageFileChanged(observed);
    const event = {
      ...reference,
      paths: ["package/manifest.json"],
      triggeredAt: "2026-10-30T00:00:00Z"
    };
    act(() => {
      for (const listener of listeners) listener(event);
    });
    expect(observed).toHaveBeenCalledExactlyOnceWith(event);
    unsubscribe();
    await userEvent.type(nextInput, "{Enter}");
    await waitFor(() => expect(nextInput).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(saveMock(kind)).toHaveBeenCalledTimes(kind === "project" ? 3 : 2);
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
    { visibility: "collapse", completion: "resolve" },
    { visibility: "collapse", completion: "reject" },
    { visibility: "settings", completion: "resolve" },
    { visibility: "settings", completion: "reject" },
    { visibility: "sidebar-unmount", completion: "resolve" },
    { visibility: "sidebar-unmount", completion: "reject" }
  ] as const)("finishes current snapshot $completion across $visibility and return", async ({
    visibility,
    completion
  }) => {
    const view = render(<RenameSidebar onError={onError} />);
    const output = screen.getByTestId("rename-project-state");
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Demo project"'));
    const input = await openRename("project", "other");
    const gate = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(api.getDesktopProjectSnapshot).mockImplementationOnce(() => gate.promise);
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed other{Enter}");
    await waitFor(() => expect(output).toHaveTextContent('"selected":"P-002"'));
    view.rerender(
      <RenameSidebar
        onError={onError}
        collapsed={visibility === "collapse"}
        activeView={
          visibility === "settings"
            ? "settings"
            : visibility === "sidebar-unmount"
              ? "task-workspace"
              : "graph"
        }
        sidebarVisible={visibility !== "sidebar-unmount"}
      />
    );
    const currentSnapshot = projectSnapshot({
      graph: { ...graph, projectId: secondProject.projectId, projectTitle: "Current B graph" },
      layout: { ...layout, projectId: secondProject.projectId },
      projectPromptMarkdown: "# Current B prompt"
    });
    await act(async () => {
      if (completion === "resolve") gate.resolve(currentSnapshot);
      else gate.reject(new Error("Current B snapshot failure"));
    });
    expect(output).toHaveTextContent('"selected":"P-002"');
    expect(output).toHaveTextContent('"loading":false');
    expect(output).toHaveTextContent('"refreshing":false');
    if (completion === "reject") {
      expect(screen.getByRole("alert")).toHaveTextContent("Current B snapshot failure");
      expect(output).toHaveTextContent('"graph":null');
      expect(output).toHaveTextContent('"layout":null');
      expect(output).toHaveTextContent('"prompt":null');
    }
    view.rerender(<RenameSidebar onError={onError} />);
    if (completion === "reject") {
      expect(screen.getByRole("alert")).toHaveTextContent("Current B snapshot failure");
      vi.mocked(api.getDesktopProjectSnapshot).mockResolvedValueOnce(currentSnapshot);
      await userEvent.click(screen.getByRole("button", { name: "Refresh projects" }));
    }
    await waitFor(() => expect(output).toHaveTextContent('"graph":"Current B graph"'));
    expect(output).toHaveTextContent('"layout":"P-002"');
    expect(output).toHaveTextContent('"prompt":"# Current B prompt"');
    expect(output).toHaveTextContent('"loading":false');
    expect(output).toHaveTextContent('"refreshing":false');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const reference = vi.mocked(api.watchPackageFiles).mock.calls.at(-1)?.[0];
    if (!reference) throw new Error("Expected current B watch after returning");
    expect(reference).toMatchObject({
      projectRoot: secondProject.rootPath,
      canvasId: "canvas-main"
    });
    const observed = vi.fn();
    const unsubscribe = desktopCommandBridge(api).onPackageFileChanged(observed);
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
    unsubscribe();
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
