import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { WorkspaceCanvasProjection } from "../../shared/workspaceCanvasProjection";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import {
  useWorkspaceCanvasCommands,
  type WorkspaceCanvasCommandBridge
} from "../../renderer/hooks/useWorkspaceCanvasCommands";
import { useTaskWorkspacePromptActions } from "../../renderer/task-workspace/useTaskWorkspacePromptActions";
import {
  TaskWorkspaceTaskPrompt,
  TaskWorkspaceBlockPrompts
} from "../../renderer/task-workspace/TaskWorkspacePrompts";
import { taskWorkspaceLabels } from "../../renderer/task-workspace/labels";
import { createTranslator } from "../../renderer/i18n";
import { taskWorkspaceInspectorFixture } from "./taskWorkspaceInspectorFixture";
import { controllerApi } from "./taskWorkspaceControllerHarness";
import { deferred } from "./desktopProjectFixtures";

const t = createTranslator("en");
export const sharedPromptLabels = taskWorkspaceLabels(t).promptLabels;
const labels = sharedPromptLabels;
const locator: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-a",
  workspaceId: "workspace-a",
  projectId: "project-a",
  canvasId: "canvas-a"
};

export async function sharedPromptSessionHarness(
  kind: "task" | "block",
  behavior?: "external" | "retired",
  delayAfterPersist = false
) {
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
      if (commands.length === 1 && !delayAfterPersist) await pending.promise;
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
      if (commands.length === 1 && delayAfterPersist) {
        const accepted = structuredClone(stored);
        signal?.({ type: "workspace.canvas.projection", projection: accepted });
        await pending.promise;
        return accepted;
      }
      return stored;
    })
  };
  let showEditor = true;
  let connected = true;
  let current!: ReturnType<typeof useTaskWorkspacePromptActions>;
  let currentCommands!: ReturnType<typeof useWorkspaceCanvasCommands>;
  let signalSequence = 2;
  let publishedSource: string | undefined;
  function App() {
    const gate = useWorkspaceCanvasCommands({
      api,
      authorityKey: "prompt-test",
      locator,
      sessionConnected: connected,
      t
    });
    currentCommands = gate;
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
    publishedSource = source;
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
    source: () => publishedSource,
    get gate() {
      return currentCommands;
    },
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
    publish(markdown: string, revision = stored.replica.revision + 1) {
      stored = structuredClone(stored);
      stored.replica.revision = revision;
      stored.replica.contentDigest = (++signalSequence).toString(16).padStart(64, "0");
      if (kind === "task") stored.replica.content.tasks[0]!.promptMarkdown = markdown;
      else
        stored.replica.content.blockPromptMarkdownByRef[fixture.selectedRun.block.ref] = markdown;
      signal?.({ type: "workspace.canvas.projection", projection: stored });
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
