// @vitest-environment jsdom

import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceValue } from "../renderer/ProjectWorkspaceProvider";
import { createTranslator } from "../renderer/i18n";
import type { ProjectWorkspaceShellInput } from "../renderer/projectWorkspaceShell";
import type { DesktopUiSettings } from "../renderer/types";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator";
import type {
  WorkspaceCanvasProjection,
  WorkspaceCanvasProjectionSignal
} from "../shared/workspaceCanvasProjection";
import { deferred } from "./helpers/desktopProjectFixtures";
import {
  bridges,
  cachedProjection,
  connectedWorkspaceStatus,
  installProviderHarness,
  locator,
  ProviderHarness,
  workspaceSettings
} from "./helpers/projectWorkspaceProviderHarness";

installProviderHarness();

function projectionFor(
  nextLocator: WorkspaceCanvasLocator,
  title: string
): WorkspaceCanvasProjection {
  const replica = cachedProjection();
  return {
    locator: nextLocator,
    status: "accepted",
    authorityMode: "offline_cache_readonly",
    readOnly: true,
    cachedAt: "2026-08-22T00:00:00.000Z",
    initialRuntimeAvailability: null,
    conflict: null,
    rejectCode: null,
    replica: {
      ...replica,
      workspaceId: nextLocator.workspaceId,
      projectId: nextLocator.projectId,
      canvasId: nextLocator.canvasId,
      content: { ...replica.content, projectTitle: title }
    }
  };
}

function editableProjectionFor(title: string): WorkspaceCanvasProjection {
  const projection = projectionFor(locator, title);
  return {
    ...projection,
    authorityMode: "server_authoritative",
    readOnly: false,
    cachedAt: null,
    replica: { ...projection.replica, canEdit: true }
  };
}

function authorizeCanvas(...locators: WorkspaceCanvasLocator[]) {
  bridges.status.current = connectedWorkspaceStatus();
  bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
    .fn()
    .mockResolvedValue({ items: [], nextCursor: null });
  bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi.fn().mockResolvedValue({
    items: locators.map((item) => ({
      registry: {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        canvasId: item.canvasId
      }
    })),
    nextCursor: null
  });
}

describe("Provider Workspace Canvas session authority", () => {
  it.each([
    "Home",
    "credential"
  ] as const)("ignores an old Main projection broadcast in the new %s subscription until its own open completes", async (change) => {
    authorizeCanvas(locator);
    const oldOpen = deferred<WorkspaceCanvasProjection>();
    const currentOpen = deferred<WorkspaceCanvasProjection>();
    const open = vi
      .fn()
      .mockImplementationOnce(() => oldOpen.promise)
      .mockImplementationOnce(() => currentOpen.promise);
    bridges.collaboration.target.openWorkspaceCanvasSession = open;
    const listeners = new Set<(signal: WorkspaceCanvasProjectionSignal) => void>();
    bridges.collaboration.target.onWorkspaceCanvasProjectionSignal = vi.fn(
      (listener: (signal: WorkspaceCanvasProjectionSignal) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    );
    const broadcast = (projection: WorkspaceCanvasProjection) => {
      for (const listener of listeners) {
        listener({ type: "workspace.canvas.projection", projection });
      }
    };
    let current: ProjectWorkspaceValue | null = null;
    let updateSettings: ProjectWorkspaceShellInput["updateSettings"] | null = null;
    const props = {
      initialSettings: workspaceSettings(),
      onSettings: vi.fn(),
      onValue: (value: ProjectWorkspaceValue) => {
        current = value;
      },
      onUpdateSettings: (update: ProjectWorkspaceShellInput["updateSettings"]) => {
        updateSettings = update;
      }
    };
    const mounted = render(<ProviderHarness {...props} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));

    if (change === "Home") {
      act(() => updateSettings!({ planweaveHome: "/tmp/another-planweave-home" }));
    } else {
      const status = connectedWorkspaceStatus();
      bridges.status.current = {
        ...status,
        profiles: status.profiles.map((profile) => ({
          ...profile,
          credentialRevision: "workspace-credential-2"
        })),
        workspaceConnection: status.workspaceConnection && {
          ...status.workspaceConnection,
          credentialRevision: "workspace-credential-2"
        }
      };
      mounted.rerender(<ProviderHarness {...props} />);
    }
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(listeners.size).toBe(1);
    await act(async () => {
      const projection = projectionFor(locator, "Old Main authority");
      oldOpen.resolve(projection);
      await oldOpen.promise;
      broadcast(projection);
    });
    expect(current?.graphWorkspace.graph).toBeNull();

    await act(async () => {
      currentOpen.resolve(projectionFor(locator, "Current authority"));
      await currentOpen.promise;
    });
    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Current authority")
    );
    act(() => broadcast(projectionFor(locator, "Current authority signal")));
    expect(current?.graphWorkspace.graph?.projectTitle).toBe("Current authority signal");
  });

  it.each([
    { change: "Home", settlement: "accepted" },
    { change: "credential", settlement: "throw" }
  ] as const)("retires an in-flight submit after a real $change change and late $settlement", async ({
    change,
    settlement
  }) => {
    const { useProjectWorkspaceAuthority } = await import(
      "../renderer/hooks/useProjectWorkspaceAuthority"
    );
    authorizeCanvas(locator);
    let openCount = 0;
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn(async () =>
      editableProjectionFor(++openCount === 1 ? "Original authority" : "Current authority")
    );
    const oldSubmission = deferred<WorkspaceCanvasProjection>();
    const submit = vi.fn(() => oldSubmission.promise);
    bridges.collaboration.target.submitWorkspaceCanvasCommand = submit;
    const setError = vi.fn();
    const t = createTranslator("en");
    const updateSettings = vi.fn();
    const initialSettings = workspaceSettings();
    const hook = renderHook(
      ({ settings }: { settings: DesktopUiSettings }) =>
        useProjectWorkspaceAuthority({
          activeView: "graph",
          settings,
          settingsHydrated: true,
          setActiveView: vi.fn(),
          setError,
          setSuccessMessage: vi.fn(),
          t,
          updateSettings
        }),
      { initialProps: { settings: initialSettings } }
    );
    await waitFor(() =>
      expect(hook.result.current.workspaceCanvasCommands.projection?.content.projectTitle).toBe(
        "Original authority"
      )
    );
    let pending!: ReturnType<typeof hook.result.current.workspaceCanvasCommands.submit>;
    act(() => {
      pending = hook.result.current.workspaceCanvasCommands.submit({
        intent: {
          kind: "update_task_fields",
          taskId: "T-001",
          fields: { executor: "codex" }
        }
      });
    });
    expect(submit).toHaveBeenCalledOnce();

    if (change === "Home") {
      hook.rerender({
        settings: { ...initialSettings, planweaveHome: "/tmp/another-planweave-home" }
      });
    } else {
      const status = connectedWorkspaceStatus();
      bridges.status.current = {
        ...status,
        profiles: status.profiles.map((profile) => ({
          ...profile,
          credentialRevision: "workspace-credential-2"
        })),
        workspaceConnection: status.workspaceConnection && {
          ...status.workspaceConnection,
          credentialRevision: "workspace-credential-2"
        }
      };
      hook.rerender({ settings: initialSettings });
    }
    await act(async () => {
      if (settlement === "accepted") {
        oldSubmission.resolve(editableProjectionFor("Retired accepted submit"));
      } else {
        oldSubmission.reject(new Error("retired_submit_error"));
      }
      await pending;
    });
    await expect(pending).resolves.toEqual({
      status: "retired",
      ok: false,
      error: null,
      staleConflict: null
    });
    await waitFor(() =>
      expect(hook.result.current.workspaceCanvasCommands.projection?.content.projectTitle).toBe(
        "Current authority"
      )
    );
    expect(hook.result.current.workspaceCanvasCommands.projection?.content.projectTitle).toBe(
      "Current authority"
    );
    expect(hook.result.current.workspaceCanvasCommands.snapshot.lastError).toBeNull();
    expect(setError).not.toHaveBeenCalledWith("retired_submit_error");
  });

  it.each([
    "Home",
    "credential"
  ] as const)("retires the old %s session even when the Canvas locator and connection remain the same", async (change) => {
    authorizeCanvas(locator);
    const oldOpen = deferred<WorkspaceCanvasProjection>();
    const open = vi
      .fn()
      .mockImplementationOnce(() => oldOpen.promise)
      .mockImplementation(async () => projectionFor(locator, "Current authority"));
    bridges.collaboration.target.openWorkspaceCanvasSession = open;
    bridges.collaboration.target.reconnectWorkspaceCanvasSession = vi
      .fn()
      .mockResolvedValue(projectionFor(locator, "Unexpected reconnect"));
    const onError = vi.fn();
    let current: ProjectWorkspaceValue | null = null;
    let updateSettings: ProjectWorkspaceShellInput["updateSettings"] | null = null;
    const props = {
      initialSettings: workspaceSettings(),
      onError,
      onSettings: vi.fn(),
      onValue: (value: ProjectWorkspaceValue) => {
        current = value;
      },
      onUpdateSettings: (update: ProjectWorkspaceShellInput["updateSettings"]) => {
        updateSettings = update;
      }
    };
    const mounted = render(<ProviderHarness {...props} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const retainedRefresh = current!.graphWorkspace.onRefreshWorkspaceCanvas;
    expect(retainedRefresh).toBeDefined();

    if (change === "Home") {
      act(() => updateSettings!({ planweaveHome: "/tmp/another-planweave-home" }));
    } else {
      const status = connectedWorkspaceStatus();
      bridges.status.current = {
        ...status,
        profiles: status.profiles.map((profile) => ({
          ...profile,
          credentialRevision: "workspace-credential-2"
        })),
        workspaceConnection: status.workspaceConnection && {
          ...status.workspaceConnection,
          credentialRevision: "workspace-credential-2"
        }
      };
      mounted.rerender(<ProviderHarness {...props} />);
    }

    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Current authority")
    );
    await act(async () => {
      if (change === "Home") {
        oldOpen.resolve(projectionFor(locator, "Retired authority"));
      } else {
        oldOpen.reject(new Error("retired_credential_error"));
      }
      await oldOpen.promise.catch(() => undefined);
    });
    expect(current?.graphWorkspace.graph?.projectTitle).toBe("Current authority");
    expect(onError).not.toHaveBeenCalledWith("retired_credential_error");
    await expect(retainedRefresh!()).resolves.toBe(false);
    expect(bridges.collaboration.target.reconnectWorkspaceCanvasSession).not.toHaveBeenCalled();
  });

  it("does not reconnect from a retained A callback after navigating A to B to A", async () => {
    const otherLocator = { ...locator, canvasId: "canvas-b" };
    authorizeCanvas(locator, otherLocator);
    let aOpenCount = 0;
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn(async (requested) =>
      projectionFor(
        requested,
        requested.canvasId === otherLocator.canvasId
          ? "Canvas B"
          : ++aOpenCount === 1
            ? "Canvas A first"
            : "Canvas A current"
      )
    );
    bridges.collaboration.target.reconnectWorkspaceCanvasSession = vi
      .fn()
      .mockResolvedValue(projectionFor(locator, "Unexpected reconnect"));
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={workspaceSettings()}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() => expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas A first"));
    const retainedRefresh = current!.graphWorkspace.onRefreshWorkspaceCanvas!;
    act(() => current!.shell.openWorkspaceCanvasLocator(otherLocator));
    await waitFor(() => expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas B"));
    act(() => current!.shell.openWorkspaceCanvasLocator(locator));
    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas A current")
    );

    await expect(retainedRefresh()).resolves.toBe(false);
    expect(bridges.collaboration.target.reconnectWorkspaceCanvasSession).not.toHaveBeenCalled();
    expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas A current");
  });

  it("ignores a reconnect result started before an A to B to A navigation", async () => {
    const otherLocator = { ...locator, canvasId: "canvas-b" };
    authorizeCanvas(locator, otherLocator);
    let aOpenCount = 0;
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn(async (requested) =>
      projectionFor(
        requested,
        requested.canvasId === otherLocator.canvasId
          ? "Canvas B"
          : ++aOpenCount === 1
            ? "Canvas A first"
            : "Canvas A current"
      )
    );
    const oldReconnect = deferred<WorkspaceCanvasProjection>();
    bridges.collaboration.target.reconnectWorkspaceCanvasSession = vi.fn(
      () => oldReconnect.promise
    );
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={workspaceSettings()}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() => expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas A first"));
    const pending = current!.graphWorkspace.onRefreshWorkspaceCanvas!();
    expect(bridges.collaboration.target.reconnectWorkspaceCanvasSession).toHaveBeenCalledWith(
      locator
    );
    act(() => current!.shell.openWorkspaceCanvasLocator(otherLocator));
    await waitFor(() => expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas B"));
    act(() => current!.shell.openWorkspaceCanvasLocator(locator));
    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas A current")
    );
    await act(async () => {
      oldReconnect.resolve(projectionFor(locator, "Retired reconnect"));
      await pending;
    });
    await expect(pending).resolves.toBe(false);
    expect(current?.graphWorkspace.graph?.projectTitle).toBe("Canvas A current");
  });
});
