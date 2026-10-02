/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import type { DesktopBridgeApi, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import {
  deferred,
  project,
  projectDiagnostics,
  projectSnapshot
} from "./helpers/desktopProjectFixtures";
import { autoRunState } from "./helpers/autoRunControlHarness";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { DesktopSettingsUpdate } from "../renderer/types";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

async function harness(autoSelectInitialProject = false) {
  const bridge = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([project]),
    selectTaskCanvas: vi.fn<DesktopBridgeApi["selectTaskCanvas"]>(async (_root, id) => id),
    getDesktopProjectSnapshot: vi.fn<DesktopBridgeApi["getDesktopProjectSnapshot"]>(async (ref) => {
      const snapshot = projectSnapshot();
      return projectSnapshot({
        graph: snapshot.graph && {
          ...snapshot.graph,
          projectTitle: `${ref.projectRoot}:${ref.canvasId}`
        }
      });
    }),
    getDesktopGraphDiagnostics: vi.fn().mockResolvedValue(projectDiagnostics()),
    getLatestAutoRunSummaryWithDiagnostics: vi.fn<
      DesktopBridgeApi["getLatestAutoRunSummaryWithDiagnostics"]
    >(async (ref) => ({
      state: autoRunState({
        projectRoot: ref.projectRoot,
        canvasId: ref.canvasId ?? null,
        runId: `RUN-${ref.projectRoot}-${ref.canvasId}`
      }),
      diagnostics: [{ code: `summary-${ref.canvasId}`, message: "Current scope" }]
    }))
  });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const { useDesktopProjectSession } = await import("../renderer/hooks/useDesktopProjectSession");
  const setError = vi.fn();
  const clearSelectedBlockRecords = vi.fn();
  const updateSettings = vi.fn();
  const hook = renderHook(
    ({
      home,
      updateSettings
    }: {
      home: string;
      updateSettings: (update: DesktopSettingsUpdate) => void;
    }) => {
      const state = useDesktopProject({
        planweaveHome: home,
        autoSelectInitialProject,
        setError,
        t: createTranslator("en"),
        updateSettings
      });
      const session = useDesktopProjectSession({
        projectState: state,
        language: "en",
        setError,
        clearSelectedBlockRecords,
        selectBlock: vi.fn(),
        setActiveView: vi.fn(),
        setBlockInspectorOpen: vi.fn(),
        setSelectedBlock: vi.fn(),
        setSelectedRunRecord: vi.fn()
      });
      return { state, session };
    },
    { initialProps: { home: "/tmp/selection-home-a", updateSettings } }
  );
  await act(async () => {
    await hook.result.current.session.openProject(project, "canvas-main", {
      recordCanvasSelection: false
    });
  });
  return { ...hook, bridge, setError, clearSelectedBlockRecords, updateSettings };
}

function otherProject(): DesktopProjectSummary {
  return {
    ...project,
    projectId: "P-B",
    rootPath: "/tmp/selection-project-b",
    workspaceRoot: "/tmp/selection-workspace-b"
  };
}

function expectScope(
  h: Awaited<ReturnType<typeof harness>>,
  target: DesktopProjectSummary,
  canvasId: string
) {
  expect(h.result.current.state.selectedProject?.rootPath).toBe(target.rootPath);
  expect(h.result.current.state.selectedCanvasId).toBe(canvasId);
  expect(h.result.current.state.graph?.projectTitle).toBe(`${target.rootPath}:${canvasId}`);
  expect(h.result.current.session.autoRunState).toMatchObject({
    projectRoot: target.rootPath,
    canvasId
  });
  expect(h.result.current.session.autoRunDiagnostics).toEqual([
    { code: `summary-${canvasId}`, message: "Current scope" }
  ]);
  expect(h.result.current.state.projectLoading).toBe(false);
}

describe("Desktop selection intent before IPC", () => {
  it.each([
    "canvas",
    "project",
    "ABA"
  ] as const)("does not load or clear a newer selection after a late %s IPC", async (mode) => {
    const h = await harness();
    const old = deferred<string>();
    vi.mocked(h.bridge.selectTaskCanvas).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.session.openProject(project, "canvas-a");
    });
    const target = mode === "project" ? otherProject() : project;
    await act(async () => {
      await h.result.current.session.openProject(target, "canvas-b");
    });
    const finalId = mode === "ABA" ? "canvas-a" : "canvas-b";
    if (mode === "ABA")
      await act(async () => {
        await h.result.current.session.openProject(project, finalId);
      });
    h.clearSelectedBlockRecords.mockClear();
    vi.mocked(h.bridge.getDesktopProjectSnapshot).mockClear();
    vi.mocked(h.bridge.getLatestAutoRunSummaryWithDiagnostics).mockClear();
    await act(async () => {
      old.resolve("canvas-a");
      await pending;
    });
    expectScope(h, target, finalId);
    expect(h.clearSelectedBlockRecords).not.toHaveBeenCalled();
    expect(h.bridge.getDesktopProjectSnapshot).not.toHaveBeenCalled();
    expect(h.bridge.getLatestAutoRunSummaryWithDiagnostics).not.toHaveBeenCalled();
  });

  it.each([
    "switch",
    "Home",
    "unmount"
  ] as const)("discards late IPC errors after %s", async (mode) => {
    const h = await harness();
    const old = deferred<string>();
    vi.mocked(h.bridge.selectTaskCanvas).mockReturnValueOnce(old.promise);
    let pending!: Promise<unknown>;
    act(() => {
      pending = h.result.current.session.openProject(project, "canvas-a").then(
        () => null,
        (error) => error
      );
    });
    if (mode === "switch")
      await act(async () => {
        await h.result.current.session.openProject(otherProject(), "canvas-b");
      });
    if (mode === "Home")
      h.rerender({ home: "/tmp/selection-home-b", updateSettings: h.updateSettings });
    if (mode === "unmount") h.unmount();
    h.setError.mockClear();
    let outcome: unknown;
    await act(async () => {
      old.reject(new Error("OBSOLETE-IPC"));
      outcome = await pending;
    });
    expect(outcome).toBeNull();
    expect(h.setError).not.toHaveBeenCalled();
  });

  it.each([
    "unmount",
    "Home"
  ] as const)("does not load or clear selection after an IPC completes following %s", async (mode) => {
    const h = await harness();
    const old = deferred<string>();
    vi.mocked(h.bridge.selectTaskCanvas).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.session.openProject(project, "canvas-a");
    });
    if (mode === "unmount") h.unmount();
    else
      await act(async () => {
        h.rerender({ home: "/tmp/selection-home-b", updateSettings: h.updateSettings });
      });
    h.clearSelectedBlockRecords.mockClear();
    vi.mocked(h.bridge.getDesktopProjectSnapshot).mockClear();
    await act(async () => {
      old.resolve("canvas-a");
      await pending;
    });
    expect(h.clearSelectedBlockRecords).not.toHaveBeenCalled();
    expect(h.bridge.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a newer selection when a prior project-list refresh finishes", async () => {
    const h = await harness();
    const old = deferred<DesktopProjectSummary[]>();
    vi.mocked(h.bridge.listProjects).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.state.refreshProjects();
    });
    const target = otherProject();
    await act(async () => {
      await h.result.current.session.openProject(target, "canvas-b");
    });
    await act(async () => {
      old.resolve([project]);
      await pending;
    });
    expectScope(h, target, "canvas-b");
    expect(h.result.current.state.projectRefreshing).toBe(false);
  });

  it("does not restore a prior canvas when its summary list refresh completes", async () => {
    const h = await harness();
    const old = deferred<DesktopProjectSummary[]>();
    vi.mocked(h.bridge.listProjects).mockReturnValueOnce(old.promise);
    let pending!: Promise<DesktopProjectSummary | null>;
    act(() => {
      pending = h.result.current.state.refreshProjectSummary(project.rootPath, "canvas-main");
    });
    await act(async () => {
      await h.result.current.session.openProject(project, "canvas-b");
    });
    await act(async () => {
      old.resolve([project]);
      await pending;
    });
    expectScope(h, project, "canvas-b");
  });

  it("keeps the newer load pending when an older selection IPC completes", async () => {
    const h = await harness();
    const old = deferred<string>();
    const newerSnapshot = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(h.bridge.selectTaskCanvas).mockReturnValueOnce(old.promise);
    let pendingOld!: Promise<void>, pendingNew!: Promise<void>;
    act(() => {
      pendingOld = h.result.current.session.openProject(project, "canvas-a");
    });
    vi.mocked(h.bridge.getDesktopProjectSnapshot).mockReturnValueOnce(newerSnapshot.promise);
    act(() => {
      pendingNew = h.result.current.session.openProject(project, "canvas-b");
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      old.resolve("canvas-a");
      await pendingOld;
    });
    expect(h.result.current.state.selectedCanvasId).toBe("canvas-b");
    expect(h.result.current.state.projectLoading).toBe(true);
    const snapshot = projectSnapshot();
    await act(async () => {
      newerSnapshot.resolve(
        projectSnapshot({
          graph: snapshot.graph && {
            ...snapshot.graph,
            projectTitle: `${project.rootPath}:canvas-b`
          }
        })
      );
      await pendingNew;
    });
    expectScope(h, project, "canvas-b");
  });

  it("keeps the latest same-scope project-list refresh and discards an earlier error", async () => {
    const h = await harness();
    const old = deferred<DesktopProjectSummary[]>();
    vi.mocked(h.bridge.listProjects).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.state.refreshProjects();
    });
    vi.mocked(h.bridge.listProjects).mockResolvedValueOnce([{ ...project, name: "New summary" }]);
    await act(async () => {
      await h.result.current.state.refreshProjects();
    });
    h.setError.mockClear();
    await act(async () => {
      old.reject(new Error("OLD-REFRESH"));
      await pending;
    });
    expect(h.result.current.state.selectedProject?.name).toBe("New summary");
    expect(h.setError).not.toHaveBeenCalled();
    expect(h.result.current.state.projectRefreshing).toBe(false);
  });

  it("does not publish refresh errors after unmount", async () => {
    const h = await harness();
    const old = deferred<DesktopProjectSummary[]>();
    vi.mocked(h.bridge.listProjects).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.state.refreshProjects();
    });
    h.unmount();
    h.setError.mockClear();
    await act(async () => {
      old.reject(new Error("UNMOUNTED-REFRESH"));
      await pending;
    });
    expect(h.setError).not.toHaveBeenCalled();
  });

  it("does not repeat initial project selection when a settings callback changes during a load", async () => {
    const h = await harness();
    const pendingSnapshot = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(h.bridge.getDesktopProjectSnapshot).mockReturnValueOnce(pendingSnapshot.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.session.openProject(project, "canvas-b");
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      h.rerender({ home: "/tmp/selection-home-a", updateSettings: vi.fn() });
    });
    expect(h.result.current.state.projectLoading).toBe(true);
    expect(h.result.current.state.selectedCanvasId).toBe("canvas-b");
    const snapshot = projectSnapshot();
    await act(async () => {
      pendingSnapshot.resolve(
        projectSnapshot({
          graph: snapshot.graph && {
            ...snapshot.graph,
            projectTitle: `${project.rootPath}:canvas-b`
          }
        })
      );
      await pending;
    });
    expectScope(h, project, "canvas-b");
  });

  it("loads the new Home's initial project instead of retaining bootstrap completion from the old Home", async () => {
    const h = await harness(true);
    const target = otherProject();
    vi.mocked(h.bridge.listProjects).mockResolvedValue([target]);
    await act(async () => {
      h.rerender({ home: "/tmp/selection-home-b", updateSettings: h.updateSettings });
    });
    expectScope(h, target, "canvas-main");
  });

  it.each(
    (["create", "duplicate", "delete", "rename", "create-project"] as const).flatMap((operation) =>
      (["success", "error"] as const).map((completion) => ({ operation, completion }))
    )
  )("does not select from a late $operation $completion mutation after switching projects", async ({
    operation,
    completion
  }) => {
    const h = await harness();
    const gate = deferred<void>();
    const canvas = project.taskCanvases[0];
    if (!canvas) throw new Error("The fixture requires a task canvas.");
    const updatedCanvas = { ...canvas, canvasId: "canvas-late" };
    const createdProject = { ...project, projectId: "P-C", rootPath: "/tmp/selection-project-c" };
    let start: () => Promise<unknown>;
    switch (operation) {
      case "create":
        vi.mocked(h.bridge.createTaskCanvas).mockImplementationOnce(async () => {
          await gate.promise;
          return updatedCanvas;
        });
        start = () => h.result.current.session.createTaskCanvas(project);
        break;
      case "duplicate":
        vi.mocked(h.bridge.duplicateTaskCanvas).mockImplementationOnce(async () => {
          await gate.promise;
          return updatedCanvas;
        });
        start = () => h.result.current.session.duplicateTaskCanvas(project, "canvas-main");
        break;
      case "delete":
        vi.mocked(h.bridge.removeTaskCanvas).mockImplementationOnce(async () => {
          await gate.promise;
          return [updatedCanvas];
        });
        start = () => h.result.current.session.deleteTaskCanvas(project, "canvas-main");
        break;
      case "rename":
        vi.mocked(h.bridge.renameTaskCanvas).mockImplementationOnce(async () => {
          await gate.promise;
          return updatedCanvas;
        });
        start = () =>
          h.result.current.session.renameTaskCanvas(project, "canvas-main", "New title");
        break;
      case "create-project":
        vi.mocked(h.bridge.createProjectFromTaskCanvas).mockImplementationOnce(async () => {
          await gate.promise;
          return createdProject;
        });
        start = () => h.result.current.session.createProjectFromTaskCanvas(project, "canvas-main");
        break;
    }
    let pending!: Promise<unknown>;
    act(() => {
      pending = start().then(
        () => null,
        (error) => error
      );
    });
    const target = otherProject();
    await act(async () => {
      await h.result.current.session.openProject(target, "canvas-b");
    });
    h.setError.mockClear();
    vi.mocked(h.bridge.listProjects).mockClear();
    h.clearSelectedBlockRecords.mockClear();
    let outcome: unknown;
    await act(async () => {
      if (completion === "success") gate.resolve();
      else gate.reject(new Error("OBSOLETE-MUTATION"));
      outcome = await pending;
    });
    expect(outcome).toBeNull();
    expectScope(h, target, "canvas-b");
    expect(h.bridge.listProjects).not.toHaveBeenCalled();
    expect(h.clearSelectedBlockRecords).not.toHaveBeenCalled();
    expect(h.setError).not.toHaveBeenCalled();
    h.unmount();
  });

  it("reports a current IPC failure, clears loading, and permits retry", async () => {
    const h = await harness();
    vi.mocked(h.bridge.selectTaskCanvas).mockRejectedValueOnce(new Error("CURRENT-IPC"));
    let failed: unknown;
    await act(async () => {
      failed = await h.result.current.session
        .openProject(project, "canvas-b")
        .catch((error) => error);
    });
    expect(failed).toBeInstanceOf(Error);
    expect(h.result.current.state.projectLoading).toBe(false);
    await act(async () => {
      await h.result.current.session.openProject(project, "canvas-b");
    });
    expectScope(h, project, "canvas-b");
    await act(async () => {
      await h.result.current.session.reloadCurrentCanvas();
    });
    expectScope(h, project, "canvas-b");
  });
});

describe("current mutation selection continuation", () => {
  it.each([
    "create",
    "duplicate",
    "delete"
  ] as const)("keeps current %s mutation loading its returned canvas", async (operation) => {
    const h = await harness();
    const base = project.taskCanvases[0];
    if (!base) throw new Error("fixture needs canvas");
    const newCanvas = { ...base, canvasId: "canvas-new" };
    const updated = { ...project, taskCanvases: [newCanvas] };
    vi.mocked(h.bridge.listProjects).mockResolvedValue([updated]);
    vi.mocked(h.bridge.createTaskCanvas).mockResolvedValue(newCanvas);
    vi.mocked(h.bridge.duplicateTaskCanvas).mockResolvedValue(newCanvas);
    vi.mocked(h.bridge.removeTaskCanvas).mockResolvedValue([newCanvas]);
    vi.mocked(h.bridge.selectTaskCanvas).mockClear();
    await act(async () => {
      if (operation === "create") await h.result.current.session.createTaskCanvas(project);
      if (operation === "duplicate")
        await h.result.current.session.duplicateTaskCanvas(project, "canvas-main");
      if (operation === "delete")
        await h.result.current.session.deleteTaskCanvas(project, "canvas-main");
    });
    expect(h.bridge.selectTaskCanvas).toHaveBeenCalledWith(project.rootPath, "canvas-new");
    expectScope(h, project, "canvas-new");
    h.unmount();
  });
});
