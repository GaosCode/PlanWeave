/* @vitest-environment jsdom */

import { workspaceCanvasLocatorSchema } from "../shared/canvasLocator";
import type {
  NotificationScope,
  NotificationNavigationContext
} from "../renderer/notificationIdentity";
import { useState } from "react";
import type { DesktopUiSettings, DesktopSettingsUpdate } from "../renderer/types";
import { graph } from "./helpers/graphFixtures";
import { project } from "./helpers/desktopProjectFixtures";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { useNotificationController } from "../renderer/controllers/NotificationController";
import { createTranslator } from "../renderer/i18n";
import { autoRunState } from "./helpers/autoRunControlHarness";

afterEach(cleanupRendererTestEnvironment);

function controllerArgs() {
  return {
    applyLocalPromptConflicts: vi.fn().mockResolvedValue(undefined),
    autoRunState: autoRunState({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/projects/authority/results/metadata.json"
    }),
    fileSyncDiagnostics: [],
    graph: null,
    handleRevealPathInFinder: vi.fn().mockResolvedValue(undefined),
    keepLocalPromptConflicts: vi.fn(),
    lastFileChange: null,
    graphScope: null,
    navigationContext: null,
    openRunWorkspace: vi.fn().mockResolvedValue(undefined),
    openTaskWorkspace: vi.fn(),
    pendingImportRecoveries: [],
    promptConflicts: [],
    reloadPromptConflicts: vi.fn().mockResolvedValue(undefined),
    rollbackPendingImportRecovery: vi.fn().mockResolvedValue({ status: "rolledBack" }),
    setError: vi.fn(),
    setSuccessMessage: vi.fn(),
    settings: defaultDesktopSettings,
    t: createTranslator("en"),
    updateSettings: vi.fn()
  };
}

describe("notification navigation controller", () => {
  it("delegates direct and lookup intents without deriving identity from display text", async () => {
    const args = controllerArgs();
    const { result } = renderHook(() => useNotificationController(args));
    const latest = result.current.notificationItems.find((item) =>
      item.id.startsWith("latest-record:")
    );
    if (!latest) {
      throw new Error("Expected latest record notification.");
    }

    await act(async () => {
      await result.current.onOpenNotification(latest);
      await result.current.onOpenNotification({
        id: "direct",
        title: "display title",
        detail: "not an identity",
        tone: "secondary",
        read: false,
        navigationIntent: {
          kind: "task-workspace",
          target: {
            projectRoot: "/projects/direct",
            canvasId: "canvas-direct",
            taskId: "T-DIRECT"
          }
        }
      });
    });

    expect(args.openRunWorkspace).toHaveBeenCalledWith({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      recordId: "T-001#B-001::RUN-001"
    });
    expect(args.openTaskWorkspace).toHaveBeenCalledWith({
      projectRoot: "/projects/direct",
      canvasId: "canvas-direct",
      taskId: "T-DIRECT"
    });
  });

  it("surfaces record authority rejection without navigating successfully", async () => {
    const args = controllerArgs();
    args.openRunWorkspace.mockRejectedValueOnce(new Error("Run record response mismatched."));
    const { result } = renderHook(() => useNotificationController(args));
    const latest = result.current.notificationItems.find((item) =>
      item.id.startsWith("latest-record:")
    );
    if (!latest) {
      throw new Error("Expected latest record notification.");
    }

    await act(async () => result.current.onOpenNotification(latest));

    expect(args.setError).toHaveBeenCalledWith("Run record response mismatched.");
  });
});

describe("notification controller read persistence", () => {
  it("keeps A read across B, return to A and remount while navigating to the original target", async () => {
    let persisted: DesktopUiSettings = {
      ...defaultDesktopSettings,
      readNotificationIds: ["dirty-T-ALPHA"]
    };
    const args = controllerArgs();
    const mount = (canvasId: string) =>
      renderHook(
        ({ canvasId }) => {
          const [settings, setSettings] = useState(persisted);
          const updateSettings = (update: DesktopSettingsUpdate) =>
            setSettings((current) => {
              persisted = {
                ...current,
                ...(typeof update === "function" ? update(current) : update)
              };
              return persisted;
            });
          return useNotificationController({
            ...args,
            autoRunState: null,
            graph: { ...graph, dirtyPromptRefs: ["T-ALPHA"] },
            graphScope: { projectRoot: "/projects/a", canvasId },
            navigationContext: { projectRoot: "/projects/a", canvasId },
            settings,
            updateSettings
          });
        },
        { initialProps: { canvasId } }
      );
    const hook = mount("A");
    expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(1);
    const itemA = hook.result.current.notificationItems[0];
    act(() => hook.result.current.onMarkNotificationRead(itemA.id));
    expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(0);
    hook.rerender({ canvasId: "B" });
    expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(1);
    await act(async () =>
      hook.result.current.onOpenNotification(hook.result.current.notificationItems[0])
    );
    expect(args.openTaskWorkspace).toHaveBeenCalledWith({
      projectRoot: "/projects/a",
      canvasId: "B",
      taskId: "T-ALPHA"
    });
    hook.rerender({ canvasId: "A" });
    expect(hook.result.current.notificationItems[0].read).toBe(true);
    expect(persisted.readNotificationIds).toEqual(["dirty-T-ALPHA", itemA.id]);
    hook.unmount();
    const restored = mount("A");
    expect(restored.result.current.notificationItems[0].read).toBe(true);
    restored.rerender({ canvasId: "B" });
    expect(restored.result.current.notificationItems[0].read).toBe(false);
    restored.unmount();
  });

  it("retains late A execution read state in B and opens the A authority record", async () => {
    const args = controllerArgs();
    const hook = renderHook(
      ({ canvasId, state, settings }) =>
        useNotificationController({
          ...args,
          autoRunState: state,
          settings,
          navigationContext: { projectRoot: "/projects/authority", canvasId }
        }),
      {
        initialProps: { canvasId: "A", state: args.autoRunState, settings: defaultDesktopSettings }
      }
    );
    const ids = hook.result.current.notificationItems.map((item) => item.id);
    hook.rerender({
      canvasId: "B",
      state: { ...args.autoRunState, updatedAt: "later" },
      settings: { ...defaultDesktopSettings, readNotificationIds: ids }
    });
    expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(0);
    await act(async () =>
      hook.result.current.onOpenNotification(hook.result.current.notificationItems[0])
    );
    expect(args.openRunWorkspace).toHaveBeenCalledWith({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      recordId: "T-001#B-001::RUN-001"
    });
    hook.rerender({
      canvasId: "B",
      state: { ...args.autoRunState, canvasId: "B" },
      settings: { ...defaultDesktopSettings, readNotificationIds: ids }
    });
    expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(1);
    hook.unmount();
  });
});

describe("notification scope producers", () => {
  it("does not reuse completed file diagnostics when switching project/canvas", async () => {
    const syncBridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: false,
        primed: false,
        fullRefresh: false,
        affectedTasks: [],
        dirtyPromptRefs: [],
        refreshedPromptCount: 0,
        refreshConcurrency: null,
        diagnostics: [{ code: "file_conflict", message: "A conflict", path: "prompt.md" }]
      })
    });
    vi.stubGlobal("planweave", syncBridge);
    vi.resetModules();
    const { useFileSyncController } = await import("../renderer/controllers/AutoRunController");
    const hook = renderHook(
      ({ canvasId, selectedProject }) =>
        useFileSyncController({
          projectDiagnostics: [],
          refreshProjectDerivedState: async () => {},
          reloadCurrentCanvas: async () => {},
          selectedCanvasId: canvasId,
          selectedProject,
          setError: vi.fn(),
          t: createTranslator("en")
        }),
      { initialProps: { canvasId: "A", selectedProject: project } }
    );
    await act(async () => hook.result.current.refreshPackageFiles());
    expect(hook.result.current.fileSyncDiagnostics).toEqual(["A conflict"]);
    hook.rerender({ canvasId: "B", selectedProject: project });
    expect(hook.result.current.fileSyncDiagnostics).toEqual([]);
    hook.rerender({ canvasId: "A", selectedProject: { ...project, rootPath: "/projects/other" } });
    expect(hook.result.current.fileSyncDiagnostics).toEqual([]);
    hook.rerender({ canvasId: "A", selectedProject: project });
    expect(hook.result.current.fileSyncDiagnostics).toEqual(["A conflict"]);
  });

  it("carries task draft conflict origin to notifications even when another canvas is active", async () => {
    vi.stubGlobal("planweave", createDesktopBridgeMock());
    vi.resetModules();
    const { useTaskPromptDrafts } = await import("../renderer/hooks/useTaskPromptDrafts");
    const hook = renderHook(
      ({ currentGraph }) =>
        useTaskPromptDrafts({
          graph: currentGraph,
          selectedProject: project,
          selectedCanvasId: "A",
          refreshGraph: async () => {},
          setError: vi.fn(),
          workspaceCanvas: null
        }),
      { initialProps: { currentGraph: graph } }
    );
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "local draft"));
    hook.rerender({
      currentGraph: {
        ...graph,
        tasks: graph.tasks.map((task) => ({ ...task, promptMarkdown: "remote changed" }))
      }
    });
    const conflict = hook.result.current.promptConflicts[0];
    expect(conflict).toMatchObject({ projectRoot: project.rootPath, canvasId: "A" });
    const args = controllerArgs();
    const notifications = renderHook(
      ({ canvasId }) =>
        useNotificationController({
          ...args,
          autoRunState: null,
          promptConflicts: [conflict],
          navigationContext: { projectRoot: project.rootPath, canvasId }
        }),
      { initialProps: { canvasId: "A" } }
    );
    const originalId = notifications.result.current.notificationItems[0].id;
    notifications.rerender({ canvasId: "B" });
    expect(notifications.result.current.notificationItems[0].id).toBe(originalId);
  });
});

describe("Workspace notification scope identity", () => {
  it("isolates all locator dimensions and Local read state without requiring navigation, across remount", async () => {
    const remote = workspaceCanvasLocatorSchema.parse({
      kind: "workspace",
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });
    const scopes: NotificationScope[] = [
      remote,
      { ...remote, connectionProfileId: "profile-2" },
      workspaceCanvasLocatorSchema.parse({ ...remote, workspaceId: "workspace-2" }),
      { ...remote, projectId: "project-2" },
      { ...remote, canvasId: "canvas-2" },
      { projectRoot: "/projects/local", canvasId: "canvas-1" }
    ];
    let persisted = defaultDesktopSettings;
    const args = controllerArgs();
    const exceptionGraph = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        exceptions: [
          { ref: task.taskId, reason: "remote runtime failed", source: "blocked" as const }
        ]
      }))
    };
    const mount = (scope: NotificationScope, navigation: NotificationNavigationContext | null) =>
      renderHook(
        ({
          scope,
          navigation
        }: {
          scope: NotificationScope;
          navigation: NotificationNavigationContext | null;
        }) => {
          const [settings, setSettings] = useState(persisted);
          return useNotificationController({
            ...args,
            autoRunState: null,
            graph: exceptionGraph,
            graphScope: scope,
            navigationContext: navigation,
            settings,
            updateSettings: (update) =>
              setSettings((current) => {
                persisted = {
                  ...current,
                  ...(typeof update === "function" ? update(current) : update)
                };
                return persisted;
              })
          });
        },
        { initialProps: { scope, navigation } }
      );
    const hook = mount(remote, remote);
    expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(2);
    const original = hook.result.current.notificationItems[0];
    act(() =>
      hook.result.current.notificationItems.forEach((item) => {
        hook.result.current.onMarkNotificationRead(item.id);
      })
    );
    expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(0);
    const ids = [original.id];
    for (const scope of scopes.slice(1)) {
      hook.rerender({ scope, navigation: null });
      expect(hook.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(2);
      expect(hook.result.current.notificationItems[0].navigationIntent).toBeUndefined();
      ids.push(hook.result.current.notificationItems[0].id);
    }
    expect(new Set(ids).size).toBe(scopes.length);
    await act(async () => hook.result.current.onOpenNotification(original));
    expect(args.openTaskWorkspace).toHaveBeenCalledWith({
      authority: "workspace",
      connectionProfileId: remote.connectionProfileId,
      workspaceId: remote.workspaceId,
      projectId: remote.projectId,
      canvasId: remote.canvasId,
      taskId: "T-ALPHA"
    });
    hook.unmount();
    const restored = mount(remote, null);
    expect(restored.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(0);
    restored.rerender({
      scope: workspaceCanvasLocatorSchema.parse({ ...remote, workspaceId: "workspace-2" }),
      navigation: null
    });
    expect(restored.result.current.notificationItems.filter((item) => !item.read)).toHaveLength(2);
    restored.unmount();
  });
});
