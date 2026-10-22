/* @vitest-environment jsdom */

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import type { DesktopImportRecoveryRollbackResult } from "../renderer/hooks/useDesktopImportRecovery";

const owned: string[] = [];
afterEach(async () => {
  cleanupRendererTestEnvironment();
  vi.unstubAllEnvs();
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function interruptedProjectDraft() {
  vi.resetModules();
  const { listProjects } = await import("../../../runtime/src/desktop/projectApi");
  const { getDesktopProjectSnapshot } = await import("../../../runtime/src/desktop/graphApi");
  const { rollbackPendingImportRecovery, listPendingImportRecoveries } = await import(
    "../../../runtime/src/desktop/importRecoveryApi"
  );
  const home = await realpath(await mkdtemp(join(tmpdir(), "pw-draft-recovery-")));
  owned.push(home);
  vi.stubEnv("PLANWEAVE_HOME", home);
  vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", join(home, "settings.json"));
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/desktop/src/__tests__/helpers/projectDraftRecoveryFixture.mts",
      home
    ],
    { timeout: 15_000 }
  );
  const projects = await listProjects();
  const project = projects.find((entry) => entry.name === "Surviving project");
  const otherProject = projects.find((entry) => entry.name === "Other project");
  if (!project || !otherProject) throw new Error("Expected real fixture projects");
  expect(project.taskCanvases.map((canvas) => canvas.canvasId)).toContain("imported");
  const api = createDesktopBridgeMock({
    listProjects: vi.fn(listProjects),
    getDesktopProjectSnapshot: vi.fn(getDesktopProjectSnapshot),
    rollbackPendingImportRecovery: vi.fn(rollbackPendingImportRecovery),
    refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
    watchPackageFiles: vi.fn().mockResolvedValue(undefined),
    watchRuntimeState: vi.fn().mockResolvedValue(undefined),
    onRuntimeStateChanged: vi.fn(() => vi.fn())
  });
  vi.stubGlobal("planweave", api);
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const { useNotificationController } = await import(
    "../renderer/controllers/NotificationController"
  );
  const setError = vi.fn();
  const setSuccessMessage = vi.fn();
  const outcomes: DesktopImportRecoveryRollbackResult[] = [];
  const hook = renderHook(() => {
    const state = useDesktopProject({
      planweaveHome: home,
      autoSelectInitialProject: false,
      setError,
      t: createTranslator("en"),
      updateSettings: vi.fn()
    });
    const notifications = useNotificationController({
      applyLocalPromptConflicts: vi.fn().mockResolvedValue(undefined),
      autoRunState: null,
      fileSyncDiagnostics: [],
      graph: state.graph,
      graphScope: null,
      handleRevealPathInFinder: vi.fn().mockResolvedValue(undefined),
      keepLocalPromptConflicts: vi.fn(),
      lastFileChange: null,
      navigationContext: null,
      openRunWorkspace: vi.fn().mockResolvedValue(undefined),
      openTaskWorkspace: vi.fn(),
      pendingImportRecoveries: state.pendingImportRecoveries,
      promptConflicts: [],
      reloadPromptConflicts: vi.fn().mockResolvedValue(undefined),
      rollbackPendingImportRecovery: async (id) => {
        const outcome = await state.rollbackPendingImportRecovery(id);
        outcomes.push(outcome);
        return outcome;
      },
      setError,
      setSuccessMessage,
      settings: defaultDesktopSettings,
      t: createTranslator("en"),
      updateSettings: vi.fn()
    });
    return { ...state, notifications };
  });
  await waitFor(() => expect(hook.result.current.projectLoading).toBe(false));
  await act(async () => hook.result.current.loadProject(project, "imported"));
  const recovery = hook.result.current.pendingImportRecoveries[0];
  if (!recovery) throw new Error("Expected real checkpoint recovery");
  return {
    ...hook,
    api,
    home,
    project,
    otherProject,
    recovery,
    setError,
    setSuccessMessage,
    outcomes,
    listPendingImportRecoveries
  };
}

describe("project draft import recovery selection", () => {
  it("loads the surviving canvas and rebinds subscriptions after public rollback removes the selected canvas", async () => {
    const f = await interruptedProjectDraft();
    const oldPackageWatch = vi.mocked(f.api.watchPackageFiles).mock.calls.at(-1)?.[0];
    const oldRuntimeWatch = vi.mocked(f.api.watchRuntimeState).mock.calls.at(-1)?.[0];
    const oldRuntimeListener = vi.mocked(f.api.onRuntimeStateChanged).mock.calls.at(-1)?.[0];
    const oldRuntimeUnsubscribe = vi.mocked(f.api.onRuntimeStateChanged).mock.results.at(-1)?.value;
    const oldGraph = f.result.current.graph;
    if (!oldGraph || !oldRuntimeListener || !oldRuntimeWatch)
      throw new Error("Expected imported canvas graph and active subscription");
    const delayedGraph = deferred<typeof oldGraph>();
    vi.mocked(f.api.getGraphViewModel).mockReturnValueOnce(delayedGraph.promise);
    let oldRequest!: Promise<void>;
    act(() => {
      oldRequest = f.result.current.refreshGraph();
    });
    vi.mocked(f.api.getDesktopProjectSnapshot).mockClear();
    await act(async () => {
      await f.result.current.notifications.onRollbackImportRecovery(f.recovery.transactionId);
    });
    expect(f.outcomes).toEqual([{ status: "rolledBack", transactionId: f.recovery.transactionId }]);
    expect(f.setSuccessMessage).toHaveBeenCalledWith(
      createTranslator("en")("importRecoveryRollbackSucceeded")
    );
    await expect(stat(f.project.rootPath)).resolves.toBeDefined();
    await expect(
      stat(join(f.project.workspaceRoot, "canvases", "imported", "package"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.api.getDesktopProjectSnapshot).toHaveBeenCalledWith({
      projectRoot: f.project.rootPath,
      canvasId: "default"
    });
    expect(f.result.current.selectedCanvasId).toBe("default");
    expect(f.result.current.graph).not.toBeNull();
    expect(f.result.current.todoGroups).not.toBeNull();
    expect(f.result.current.statistics?.taskTotal).toBe(1);
    expect(f.result.current.pendingImportRecoveries).toEqual([]);
    expect(f.result.current.projectLoading).toBe(false);
    expect(f.result.current.projectRefreshing).toBe(false);
    expect(f.api.unwatchPackageFiles).toHaveBeenCalledWith(oldPackageWatch);
    expect(f.api.unwatchRuntimeState).toHaveBeenCalledWith(oldRuntimeWatch);
    expect(oldRuntimeUnsubscribe).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.watchPackageFiles).mock.calls.at(-1)?.[0]).toMatchObject({
      canvasId: "default"
    });
    expect(vi.mocked(f.api.watchRuntimeState).mock.calls.at(-1)?.[0]).toMatchObject({
      canvasId: "default"
    });
    const survivingGraph = f.result.current.graph;
    vi.mocked(f.api.getGraphViewModel).mockClear();
    await act(async () => {
      oldRuntimeListener({
        ...oldRuntimeWatch,
        stateFile: "old-state.json",
        changedAt: "2026-10-22T00:00:00Z"
      });
      delayedGraph.resolve({ ...oldGraph, graphVersion: "obsolete imported canvas" });
      await oldRequest;
    });
    expect(f.api.getGraphViewModel).not.toHaveBeenCalled();
    expect(f.result.current.graph).toBe(survivingGraph);
    expect(f.setError.mock.calls.filter(([error]) => error !== null)).toEqual([]);
  });

  it.each([
    ["rollback", "project"],
    ["rollback", "canvas"],
    ["snapshot", "project"],
    ["snapshot", "canvas"]
  ] as const)("keeps a user %s-time %s selection when the recovery load completes late", async (phase, scope) => {
    const f = await interruptedProjectDraft();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const rollback = vi.mocked(f.api.rollbackPendingImportRecovery).getMockImplementation();
    const snapshot = vi.mocked(f.api.getDesktopProjectSnapshot).getMockImplementation();
    if (!rollback || !snapshot) throw new Error("Expected public runtime bridge delegates");
    if (phase === "rollback") {
      vi.mocked(f.api.rollbackPendingImportRecovery).mockImplementationOnce(async (...args) => {
        entered.resolve();
        await gate.promise;
        return rollback(...args);
      });
    } else {
      vi.mocked(f.api.getDesktopProjectSnapshot).mockImplementationOnce(async (...args) => {
        const value = await snapshot(...args);
        entered.resolve();
        await gate.promise;
        return value;
      });
    }
    let recovering!: ReturnType<typeof f.result.current.rollbackPendingImportRecovery>;
    act(() => {
      recovering = f.result.current.rollbackPendingImportRecovery(f.recovery.transactionId);
    });
    await entered.promise;
    const selectedProject = scope === "project" ? f.otherProject : f.project;
    const selectedCanvas =
      scope === "project"
        ? "default"
        : f.project.taskCanvases.find(
            (canvas) => canvas.canvasId !== "default" && canvas.canvasId !== "imported"
          )?.canvasId;
    if (!selectedCanvas) throw new Error("Expected surviving user canvas");
    await act(async () => f.result.current.loadProject(selectedProject, selectedCanvas));
    const selectedGraph = f.result.current.graph;
    await act(async () => {
      gate.resolve();
      await recovering;
    });
    expect(f.result.current.selectedProject?.rootPath).toBe(selectedProject.rootPath);
    expect(f.result.current.selectedCanvasId).toBe(selectedCanvas);
    expect(f.result.current.graph).toBe(selectedGraph);
    expect(selectedGraph).not.toBeNull();
    expect(f.result.current.projectLoading).toBe(false);
    expect(f.result.current.projectRefreshing).toBe(false);
    expect(f.setError.mock.calls.filter(([error]) => error !== null)).toEqual([]);
  });

  it.each([
    ["catalog", "project"],
    ["snapshot", "canvas"]
  ] as const)("ignores a late %s rejection after the user selects another %s", async (boundary, scope) => {
    const f = await interruptedProjectDraft();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const rejectLate = async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("obsolete recovery refresh");
    };
    if (boundary === "catalog") vi.mocked(f.api.listProjects).mockImplementationOnce(rejectLate);
    else vi.mocked(f.api.getDesktopProjectSnapshot).mockImplementationOnce(rejectLate);
    let recovering!: ReturnType<typeof f.result.current.rollbackPendingImportRecovery>;
    act(() => {
      recovering = f.result.current.rollbackPendingImportRecovery(f.recovery.transactionId);
    });
    await entered.promise;
    const selectedProject = scope === "project" ? f.otherProject : f.project;
    const selectedCanvas =
      scope === "project"
        ? "default"
        : f.project.taskCanvases.find(
            (canvas) => canvas.canvasId !== "default" && canvas.canvasId !== "imported"
          )?.canvasId;
    if (!selectedCanvas) throw new Error("Expected surviving user canvas");
    await act(async () => f.result.current.loadProject(selectedProject, selectedCanvas));
    const selectedGraph = f.result.current.graph;
    f.setError.mockClear();
    await act(async () => {
      gate.resolve();
      await recovering;
    });
    expect(f.result.current.selectedProject?.rootPath).toBe(selectedProject.rootPath);
    expect(f.result.current.selectedCanvasId).toBe(selectedCanvas);
    expect(f.result.current.graph).toBe(selectedGraph);
    expect(selectedGraph).not.toBeNull();
    expect(f.result.current.projectLoading).toBe(false);
    expect(f.result.current.projectRefreshing).toBe(false);
    expect(f.setError).not.toHaveBeenCalled();
    expect(await f.listPendingImportRecoveries(f.project.rootPath)).toEqual([]);
    expect(f.api.rollbackPendingImportRecovery).toHaveBeenCalledOnce();
  });

  it.each([
    "catalog",
    "snapshot",
    "package refresh"
  ] as const)("surfaces a current recovery %s failure and finishes loading", async (boundary) => {
    const f = await interruptedProjectDraft();
    const error = `${boundary} unavailable`;
    if (boundary === "catalog")
      vi.mocked(f.api.listProjects).mockRejectedValueOnce(new Error(error));
    else if (boundary === "snapshot")
      vi.mocked(f.api.getDesktopProjectSnapshot).mockRejectedValueOnce(new Error(error));
    else vi.mocked(f.api.refreshPackageFileChanges).mockRejectedValueOnce(new Error(error));
    await act(async () => {
      await f.result.current.notifications.onRollbackImportRecovery(f.recovery.transactionId);
    });
    expect(f.outcomes).toEqual([
      { status: "refreshFailed", transactionId: f.recovery.transactionId, error }
    ]);
    expect(f.setSuccessMessage).not.toHaveBeenCalled();
    await expect(stat(f.project.rootPath)).resolves.toBeDefined();
    await expect(
      stat(join(f.project.workspaceRoot, "canvases", "imported", "package"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.listPendingImportRecoveries(f.project.rootPath)).toEqual([]);
    expect(f.setError).toHaveBeenCalledWith(error);
    expect(f.result.current.selectedCanvasId).toBe(boundary === "catalog" ? "imported" : "default");
    expect(f.result.current.projectLoading).toBe(false);
    expect(f.result.current.projectRefreshing).toBe(false);
    expect(f.api.rollbackPendingImportRecovery).toHaveBeenCalledOnce();
    const selectedProject = f.result.current.selectedProject;
    if (!selectedProject) throw new Error("Expected surviving project");
    await act(async () =>
      boundary === "catalog"
        ? f.result.current.refreshProjects()
        : f.result.current.loadProject(selectedProject, "default")
    );
    expect(f.result.current.graph).not.toBeNull();
    expect(f.result.current.pendingImportRecoveries).toEqual([]);
    expect(f.result.current.projectLoading).toBe(false);
    expect(f.result.current.projectRefreshing).toBe(false);
  });
});
