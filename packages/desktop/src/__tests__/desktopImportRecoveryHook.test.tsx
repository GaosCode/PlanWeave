/* @vitest-environment jsdom */

import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        planweaveHome: "",
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
      listProjects: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([project]),
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
        planweaveHome: "",
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
        planweaveHome: "",
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
    expect(result.current.selectedProject?.rootPath).toBe(project.rootPath);
    expect(bridge.listProjects).toHaveBeenCalledOnce();
  });

  it("reports refresh failure after a successful rollback and keeps stale recovery state visible", async () => {
    const pendingImportRecoveries = [pendingImportRecovery("import-tx-1")];
    const rollbackPendingImportRecovery = vi.fn().mockResolvedValue(undefined);
    const getDesktopProjectSnapshot = vi
      .fn()
      .mockResolvedValueOnce(projectSnapshot({ pendingImportRecoveries }))
      .mockRejectedValueOnce(new Error("refresh failed"));
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([project]),
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
        planweaveHome: "",
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

  it.each([
    false,
    true
  ])("reconciles catalog, selection and subscriptions after public rollback deletes a Home project (fallback=%s)", async (withFallback) => {
    vi.resetModules();
    const { ImportTransaction } = await import("../../../runtime/src/package/importTransaction");
    const { initialManifest } = await import("../../../runtime/src/initWorkspace");
    const { importManagedPackage } = await import(
      "../../../runtime/src/package/managedPackageImport"
    );
    const { listProjects } = await import("../../../runtime/src/desktop/projectApi");
    const { getDesktopProjectSnapshot } = await import("../../../runtime/src/desktop/graphApi");
    const { rollbackPendingImportRecovery: rollbackRecovery } = await import(
      "../../../runtime/src/desktop/importRecoveryApi"
    );
    const home = await realpath(await mkdtemp(join(tmpdir(), "pw-recovery-ui-")));
    vi.stubEnv("PLANWEAVE_HOME", home);
    try {
      const draftRoot = join(home, "draft");
      await mkdir(draftRoot);
      await writeFile(
        join(draftRoot, "manifest.json"),
        JSON.stringify(initialManifest("UI recovery"))
      );
      if (withFallback)
        await importManagedPackage({ name: "Survivor", draftRoot, overwrite: false });
      const { workspace } = await importManagedPackage({
        name: "Pending",
        draftRoot,
        overwrite: false
      });
      const staged = join(home, "staged-project");
      await rename(workspace.workspaceRoot, staged);
      const transaction = await ImportTransaction.create({
        workspaceRoot: home,
        transactionId: "installed-project",
        writeIsolationTargets: [workspace.workspaceRoot]
      });
      await transaction.replacePath(workspace.workspaceRoot, staged);
      const projects = await listProjects();
      const pendingProject = projects.find((entry) => entry.name === "Pending");
      if (!pendingProject) throw new Error("Expected installed Home project");
      const survivor = projects.find((entry) => entry.name === "Survivor") ?? null;
      const api = createDesktopBridgeMock({
        listProjects: vi.fn(listProjects),
        getDesktopProjectSnapshot: vi.fn(getDesktopProjectSnapshot),
        rollbackPendingImportRecovery: vi.fn(rollbackRecovery),
        refreshPackageFileChanges: vi
          .fn()
          .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
        watchPackageFiles: vi.fn().mockResolvedValue(undefined),
        watchRuntimeState: vi.fn().mockResolvedValue(undefined)
      });
      vi.stubGlobal("planweave", api);
      const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
      const setError = vi.fn();
      const { result } = renderHook(() =>
        useDesktopProject({
          planweaveHome: home,
          autoSelectInitialProject: false,
          setError,
          t: createTranslator("en"),
          updateSettings: vi.fn()
        })
      );
      await waitFor(() => expect(result.current.projectLoading).toBe(false));
      await act(async () => result.current.loadProject(pendingProject));
      const recovery = result.current.pendingImportRecoveries[0];
      if (!recovery) throw new Error("Expected real pending Home transaction");
      const oldPackageWatch = vi.mocked(api.watchPackageFiles).mock.calls.at(-1)?.[0];
      const oldRuntimeWatch = vi.mocked(api.watchRuntimeState).mock.calls.at(-1)?.[0];
      await act(async () => {
        expect(await result.current.rollbackPendingImportRecovery(recovery.transactionId)).toEqual({
          status: "rolledBack",
          transactionId: recovery.transactionId
        });
      });
      await expect(stat(pendingProject.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.current.projects.map((entry) => entry.rootPath)).toEqual(
        survivor ? [survivor.rootPath] : []
      );
      expect(result.current.selectedProject?.rootPath ?? null).toBe(survivor?.rootPath ?? null);
      expect(result.current.pendingImportRecoveries).toEqual([]);
      expect(api.unwatchPackageFiles).toHaveBeenCalledWith(oldPackageWatch);
      expect(api.unwatchRuntimeState).toHaveBeenCalledWith(oldRuntimeWatch);
      vi.mocked(api.getDesktopRuntimeRefresh).mockClear();
      vi.useFakeTimers();
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(
        vi
          .mocked(api.getDesktopRuntimeRefresh)
          .mock.calls.every(([ref]) => ref.projectRoot !== pendingProject.rootPath)
      ).toBe(true);
      if (survivor) expect(api.getDesktopRuntimeRefresh).toHaveBeenCalled();
      else expect(api.getDesktopRuntimeRefresh).not.toHaveBeenCalled();
      expect(
        setError.mock.calls.some(([error]) => typeof error === "string" && error.includes("ENOENT"))
      ).toBe(false);
    } finally {
      cleanupRendererTestEnvironment();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["project", "success"],
    ["project", "failure"],
    ["home", "success"],
    ["home", "failure"]
  ] as const)("keeps the new %s selection after a late rollback %s", async (scope, outcome) => {
    const otherProject: DesktopProjectSummary = {
      ...project,
      projectId: "P-002",
      rootPath: scope === "home" ? project.rootPath : "/tmp/other-demo",
      workspaceRoot: "/tmp/other-demo"
    };
    const pendingA = [pendingImportRecovery("import-A")];
    const pendingB = [pendingImportRecovery("import-B")];
    const rollback = deferred<void>();
    let activePending = pendingA;
    const api = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project, otherProject]),
      getDesktopProjectSnapshot: vi
        .fn()
        .mockImplementation(async () =>
          projectSnapshot({ pendingImportRecoveries: activePending })
        ),
      rollbackPendingImportRecovery: vi.fn().mockReturnValue(rollback.promise),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", api);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const setError = vi.fn();
    const { result, rerender } = renderHook(
      ({ home }) =>
        useDesktopProject({
          planweaveHome: home,
          autoSelectInitialProject: false,
          setError,
          t: createTranslator("en"),
          updateSettings: vi.fn()
        }),
      { initialProps: { home: "/home-A" } }
    );
    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => result.current.loadProject(project));
    let operation: Promise<unknown> | undefined;
    act(() => {
      operation = result.current.rollbackPendingImportRecovery("import-A");
    });
    if (scope === "home") {
      rerender({ home: "/home-B" });
      await waitFor(() => expect(result.current.projectLoading).toBe(false));
    }
    activePending = pendingB;
    await act(async () => result.current.loadProject(otherProject));
    vi.mocked(api.getDesktopProjectSnapshot).mockClear();
    vi.mocked(api.listProjects).mockClear();
    setError.mockClear();
    await act(async () => {
      if (outcome === "success") rollback.resolve();
      else rollback.reject(new Error("late A rollback failure"));
      await operation;
    });
    expect(result.current.selectedProject?.rootPath).toBe(otherProject.rootPath);
    expect(result.current.pendingImportRecoveries).toEqual(pendingB);
    expect(api.getDesktopProjectSnapshot).not.toHaveBeenCalled();
    expect(api.listProjects).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
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
        planweaveHome: "",
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
