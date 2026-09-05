import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { requireMapValue } from "../graph/requireMapValue.js";
import { buildPlanGraph, buildPlanGraphContentProjection } from "../plangraph/index.js";
import {
  packageFingerprintFromContent,
  promptPreview,
  sha256Hex,
  graphVersionFromPackageFingerprint
} from "../plangraph/hash.js";
import { exceptionForBlock } from "../plangraph/projections/graphViewProjection.js";
import type {
  DesktopGraphEdgeViewModel,
  DesktopSharedResourceGroup,
  DesktopTaskException,
  DesktopTaskNodeViewModel
} from "../desktop/types/graphTypes.js";
import { buildSharedResourceGroupsFromMembership } from "../desktop/graph/sharedResourceViewModel.js";
import type { CanvasReplicaDocument } from "./document.js";

export type CanvasReplicaGraphContent = {
  manifest: CanvasReplicaDocument["manifest"];
  promptMarkdownByPath: CanvasReplicaDocument["promptMarkdownByPath"];
  projectTitle: string;
  graphVersion: string;
  packageFingerprint: string;
  tasks: DesktopTaskNodeViewModel[];
  edges: DesktopGraphEdgeViewModel[];
  sharedResourceGroups: DesktopSharedResourceGroup[];
  diagnostics: Array<{ code: string; message: string; path?: string }>;
  blockDependenciesByRef: Record<string, string[]>;
  taskOpenFeedbackCountByTaskId: Record<string, number>;
  blockPromptMarkdownByRef: Record<string, string>;
  layout: CanvasReplicaDocument["layout"];
};

function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

function requireReplicaPrompt(
  markdownByPath: ReadonlyMap<string, string>,
  path: string,
  ownerRef: string
): string {
  const markdown = markdownByPath.get(path);
  if (markdown === undefined) throw new Error(`canvas_replica_prompt_missing:${ownerRef}`);
  return markdown;
}

function promptIndex(document: CanvasReplicaDocument) {
  const index = new Map<
    string,
    {
      ownerKind: "task" | "block";
      ownerRef: string;
      path: string;
      contentHash: string;
      preview: string;
    }
  >();
  const markdownByPath = new Map(Object.entries(document.promptMarkdownByPath));
  for (const task of document.manifest.nodes) {
    const taskMarkdown = markdownByPath.get(task.prompt);
    if (taskMarkdown === undefined)
      throw new Error(`canvas_replica_task_prompt_missing:${task.id}`);
    index.set(task.prompt, {
      ownerKind: "task",
      ownerRef: task.id,
      path: task.prompt,
      contentHash: sha256Hex(taskMarkdown),
      preview: promptPreview(taskMarkdown)
    });
    for (const block of task.blocks) {
      const ref = blockRef(task.id, block.id);
      const blockMarkdown = markdownByPath.get(block.prompt);
      if (blockMarkdown === undefined)
        throw new Error(`canvas_replica_block_prompt_missing:${ref}`);
      index.set(block.prompt, {
        ownerKind: "block",
        ownerRef: ref,
        path: block.prompt,
        contentHash: sha256Hex(blockMarkdown),
        preview: promptPreview(blockMarkdown)
      });
    }
  }
  return { index, markdownByPath };
}

function sameScope(left: CanvasScopeRef, right: CanvasScopeRef): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

function hasExactRuntimeIdentity(
  content: CanvasReplicaGraphContent,
  status: CanvasRuntimeStatusProjection
): boolean {
  const contentTaskIds = content.tasks.map((task) => task.taskId);
  const contentBlockRefs = content.tasks.flatMap((task) => task.blocks.map((block) => block.ref));
  const statusTaskIds = new Set(status.tasks.map((task) => task.taskId));
  const statusBlockRefs = new Set(status.blocks.map((block) => block.ref));
  return (
    status.tasks.length === contentTaskIds.length &&
    status.blocks.length === contentBlockRefs.length &&
    contentTaskIds.every((taskId) => statusTaskIds.has(taskId)) &&
    contentBlockRefs.every((ref) => statusBlockRefs.has(ref))
  );
}

function requirePreviewBlock(
  blocksByRef: Map<string, DesktopTaskNodeViewModel["blocks"][number]>,
  ref: string
): DesktopTaskNodeViewModel["blocks"][number] {
  return requireMapValue(blocksByRef, ref, "canvasReplicaBlockPreviewByRef");
}

function failClosed(content: CanvasReplicaGraphContent): CanvasReplicaGraphContent {
  const tasks = content.tasks.map((task) => {
    const blocks = task.blocks.map((block) => ({
      ...block,
      status: "planned" as const,
      exceptionReason: null,
      dispatchable: false,
      remoteExecution: null
    }));
    const previewByRef = new Map(blocks.map((block) => [block.ref, block]));
    return {
      ...task,
      status: "planned" as const,
      blocks,
      blockPreview: task.blockPreview.map((block) => requirePreviewBlock(previewByRef, block.ref)),
      exceptions: []
    };
  });
  return {
    ...content,
    tasks,
    sharedResourceGroups: content.sharedResourceGroups.map((group) => ({
      ...group,
      activeBlockRefs: []
    })),
    taskOpenFeedbackCountByTaskId: Object.fromEntries(tasks.map((task) => [task.taskId, 0]))
  };
}

/**
 * Projects authoritative replica content without loading a local package or RuntimeState.
 * Every runtime-derived field begins fail-closed and may only be populated by a compatible status overlay.
 */
export function projectCanvasReplicaDocument(
  document: CanvasReplicaDocument
): CanvasReplicaGraphContent {
  const { index, markdownByPath } = promptIndex(document);
  const compiledGraph = compileTaskGraph(document.manifest);
  if (compiledGraph.diagnostics.errors.length > 0) {
    throw new Error("canvas_replica_graph_invalid");
  }
  const packageFingerprint = packageFingerprintFromContent(document.manifest, markdownByPath);
  const graph = buildPlanGraph({
    manifest: document.manifest,
    compiledGraph,
    graphVersion: graphVersionFromPackageFingerprint(packageFingerprint),
    packageFingerprint,
    promptIndex: index
  });
  const taskPromptMarkdownById = new Map(
    document.manifest.nodes.map((task) => [
      task.id,
      requireReplicaPrompt(markdownByPath, task.prompt, task.id)
    ])
  );
  const graphProjection = buildPlanGraphContentProjection({
    graph,
    runtime: { manifest: document.manifest },
    taskPromptMarkdownById
  });
  const tasks = graphProjection.tasks.map((task) => ({
    ...task,
    sharedResources: [
      ...new Set(
        task.blocks.flatMap((block) =>
          requireMapValue(
            compiledGraph.sharedResourcesByBlockRef,
            block.ref,
            "sharedResourcesByBlockRef"
          )
        )
      )
    ].sort((left, right) => left.localeCompare(right))
  }));
  return {
    manifest: document.manifest,
    promptMarkdownByPath: document.promptMarkdownByPath,
    projectTitle: graph.project.title,
    graphVersion: graph.graphVersion,
    packageFingerprint,
    tasks,
    edges: graphProjection.edges,
    sharedResourceGroups: buildSharedResourceGroupsFromMembership(
      compiledGraph.blockRefsInManifestOrder.map((ref) => ({
        ref,
        taskId: requireMapValue(compiledGraph.blockTaskByRef, ref, "blockTaskByRef"),
        resources: requireMapValue(
          compiledGraph.sharedResourcesByBlockRef,
          ref,
          "sharedResourcesByBlockRef"
        ),
        status: "inactive" as const
      }))
    ),
    diagnostics: [...graph.diagnostics],
    blockDependenciesByRef: Object.fromEntries(
      compiledGraph.blockRefsInManifestOrder.map((ref) => [
        ref,
        [...requireMapValue(compiledGraph.blockDependenciesByRef, ref, "blockDependenciesByRef")]
      ])
    ),
    taskOpenFeedbackCountByTaskId: Object.fromEntries(tasks.map((task) => [task.taskId, 0])),
    blockPromptMarkdownByRef: Object.fromEntries(
      document.manifest.nodes.flatMap((task) =>
        task.blocks.map((block) => [
          blockRef(task.id, block.id),
          requireReplicaPrompt(markdownByPath, block.prompt, blockRef(task.id, block.id))
        ])
      )
    ),
    layout: document.layout
  };
}

/**
 * Applies the owner Runtime's redacted status only when it belongs to this exact replica identity.
 * Mismatched scope or package content resets the transient surface instead of borrowing local graph state.
 */
export function overlayCanvasReplicaRuntimeStatus(input: {
  content: CanvasReplicaGraphContent;
  status: CanvasRuntimeStatusProjection | null;
  scope: CanvasScopeRef;
}): CanvasReplicaGraphContent {
  const { content, status, scope } = input;
  const baseline = failClosed(content);
  if (!status || !sameScope(status.scope, scope) || !hasExactRuntimeIdentity(content, status)) {
    return baseline;
  }
  const contentMatchesRuntime = status.packageFingerprint === content.packageFingerprint;
  const taskStatuses = new Map(status.tasks.map((task) => [task.taskId, task]));
  const blockStatuses = new Map(status.blocks.map((block) => [block.ref, block]));
  const taskOpenFeedbackCountByTaskId: Record<string, number> = {};
  const tasks = baseline.tasks.map((task) => {
    const remoteTask = requireMapValue(taskStatuses, task.taskId, "canvasReplicaTaskStatusById");
    taskOpenFeedbackCountByTaskId[task.taskId] = remoteTask.openFeedbackCount;
    const blocks = task.blocks.map((block) => {
      const remoteBlock = requireMapValue(
        blockStatuses,
        block.ref,
        "canvasReplicaBlockStatusByRef"
      );
      return {
        ...block,
        status: remoteBlock.status,
        stopped: remoteBlock.stopped,
        exceptionReason: remoteBlock.blockedReason ?? remoteBlock.divergenceReason ?? null,
        dispatchable: contentMatchesRuntime && remoteBlock.dispatchable
      };
    });
    const blockByRef = new Map(blocks.map((block) => [block.ref, block]));
    return {
      ...task,
      status: remoteTask.status,
      blocks,
      blockPreview: task.blockPreview.map((block) => requirePreviewBlock(blockByRef, block.ref)),
      exceptions: blocks
        .map((block) =>
          block.stopped ? null : exceptionForBlock(block.ref, block.status, block.exceptionReason)
        )
        .filter((exception): exception is DesktopTaskException => exception !== null)
    };
  });
  const statusByRef = new Map(
    tasks.flatMap((task) => task.blocks.map((block) => [block.ref, block.status] as const))
  );
  return {
    ...baseline,
    tasks,
    sharedResourceGroups: baseline.sharedResourceGroups.map((group) => ({
      ...group,
      activeBlockRefs: group.memberBlockRefs.filter((ref) => statusByRef.get(ref) === "in_progress")
    })),
    taskOpenFeedbackCountByTaskId
  };
}
