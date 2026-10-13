/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopPackageFileChangeEvent,
  DesktopRuntimeStateChangeEvent,
  DesktopWatchRegistration
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { graph } from "./helpers/graphFixtures";

afterEach(cleanupRendererTestEnvironment);

const projectA = { ...project, workspaceRoot: "/home-a/projects/shared" };
const projectB = { ...project, workspaceRoot: "/home-b/projects/shared" };
const syncResult = {
  ok: true,
  fullRefresh: false,
  primed: false,
  diagnostics: [],
  dirtyPromptRefs: [],
  affectedTasks: [],
  refreshedPromptCount: 0,
  refreshConcurrency: 4
};

async function setup() {
  const runtimeListeners = new Set<(event: DesktopRuntimeStateChangeEvent) => void>();
  const packageListeners = new Set<(event: DesktopPackageFileChangeEvent) => void>();
  const api = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([]),
    getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
    getGraphViewModel: vi.fn().mockResolvedValue(graph),
    watchPackageFiles: vi.fn().mockResolvedValue(undefined),
    watchRuntimeState: vi.fn().mockResolvedValue(undefined),
    refreshPackageFileChanges: vi.fn().mockResolvedValue(syncResult),
    onRuntimeStateChanged: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    onPackageFileChanged: (listener) => {
      packageListeners.add(listener);
      return () => packageListeners.delete(listener);
    }
  });
  vi.stubGlobal("planweave", api);
  vi.resetModules();
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");
  const setError = vi.fn();
  const setFileSyncResult = vi.fn();
  const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
  const updateSettings = vi.fn();
  const t = createTranslator("en");
  const hook = renderHook(
    ({ home }) => {
      const state = useDesktopProject({ planweaveHome: home, setError, updateSettings, t });
      usePackageFileSync({
        selectedProject: state.selectedProject,
        selectedCanvasId: state.selectedCanvasId,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        refreshProjectDerivedState,
        setError,
        setFileSyncDiagnostics: vi.fn(),
        setFileSyncResult,
        setLastFileChange: vi.fn()
      });
      return state;
    },
    { initialProps: { home: "/home-a" } }
  );
  await waitFor(() => expect(hook.result.current.projectLoading).toBe(false));
  await act(async () => hook.result.current.loadProject(projectA));
  const registration = (kind: "runtime" | "package"): DesktopWatchRegistration => {
    const calls =
      kind === "runtime"
        ? vi.mocked(api.watchRuntimeState).mock.calls
        : vi.mocked(api.watchPackageFiles).mock.calls;
    const ref = calls.at(-1)?.[0];
    if (!ref) throw new Error("Expected an admitted watch registration.");
    return ref;
  };
  const emit = (kind: "runtime" | "package", ref: DesktopWatchRegistration) => {
    if (kind === "runtime") {
      const event = {
        ...ref,
        canvasId: ref.canvasId ?? null,
        stateFile: "state.json",
        changedAt: "2026-10-13T00:00:00Z"
      };
      for (const listener of runtimeListeners) listener(event);
    } else {
      const event = {
        ...ref,
        paths: ["package/manifest.json"],
        triggeredAt: "2026-10-13T00:00:00Z"
      };
      for (const listener of packageListeners) listener(event);
    }
  };
  const switchHome = async (home: string) => {
    hook.rerender({ home });
    await act(async () =>
      hook.result.current.loadProject(home === "/home-b" ? projectB : projectA)
    );
  };
  return {
    ...hook,
    api,
    registration,
    emit,
    switchHome,
    setError,
    setFileSyncResult,
    refreshProjectDerivedState
  };
}

describe("renderer watch registration lifecycle", () => {
  it.each([
    "runtime",
    "package"
  ] as const)("drops retired %s events across shared-source Home switches and ABA", async (kind) => {
    const h = await setup();
    const firstA = h.registration(kind);
    await h.switchHome("/home-b");
    const firstB = h.registration(kind);
    await h.switchHome("/home-a");
    const currentA = h.registration(kind);
    vi.mocked(h.api.getGraphViewModel).mockClear();
    vi.mocked(h.api.refreshPackageFileChanges).mockClear();
    h.setFileSyncResult.mockClear();
    await act(async () => {
      h.emit(kind, firstA);
      h.emit(kind, firstB);
    });
    expect(h.api.getGraphViewModel).not.toHaveBeenCalled();
    expect(h.api.refreshPackageFileChanges).not.toHaveBeenCalled();
    expect(h.setFileSyncResult).not.toHaveBeenCalled();
    expect(
      new Set([firstA.registrationId, firstB.registrationId, currentA.registrationId]).size
    ).toBe(3);
    await act(async () => h.emit(kind, currentA));
    if (kind === "runtime") expect(h.api.getGraphViewModel).toHaveBeenCalledOnce();
    else expect(h.api.refreshPackageFileChanges).toHaveBeenCalledOnce();
  });

  it("lets a new workspace refresh complete while the old workspace's request remains pending", async () => {
    const h = await setup();
    const pending = deferred<typeof syncResult>();
    vi.mocked(h.api.refreshPackageFileChanges).mockReturnValueOnce(pending.promise);
    try {
      act(() => h.emit("package", h.registration("package")));
      await h.switchHome("/home-b");
      h.setFileSyncResult.mockClear();
      await act(async () => h.emit("package", h.registration("package")));
      expect(h.setFileSyncResult).toHaveBeenCalledOnce();
      await act(async () => pending.resolve({ ...syncResult, ok: false, diagnostics: [] }));
      expect(h.setFileSyncResult).toHaveBeenCalledOnce();
      expect(h.setError).not.toHaveBeenCalledWith("");
    } finally {
      await act(async () => pending.resolve(syncResult));
    }
  });
});
