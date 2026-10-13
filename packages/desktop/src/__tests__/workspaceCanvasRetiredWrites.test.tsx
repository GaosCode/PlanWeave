/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { deferred, project } from "./helpers/desktopProjectFixtures";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";
import {
  type WorkspaceCanvasCommandBridge,
  useWorkspaceCanvasCommands
} from "../renderer/hooks/useWorkspaceCanvasCommands";
import { useTaskExecutorActions } from "../renderer/hooks/useTaskExecutorActions";
import { useGraphDeleteActions } from "../renderer/hooks/useGraphDeleteActions";
import { useTaskWorkspaceExecutorActions } from "../renderer/task-workspace/useTaskWorkspaceExecutorActions";
import { useTaskWorkspacePromptActions } from "../renderer/task-workspace/useTaskWorkspacePromptActions";
import { TaskWorkspaceTaskPrompt } from "../renderer/task-workspace/TaskWorkspacePrompts";
import type { TaskWorkspacePromptLabels } from "../renderer/task-workspace/contracts";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";
import { runDurablePackageWrite } from "../renderer/collaboration/packageWriteAdapter";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator";
import type { WorkspaceCanvasProjection } from "../shared/workspaceCanvasProjection";

const locatorA: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-a",
  workspaceId: "workspace-a",
  projectId: "project-a",
  canvasId: "canvas-a"
};
const locatorB: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-b",
  workspaceId: "workspace-b",
  projectId: "project-b",
  canvasId: "canvas-b"
};
const t = createTranslator("en");
const failureMessage = "retired_workspace_submit_failure";
type Settlement = "throw" | "rejected" | "conflicted" | "accepted";

function projection(
  locator: WorkspaceCanvasLocator,
  status: WorkspaceCanvasProjection["status"] = "accepted"
): WorkspaceCanvasProjection {
  return {
    locator,
    status,
    authorityMode: "server_authoritative",
    readOnly: false,
    cachedAt: null,
    initialRuntimeAvailability: null,
    conflict:
      status === "conflicted"
        ? {
            expectedRevision: 4,
            authoritativeRevision: 5,
            authoritativeContentDigest: "c".repeat(64)
          }
        : null,
    rejectCode: status === "rejected" ? "permission_denied" : null,
    replica: {
      authorityId: `workspace:${locator.workspaceId}:${locator.projectId}:${locator.canvasId}`,
      bindingKind: "remote",
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      canvasId: locator.canvasId,
      revision: 4,
      contentDigest: "a".repeat(64),
      canEdit: true,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        projectTitle: "Workspace plan",
        graphVersion: "1",
        packageFingerprint: `pkg-${"b".repeat(64)}`,
        tasks: [],
        edges: [],
        sharedResourceGroups: [],
        diagnostics: [],
        layout: {
          version: "desktop-layout/v1",
          projectId: locator.projectId,
          nodes: [],
          updatedAt: "2026-10-13T00:00:00.000Z"
        },
        blockDependenciesByRef: {},
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: {}
      }
    }
  };
}

function commandBridge() {
  const submission = deferred<WorkspaceCanvasProjection>();
  const submitWorkspaceCanvasCommand = vi.fn(() => submission.promise);
  const api: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: vi.fn(async (locator) => projection(locator)),
    submitWorkspaceCanvasCommand,
    reconnectWorkspaceCanvasSession: vi.fn(async (locator) => projection(locator)),
    closeWorkspaceCanvasSession: vi.fn(async () => undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn(() => () => undefined)
  };
  return { api, submission, submitWorkspaceCanvasCommand };
}

function settle(
  submission: ReturnType<typeof deferred<WorkspaceCanvasProjection>>,
  settlement: Settlement
) {
  if (settlement === "throw") submission.reject(new Error(failureMessage));
  else submission.resolve(projection(locatorA, settlement));
}

const navigationCases: Array<{ name: string; locators: Array<WorkspaceCanvasLocator | null> }> = [
  { name: "A to B", locators: [locatorB] },
  { name: "A to Local", locators: [null] },
  { name: "A to B to A", locators: [locatorB, locatorA] }
];
const retiredCases = navigationCases.flatMap((navigation) =>
  (["throw", "rejected", "conflicted", "accepted"] as const).map((settlement) => ({
    ...navigation,
    settlement
  }))
);

afterEach(() => {
  vi.useRealTimers();
  cleanupRendererTestEnvironment();
});

describe("Workspace command result retirement", () => {
  it("keeps the real Task Workspace prompt editor dirty after A's save is accepted in B", async () => {
    const port = commandBridge();
    const api = createDesktopBridgeMock();
    const onLocalSaved = vi.fn();
    const fixture = taskWorkspaceInspectorFixture();
    const labels: TaskWorkspacePromptLabels = {
      blockPrompt: "Block prompt",
      disabled: "Disabled",
      effectivePrompt: "Effective prompt",
      empty: "Empty",
      included: "Included",
      missing: "Missing",
      promptSources: "Prompt sources",
      savePrompt: "Save Prompt",
      saved: "Saved",
      saving: "Saving",
      taskPrompt: "Task prompt"
    };
    port.api.openWorkspaceCanvasSession = vi.fn(async (locator) => {
      const opened = projection(locator);
      opened.replica.content.tasks = [
        {
          taskId: fixture.workspace.task.taskId,
          title: fixture.workspace.task.title,
          status: fixture.workspace.task.status,
          executor: fixture.workspace.task.executor,
          promptMarkdown: fixture.workspace.task.promptMarkdown,
          promptMissing: fixture.workspace.task.promptMissing,
          executorLabel: "codex",
          promptPreview: fixture.workspace.task.promptMarkdown,
          sharedResources: [],
          blocks: [],
          blockPreview: [],
          hiddenBlockRefs: [],
          overflowBlockCount: 0,
          exceptions: []
        }
      ];
      return opened;
    });
    function PromptWorkspace({ locator }: { locator: WorkspaceCanvasLocator }) {
      const commands = useWorkspaceCanvasCommands({
        api: port.api,
        locator,
        sessionConnected: true,
        t
      });
      const { saveTaskPrompt } = useTaskWorkspacePromptActions({
        api,
        navigation: {
          authority: "workspace",
          connectionProfileId: locator.connectionProfileId,
          workspaceId: locator.workspaceId,
          projectId: locator.projectId,
          canvasId: locator.canvasId,
          taskId: fixture.workspace.task.taskId,
          source: { view: "graph" }
        },
        onLocalSaved,
        workspace: {
          ...fixture.workspace,
          project: {
            authority: "workspace",
            workspaceId: locator.workspaceId,
            projectId: locator.projectId,
            canvasId: locator.canvasId
          }
        },
        workspaceCanvas: commands
      });
      return (
        <>
          <output data-testid="active-canvas">{commands.projection?.canvasId}</output>
          <TaskWorkspaceTaskPrompt
            labels={labels}
            onSave={saveTaskPrompt}
            task={fixture.workspace.task}
          />
        </>
      );
    }
    const view = render(<PromptWorkspace locator={locatorA} />);
    await waitFor(() => expect(screen.getByTestId("active-canvas")).toHaveTextContent("canvas-a"));
    const input = screen.getByLabelText("Task prompt");
    fireEvent.change(input, { target: { value: "# Pending Workspace A prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Prompt" }));
    expect(port.submitWorkspaceCanvasCommand).toHaveBeenCalledWith({
      locator: locatorA,
      intent: {
        kind: "update_task_prompt",
        taskId: fixture.workspace.task.taskId,
        promptMarkdown: "# Pending Workspace A prompt"
      }
    });
    view.rerender(<PromptWorkspace locator={locatorB} />);
    await waitFor(() => expect(screen.getByTestId("active-canvas")).toHaveTextContent("canvas-b"));
    vi.useFakeTimers();
    await act(async () => {
      port.submission.resolve(projection(locatorA));
      await port.submission.promise;
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("# Pending Workspace A prompt");
    expect(screen.getByRole("button", { name: "Save Prompt" })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(port.submitWorkspaceCanvasCommand).toHaveBeenCalledTimes(1);
    expect(api.updateTaskPrompt).not.toHaveBeenCalled();
    expect(onLocalSaved).not.toHaveBeenCalled();
  });

  it.each(retiredCases)("does not publish $settlement or refresh after $name", async ({
    locators,
    settlement
  }) => {
    const port = commandBridge();
    const setError = vi.fn();
    const refreshGraph = vi.fn(async () => undefined);
    const hook = renderHook(
      ({ locator }) => {
        const commands = useWorkspaceCanvasCommands({
          api: port.api,
          locator,
          sessionConnected: true,
          t
        });
        const actions = useTaskExecutorActions({
          refreshGraph,
          selectedCanvasId: null,
          selectedProject: null,
          setError,
          workspaceCanvas: commands
        });
        return { commands, actions };
      },
      { initialProps: { locator: locatorA as WorkspaceCanvasLocator | null } }
    );
    await waitFor(() => expect(hook.result.current.commands.projection?.canvasId).toBe("canvas-a"));
    let pending!: Promise<boolean>;
    act(() => {
      pending = hook.result.current.actions.handleTaskExecutorChange("T-001", "codex");
    });
    expect(port.submitWorkspaceCanvasCommand).toHaveBeenCalledTimes(1);

    for (const locator of locators) {
      hook.rerender({ locator });
      if (locator) {
        await waitFor(() =>
          expect(hook.result.current.commands.projection?.canvasId).toBe(locator.canvasId)
        );
      } else expect(hook.result.current.commands.enabled).toBe(false);
    }
    await act(async () => {
      settle(port.submission, settlement);
      await expect(pending).resolves.toBe(false);
    });

    expect(setError).not.toHaveBeenCalled();
    expect(refreshGraph).not.toHaveBeenCalled();
    expect(hook.result.current.commands.snapshot.lastError).toBeNull();
    expect(hook.result.current.commands.snapshot.lastStaleConflict).toBeNull();
    expect(hook.result.current.commands.projection?.canvasId ?? null).toBe(
      locators.at(-1)?.canvasId ?? null
    );
  });

  it.each([
    "throw",
    "rejected",
    "conflicted"
  ] as const)("keeps a current $settlement visible to the error consumer", async (settlement) => {
    const port = commandBridge();
    const setError = vi.fn();
    const refreshGraph = vi.fn(async () => undefined);
    const { result } = renderHook(() => {
      const commands = useWorkspaceCanvasCommands({
        api: port.api,
        locator: locatorA,
        sessionConnected: true,
        t
      });
      return useTaskExecutorActions({
        refreshGraph,
        selectedCanvasId: null,
        selectedProject: null,
        setError,
        workspaceCanvas: commands
      });
    });
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.handleTaskExecutorChange("T-001", "codex");
    });
    await act(async () => {
      settle(port.submission, settlement);
      await expect(pending).resolves.toBe(false);
    });
    const expectedError =
      settlement === "throw"
        ? failureMessage
        : settlement === "rejected"
          ? t("canvasCommandRejected").replace("{code}", "permission_denied")
          : t("canvasCommandStaleRevision")
              .replace("{expected}", "4")
              .replace("{authoritative}", "5");
    expect(setError).toHaveBeenCalledWith(expectedError);
    expect(refreshGraph).not.toHaveBeenCalled();
  });

  it.each(navigationCases)("refuses a retained callback from $name", async ({ locators }) => {
    const port = commandBridge();
    port.submitWorkspaceCanvasCommand.mockResolvedValue(projection(locatorA));
    const setError = vi.fn();
    const refreshGraph = vi.fn(async () => undefined);
    const hook = renderHook(
      ({ locator }) => {
        const commands = useWorkspaceCanvasCommands({
          api: port.api,
          locator,
          sessionConnected: true,
          t
        });
        return useTaskExecutorActions({
          refreshGraph,
          selectedCanvasId: null,
          selectedProject: null,
          setError,
          workspaceCanvas: commands
        });
      },
      { initialProps: { locator: locatorA as WorkspaceCanvasLocator | null } }
    );
    const retained = hook.result.current.handleTaskExecutorChange;
    for (const locator of locators) {
      hook.rerender({ locator });
      if (locator)
        await waitFor(() =>
          expect(port.api.openWorkspaceCanvasSession).toHaveBeenCalledWith(locator)
        );
    }
    await act(async () => {
      await expect(retained("T-001", "codex")).resolves.toBe(false);
    });
    expect(port.submitWorkspaceCanvasCommand).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(refreshGraph).not.toHaveBeenCalled();
  });

  it("returns a retired durable outcome without local fallback", async () => {
    const port = commandBridge();
    const localWrite = vi.fn(async () => undefined);
    const onError = vi.fn();
    const hook = renderHook(
      ({ locator }) =>
        useWorkspaceCanvasCommands({ api: port.api, locator, sessionConnected: true, t }),
      { initialProps: { locator: locatorA as WorkspaceCanvasLocator | null } }
    );
    let pending!: ReturnType<typeof runDurablePackageWrite>;
    act(() => {
      pending = runDurablePackageWrite({
        workspaceCanvas: hook.result.current,
        intent: { kind: "update_task_fields", taskId: "T-001", fields: { executor: "codex" } },
        onError,
        localWrite
      });
    });
    hook.rerender({ locator: null });
    await act(async () => {
      port.submission.resolve(projection(locatorA));
      await expect(pending).resolves.toBe("retired");
    });
    expect(localWrite).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    "throw",
    "accepted"
  ] as const)("does not reject or announce a saved Task Workspace executor for retired $settlement", async (settlement) => {
    const port = commandBridge();
    const api = createDesktopBridgeMock();
    const onSaved = vi.fn();
    const hook = renderHook(
      ({ locator }) => {
        const commands = useWorkspaceCanvasCommands({
          api: port.api,
          locator,
          sessionConnected: true,
          t
        });
        return useTaskWorkspaceExecutorActions({
          api,
          navigation: {
            authority: "workspace",
            connectionProfileId: locator.connectionProfileId,
            workspaceId: locator.workspaceId,
            projectId: locator.projectId,
            canvasId: locator.canvasId,
            taskId: "T-001",
            source: { view: "graph" }
          },
          onSaved,
          workspaceCanvas: commands
        });
      },
      { initialProps: { locator: locatorA } }
    );
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.saveTaskExecutor("codex");
    });
    hook.rerender({ locator: locatorB });
    await act(async () => {
      settle(port.submission, settlement);
      await expect(pending).resolves.toBeUndefined();
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.updateTaskExecutor).not.toHaveBeenCalled();
  });

  it.each([
    "rejected",
    "accepted"
  ] as const)("does not publish errors, clear selection or reload for a retired task deletion ($settlement)", async (settlement) => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const port = commandBridge();
    const setError = vi.fn();
    const clearReviewTaskSelection = vi.fn();
    const clearTaskPanelSelection = vi.fn();
    const loadProject = vi.fn(async () => undefined);
    const hook = renderHook(
      ({ locator }) => {
        const commands = useWorkspaceCanvasCommands({
          api: port.api,
          locator,
          sessionConnected: true,
          t
        });
        return useGraphDeleteActions({
          clearReviewTaskSelection,
          clearTaskPanelSelection,
          clearSelectedBlockRecords: vi.fn(),
          deleteBlockConfirm: "Delete Block?",
          deleteTaskConfirm: "Delete Task?",
          loadProject,
          refreshProjectDerivedState: vi.fn(async () => undefined),
          selectedCanvasId: locator.canvasId,
          selectedBlock: null,
          selectedProject: project,
          selectedTaskPanelId: "T-001",
          setBlockInspectorOpen: vi.fn(),
          setError,
          setSelectedBlock: vi.fn(),
          setSelectedRunRecord: vi.fn(),
          workspaceCanvas: commands
        });
      },
      { initialProps: { locator: locatorA } }
    );
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.handleDeleteTaskNode("T-001");
    });
    hook.rerender({ locator: locatorB });
    await act(async () => {
      settle(port.submission, settlement);
      await pending;
    });
    expect(setError).not.toHaveBeenCalled();
    expect(clearReviewTaskSelection).not.toHaveBeenCalled();
    expect(clearTaskPanelSelection).not.toHaveBeenCalled();
    expect(loadProject).not.toHaveBeenCalled();
  });
});
