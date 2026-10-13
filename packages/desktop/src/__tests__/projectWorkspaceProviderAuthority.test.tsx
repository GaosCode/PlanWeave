// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceCanvasProjectionSignal } from "../shared/workspaceCanvasProjection";
import type { ProjectWorkspaceValue } from "../renderer/ProjectWorkspaceProvider";
import type { ProjectWorkspaceShellInput } from "../renderer/projectWorkspaceShell";
import { graph } from "./helpers/graphFixtures";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import type { DesktopUiSettings } from "../renderer/types";
import {
  bridges,
  endpointCatalogProbe,
  locator,
  ProviderHarness,
  workspaceSettings,
  cachedProjection,
  connectedWorkspaceStatus,
  installProviderHarness
} from "./helpers/projectWorkspaceProviderHarness";

installProviderHarness();

describe("ProjectWorkspaceProvider startup authority", () => {
  it.each([
    null,
    "unrelated_operation_failure"
  ])("retires only its own Canvas error and preserves %s", async (unrelatedError) => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn(async (requested) => {
      if (requested.canvasId === locator.canvasId) throw new Error("current_canvas_failure");
      return {
        locator: requested,
        status: "accepted",
        authorityMode: "offline_cache_readonly",
        readOnly: true,
        cachedAt: "2026-08-22T00:00:00.000Z",
        conflict: null,
        rejectCode: null,
        replica: { ...cachedProjection(), canvasId: requested.canvasId }
      };
    });
    let error: string | null = null;
    const onError: ProjectWorkspaceShellInput["setError"] = (update) => {
      error = typeof update === "function" ? update(error) : update;
    };
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={workspaceSettings()}
        onError={onError}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() => expect(error).toBe("current_canvas_failure"));
    if (unrelatedError) error = unrelatedError;
    act(() => current!.shell.openWorkspaceCanvasLocator({ ...locator, canvasId: "canvas-next" }));
    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Cached Workspace")
    );
    expect(error).toBe(unrelatedError);
  });

  it.each([
    false,
    true
  ])("shows Task and Block comment entry points on a Workspace canvas without a Local selection (connected=%s)", async (connected) => {
    const replica = cachedProjection();
    const task = graph.tasks[0]!;
    const block = {
      ref: `${task.taskId}#B-001`,
      blockId: "B-001",
      type: "implementation" as const,
      title: "Implementation",
      status: "ready" as const,
      executor: null,
      requiredCapabilities: [],
      promptMissing: false,
      exceptionReason: null,
      dispatchable: false,
      remoteExecution: null
    };
    replica.content.tasks = [{ ...task, blocks: [block], blockPreview: [block] }];
    if (connected) {
      bridges.status.current = connectedWorkspaceStatus();
      bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
        .fn()
        .mockResolvedValue({ items: [], nextCursor: null });
      bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi.fn().mockResolvedValue({
        items: [
          {
            registry: {
              workspaceId: locator.workspaceId,
              projectId: locator.projectId,
              canvasId: locator.canvasId
            }
          }
        ],
        nextCursor: null
      });
    }
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: connected ? "server_authoritative" : "offline_cache_readonly",
      readOnly: !connected,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica
    });
    render(
      <ProviderHarness
        initialSettings={workspaceSettings()}
        onSettings={vi.fn()}
        onValue={vi.fn()}
        showGraph
      />
    );
    await screen.findByDisplayValue(task.title);
    const commentTriggers = screen.getAllByTestId("work-item-comments-trigger");
    expect(commentTriggers).toHaveLength(2);
    fireEvent.click(commentTriggers[0]!);
    await screen.findByTestId("work-item-comments-popover");
    expect(
      screen.getByTestId("work-item-collaboration-panel").getAttribute("data-work-item-kind")
    ).toBe("task");
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a persisted Workspace cache authoritative after the Local project list resolves", async () => {
    const replica = cachedProjection();
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica
    });
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

    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Cached Workspace")
    );
    expect(current?.graphWorkspace.workspaceCanvasOffline).toBe(true);
    expect(current?.graphWorkspace.runtimeAvailability).toEqual({
      kind: "checking"
    });
    expect(bridges.desktop.target.listProjects).toHaveBeenCalled();
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
    expect(bridges.collaboration.target.openWorkspaceCanvasSession).toHaveBeenCalledWith(locator);
    expect(Reflect.has(bridges.collaboration.target, "submitWorkspaceCanvasCommand")).toBe(false);
  });

  it("keeps the remote identity and surfaces a missing-cache error without Local fallback", async () => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi
      .fn()
      .mockRejectedValue(new Error("workspace_canvas_offline_cache_unavailable"));
    const onError = vi.fn();
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    render(
      <ProviderHarness
        initialSettings={settings}
        onError={onError}
        onSettings={(next) => {
          settings = next;
        }}
        onValue={(value) => {
          current = value;
        }}
      />
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("workspace_canvas_offline_cache_unavailable")
    );
    expect(settings.lastOpenedWorkspaceLocator).toEqual(locator);
    expect(current?.graphWorkspace.graph).toBeNull();
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("replaces the persisted Workspace authority when the user explicitly opens Local", async () => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica: cachedProjection()
    });
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    const onSettings = (next: DesktopUiSettings) => {
      settings = next;
    };
    const mounted = render(
      <ProviderHarness
        initialSettings={settings}
        onSettings={onSettings}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() => expect(current?.graphWorkspace.workspaceCanvasOffline).toBe(true));

    await act(async () => {
      await current?.shell.loadProject(project, "canvas-main");
    });
    await waitFor(() => expect(settings.lastOpenedWorkspaceLocator).toBeNull());
    expect(bridges.desktop.target.getDesktopProjectSnapshot).toHaveBeenCalled();

    mounted.unmount();
    vi.mocked(bridges.desktop.target.getDesktopProjectSnapshot).mockClear();
    vi.mocked(bridges.collaboration.target.openWorkspaceCanvasSession).mockClear();
    render(
      <ProviderHarness
        initialSettings={settings}
        onSettings={onSettings}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() =>
      expect(bridges.desktop.target.getDesktopProjectSnapshot).toHaveBeenCalled()
    );
    expect(bridges.collaboration.target.openWorkspaceCanvasSession).not.toHaveBeenCalled();
  });

  it("drops a revoked cached locator after reconnect authorization completes", async () => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica: cachedProjection()
    });
    bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    const props = {
      initialSettings: settings,
      onSettings: (next: DesktopUiSettings) => {
        settings = next;
      },
      onValue: (value: ProjectWorkspaceValue) => {
        current = value;
      }
    };
    const mounted = render(<ProviderHarness {...props} />);
    await waitFor(() => expect(current?.graphWorkspace.workspaceCanvasOffline).toBe(true));

    bridges.status.current = connectedWorkspaceStatus();
    mounted.rerender(<ProviderHarness {...props} />);

    await waitFor(() => expect(settings.lastOpenedWorkspaceLocator).toBeNull());
    await waitFor(() => expect(current?.graphWorkspace.graph).toBeNull());
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("keeps normal Local startup when no Workspace authority is persisted", async () => {
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={{
          ...workspaceSettings(),
          lastOpenedWorkspaceLocator: null
        }}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );

    await waitFor(() =>
      expect(bridges.desktop.target.getDesktopProjectSnapshot).toHaveBeenCalled()
    );
    await waitFor(() => expect(current?.shell.selectedProject?.projectId).toBe(project.projectId));
    expect(Reflect.has(bridges.collaboration.target, "openWorkspaceCanvasSession")).toBe(false);
  });

  it("loads the Local canvas endpoint catalog with the graph authority project id", async () => {
    bridges.desktop.target.getDesktopProjectSnapshot = vi.fn().mockResolvedValue(
      projectSnapshot({
        graph: { ...projectSnapshot().graph, projectId: "authority-project-1" }
      })
    );

    render(
      <ProviderHarness
        initialSettings={{ ...workspaceSettings(), lastOpenedWorkspaceLocator: null }}
        onSettings={vi.fn()}
        onValue={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(endpointCatalogProbe.input).toMatchObject({
        locator: { projectId: "authority-project-1", canvasId: "canvas-main" },
        enabled: true,
        operatorProfileId: "profile-remote-owner",
        fleetCatalogBlockedCode: null
      })
    );
  });

  it("refreshes the Server-authorized canvas catalog with the Local project catalog", async () => {
    bridges.status.current = connectedWorkspaceStatus();
    bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={{ ...workspaceSettings(), lastOpenedWorkspaceLocator: null }}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );

    await waitFor(() =>
      expect(
        bridges.collaboration.target.listCollaborationAuthorizedCanvases
      ).toHaveBeenCalledOnce()
    );
    vi.mocked(bridges.desktop.target.listProjects).mockClear();
    vi.mocked(bridges.collaboration.target.listCollaborationAuthorizedProjects).mockClear();
    vi.mocked(bridges.collaboration.target.listCollaborationAuthorizedCanvases).mockClear();

    await act(async () => {
      await current?.projectSidebar.handleRefreshProjects();
    });

    expect(bridges.desktop.target.listProjects).toHaveBeenCalledOnce();
    expect(bridges.collaboration.target.listCollaborationAuthorizedProjects).toHaveBeenCalledOnce();
    expect(bridges.collaboration.target.listCollaborationAuthorizedCanvases).toHaveBeenCalledOnce();
  });
});

describe("Workspace runtime exception notifications", () => {
  it.each([
    "blocked",
    "diverged"
  ] as const)("shows %s from the real Workspace authority and isolates remote switching while retiring late projections after Local opens", async (exceptionStatus) => {
    const replica = cachedProjection();
    const task = graph.tasks[0];
    const block = {
      ref: `${task.taskId}#B-001`,
      blockId: "B-001",
      type: "implementation" as const,
      title: "Implementation",
      status: "ready" as const,
      executor: null,
      requiredCapabilities: [],
      promptMissing: false,
      exceptionReason: null,
      dispatchable: false,
      remoteExecution: null
    };
    replica.content.tasks = [{ ...task, blocks: [block], blockPreview: [block] }];
    const runtimeStatus = {
      schemaVersion: "canvas-runtime-status/v2" as const,
      scope: {
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        canvasId: locator.canvasId
      },
      packageFingerprint: replica.content.packageFingerprint,
      capturedAt: "2026-08-22T00:00:00.000Z",
      tasks: [{ taskId: task.taskId, status: "ready" as const, openFeedbackCount: 0 }],
      blocks: [
        {
          ref: block.ref,
          status: exceptionStatus,
          completionReason: null,
          blockedReason: exceptionStatus === "blocked" ? "remote blocked" : null,
          divergenceReason: exceptionStatus === "diverged" ? "remote diverged" : null,
          dispatchable: false
        }
      ]
    };
    const projection = {
      locator,
      status: "accepted" as const,
      authorityMode: "server_authoritative" as const,
      readOnly: false,
      cachedAt: null,
      conflict: null,
      rejectCode: null,
      replica,
      initialRuntimeAvailability: {
        schemaVersion: "canvas-runtime-view/v2" as const,
        authority: {
          revision: 1,
          sourceRevision: "source-1",
          graphFingerprint: replica.content.packageFingerprint
        },
        state: { kind: "initialized" as const, runtimeRevision: 1, status: runtimeStatus },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1" as const,
          kind: "available" as const,
          status: runtimeStatus,
          sourceRevision: "source-1",
          graphFingerprint: replica.content.packageFingerprint
        }
      }
    };
    bridges.status.current = connectedWorkspaceStatus();
    bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi
      .fn()
      .mockResolvedValue({ items: [{ registry: runtimeStatus.scope }], nextCursor: null });
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue(projection);
    let lateSignal: ((signal: WorkspaceCanvasProjectionSignal) => void) | null = null;
    bridges.collaboration.target.onWorkspaceCanvasProjectionSignal = vi.fn((listener) => {
      lateSignal = listener;
      return () => undefined;
    });
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    const onValue = (value: ProjectWorkspaceValue) => {
      current = value;
    };
    const onSettings = (value: DesktopUiSettings) => {
      settings = value;
    };
    const mount = () =>
      render(
        <ProviderHarness initialSettings={settings} onSettings={onSettings} onValue={onValue} />
      );
    const mounted = mount();
    await waitFor(() => expect(current?.graphWorkspace.graph?.tasks[0].exceptions).toHaveLength(1));
    expect(current?.notifications.notificationItems).toHaveLength(1);
    const notification = current!.notifications.notificationItems[0];
    expect(notification.read).toBe(false);
    expect(notification.navigationIntent).toEqual({
      kind: "task-workspace",
      target: {
        authority: "workspace",
        connectionProfileId: locator.connectionProfileId,
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        canvasId: locator.canvasId,
        taskId: task.taskId,
        blockRef: block.ref
      }
    });
    act(() => current!.notifications.onMarkNotificationRead(notification.id));
    expect(current!.notifications.notificationItems.filter((item) => !item.read)).toHaveLength(0);
    const otherLocator = { ...locator, canvasId: "canvas-other" };
    const otherStatus = {
      ...runtimeStatus,
      scope: { ...runtimeStatus.scope, canvasId: otherLocator.canvasId }
    };
    const otherProjection = {
      ...projection,
      locator: otherLocator,
      replica: { ...replica, canvasId: otherLocator.canvasId },
      initialRuntimeAvailability: {
        ...projection.initialRuntimeAvailability,
        state: { ...projection.initialRuntimeAvailability.state, status: otherStatus },
        execution: { ...projection.initialRuntimeAvailability.execution, status: otherStatus }
      }
    };
    bridges.collaboration.target.openWorkspaceCanvasSession = vi
      .fn()
      .mockImplementation((opened) =>
        Promise.resolve(opened.canvasId === otherLocator.canvasId ? otherProjection : projection)
      );
    const retiredSignal = lateSignal;
    act(() => current!.shell.openWorkspaceCanvasLocator(otherLocator));
    await waitFor(() => expect(current?.notifications.notificationItems[0]?.read).toBe(false));
    const otherId = current!.notifications.notificationItems[0].id;
    expect(otherId).not.toBe(notification.id);
    act(() => retiredSignal?.({ type: "workspace.canvas.projection", projection }));
    expect(current!.notifications.notificationItems[0].id).toBe(otherId);
    expect(current!.notifications.notificationItems[0].navigationIntent).toMatchObject({
      target: { canvasId: otherLocator.canvasId }
    });
    act(() => current!.shell.openWorkspaceCanvasLocator(locator));
    await waitFor(() => expect(current?.notifications.notificationItems[0]?.read).toBe(true));
    mounted.unmount();
    const restored = mount();
    await waitFor(() => expect(current?.notifications.notificationItems[0]?.read).toBe(true));
    await act(async () => {
      await current!.shell.loadProject(project, "canvas-main");
    });
    await waitFor(() => expect(settings.lastOpenedWorkspaceLocator).toBeNull());
    act(() => lateSignal?.({ type: "workspace.canvas.projection", projection }));
    expect(current!.notifications.notificationItems).toHaveLength(0);
    expect(current!.graphWorkspace.graph?.projectId).toBe(projectSnapshot().graph.projectId);
    restored.unmount();
  });
});
