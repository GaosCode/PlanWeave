import { useState } from "react";
import type { ComponentProps } from "react";
import type { TaskWorkspaceController } from "../../renderer/task-workspace/contracts";
import { TaskWorkspacePromptDraft } from "../../renderer/task-workspace/taskWorkspacePromptDraft";
import {
  TaskWorkspaceTaskPrompt as TaskPrompt,
  TaskWorkspaceBlockPrompts as BlockPrompts
} from "../../renderer/task-workspace/TaskWorkspacePrompts";

export function taskWorkspacePromptOwnerFixture(): TaskWorkspaceController["getPromptDraft"] {
  const drafts = new Map<string | null, TaskWorkspacePromptDraft>();
  const authority = {};
  return (blockRef, markdown, writer) => {
    let draft = drafts.get(blockRef);
    if (!draft) {
      draft = new TaskWorkspacePromptDraft(markdown, writer);
      drafts.set(blockRef, draft);
    }
    draft.activate(authority, writer);
    return draft;
  };
}

type PromptWriter = TaskWorkspaceController["saveTaskPrompt"];
export function TaskWorkspaceTaskPrompt({
  onSave,
  ...props
}: ComponentProps<typeof TaskPrompt> & { onSave: PromptWriter }) {
  const [getDraft] = useState(taskWorkspacePromptOwnerFixture);
  return <TaskPrompt {...props} owner={getDraft(null, props.task.promptMarkdown, onSave)} />;
}
export function TaskWorkspaceBlockPrompts({
  onSave,
  ...props
}: ComponentProps<typeof BlockPrompts> & { onSave: PromptWriter }) {
  const [getDraft] = useState(taskWorkspacePromptOwnerFixture);
  return (
    <BlockPrompts
      {...props}
      owner={getDraft(props.block.ref, props.block.promptMarkdown, onSave)}
    />
  );
}
