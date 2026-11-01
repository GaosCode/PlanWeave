/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import {
  getTaskWorkspace,
  getGraphViewModel,
  getTaskDetail,
  getBlockDetail,
  updateTaskPrompt,
  updateBlockPrompt,
  resolveTaskCanvasWorkspace,
  duplicateTaskCanvas
} from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers";
import { useAppViewHistory } from "../renderer/hooks/useAppViewHistory";
import { useTaskWorkspaceController } from "../renderer/task-workspace/useTaskWorkspaceController";
import { TaskWorkspaceRoute } from "../renderer/task-workspace/TaskWorkspaceRoute";
import { taskWorkspaceLabels } from "../renderer/task-workspace/labels";
import { createTranslator } from "../renderer/i18n";
import { controllerApi } from "./helpers/taskWorkspaceControllerHarness";
import { deferred } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const labels = taskWorkspaceLabels(createTranslator("en"));
afterEach(() => {
  cleanupRendererTestEnvironment();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  window.history.replaceState(null, "", "/");
});

async function harness(kind: "task" | "block", failure?: "second" | "conflict") {
  const { root, init, home } = await createTestWorkspace(
    basicManifest({ includeSecondTask: true })
  );
  let selected = { projectRoot: root, projectId: init.workspace.id, canvasId: "default" };
  const pending = deferred<void>();
  const writes: Array<{ markdown: string; baseline: string; concurrent: number }> = [];
  let activeWrites = 0;
  const base = controllerApi({ readModel: () => null }).api;
  const api = {
    ...base,
    getTaskWorkspace: vi.fn<DesktopBridgeApi["getTaskWorkspace"]>(async (input) => {
      const workspace = await getTaskWorkspace({ ...input, selectedRecordId: null });
      const block = workspace.blocks.find((candidate) => candidate.ref === "T-001#R-001");
      if (block)
        block.annotations = [
          {
            annotationId: "review-attempt:A-001",
            associatedRunRecordId: null,
            attemptId: "A-001",
            content: "Review annotation",
            contentPreview: "Review annotation",
            kind: "review_attempt",
            reviewedAt: "2026-07-13T00:00:02.000Z",
            sourceReviewBlockRef: block.ref,
            verdict: "needs_changes"
          }
        ];
      return workspace;
    }),
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
      async (ref, taskId, markdown, options) => {
        const baseline = (
          await getTaskDetail(
            await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId),
            taskId
          )
        ).promptMarkdown;
        activeWrites += 1;
        writes.push({ markdown, baseline, concurrent: activeWrites });
        try {
          if (writes.length === 1) await pending.promise;
          if (writes.length === 2 && failure === "second")
            throw new Error("Prompt disk unavailable");
          const result = await updateTaskPrompt(
            await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId),
            taskId,
            markdown,
            options
          );
          if (writes.length === 1 && failure === "conflict")
            await updateTaskPrompt(
              await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId),
              taskId,
              "C"
            );
          return result;
        } finally {
          activeWrites -= 1;
        }
      }
    ),
    updateBlockPrompt: vi.fn<DesktopBridgeApi["updateBlockPrompt"]>(
      async (ref, blockRef, markdown, options) => {
        const baseline = (
          await getBlockDetail(
            await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId),
            blockRef
          )
        ).promptMarkdown;
        activeWrites += 1;
        writes.push({ markdown, baseline, concurrent: activeWrites });
        try {
          if (writes.length === 1) await pending.promise;
          if (writes.length === 2 && failure === "second")
            throw new Error("Prompt disk unavailable");
          const result = await updateBlockPrompt(
            await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId),
            blockRef,
            markdown,
            options
          );
          if (writes.length === 1 && failure === "conflict")
            await updateBlockPrompt(
              await resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId),
              blockRef,
              "C"
            );
          return result;
        } finally {
          activeWrites -= 1;
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
      <TaskWorkspaceRoute controller={current} labels={labels} />
    ) : null;
  }
  const view = render(<App />);
  const open = (taskId = "T-001") =>
    history.openTaskWorkspace(
      { projectRoot: selected.projectRoot, canvasId: selected.canvasId, taskId },
      { view: "graph" }
    );
  await act(async () => {
    open();
  });
  await waitFor(() => expect(current.status).toBe("ready"));
  const input = () =>
    kind === "task"
      ? screen.getByLabelText(labels.promptLabels.taskPrompt)
      : within(screen.getByTestId("task-workspace-block-prompts:T-001#B-001")).getByLabelText(
          labels.promptLabels.blockPrompt
        );
  return {
    root,
    init,
    home,
    async leave() {
      act(() => history.returnToTaskWorkspaceSource());
      await waitFor(() => expect(history.taskWorkspaceNavigation).toBeNull());
    },
    setAuthority(next: typeof selected) {
      selected = next;
      view.rerender(<App />);
    },
    api,
    writes,
    pending,
    view,
    input,
    open,
    get current() {
      return current;
    },
    get history() {
      return history;
    }
  };
}

it.each([
  "task",
  "block"
] as const)("serializes the latest %s draft after blur and real run navigation unmounts Overview", async (kind) => {
  const h = await harness(kind);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.change(h.input(), { target: { value: "A" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  await waitFor(() => expect(h.writes).toHaveLength(1));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => h.current.selectRun({ blockRef: "T-001#B-001", recordId: "T-001#B-001::RUN-001" }));
  await waitFor(() =>
    expect(screen.queryByTestId("task-workspace-overview-panel")).not.toBeInTheDocument()
  );
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.writes.map((write) => write.markdown)).toEqual(["A", "AB"]));
  await waitFor(async () =>
    expect(
      (kind === "task"
        ? await h.api.getTaskDetail({ projectRoot: h.root, canvasId: "default" }, "T-001")
        : await h.api.getBlockDetail({ projectRoot: h.root, canvasId: "default" }, "T-001#B-001")
      ).promptMarkdown
    ).toBe("AB")
  );
  expect(h.writes[1]?.baseline).toBe("A");
  expect(h.writes.map((write) => write.concurrent)).toEqual([1, 1]);
});

it.each([
  "annotation",
  "canvas",
  "task"
] as const)("retains the original owner through %s navigation while its first save is pending", async (destination) => {
  const h = await harness("task");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => {
    if (destination === "annotation")
      h.current.selectAnnotation({ blockRef: "T-001#R-001", annotationId: "review-attempt:A-001" });
    else if (destination === "canvas") h.history.returnToTaskWorkspaceSource();
    else h.open("T-002");
  });
  await waitFor(() =>
    expect(screen.queryByTestId("task-workspace-overview-panel")).not.toBeInTheDocument()
  );
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.writes.map((write) => write.markdown)).toEqual(["A", "AB"]));
  await waitFor(async () =>
    expect(
      (await h.api.getTaskDetail({ projectRoot: h.root, canvasId: "default" }, "T-001"))
        .promptMarkdown
    ).toBe("AB")
  );
  act(() => {
    if (destination === "annotation") h.current.selectRun(null);
    else h.open();
  });
  await waitFor(() => expect(h.input()).toHaveValue("AB"));
});

it.each([
  "task",
  "block"
] as const)("keeps the latest %s draft and the write error after Overview is reopened", async (kind) => {
  const h = await harness(kind, "second");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await h.leave();
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.writes).toHaveLength(2));
  act(() => h.open());
  await waitFor(() => expect(h.input()).toHaveValue("AB"));
  expect(screen.getByRole("alert")).toHaveTextContent("Prompt disk unavailable");
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(3));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("preserves AB and reports an actual CAS conflict with external C after leaving Overview", async () => {
  const h = await harness("task", "conflict");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await h.leave();
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(async () =>
    expect(
      (await h.api.getTaskDetail({ projectRoot: h.root, canvasId: "default" }, "T-001"))
        .promptMarkdown
    ).toBe("C")
  );
  act(() => h.open());
  await waitFor(() => expect(h.input()).toHaveValue("AB"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("changed outside this editor")
  );
  expect(h.writes).toHaveLength(1);
});

it.each([
  "resolve",
  "reject"
] as const)("isolates a late %s after switching project authority and restores the original dirty draft", async (settlement) => {
  const h = await harness("task");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await h.leave();
  const other = await createTestWorkspace(basicManifest(), { planweaveHome: h.home });
  act(() => {
    h.setAuthority({
      projectRoot: other.root,
      projectId: other.init.workspace.id,
      canvasId: "default"
    });
    h.open();
  });
  await waitFor(() =>
    expect(h.current.workspace?.project).toMatchObject({ projectId: other.init.workspace.id })
  );
  const originalOther = "# T-001 task prompt\n";
  await act(async () => {
    if (settlement === "reject") {
      h.pending.reject(new Error("Original scope write failed"));
      await expect(h.pending.promise).rejects.toThrow("Original scope write failed");
    } else {
      h.pending.resolve();
      await h.pending.promise;
    }
  });
  expect(h.input()).toHaveValue(originalOther);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(h.writes).toHaveLength(1);
  await h.leave();
  act(() => {
    h.setAuthority({ projectRoot: h.root, projectId: h.init.workspace.id, canvasId: "default" });
    h.open();
  });
  await waitFor(() => expect(h.input()).toHaveValue("AB"));
  if (settlement === "reject")
    expect(screen.getByRole("alert")).toHaveTextContent("Original scope write failed");
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(2));
  await waitFor(async () =>
    expect(
      (await h.api.getTaskDetail({ projectRoot: h.root, canvasId: "default" }, "T-001"))
        .promptMarkdown
    ).toBe("AB")
  );
});

it("finishes an IME draft when annotation navigation detaches the editor without compositionEnd", async () => {
  const h = await harness("task");
  fireEvent.compositionStart(h.input());
  fireEvent.change(h.input(), { target: { value: "中文草稿" } });
  fireEvent.blur(h.input());
  act(() =>
    h.current.selectAnnotation({ blockRef: "T-001#R-001", annotationId: "review-attempt:A-001" })
  );
  await waitFor(() => expect(h.writes).toHaveLength(1), { timeout: 2000 });
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  act(() => h.current.selectRun(null));
  await waitFor(() => expect(h.input()).toHaveValue("中文草稿"));
  fireEvent.change(h.input(), { target: { value: "中文草稿继续" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(2));
});

it("retires an original canvas queue while the route is absent and restores AB on that canvas", async () => {
  const h = await harness("block");
  const other = await duplicateTaskCanvas(h.root, "default", { name: "Another canvas" });
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await h.leave();
  act(() =>
    h.setAuthority({
      projectRoot: h.root,
      projectId: h.init.workspace.id,
      canvasId: other.canvasId
    })
  );
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(async () =>
    expect(
      (await h.api.getBlockDetail({ projectRoot: h.root, canvasId: "default" }, "T-001#B-001"))
        .promptMarkdown
    ).toBe("A")
  );
  expect(h.writes).toHaveLength(1);
  act(() => {
    h.setAuthority({ projectRoot: h.root, projectId: h.init.workspace.id, canvasId: "default" });
    h.open();
  });
  await waitFor(() => expect(h.input()).toHaveValue("AB"));
  fireEvent.blur(h.input());
  await waitFor(async () =>
    expect(
      (await h.api.getBlockDetail({ projectRoot: h.root, canvasId: "default" }, "T-001#B-001"))
        .promptMarkdown
    ).toBe("AB")
  );
  expect(h.writes.map((write) => write.markdown)).toEqual(["A", "AB"]);
});

it("does not write after a delayed revision read returns to a retired project authority", async () => {
  const h = await harness("task");
  const detail = await h.api.getTaskDetail({ projectRoot: h.root, canvasId: "default" }, "T-001");
  const read = deferred<typeof detail>();
  h.api.getTaskDetail.mockReturnValueOnce(read.promise);
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await h.leave();
  act(() =>
    h.setAuthority({ projectRoot: "/projects/another", projectId: "another", canvasId: "default" })
  );
  await act(async () => {
    read.resolve(detail);
    await read.promise;
  });
  expect(h.api.updateTaskPrompt).not.toHaveBeenCalled();
  act(() => {
    h.setAuthority({ projectRoot: h.root, projectId: h.init.workspace.id, canvasId: "default" });
    h.open();
  });
  await waitFor(() => expect(h.input()).toHaveValue("AB"));
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(async () =>
    expect(
      (await h.api.getTaskDetail({ projectRoot: h.root, canvasId: "default" }, "T-001"))
        .promptMarkdown
    ).toBe("AB")
  );
});
