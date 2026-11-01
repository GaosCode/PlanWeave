import { useLayoutEffect, useState } from "react";
import type { ComponentProps } from "react";
import type { TaskWorkspaceController } from "../../renderer/task-workspace/contracts";
import { TaskWorkspacePromptDraft } from "../../renderer/task-workspace/taskWorkspacePromptDraft";
import {
  TaskWorkspaceTaskPrompt as TaskPrompt,
  TaskWorkspaceBlockPrompts as BlockPrompts
} from "../../renderer/task-workspace/TaskWorkspacePrompts";

export function taskWorkspacePromptOwnerFixture(): TaskWorkspaceController["getPromptDraft"] {
  const drafts = new Map<
    string | null,
    {
      draft: TaskWorkspacePromptDraft;
      source: { markdown: string };
      observed: string;
    }
  >();
  const authority = {};
  return (blockRef, markdown, writer) => {
    let entry = drafts.get(blockRef);
    if (!entry) {
      const source = { markdown };
      entry = {
        source,
        observed: markdown,
        draft: new TaskWorkspacePromptDraft(markdown, writer, async () => source.markdown)
      };
      drafts.set(blockRef, entry);
    }
    if (entry.observed !== markdown) {
      entry.observed = markdown;
      entry.source.markdown = markdown;
    }
    const current = entry;
    const persist: PromptWriter = async (input) => {
      const result = await writer(input);
      if (result === "saved") current.source.markdown = input.markdown;
      return result;
    };
    current.draft.activate(authority, persist, async () => current.source.markdown);
    return current.draft;
  };
}

type PromptWriter = TaskWorkspaceController["saveTaskPrompt"];
export function TaskWorkspaceTaskPrompt({
  onSave,
  ...props
}: ComponentProps<typeof TaskPrompt> & { onSave: PromptWriter }) {
  const [getDraft] = useState(taskWorkspacePromptOwnerFixture);
  const owner = getDraft(null, props.task.promptMarkdown, onSave);
  useLayoutEffect(() => {
    void owner.refreshSource();
  });
  return <TaskPrompt {...props} owner={owner} />;
}
export function TaskWorkspaceBlockPrompts({
  onSave,
  ...props
}: ComponentProps<typeof BlockPrompts> & { onSave: PromptWriter }) {
  const [getDraft] = useState(taskWorkspacePromptOwnerFixture);
  const owner = getDraft(props.block.ref, props.block.promptMarkdown, onSave);
  useLayoutEffect(() => {
    void owner.refreshSource();
  });
  return <BlockPrompts {...props} owner={owner} />;
}
