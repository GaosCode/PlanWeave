import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  buildPlanPackageBlockFieldEditMutation,
  buildPlanPackageTaskFieldEditMutation
} from "./fieldEditMutation.js";
import {
  buildPlanPackageGraphMutation,
  buildPlanPackageManifestChangeMutation,
  type PlanPackageGraphMutation
} from "./mutation.js";
import type { ManifestBlock, ManifestTaskNode, PlanPackageManifest } from "../types.js";
import type { DesktopLayout } from "../desktop/types.js";

export class CanvasCommandMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasCommandMutationError";
  }
}

function promptMarkdown(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function taskNode(manifest: PlanPackageManifest, taskId: string): ManifestTaskNode | undefined {
  return manifest.nodes.find((candidate) => candidate.id === taskId);
}

function requireTask(manifest: PlanPackageManifest, taskId: string): ManifestTaskNode {
  const task = taskNode(manifest, taskId);
  if (!task) throw new CanvasCommandMutationError(`task_missing:${taskId}`);
  return task;
}

function buildDefaultTaskNode(
  intent: Extract<CanvasCommandIntent, { kind: "add_task" }>,
  maxFeedbackCycles: number
): {
  node: ManifestTaskNode;
  taskPromptMarkdown: string;
  blockPromptMarkdown: Array<{ blockId: string; markdown: string }>;
} {
  const allowedBlockIds = new Set(["B-001", "R-001"]);
  const seenBlockIds = new Set<string>();
  for (const entry of intent.blockPrompts ?? []) {
    if (!allowedBlockIds.has(entry.blockId)) {
      throw new CanvasCommandMutationError(`add_task_block_prompt_unknown:${entry.blockId}`);
    }
    if (seenBlockIds.has(entry.blockId)) {
      throw new CanvasCommandMutationError(`add_task_block_prompt_duplicate:${entry.blockId}`);
    }
    seenBlockIds.add(entry.blockId);
  }
  if (intent.layout && intent.layout.nodeId !== intent.taskId) {
    throw new CanvasCommandMutationError("add_task_layout_task_mismatch");
  }
  if (intent.layout && !intent.layoutUpdatedAt) {
    throw new CanvasCommandMutationError("canvas_layout_updated_at_required");
  }
  if (!intent.layout && intent.layoutUpdatedAt) {
    throw new CanvasCommandMutationError("add_task_layout_missing");
  }
  const implementation: ManifestBlock = {
    id: "B-001",
    type: "implementation",
    title: "Implement work",
    prompt: `nodes/${intent.taskId}/blocks/B-001.prompt.md`,
    depends_on: [],
    ...(intent.executor === undefined ? {} : { executor: intent.executor })
  };
  const review: ManifestBlock = {
    id: "R-001",
    type: "review",
    title: "Review work",
    prompt: `nodes/${intent.taskId}/blocks/R-001.prompt.md`,
    depends_on: ["B-001"],
    review: { required: true, maxFeedbackCycles, hook: null }
  };
  const blocks = [implementation, review];
  const blockPromptById = new Map(
    (intent.blockPrompts ?? []).map((entry) => [entry.blockId, entry.markdown])
  );
  return {
    node: {
      id: intent.taskId,
      type: "task",
      title: intent.title,
      prompt: `nodes/${intent.taskId}/prompt.md`,
      ...(intent.executor === undefined ? {} : { executor: intent.executor }),
      acceptance: intent.acceptance?.length ? intent.acceptance : ["Task is implemented."],
      blocks
    },
    taskPromptMarkdown: promptMarkdown(intent.promptMarkdown),
    blockPromptMarkdown: blocks.map((block) => ({
      blockId: block.id,
      markdown: promptMarkdown(
        blockPromptById.get(block.id) ?? `# ${block.title}\n\n${intent.promptMarkdown}`
      )
    }))
  };
}

export type CanvasCommandApplication = {
  graphMutation: PlanPackageGraphMutation;
  baseLayout: DesktopLayout;
  nextLayout: DesktopLayout;
  layoutChanged: boolean;
};

function applyCanvasLayoutMutation(
  layout: DesktopLayout,
  nextManifest: PlanPackageManifest,
  intent: CanvasCommandIntent
): Pick<CanvasCommandApplication, "nextLayout" | "layoutChanged"> {
  const update =
    intent.kind === "update_layout"
      ? { nodes: intent.nodes, updatedAt: intent.updatedAt }
      : intent.kind === "add_task" && intent.layout
        ? { nodes: [intent.layout], updatedAt: intent.layoutUpdatedAt }
        : undefined;
  if (intent.kind === "update_layout" && !intent.updatedAt) {
    throw new CanvasCommandMutationError("canvas_layout_updated_at_required");
  }
  const validNodeIds = new Set(nextManifest.nodes.map((task) => task.id));
  const retainedNodes = layout.nodes.filter((node) => validNodeIds.has(node.nodeId));
  const byId = new Map(retainedNodes.map((node) => [node.nodeId, node]));
  if (update) {
    for (const node of update.nodes) {
      if (!validNodeIds.has(node.nodeId)) {
        throw new CanvasCommandMutationError(`canvas_layout_node_unknown:${node.nodeId}`);
      }
      byId.set(node.nodeId, { nodeId: node.nodeId, x: node.x, y: node.y });
    }
  }
  const nextLayout = {
    ...layout,
    nodes: [...byId.values()],
    updatedAt: update?.updatedAt ?? layout.updatedAt
  };
  return {
    nextLayout,
    layoutChanged: update !== undefined || retainedNodes.length !== layout.nodes.length
  };
}

/** Deterministic manifest, prompt, and layout application shared by disk and replicas. */
export function buildCanvasCommandApplication(
  manifest: PlanPackageManifest,
  layout: DesktopLayout,
  intent: CanvasCommandIntent
): CanvasCommandApplication {
  const graphMutation = buildCanvasCommandMutation(manifest, intent);
  return {
    graphMutation,
    baseLayout: layout,
    ...applyCanvasLayoutMutation(layout, graphMutation.nextManifest, intent)
  };
}

function fieldEditError(error: unknown, fallback: string): CanvasCommandMutationError {
  return new CanvasCommandMutationError(error instanceof Error ? error.message : fallback);
}

/** Single authoritative mapping from collaboration intents to Plan Package mutations. */
export function buildCanvasCommandMutation(
  manifest: PlanPackageManifest,
  intent: CanvasCommandIntent
): PlanPackageGraphMutation {
  switch (intent.kind) {
    case "add_task": {
      if (taskNode(manifest, intent.taskId)) {
        throw new CanvasCommandMutationError(`task_exists:${intent.taskId}`);
      }
      const built = buildDefaultTaskNode(intent, manifest.review.maxFeedbackCycles);
      return buildPlanPackageGraphMutation(manifest, {
        kind: "addTaskNode",
        node: built.node,
        taskPromptMarkdown: built.taskPromptMarkdown,
        blockPromptMarkdown: built.blockPromptMarkdown
      });
    }
    case "remove_task":
      requireTask(manifest, intent.taskId);
      return buildPlanPackageGraphMutation(manifest, {
        kind: "removeNode",
        nodeId: intent.taskId,
        removeTaskDirectory: true
      });
    case "update_task_fields":
    case "update_task_prompt": {
      requireTask(manifest, intent.taskId);
      try {
        return buildPlanPackageTaskFieldEditMutation(manifest, {
          taskId: intent.taskId,
          ...(intent.kind === "update_task_prompt"
            ? { promptMarkdown: intent.promptMarkdown }
            : {
                title: intent.fields.title,
                promptMarkdown: intent.fields.promptMarkdown,
                executor: intent.fields.executor,
                acceptance: intent.fields.acceptance
              })
        });
      } catch (error) {
        throw fieldEditError(error, "task_field_edit_failed");
      }
    }
    case "add_block": {
      const task = requireTask(manifest, intent.taskId);
      if (task.blocks.some((block) => block.id === intent.blockId)) {
        throw new CanvasCommandMutationError(`block_exists:${intent.taskId}#${intent.blockId}`);
      }
      const common = {
        id: intent.blockId,
        title: intent.title,
        prompt: `nodes/${intent.taskId}/blocks/${intent.blockId}.prompt.md`,
        depends_on: intent.dependsOn ?? [],
        ...(intent.executor === undefined ? {} : { executor: intent.executor })
      };
      const block: ManifestBlock =
        intent.blockType === "review"
          ? {
              ...common,
              type: "review",
              review: {
                required: true,
                maxFeedbackCycles: manifest.review.maxFeedbackCycles,
                hook: null
              }
            }
          : { ...common, type: "implementation" };
      return buildPlanPackageGraphMutation(manifest, {
        kind: "addBlock",
        taskId: intent.taskId,
        block,
        promptMarkdown: promptMarkdown(intent.promptMarkdown)
      });
    }
    case "remove_block":
    case "update_block_prompt":
    case "update_block_fields": {
      try {
        if (intent.kind === "remove_block") {
          return buildPlanPackageGraphMutation(manifest, {
            kind: "removeBlock",
            blockRef: intent.blockRef
          });
        }
        return buildPlanPackageBlockFieldEditMutation(manifest, {
          blockRef: intent.blockRef,
          ...(intent.kind === "update_block_prompt"
            ? { promptMarkdown: intent.promptMarkdown }
            : {
                title: intent.fields.title,
                promptMarkdown: intent.fields.promptMarkdown,
                executor: intent.fields.executor,
                dependsOn: intent.fields.dependsOn,
                sharedResources: intent.fields.sharedResources,
                requiredCapabilities: intent.fields.requiredCapabilities,
                reviewRequired: intent.fields.reviewRequired,
                maxFeedbackCycles: intent.fields.maxFeedbackCycles
              })
        });
      } catch (error) {
        throw fieldEditError(error, "block_edit_failed");
      }
    }
    case "add_task_dependency": {
      if (!taskNode(manifest, intent.fromTaskId) || !taskNode(manifest, intent.toTaskId)) {
        throw new CanvasCommandMutationError("task_dependency_endpoint_missing");
      }
      const exists = manifest.edges.some(
        (edge) =>
          edge.type === "depends_on" &&
          edge.from === intent.fromTaskId &&
          edge.to === intent.toTaskId
      );
      if (exists) throw new CanvasCommandMutationError("task_dependency_exists");
      return buildPlanPackageGraphMutation(manifest, {
        kind: "addEdge",
        edge: { type: "depends_on", from: intent.fromTaskId, to: intent.toTaskId }
      });
    }
    case "remove_task_dependency":
      return buildPlanPackageGraphMutation(manifest, {
        kind: "removeEdge",
        edge: { type: "depends_on", from: intent.fromTaskId, to: intent.toTaskId }
      });
    case "reconnect_task_dependency": {
      const fromTaskId = intent.newFromTaskId ?? intent.fromTaskId;
      if (!taskNode(manifest, fromTaskId) || !taskNode(manifest, intent.newToTaskId)) {
        throw new CanvasCommandMutationError("task_dependency_endpoint_missing");
      }
      const withoutOld = buildPlanPackageGraphMutation(manifest, {
        kind: "removeEdge",
        edge: { type: "depends_on", from: intent.fromTaskId, to: intent.oldToTaskId }
      });
      const reconnected = buildPlanPackageGraphMutation(withoutOld.nextManifest, {
        kind: "addEdge",
        edge: { type: "depends_on", from: fromTaskId, to: intent.newToTaskId }
      });
      return { ...reconnected, baseManifest: manifest };
    }
    case "bulk_update_blocks": {
      let nextManifest = manifest;
      const sideEffects: PlanPackageGraphMutation["sideEffects"] = [];
      const affected = new Set<string>();
      for (const update of intent.updates) {
        try {
          const mutation = buildPlanPackageBlockFieldEditMutation(nextManifest, {
            blockRef: update.blockRef,
            title: update.fields.title,
            promptMarkdown: update.fields.promptMarkdown,
            executor: update.fields.executor,
            dependsOn: update.fields.dependsOn,
            sharedResources: update.fields.sharedResources,
            requiredCapabilities: update.fields.requiredCapabilities,
            reviewRequired: update.fields.reviewRequired,
            maxFeedbackCycles: update.fields.maxFeedbackCycles
          });
          nextManifest = mutation.nextManifest;
          sideEffects.push(...mutation.sideEffects);
          for (const taskId of mutation.affectedTasks) affected.add(taskId);
        } catch (error) {
          throw fieldEditError(error, "bulk_block_update_failed");
        }
      }
      return buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
        affectedTasks: [...affected],
        sideEffects
      });
    }
    case "update_layout":
      return buildPlanPackageManifestChangeMutation(manifest, manifest);
  }
}
