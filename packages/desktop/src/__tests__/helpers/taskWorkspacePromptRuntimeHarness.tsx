import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import {
  getTaskWorkspace,
  getGraphViewModel,
  getTaskDetail,
  getBlockDetail,
  updateTaskPrompt,
  updateBlockPrompt,
  resolveTaskCanvasWorkspace,
  type DesktopBridgeApi
} from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace
} from "../../../../runtime/src/__tests__/promptTestHelpers";
import { useAppViewHistory } from "../../renderer/hooks/useAppViewHistory";
import { useTaskWorkspaceController } from "../../renderer/task-workspace/useTaskWorkspaceController";
import { TaskWorkspaceRoute } from "../../renderer/task-workspace/TaskWorkspaceRoute";
import { taskWorkspaceLabels } from "../../renderer/task-workspace/labels";
import { createTranslator } from "../../renderer/i18n";
import { controllerApi } from "./taskWorkspaceControllerHarness";
import { deferred } from "./desktopProjectFixtures";

export const runtimePromptLabels = taskWorkspaceLabels(createTranslator("en"));

export async function runtimePromptHarness(
  kind: "task" | "block",
  acknowledgement: "before-write" | "after-write" = "before-write",
  heldWrite = 1
) {
  const original = await createTestWorkspace(basicManifest());
  let selected = {
    projectRoot: original.root,
    projectId: original.init.workspace.id,
    canvasId: "default"
  };
  const pending = deferred<void>();
  const writes: Array<{ markdown: string; baseline: string; concurrent: number }> = [];
  let concurrent = 0;
  const api = {
    ...controllerApi({ readModel: () => null }).api,
    getTaskWorkspace: vi.fn<DesktopBridgeApi["getTaskWorkspace"]>(getTaskWorkspace),
    getGraphViewModel: vi.fn<DesktopBridgeApi["getGraphViewModel"]>(async (ref) =>
      getGraphViewModel(await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId))
    ),
    getTaskDetail: vi.fn<DesktopBridgeApi["getTaskDetail"]>(async (ref, id) =>
      getTaskDetail(await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId), id)
    ),
    getBlockDetail: vi.fn<DesktopBridgeApi["getBlockDetail"]>(async (ref, id) =>
      getBlockDetail(await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId), id)
    ),
    updateTaskPrompt: vi.fn<DesktopBridgeApi["updateTaskPrompt"]>(
      async (ref, id, markdown, options) => {
        const workspace = await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId);
        const baseline = (await getTaskDetail(workspace, id)).promptMarkdown;
        writes.push({ markdown, baseline, concurrent: ++concurrent });
        try {
          if (writes.length === heldWrite && acknowledgement === "before-write")
            await pending.promise;
          const result = await updateTaskPrompt(workspace, id, markdown, options);
          if (writes.length === heldWrite && acknowledgement === "after-write")
            await pending.promise;
          return result;
        } finally {
          concurrent -= 1;
        }
      }
    ),
    updateBlockPrompt: vi.fn<DesktopBridgeApi["updateBlockPrompt"]>(
      async (ref, id, markdown, options) => {
        const workspace = await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId);
        const baseline = (await getBlockDetail(workspace, id)).promptMarkdown;
        writes.push({ markdown, baseline, concurrent: ++concurrent });
        try {
          if (writes.length === heldWrite && acknowledgement === "before-write")
            await pending.promise;
          const result = await updateBlockPrompt(workspace, id, markdown, options);
          if (writes.length === heldWrite && acknowledgement === "after-write")
            await pending.promise;
          return result;
        } finally {
          concurrent -= 1;
        }
      }
    )
  };
  let current!: ReturnType<typeof useTaskWorkspaceController>;
  let history!: ReturnType<typeof useAppViewHistory>[2];
  function App() {
    const [view, , appHistory] = useAppViewHistory("graph");
    history = appHistory;
    current = useTaskWorkspaceController({
      agentEndpointCatalog: [],
      agentEndpointPreferences: {},
      api,
      history: appHistory,
      promptAuthority: {
        workspaceRoot: null,
        projectRoot: selected.projectRoot,
        canvasLocator: { kind: "local", projectId: selected.projectId, canvasId: selected.canvasId }
      },
      selectedWorkspaceRoot: null,
      saveAgentEndpointPreference: async () => undefined
    });
    return view === "task-workspace" ? (
      <TaskWorkspaceRoute controller={current} labels={runtimePromptLabels} />
    ) : null;
  }
  const view = render(<App />);
  const open = () =>
    history.openTaskWorkspace(
      { projectRoot: selected.projectRoot, canvasId: selected.canvasId, taskId: "T-001" },
      { view: "graph" }
    );
  act(open);
  const input = () =>
    kind === "task"
      ? screen.getByLabelText(runtimePromptLabels.promptLabels.taskPrompt)
      : within(screen.getByTestId("task-workspace-block-prompts:T-001#B-001")).getByLabelText(
          runtimePromptLabels.promptLabels.blockPrompt
        );
  await waitFor(() => expect(input()).toBeInTheDocument());
  const workspace = await resolveTaskCanvasWorkspace(original.root, "default");
  const initialMarkdown =
    kind === "task"
      ? (await getTaskDetail(workspace, "T-001")).promptMarkdown
      : (await getBlockDetail(workspace, "T-001#B-001")).promptMarkdown;
  return {
    ...original,
    api,
    input,
    pending,
    writes,
    initialMarkdown,
    async externalWrite(markdown: string) {
      if (kind === "task") await updateTaskPrompt(workspace, "T-001", markdown);
      else await updateBlockPrompt(workspace, "T-001#B-001", markdown);
      act(() => current.refresh());
      await waitFor(() =>
        expect(
          kind === "task"
            ? current.workspace?.task.promptMarkdown
            : current.workspace?.blocks.find((block) => block.ref === "T-001#B-001")?.promptMarkdown
        ).toBe(markdown)
      );
    },
    async remount() {
      act(() => history.returnToTaskWorkspaceSource());
      act(open);
      await waitFor(() => expect(input()).toBeInTheDocument());
    },
    async reactivate() {
      act(() => history.returnToTaskWorkspaceSource());
      const other = await createTestWorkspace(basicManifest(), { planweaveHome: original.home });
      act(() => {
        selected = {
          projectRoot: other.root,
          projectId: other.init.workspace.id,
          canvasId: "default"
        };
        view.rerender(<App />);
        open();
      });
      await waitFor(() =>
        expect(current.workspace?.project).toMatchObject({ projectId: other.init.workspace.id })
      );
      act(() => history.returnToTaskWorkspaceSource());
      act(() => {
        selected = {
          projectRoot: original.root,
          projectId: original.init.workspace.id,
          canvasId: "default"
        };
        view.rerender(<App />);
        open();
      });
      await waitFor(() => expect(input()).toHaveValue("A"));
    },
    async markdown() {
      const workspace = await resolveTaskCanvasWorkspace(original.root, "default");
      return kind === "task"
        ? (await getTaskDetail(workspace, "T-001")).promptMarkdown
        : (await getBlockDetail(workspace, "T-001#B-001")).promptMarkdown;
    }
  };
}
