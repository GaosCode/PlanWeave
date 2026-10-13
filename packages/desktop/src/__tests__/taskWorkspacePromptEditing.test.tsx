/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskWorkspaceBlockPrompts,
  TaskWorkspaceTaskPrompt
} from "../renderer/task-workspace/TaskWorkspacePrompts";
import type { TaskWorkspacePromptLabels } from "../renderer/task-workspace/contracts";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";
import { deferred } from "./helpers/desktopProjectFixtures";

afterEach(() => {
  vi.useRealTimers();
  cleanupRendererTestEnvironment();
});

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

describe("Task Workspace prompt editing", () => {
  it.each([
    "task",
    "block"
  ] as const)("keeps a %s draft dirty when its save is retired", async (kind) => {
    vi.useFakeTimers();
    const fixture = taskWorkspaceInspectorFixture();
    const task = fixture.workspace.task;
    const block = fixture.selectedRun.block;
    const originalMarkdown = kind === "task" ? task.promptMarkdown : block.promptMarkdown;
    const submitted = deferred<"retired">();
    const onSave = vi.fn().mockReturnValue(submitted.promise);
    if (kind === "task") {
      render(<TaskWorkspaceTaskPrompt labels={labels} onSave={onSave} task={task} />);
    } else {
      render(<TaskWorkspaceBlockPrompts block={block} labels={labels} onSave={onSave} />);
    }
    const input = screen.getByLabelText(kind === "task" ? "Task prompt" : "Block prompt");
    fireEvent.change(input, { target: { value: "# Draft awaiting the current Workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Prompt" }));
    await act(async () => {
      submitted.resolve("retired");
      await submitted.promise;
    });

    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("# Draft awaiting the current Workspace");
    expect(screen.getByRole("button", { name: "Save Prompt" })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save Prompt" }));
    expect(onSave).toHaveBeenLastCalledWith({
      baseMarkdown: originalMarkdown,
      markdown: "# Draft awaiting the current Workspace"
    });
  });

  it("automatically saves a settled Task prompt draft", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => "saved" as const);
    render(
      <TaskWorkspaceTaskPrompt
        labels={labels}
        onSave={onSave}
        task={{
          taskId: "T-001",
          title: "Task",
          status: "ready",
          executor: null,
          promptMarkdown: "# Original Task prompt",
          promptMissing: false,
          acceptance: []
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "# Automatically saved Task prompt" }
    });
    await vi.advanceTimersByTimeAsync(800);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      baseMarkdown: "# Original Task prompt",
      markdown: "# Automatically saved Task prompt"
    });
  });

  it("flushes a pending Block prompt save when editing loses focus", async () => {
    vi.useFakeTimers();
    const block = taskWorkspaceInspectorFixture().selectedRun.block;
    const onSave = vi.fn(async () => "saved" as const);
    render(<TaskWorkspaceBlockPrompts block={block} labels={labels} onSave={onSave} />);
    const blockPrompt = screen.getByLabelText("Block prompt");

    fireEvent.change(blockPrompt, { target: { value: "# Saved on blur" } });
    fireEvent.blur(blockPrompt);
    await vi.runAllTimersAsync();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      baseMarkdown: block.promptMarkdown,
      markdown: "# Saved on blur"
    });
  });

  it("does not submit twice when blur and the manual save action happen together", async () => {
    let resolveSave: (() => void) | null = null;
    const onSave = vi.fn(
      () =>
        new Promise<"saved">((resolve) => {
          resolveSave = () => resolve("saved");
        })
    );
    render(
      <TaskWorkspaceTaskPrompt
        labels={labels}
        onSave={onSave}
        task={{
          taskId: "T-001",
          title: "Task",
          status: "ready",
          executor: null,
          promptMarkdown: "# Original Task prompt",
          promptMissing: false,
          acceptance: []
        }}
      />
    );
    const prompt = screen.getByLabelText("Task prompt");

    fireEvent.change(prompt, { target: { value: "# Updated once" } });
    fireEvent.blur(prompt);
    fireEvent.click(screen.getByRole("button", { name: "Save Prompt" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
    });
  });

  it("saves an edited Task prompt with its original source as the conflict baseline", async () => {
    const onSave = vi.fn(async () => "saved" as const);
    render(
      <TaskWorkspaceTaskPrompt
        labels={labels}
        onSave={onSave}
        task={{
          taskId: "T-001",
          title: "Task",
          status: "ready",
          executor: null,
          promptMarkdown: "# Original Task prompt",
          promptMissing: false,
          acceptance: []
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "# Updated Task prompt" }
    });
    await userEvent.click(screen.getByRole("button", { name: "Save Prompt" }));

    expect(onSave).toHaveBeenCalledWith({
      baseMarkdown: "# Original Task prompt",
      markdown: "# Updated Task prompt"
    });
  });

  it("saves a Block source prompt while leaving its Effective Prompt read-only", async () => {
    const block = taskWorkspaceInspectorFixture().selectedRun.block;
    const onSave = vi.fn(async () => "saved" as const);
    render(<TaskWorkspaceBlockPrompts block={block} labels={labels} onSave={onSave} />);

    const blockPrompts = screen.getByTestId(`task-workspace-block-prompts:${block.ref}`);
    const blockPrompt = within(blockPrompts).getByLabelText("Block prompt");
    const effectivePrompt = within(blockPrompts).getByLabelText("Effective prompt");
    fireEvent.change(blockPrompt, { target: { value: "# Updated Block prompt" } });
    await userEvent.click(within(blockPrompts).getByRole("button", { name: "Save Prompt" }));

    expect(onSave).toHaveBeenCalledWith({
      baseMarkdown: block.promptMarkdown,
      markdown: "# Updated Block prompt"
    });
    expect(effectivePrompt).toHaveTextContent("Task prompt and block prompt rendered together.");
    expect(effectivePrompt.tagName).toBe("PRE");
  });
});
