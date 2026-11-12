import { useLayoutEffect, useState } from "react";
import type { ComponentProps } from "react";
import type { TaskWorkspaceController } from "../../renderer/task-workspace/contracts";
import { TaskWorkspacePromptDraft } from "../../renderer/task-workspace/taskWorkspacePromptDraft";
import {
  TaskWorkspaceTaskPrompt as TaskPrompt,
  TaskWorkspaceBlockPrompts as BlockPrompts
} from "../../renderer/task-workspace/TaskWorkspacePrompts";

function createPromptOwnerFixture() {
  const drafts = new Map<
    string | null,
    {
      draft: TaskWorkspacePromptDraft;
      source: { generation: number; markdown: string };
      observed: string;
    }
  >();
  const authority = {};
  const getDraft: TaskWorkspaceController["getPromptDraft"] = (blockRef, markdown, writer) => {
    let entry = drafts.get(blockRef);
    if (!entry) {
      const source = { generation: 0, markdown };
      entry = {
        source,
        observed: markdown,
        draft: new TaskWorkspacePromptDraft(markdown, writer, () => ({ ...source }))
      };
      drafts.set(blockRef, entry);
    }
    if (entry.observed !== markdown) {
      entry.observed = markdown;
      entry.source.markdown = markdown;
      entry.source.generation += 1;
    }
    const current = entry;
    const persist: PromptWriter = async (input) => {
      const result = await writer(input);
      if (result === "saved") {
        current.source.markdown = input.markdown;
        current.source.generation += 1;
      }
      return result;
    };
    current.draft.activate(authority, persist, () => ({ ...current.source }));
    return current.draft;
  };
  const syncSource = (blockRef: string | null) => {
    const entry = drafts.get(blockRef);
    if (entry) entry.draft.acceptSource(authority, entry.source.generation, entry.source.markdown);
  };
  return { getDraft, syncSource };
}

export function taskWorkspacePromptOwnerFixture(): TaskWorkspaceController["getPromptDraft"] {
  return createPromptOwnerFixture().getDraft;
}

type PromptWriter = TaskWorkspaceController["saveTaskPrompt"];
export function TaskWorkspaceTaskPrompt({
  onSave,
  ...props
}: ComponentProps<typeof TaskPrompt> & { onSave: PromptWriter }) {
  const [{ getDraft, syncSource }] = useState(createPromptOwnerFixture);
  const owner = getDraft(null, props.task.promptMarkdown, onSave);
  useLayoutEffect(() => {
    syncSource(null);
  });
  return <TaskPrompt {...props} owner={owner} />;
}
export function TaskWorkspaceBlockPrompts({
  onSave,
  ...props
}: ComponentProps<typeof BlockPrompts> & { onSave: PromptWriter }) {
  const [{ getDraft, syncSource }] = useState(createPromptOwnerFixture);
  const owner = getDraft(props.block.ref, props.block.promptMarkdown, onSave);
  useLayoutEffect(() => {
    syncSource(props.block.ref);
  });
  return <BlockPrompts {...props} owner={owner} />;
}
