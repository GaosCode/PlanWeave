/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceCanvasProjection } from "../shared/workspaceCanvasProjection";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator";
import {
  useWorkspaceCanvasCommands,
  type WorkspaceCanvasCommandBridge
} from "../renderer/hooks/useWorkspaceCanvasCommands";
import { useTaskWorkspacePromptActions } from "../renderer/task-workspace/useTaskWorkspacePromptActions";
import {
  TaskWorkspaceTaskPrompt,
  TaskWorkspaceBlockPrompts
} from "../renderer/task-workspace/TaskWorkspacePrompts";
import { taskWorkspaceLabels } from "../renderer/task-workspace/labels";
import { createTranslator } from "../renderer/i18n";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";
import { controllerApi } from "./helpers/taskWorkspaceControllerHarness";
import { deferred } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");
const labels = taskWorkspaceLabels(t).promptLabels;
const locator: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-a",
  workspaceId: "workspace-a",
  projectId: "project-a",
  canvasId: "canvas-a"
};
afterEach(cleanupRendererTestEnvironment);

async function harness(kind: "task" | "block", behavior?: "external" | "retired") {
  const fixture = taskWorkspaceInspectorFixture();
  const graph = await controllerApi({ readModel: () => null }).api.getGraphViewModel();
  const task = graph.tasks[0];
  if (!task) throw new Error("Missing Task fixture");
  task.promptMarkdown = fixture.workspace.task.promptMarkdown;
  let stored: WorkspaceCanvasProjection = {
    locator,
    status: "accepted",
    authorityMode: "server_authoritative",
    readOnly: false,
    cachedAt: null,
    initialRuntimeAvailability: null,
    conflict: null,
    rejectCode: null,
    replica: {
      authorityId: "workspace-authority-a",
      bindingKind: "remote",
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      canvasId: locator.canvasId,
      revision: 1,
      contentDigest: "a".repeat(64),
      canEdit: true,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        projectTitle: "Prompt queue",
        graphVersion: "pgv-1",
        packageFingerprint: `pkg-${"b".repeat(64)}`,
        tasks: [task],
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
        blockPromptMarkdownByRef: {
          [fixture.selectedRun.block.ref]: fixture.selectedRun.block.promptMarkdown
        }
      }
    }
  };
  const pending = deferred<void>();
  const commands: string[] = [];
  let signal:
    | Parameters<WorkspaceCanvasCommandBridge["onWorkspaceCanvasProjectionSignal"]>[0]
    | null = null;
  const api: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: vi.fn(async () => stored),
    reconnectWorkspaceCanvasSession: vi.fn(async () => stored),
    closeWorkspaceCanvasSession: vi.fn(async () => undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn((callback) => {
      signal = callback;
      return () => {
        signal = null;
      };
    }),
    submitWorkspaceCanvasCommand: vi.fn(async ({ intent }) => {
      if (intent.kind !== "update_task_prompt" && intent.kind !== "update_block_prompt")
        throw new Error("Unexpected prompt intent");
      commands.push(intent.promptMarkdown);
      if (commands.length === 1) await pending.promise;
      stored = structuredClone(stored);
      stored.replica.revision += 1;
      stored.replica.contentDigest = (commands.length === 1 ? "b" : "c").repeat(64);
      if (intent.kind === "update_task_prompt")
        stored.replica.content.tasks[0]!.promptMarkdown = intent.promptMarkdown;
      else stored.replica.content.blockPromptMarkdownByRef[intent.blockRef] = intent.promptMarkdown;
      if (commands.length === 1 && behavior === "external") {
        stored = structuredClone(stored);
        stored.replica.revision += 1;
        if (intent.kind === "update_task_prompt")
          stored.replica.content.tasks[0]!.promptMarkdown = "C";
        else stored.replica.content.blockPromptMarkdownByRef[intent.blockRef] = "C";
        signal?.({ type: "workspace.canvas.projection", projection: stored });
      }
      return stored;
    })
  };
  let showEditor = true;
  let connected = true;
  let current!: ReturnType<typeof useTaskWorkspacePromptActions>;
  function App() {
    const gate = useWorkspaceCanvasCommands({
      api,
      authorityKey: "prompt-test",
      locator,
      sessionConnected: connected,
      t
    });
    const workspace = {
      ...fixture.workspace,
      project: {
        authority: "workspace" as const,
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        canvasId: locator.canvasId
      }
    };
    current = useTaskWorkspacePromptActions({
      api: controllerApi({ readModel: () => null }).api,
      authority: { canvasLocator: locator, projectRoot: null, workspaceRoot: null },
      navigation: {
        authority: "workspace",
        connectionProfileId: locator.connectionProfileId,
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        canvasId: locator.canvasId,
        taskId: workspace.task.taskId,
        source: { view: "graph" }
      },
      workspace,
      workspaceCanvas: gate,
      onLocalSaved: vi.fn()
    });
    const source =
      kind === "task"
        ? gate.projection?.content.tasks[0]?.promptMarkdown
        : gate.projection?.content.blockPromptMarkdownByRef[fixture.selectedRun.block.ref];
    if (source === undefined) return null;
    const writer =
      kind === "task"
        ? current.saveTaskPrompt
        : (input: Parameters<typeof current.saveTaskPrompt>[0]) =>
            current.saveBlockPrompt(fixture.selectedRun.block.ref, input);
    if (!showEditor) return null;
    const owner = current.getPromptDraft(
      kind === "task" ? null : fixture.selectedRun.block.ref,
      source,
      writer
    );
    return showEditor ? (
      kind === "task" ? (
        <TaskWorkspaceTaskPrompt
          task={{ ...workspace.task, promptMarkdown: source }}
          labels={labels}
          owner={owner}
        />
      ) : (
        <TaskWorkspaceBlockPrompts
          block={{ ...fixture.selectedRun.block, promptMarkdown: source }}
          labels={labels}
          owner={owner}
        />
      )
    ) : null;
  }
  const view = render(<App />);
  const input = () =>
    screen.getByLabelText(kind === "task" ? labels.taskPrompt : labels.blockPrompt);
  await waitFor(() => expect(input()).toBeInTheDocument());
  return {
    pending,
    commands,
    input,
    api,
    view,
    hide() {
      showEditor = false;
      view.rerender(<App />);
    },
    show() {
      showEditor = true;
      view.rerender(<App />);
    },
    retire() {
      connected = false;
      view.rerender(<App />);
    },
    setWritable(writable: boolean) {
      stored = structuredClone(stored);
      stored.readOnly = !writable;
      stored.replica.canEdit = writable;
      signal?.({ type: "workspace.canvas.projection", projection: stored });
    },
    resume() {
      connected = true;
      view.rerender(<App />);
    },
    markdown() {
      return kind === "task"
        ? stored.replica.content.tasks[0]?.promptMarkdown
        : stored.replica.content.blockPromptMarkdownByRef[fixture.selectedRun.block.ref];
    }
  };
}

it.each([
  "task",
  "block"
] as const)("uses the real session's confirmed %s projection to drain AB before React readback", async (kind) => {
  const h = await harness(kind);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.commands).toEqual(["A"]));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => h.hide());
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.commands).toEqual(["A", "AB"]));
  expect(h.markdown()).toBe("AB");
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
});

it("reports the real session's external C without overwriting it or losing AB", async () => {
  const h = await harness("task", "external");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => h.hide());
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.markdown()).toBe("C"));
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
  expect(screen.getByRole("alert")).toHaveTextContent("changed before its save was confirmed");
  expect(h.commands).toEqual(["A"]);
});

it("keeps AB available after the real session retires its pending command", async () => {
  const h = await harness("task", "retired");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => {
    h.hide();
    h.retire();
  });
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.commands).toEqual(["A"]));
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
  expect(screen.queryByText(labels.saved)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: labels.savePrompt })).toBeEnabled();
});

it.each([
  ["task", "session"],
  ["block", "session"],
  ["task", "permission"],
  ["block", "permission"]
] as const)("retires an unsubmitted %s autosave across a real %s generation", async (kind, retirement) => {
  const h = await harness(kind);
  fireEvent.change(h.input(), { target: { value: "AB" } });
  if (retirement === "session") {
    act(() => h.hide());
    act(() => h.retire());
    await act(async () => {
      h.resume();
      await Promise.resolve();
    });
  } else {
    act(() => h.setWritable(false));
    await act(async () => {
      h.setWritable(true);
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 850));
  });
  expect(h.commands).toEqual([]);
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
  const markdown = kind === "task" ? "AB" : "ABC";
  if (kind === "task") fireEvent.click(screen.getByRole("button", { name: labels.savePrompt }));
  else fireEvent.change(h.input(), { target: { value: markdown } });
  await waitFor(() => expect(h.commands).toEqual([markdown]));
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.markdown()).toBe(markdown));
});
