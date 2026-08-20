import type { TaskWorkspace } from "@planweave-ai/runtime";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc";

function matchesWorkspace(
  workspace: TaskWorkspace,
  projection: CollaborationCanvasBindingReplicaProjection
): boolean {
  return (
    !("bindingKind" in projection) &&
    projection.localProjectId === workspace.project.projectId &&
    projection.localCanvasId === workspace.project.canvasId
  );
}

export function sharedTaskPromptMarkdown(
  projection: CollaborationCanvasBindingReplicaProjection | null,
  workspace: TaskWorkspace,
  taskId: string
): string | null {
  if (!projection || !matchesWorkspace(workspace, projection)) {
    return null;
  }
  return projection.content.tasks.find((task) => task.taskId === taskId)?.promptMarkdown ?? null;
}

export function sharedBlockPromptMarkdown(
  projection: CollaborationCanvasBindingReplicaProjection | null,
  workspace: TaskWorkspace,
  blockRef: string
): string | null {
  if (!projection || !matchesWorkspace(workspace, projection)) {
    return null;
  }
  return projection.content.blockPromptMarkdownByRef[blockRef] ?? null;
}

/**
 * Task Workspace combines local runtime/run history with shared durable graph content.
 * Durable task and block fields must come from the replica while shared mode is active;
 * local Task Workspace reads can legitimately lag because they target the local package.
 */
export function projectSharedTaskWorkspace(
  workspace: TaskWorkspace,
  projection: CollaborationCanvasBindingReplicaProjection | null
): TaskWorkspace {
  if (!projection || !matchesWorkspace(workspace, projection)) {
    return workspace;
  }
  const sharedTask = projection.content.tasks.find((task) => task.taskId === workspace.task.taskId);
  if (!sharedTask) {
    return workspace;
  }
  const sharedBlocks = new Map(sharedTask.blocks.map((block) => [block.ref, block]));
  return {
    ...workspace,
    task: {
      ...workspace.task,
      title: sharedTask.title,
      status: sharedTask.status,
      executor: sharedTask.executor,
      promptMarkdown: sharedTask.promptMarkdown,
      promptMissing: sharedTask.promptMissing
    },
    blocks: workspace.blocks.map((block) => {
      const sharedBlock = sharedBlocks.get(block.ref);
      const promptMarkdown = projection.content.blockPromptMarkdownByRef[block.ref];
      if (!sharedBlock && promptMarkdown === undefined) {
        return block;
      }
      return {
        ...block,
        ...(sharedBlock
          ? {
              title: sharedBlock.title,
              status: sharedBlock.status,
              executor: sharedBlock.executor,
              promptMissing: sharedBlock.promptMissing
            }
          : {}),
        ...(promptMarkdown === undefined ? {} : { promptMarkdown })
      };
    })
  };
}
