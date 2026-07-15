/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskWorkspaceBlockPrompts,
  TaskWorkspaceTaskPrompt
} from "../renderer/task-workspace/TaskWorkspacePrompts";
import type { TaskWorkspacePromptLabels } from "../renderer/task-workspace/contracts";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";

afterEach(cleanupRendererTestEnvironment);

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
  it("saves an edited Task prompt with its original source as the conflict baseline", async () => {
    const onSave = vi.fn(async () => undefined);
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
    const onSave = vi.fn(async () => undefined);
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
