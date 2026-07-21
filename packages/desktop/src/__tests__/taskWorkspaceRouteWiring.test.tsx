/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { runnerRecordReadModelSchema } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "../renderer/views/WorkspaceTabs";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { deferred } from "./helpers/desktopProjectFixtures";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";
import type { TaskWorkspaceController } from "../renderer/task-workspace/contracts";
import { readModel, record, selection } from "./helpers/taskWorkspaceConversationFixture";

const useProjectWorkspace = vi.hoisted(() => vi.fn());
const cancelAgentRun = vi.hoisted(() => vi.fn(async () => undefined));
const detectDevelopmentTools = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../renderer/ProjectWorkspaceProvider", () => ({ useProjectWorkspace }));
vi.mock("../renderer/bridge", () => ({ bridge: { cancelAgentRun, detectDevelopmentTools } }));
vi.mock("../renderer/views/GraphView", () => ({
  GraphView: () => <div data-testid="graph-route">Graph route</div>
}));

afterEach(cleanupRendererTestEnvironment);

function readyTaskWorkspace(
  fixture: ReturnType<typeof taskWorkspaceInspectorFixture>,
  patch: Partial<TaskWorkspaceController> = {}
): TaskWorkspaceController {
  return {
    error: null,
    executorOptions: ["manual", "codex", "claude-code", "pi"],
    getRunScrollTop: vi.fn(() => 0),
    hasMoreRuns: false,
    liveStatus: "live",
    liveUnavailableReason: null,
    loadMoreRuns: vi.fn(async () => undefined),
    loadMoreRunsError: null,
    loadingMoreRuns: false,
    navigation: {
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      source: { view: "graph" }
    },
    onRunScrollTopChange: vi.fn(),
    packageExecutorNames: [],
    recordError: null,
    refresh: vi.fn(),
    returnToCanvas: vi.fn(),
    runnerModel: fixture.selectedRecord.runnerReadModel,
    saveBlockExecutor: vi.fn(async () => undefined),
    saveBlockPrompt: vi.fn(async () => undefined),
    saveTaskExecutor: vi.fn(async () => undefined),
    saveTaskPrompt: vi.fn(async () => undefined),
    selectRun: vi.fn(),
    selectedAnnotation: null,
    selectedRecord: fixture.selectedRecord,
    selectedRecordId: fixture.selectedRun.item.run.record.recordId,
    selectedRun: fixture.selectedRun,
    status: "ready",
    subscriptionError: null,
    workspace: fixture.workspace,
    ...patch
  };
}

describe("Task Workspace route wiring", () => {
  it("renders the explicit Task Workspace route without falling back to Graph chrome", async () => {
    useProjectWorkspace.mockReturnValue({
      shell: {
        activeView: "task-workspace",
        t: (key: string) => key
      },
      taskWorkspace: {
        error: null,
        navigation: {
          projectRoot: "/projects/demo",
          canvasId: "canvas-main",
          taskId: "T-001",
          source: { view: "graph" }
        },
        returnToCanvas: vi.fn(),
        status: "loading"
      }
    });

    const { container } = render(<WorkspaceTabs />);

    expect(
      await screen.findByRole("heading", { name: "taskWorkspaceLoading" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-loading-state")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByText("taskWorkspaceLoading")).toHaveLength(1);
    expect(screen.queryByTestId("graph-route")).not.toBeInTheDocument();
    expect(container.querySelector(".app-drag-region")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "taskWorkspaceBackToCanvas" })).toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass("rounded-l-xl");
  });

  it("keeps production slots and structural overflow controls usable", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    const returnToCanvas = vi.fn();
    useProjectWorkspace.mockReturnValue({
      shell: {
        activeView: "task-workspace",
        t: createTranslator("en")
      },
      taskWorkspace: readyTaskWorkspace(fixture, { returnToCanvas })
    });

    render(<WorkspaceTabs />);

    expect(await screen.findByRole("separator", { name: "Resize timeline" })).toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-acp-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-composer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Context usage: 18,300 \/ 25,800 tokens/ })
    ).toBeInTheDocument();
    const composer = within(screen.getByTestId("task-workspace-composer"));
    expect(composer.getByTitle("Agent: codex")).toBeInTheDocument();
    expect(composer.getByTitle("Model: gpt-5")).toBeInTheDocument();
    expect(composer.getByTitle("Reasoning: high")).toBeInTheDocument();
    expect(composer.getByTitle("Mode: code")).toBeInTheDocument();
    expect(composer.queryByTitle(/^Permission:/)).not.toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-inspector-slot")).toBeInTheDocument();
    expect(screen.getByLabelText("Task Prompt")).toHaveTextContent("Task source prompt.");
    expect(screen.getByLabelText("Block prompt")).toHaveTextContent("Block source prompt.");
    expect(screen.getByLabelText("Effective Prompt")).toHaveTextContent(
      "Task prompt and block prompt rendered together."
    );
    expect(screen.getByTestId("task-workspace-shell")).toHaveClass("min-w-0");
    expect(screen.getByTestId("task-workspace-run-summary")).toHaveAttribute(
      "data-record-id",
      "T-001#B-001::RUN-001"
    );
    expect(screen.getByTestId("task-workspace-run-summary")).toHaveAttribute(
      "data-status",
      "completed"
    );
    expect(
      within(screen.getByTestId("task-workspace-header")).queryByRole("button", { name: "Stop" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();

    expect(screen.getAllByText("Inspector overview")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Back to canvas" }));
    expect(returnToCanvas).toHaveBeenCalledTimes(1);
  });

  it("shows Cancel run in the composer only for an exact available ACP cancel identity", async () => {
    const model = readModel();
    const selectedRun = selection({ model });
    const fixture = taskWorkspaceInspectorFixture();
    cancelAgentRun.mockClear();
    useProjectWorkspace.mockReturnValue({
      shell: { activeView: "task-workspace", t: createTranslator("en") },
      taskWorkspace: readyTaskWorkspace(fixture, {
        runnerModel: model,
        selectedRecord: record(model),
        selectedRun
      })
    });

    render(<WorkspaceTabs />);

    expect(
      within(await screen.findByTestId("task-workspace-header")).queryByRole("button", {
        name: "Stop"
      })
    ).not.toBeInTheDocument();
    const cancel = within(screen.getByTestId("task-workspace-composer")).getByRole("button", {
      name: "Cancel run"
    });
    await userEvent.click(cancel);
    await waitFor(() =>
      expect(cancelAgentRun).toHaveBeenCalledWith(
        { projectRoot: "/projects/demo", canvasId: "canvas-main" },
        selectedRun.item.run.record.recordId,
        model.intervention.cancel.identity
      )
    );
  });

  it("deduplicates Cancel run while a cancel is in flight", async () => {
    const pendingCancel = deferred<void>();
    const model = readModel();
    const selectedRun = selection({ model });
    const fixture = taskWorkspaceInspectorFixture();
    cancelAgentRun.mockClear();
    cancelAgentRun.mockImplementation(() => pendingCancel.promise);
    useProjectWorkspace.mockReturnValue({
      shell: { activeView: "task-workspace", t: createTranslator("en") },
      taskWorkspace: readyTaskWorkspace(fixture, {
        runnerModel: model,
        selectedRecord: record(model),
        selectedRun
      })
    });

    render(<WorkspaceTabs />);

    expect(
      within(screen.getByTestId("task-workspace-header")).queryByRole("button", {
        name: "Stop"
      })
    ).not.toBeInTheDocument();
    const composerStop = screen.getByRole("button", { name: "Cancel run" });
    fireEvent.click(composerStop);
    fireEvent.click(composerStop);

    expect(cancelAgentRun).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(composerStop).toBeDisabled();
    });

    pendingCancel.resolve();
    await pendingCancel.promise;
    cancelAgentRun.mockResolvedValue(undefined);
  });

  it("hides Cancel run when the live and selected ACP cancel identities differ", async () => {
    const selectedModel = readModel();
    const selectedRun = selection({ model: selectedModel });
    const liveModel = runnerRecordReadModelSchema.parse({
      ...selectedModel,
      intervention: {
        ...selectedModel.intervention,
        cancel: {
          ...selectedModel.intervention.cancel,
          identity: {
            ...selectedModel.intervention.cancel.identity,
            scope: "/projects/other"
          }
        }
      }
    });
    const fixture = taskWorkspaceInspectorFixture();
    cancelAgentRun.mockClear();
    useProjectWorkspace.mockReturnValue({
      shell: { activeView: "task-workspace", t: createTranslator("en") },
      taskWorkspace: readyTaskWorkspace(fixture, {
        runnerModel: liveModel,
        selectedRecord: record(liveModel),
        selectedRun
      })
    });

    render(<WorkspaceTabs />);

    expect(
      within(await screen.findByTestId("task-workspace-header")).queryByRole("button", {
        name: "Stop"
      })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });
});
