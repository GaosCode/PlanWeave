/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopProjectSnapshot,
  DesktopProjectSummary,
  PendingImportTransaction
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

function pendingImportRecovery(
  transactionId: string,
  recoveryRoot = `/tmp/demo/desktop/recovery/package-import/${transactionId}`
): PendingImportTransaction {
  return {
    transactionId,
    recoveryRoot,
    createdAt: "2026-07-06T00:00:00.000Z",
    operationCount: 2,
    phases: ["prepared", "applied"]
  };
}

describe("desktop import recovery hook", () => {
  it("loads pending import recoveries from the project snapshot", async () => {
    const pendingImportRecoveries = [pendingImportRecovery("import-tx-1")];
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi
        .fn()
        .mockResolvedValue(projectSnapshot({ pendingImportRecoveries })),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() =>
      expect(result.current.pendingImportRecoveries).toEqual(pendingImportRecoveries)
    );
    expect(bridge.listPendingImportRecoveries).not.toHaveBeenCalled();
  });

  it("rolls back pending import recovery and refreshes derived project state", async () => {
    const firstPendingImportRecoveries = [pendingImportRecovery("import-tx-1")];
    const rollbackPendingImportRecovery = vi.fn().mockResolvedValue(undefined);
    const getDesktopProjectSnapshot = vi
      .fn()
      .mockResolvedValueOnce(
        projectSnapshot({ pendingImportRecoveries: firstPendingImportRecoveries })
      )
      .mockResolvedValueOnce(projectSnapshot({ pendingImportRecoveries: [] }));
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot,
      rollbackPendingImportRecovery,
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project, "canvas-main");
    });
    await waitFor(() =>
      expect(result.current.pendingImportRecoveries).toEqual(firstPendingImportRecoveries)
    );
    getDesktopProjectSnapshot.mockClear();

    let rollbackResult: Awaited<
      ReturnType<typeof result.current.rollbackPendingImportRecovery>
    > | null = null;
    await act(async () => {
      rollbackResult = await result.current.rollbackPendingImportRecovery("import-tx-1");
    });

    expect(rollbackPendingImportRecovery).toHaveBeenCalledWith(project.rootPath, "import-tx-1");
    expect(rollbackResult).toEqual({ status: "rolledBack", transactionId: "import-tx-1" });
    expect(getDesktopProjectSnapshot).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(bridge.listPendingImportRecoveries).not.toHaveBeenCalled();
    expect(result.current.pendingImportRecoveries).toEqual([]);
  });

  it("keeps pending import recovery visible when rollback fails", async () => {
    const pendingImportRecoveries = [pendingImportRecovery("import-tx-1")];
    const rollbackPendingImportRecovery = vi.fn().mockRejectedValue(new Error("rollback failed"));
    const getDesktopProjectSnapshot = vi
      .fn()
      .mockResolvedValue(projectSnapshot({ pendingImportRecoveries }));
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot,
      rollbackPendingImportRecovery,
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project, "canvas-main");
    });
    await waitFor(() =>
      expect(result.current.pendingImportRecoveries).toEqual(pendingImportRecoveries)
    );
    getDesktopProjectSnapshot.mockClear();

    let rollbackResult: Awaited<
      ReturnType<typeof result.current.rollbackPendingImportRecovery>
    > | null = null;
    await act(async () => {
      rollbackResult = await result.current.rollbackPendingImportRecovery("import-tx-1");
    });

    expect(rollbackPendingImportRecovery).toHaveBeenCalledWith(project.rootPath, "import-tx-1");
    expect(rollbackResult).toEqual({
      status: "rollbackFailed",
      transactionId: "import-tx-1",
      error: "rollback failed"
    });
    expect(setError).toHaveBeenCalledWith("rollback failed");
    expect(getDesktopProjectSnapshot).not.toHaveBeenCalled();
    expect(bridge.listPendingImportRecoveries).not.toHaveBeenCalled();
    expect(result.current.pendingImportRecoveries).toEqual(pendingImportRecoveries);
  });

  it("reports refresh failure after a successful rollback and keeps stale recovery state visible", async () => {
    const pendingImportRecoveries = [pendingImportRecovery("import-tx-1")];
    const rollbackPendingImportRecovery = vi.fn().mockResolvedValue(undefined);
    const getDesktopProjectSnapshot = vi
      .fn()
      .mockResolvedValueOnce(projectSnapshot({ pendingImportRecoveries }))
      .mockRejectedValueOnce(new Error("refresh failed"));
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot,
      rollbackPendingImportRecovery,
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project, "canvas-main");
    });
    await waitFor(() =>
      expect(result.current.pendingImportRecoveries).toEqual(pendingImportRecoveries)
    );
    getDesktopProjectSnapshot.mockClear();

    let rollbackResult: Awaited<
      ReturnType<typeof result.current.rollbackPendingImportRecovery>
    > | null = null;
    await act(async () => {
      rollbackResult = await result.current.rollbackPendingImportRecovery("import-tx-1");
    });

    expect(rollbackPendingImportRecovery).toHaveBeenCalledWith(project.rootPath, "import-tx-1");
    expect(rollbackResult).toEqual({
      status: "refreshFailed",
      transactionId: "import-tx-1",
      error: "refresh failed"
    });
    expect(setError).toHaveBeenCalledWith("refresh failed");
    expect(getDesktopProjectSnapshot).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(bridge.listPendingImportRecoveries).not.toHaveBeenCalled();
    expect(result.current.pendingImportRecoveries).toEqual(pendingImportRecoveries);
  });

  it("ignores stale project snapshot recoveries after switching projects", async () => {
    const stalePendingImportRecoveries = [pendingImportRecovery("stale-import-tx")];
    const activePendingImportRecoveries = [
      pendingImportRecovery(
        "active-import-tx",
        "/tmp/other-demo/desktop/recovery/package-import/active-import-tx"
      )
    ];
    const otherProject: DesktopProjectSummary = {
      ...project,
      projectId: "P-002",
      name: "Other project",
      rootPath: "/tmp/other-demo",
      workspaceRoot: "/tmp/other-demo"
    };
    const staleSnapshot = deferred<DesktopProjectSnapshot>();
    const getDesktopProjectSnapshot = vi
      .fn()
      .mockReturnValueOnce(staleSnapshot.promise)
      .mockResolvedValueOnce(
        projectSnapshot({ pendingImportRecoveries: activePendingImportRecoveries })
      );
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot,
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    let staleLoadPromise: Promise<void> | null = null;
    await act(async () => {
      staleLoadPromise = result.current.loadProject(project, "canvas-main");
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.loadProject(otherProject, "canvas-main");
    });

    expect(result.current.selectedProject?.projectId).toBe(otherProject.projectId);
    expect(result.current.pendingImportRecoveries).toEqual(activePendingImportRecoveries);

    await act(async () => {
      staleSnapshot.resolve(
        projectSnapshot({ pendingImportRecoveries: stalePendingImportRecoveries })
      );
      if (!staleLoadPromise) {
        throw new Error("Stale load promise was not started.");
      }
      await staleLoadPromise;
    });

    expect(result.current.selectedProject?.projectId).toBe(otherProject.projectId);
    expect(result.current.pendingImportRecoveries).toEqual(activePendingImportRecoveries);
    expect(bridge.listPendingImportRecoveries).not.toHaveBeenCalled();
  });
});
