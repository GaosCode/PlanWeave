/* @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getTaskWorkspace } from "@planweave-ai/runtime";
import { TaskWorkspaceTaskPrompt } from "../renderer/task-workspace/TaskWorkspacePrompts";
import { TaskWorkspacePromptDraft } from "../renderer/task-workspace/taskWorkspacePromptDraft";
import { TaskWorkspaceRoute } from "../renderer/task-workspace/TaskWorkspaceRoute";
import { controllerApi, useControllerHarness } from "./helpers/taskWorkspaceControllerHarness";
import { navigation, workspaceHeader } from "./helpers/taskWorkspaceControllerModelFixture";
import { deferred } from "./helpers/desktopProjectFixtures";
import {
  runtimePromptHarness,
  runtimePromptLabels
} from "./helpers/taskWorkspacePromptRuntimeHarness";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(() => {
  cleanupRendererTestEnvironment();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  window.history.replaceState(null, "", "/");
});

it("appends a run page with 100 Block drafts without reloading Prompt details", async () => {
  const { api } = controllerApi({ readModel: () => null });
  const header = workspaceHeader(null);
  const firstBlock = header.blocks[0]!;
  header.blocks = Array.from({ length: 100 }, (_, index) => {
    const blockId = `B-${String(index + 1).padStart(3, "0")}`;
    return { ...firstBlock, blockId, ref: `T-001#${blockId}` };
  });
  api.getTaskWorkspace.mockResolvedValue(header);
  const page = await api.listTaskWorkspaceRuns({
    projectRoot: "/projects/demo",
    canvasId: "canvas-main",
    taskId: "T-001"
  });
  const [first, second] = page.items;
  api.listTaskWorkspaceRuns
    .mockResolvedValueOnce({
      ...page,
      items: [first!],
      nextCursor: {
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "canvas-main",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: first!.run.record.recordId
      }
    })
    .mockResolvedValueOnce({ ...page, items: [second!] });

  let current!: ReturnType<typeof useControllerHarness>;
  function App() {
    current = useControllerHarness(api, {
      ...navigation(),
      blockRef: undefined,
      recordId: undefined
    });
    return <TaskWorkspaceRoute controller={current} labels={runtimePromptLabels} />;
  }
  render(<App />);
  const prompt = await screen.findByLabelText(runtimePromptLabels.promptLabels.taskPrompt);
  expect(prompt).toHaveValue(header.task.promptMarkdown);
  expect(current.workspace?.blocks).toHaveLength(100);
  const initialReads = [api.getTaskDetail.mock.calls.length, api.getBlockDetail.mock.calls.length];
  api.getTaskDetail.mockClear();
  api.getBlockDetail.mockClear();

  await act(async () => current.loadMoreRuns());

  expect(current.workspace?.blocks[0]?.runs.map(({ run }) => run.record.recordId)).toEqual([
    first!.run.record.recordId,
    second!.run.record.recordId
  ]);
  expect(prompt).toHaveValue(header.task.promptMarkdown);
  expect([api.getTaskDetail.mock.calls.length, api.getBlockDetail.mock.calls.length]).toEqual([
    0, 0
  ]);
  expect(initialReads).toEqual([0, 0]);

  const recordId = second!.run.record.recordId;
  act(() => current.selectRun({ blockRef: second!.blockRef, recordId }));
  await waitFor(() => expect(current.selectedRecord?.recordId).toBe(recordId));
  act(() => current.selectRun(null));
  expect(await screen.findByLabelText(runtimePromptLabels.promptLabels.taskPrompt)).toHaveValue(
    header.task.promptMarkdown
  );
  await act(async () => current.refresh());
  expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2);
  expect([api.getTaskDetail.mock.calls.length, api.getBlockDetail.mock.calls.length]).toEqual([
    0, 0
  ]);
});

it("does not roll back a saved Task Prompt when a pre-save header returns late", async () => {
  const h = await runtimePromptHarness("task", "after-write");
  const captured = deferred<string>();
  const releaseStale = deferred<void>();
  const releaseFresh = deferred<void>();
  expect(await h.writeSource("Earlier source")).toMatchObject({ ok: true });
  h.api.getTaskWorkspace
    .mockImplementationOnce(async (input) => {
      const header = await getTaskWorkspace(input);
      captured.resolve(header.task.promptMarkdown);
      await releaseStale.promise;
      return header;
    })
    .mockImplementationOnce(async (input) => {
      await releaseFresh.promise;
      return getTaskWorkspace(input);
    });
  act(() => h.controller.refresh());
  expect(await captured.promise).toBe("Earlier source");
  const staleRead = h.api.getTaskWorkspace.mock.results.at(-1)?.value;
  expect(await h.writeSource(h.initialMarkdown)).toMatchObject({ ok: true });
  h.api.getTaskDetail.mockClear();
  h.api.getBlockDetail.mockClear();
  fireEvent.change(h.input(), { target: { value: "Saved source" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("Saved source"));
  try {
    await act(async () => {
      h.pending.resolve();
      await h.pending.promise;
    });
    await screen.findByText(runtimePromptLabels.promptLabels.saved);
    await act(async () => {
      releaseStale.resolve();
      expect((await staleRead)?.task.promptMarkdown).toBe("Earlier source");
    });
    expect(h.input()).toHaveValue("Saved source");
    expect([h.api.getTaskDetail.mock.calls.length, h.api.getBlockDetail.mock.calls.length]).toEqual(
      [2, 0]
    );
  } finally {
    releaseStale.resolve();
    releaseFresh.resolve();
  }
  await waitFor(() => expect(h.controller.workspace?.task.promptMarkdown).toBe("Saved source"));
  expect(h.input()).toHaveValue("Saved source");
});

it("accepts an older text only from a source read that started after the saved Prompt read", async () => {
  const task = workspaceHeader(null).task;
  const labels = runtimePromptLabels.promptLabels;
  const authority = {};
  const writer = vi.fn(async () => "saved" as const);
  const readSource = () => ({ generation: 3, markdown: "Saved source" });
  const owner = new TaskWorkspacePromptDraft(task.promptMarkdown, writer, readSource);
  owner.activate(authority, writer, readSource);
  render(<TaskWorkspaceTaskPrompt labels={labels} owner={owner} task={task} />);
  const prompt = screen.getByLabelText(labels.taskPrompt);
  fireEvent.change(prompt, { target: { value: "Saved source" } });
  fireEvent.blur(prompt);
  await screen.findByText(labels.saved);

  act(() => owner.acceptSource(authority, 2, task.promptMarkdown));
  expect(prompt).toHaveValue("Saved source");
  act(() => owner.acceptSource(authority, 4, task.promptMarkdown));
  expect(prompt).toHaveValue(task.promptMarkdown);
  expect(writer).toHaveBeenCalledTimes(1);
});

it("defers an external Task Prompt update until the editor leaves composition", async () => {
  const h = await runtimePromptHarness("task");
  fireEvent.compositionStart(h.input());
  await h.externalWrite("External source");
  expect(h.input()).toHaveValue(h.initialMarkdown);
  fireEvent.compositionEnd(h.input());
  expect(h.input()).toHaveValue("External source");
  expect(h.writes).toHaveLength(0);
});

it.each([
  "task",
  "block"
] as const)("reconciles the latest persisted %s source after A's delayed acknowledgement and same-source remount", async (kind) => {
  const h = await runtimePromptHarness(kind, "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  await h.externalWrite("C");
  if (kind === "block") await h.externalWrite("D");
  const latest = kind === "block" ? "D" : "C";
  expect(h.input()).toHaveValue("A");
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue(latest));
  const form = h.input().closest("form");
  if (!form) throw new Error("Missing prompt form");
  expect(
    within(form).getByRole("button", { name: runtimePromptLabels.promptLabels.savePrompt })
  ).toBeDisabled();
  await h.remount();
  expect(h.input()).toHaveValue(latest);
  expect(await h.markdown()).toBe(latest);
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
});

it.each([
  "task",
  "block"
] as const)("preserves the newer %s draft when external updates win during acknowledgement", async (kind) => {
  const h = await runtimePromptHarness(kind, "after-write");
  const summary = kind === "block" ? h.input().closest("details")?.querySelector("summary") : null;
  if (kind === "block") {
    if (!summary) throw new Error("Missing Block summary");
    if (!h.input().closest("details")?.open) fireEvent.click(summary);
    expect(h.input()).toBeVisible();
  }
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  if (summary) {
    fireEvent.click(summary);
    expect(h.input()).not.toBeVisible();
  }
  await h.externalWrite("C");
  if (kind === "block") await h.externalWrite("D");
  const latest = kind === "block" ? "D" : "C";
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  if (summary) {
    fireEvent.click(summary);
    expect(h.input()).toBeVisible();
  }
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("changed outside this editor")
  );
  expect(h.input()).toHaveValue("AB");
  expect(await h.markdown()).toBe(latest);
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
  await h.remount();
  expect(h.input()).toHaveValue("AB");
});

it("keeps the Task draft and visible failure when an unconfirmed acknowledgement rejects after C arrives", async () => {
  const h = await runtimePromptHarness("task", "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  await h.externalWrite("C");
  await act(async () => {
    h.pending.reject(new Error("Acknowledgement failed"));
    await expect(h.pending.promise).rejects.toThrow("Acknowledgement failed");
  });
  expect(h.input()).toHaveValue("A");
  expect(screen.getByRole("alert")).toHaveTextContent("Acknowledgement failed");
  await h.remount();
  expect(h.input()).toHaveValue("A");
  fireEvent.blur(h.input());
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("changed outside this editor")
  );
  expect(await h.markdown()).toBe("C");
  expect(h.writes).toHaveLength(1);
});

it("reconciles the Block source after a previous project generation confirms persisted A", async () => {
  const h = await runtimePromptHarness("block", "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  await h.externalWrite("C");
  await h.reactivate();
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue("C"));
  expect(await h.markdown()).toBe("C");
  expect(h.writes).toHaveLength(1);
});

it.each([
  { kind: "task", intermediate: false },
  { kind: "block", intermediate: false },
  { kind: "task", intermediate: true },
  { kind: "block", intermediate: true }
] as const)("accepts a real $kind source returning to the initial text, intermediate=$intermediate", async ({
  kind,
  intermediate
}) => {
  const h = await runtimePromptHarness(kind, "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  if (intermediate) await h.externalWrite("C");
  await h.externalWrite(h.initialMarkdown);
  expect(await h.markdown()).toBe(h.initialMarkdown);
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue(h.initialMarkdown));
  await h.remount();
  expect(h.input()).toHaveValue(h.initialMarkdown);
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
});

it.each([
  "task",
  "block"
] as const)("accepts an external %s restore to confirmed A while AB acknowledgement waits", async (kind) => {
  const h = await runtimePromptHarness(kind, "after-write", 2);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() =>
    expect(screen.getAllByText(runtimePromptLabels.promptLabels.saved)).toHaveLength(1)
  );
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("AB"));
  if (kind === "block") await h.externalWrite("C");
  await h.externalWrite("A");
  expect(await h.markdown()).toBe("A");
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue("A"));
  await h.remount();
  expect(h.input()).toHaveValue("A");
  expect(h.writes.map((write) => write.markdown)).toEqual(["A", "AB"]);
});

it("preserves confirmed A and the newer draft when its post-save source read fails", async () => {
  const h = await runtimePromptHarness("task", "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  h.api.getTaskDetail.mockRejectedValueOnce(new Error("Source read unavailable"));
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("saved, but its current source")
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Source read unavailable");
  expect(h.input()).toHaveValue("AB");
  expect(await h.markdown()).toBe("A");
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("AB"));
  expect(h.writes.map((write) => ({ markdown: write.markdown, baseline: write.baseline }))).toEqual(
    [
      { markdown: "A", baseline: h.initialMarkdown },
      { markdown: "AB", baseline: "A" }
    ]
  );
});

it.each([
  "task",
  "block"
] as const)("continues a queued %s save when a newer accepted header supersedes the delayed post-save read error", async (kind) => {
  const h = await runtimePromptHarness(kind, "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  const postReadStarted = deferred<void>();
  const postRead = deferred<never>();
  const readDetail = kind === "task" ? h.api.getTaskDetail : h.api.getBlockDetail;
  readDetail.mockImplementationOnce(() => {
    postReadStarted.resolve();
    return postRead.promise;
  });
  await act(async () => {
    h.pending.resolve();
    await postReadStarted.promise;
  });
  try {
    const previousHeader = h.controller.workspace;
    act(() => h.controller.refresh());
    await waitFor(() => {
      const { workspace } = h.controller;
      expect(workspace).not.toBe(previousHeader);
      const source =
        kind === "task"
          ? workspace?.task
          : workspace?.blocks.find(({ ref }) => ref === "T-001#B-001");
      expect(source?.promptMarkdown).toBe("A");
    });
  } finally {
    await act(async () => {
      postRead.reject(new Error("Obsolete detail request failed"));
      await postRead.promise.catch(() => undefined);
    });
  }
  await waitFor(async () => expect(await h.markdown()).toBe("AB"));
  const form = h.input().closest("form")!;
  expect(await within(form).findByText(runtimePromptLabels.promptLabels.saved)).toBeInTheDocument();
  expect(within(form).queryByRole("alert")).toBeNull();
  expect(h.writes).toEqual([
    { markdown: "A", baseline: h.initialMarkdown, concurrent: 1 },
    { markdown: "AB", baseline: "A", concurrent: 1 }
  ]);
});
