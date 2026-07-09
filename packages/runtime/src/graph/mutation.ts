import { affectedTaskIdsForManifestChange } from "./affectedTasks.js";
import { parseBlockRef } from "./compileTaskGraph.js";
import type {
  ManifestBlock,
  ManifestEdge,
  ManifestNode,
  ManifestTaskNode,
  PlanPackageManifest
} from "../types.js";

export type PlanPackageGraphMutationIntent =
  | { kind: "addNode"; node: ManifestNode; promptMarkdown?: string }
  | {
      kind: "addTaskNode";
      node: ManifestTaskNode;
      taskPromptMarkdown?: string;
      blockPromptMarkdown?: Array<{ blockId: string; markdown: string }>;
    }
  | { kind: "addBlock"; taskId: string; block: ManifestBlock; promptMarkdown: string }
  | { kind: "updateNode"; node: ManifestNode }
  | { kind: "removeNode"; nodeId: string; removePrompt?: boolean; removeTaskDirectory?: boolean }
  | { kind: "addEdge"; edge: ManifestEdge }
  | { kind: "removeEdge"; edge: ManifestEdge }
  | { kind: "removeBlock"; blockRef: string }
  | { kind: "writeTaskPrompt"; taskId: string; markdown: string }
  | { kind: "writeBlockPrompt"; blockRef: string; markdown: string };

export type PlanPackageGraphMutationSideEffect =
  | { kind: "writePrompt"; packagePath: string; markdown: string }
  | { kind: "removePrompt"; packagePath: string }
  | { kind: "removeTaskDirectory"; packagePath: string };

export type PlanPackageGraphMutation = {
  nextManifest: PlanPackageManifest;
  affectedTasks: string[];
  sideEffects: PlanPackageGraphMutationSideEffect[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function writePromptSideEffects(
  packagePath: string,
  markdown: string | undefined
): PlanPackageGraphMutationSideEffect[] {
  return markdown === undefined ? [] : [{ kind: "writePrompt", packagePath, markdown }];
}

export function removePromptSideEffect(packagePath: string): PlanPackageGraphMutationSideEffect {
  return { kind: "removePrompt", packagePath };
}

function sameEdge(left: ManifestEdge, right: ManifestEdge): boolean {
  return left.from === right.from && left.to === right.to && left.type === right.type;
}

function packageDirname(packagePath: string): string {
  const parts = packagePath.split("/");
  parts.pop();
  return parts.join("/");
}

function taskNode(manifest: PlanPackageManifest, taskId: string): ManifestTaskNode {
  const node = manifest.nodes.find(
    (candidate) => candidate.type === "task" && candidate.id === taskId
  );
  if (!node || node.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  return node;
}

export function buildPlanPackageManifestChangeMutation(
  manifest: PlanPackageManifest,
  nextManifest: PlanPackageManifest,
  options: {
    affectedTasks?: string[];
    sideEffects?: PlanPackageGraphMutationSideEffect[];
  } = {}
): PlanPackageGraphMutation {
  return {
    affectedTasks: unique([
      ...affectedTaskIdsForManifestChange(manifest, nextManifest),
      ...(options.affectedTasks ?? [])
    ]),
    nextManifest,
    sideEffects: options.sideEffects ?? []
  };
}

function removeBlock(manifest: PlanPackageManifest, blockRef: string): PlanPackageGraphMutation {
  const { taskId, blockId } = parseBlockRef(blockRef);
  const task = taskNode(manifest, taskId);
  const block = task.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw new Error(`Block '${blockRef}' does not exist.`);
  }
  const nextTask: ManifestTaskNode = {
    ...task,
    blocks: task.blocks
      .filter((candidate) => candidate.id !== blockId)
      .map((candidate) => ({
        ...candidate,
        depends_on: candidate.depends_on.filter((dependency) => dependency !== blockId)
      }))
  };
  const nextManifest = {
    ...manifest,
    nodes: manifest.nodes.map((node) =>
      node.type === "task" && node.id === taskId ? nextTask : node
    )
  };
  return buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
    sideEffects: [removePromptSideEffect(block.prompt)]
  });
}

export function buildPlanPackageGraphMutation(
  manifest: PlanPackageManifest,
  intent: PlanPackageGraphMutationIntent
): PlanPackageGraphMutation {
  if (intent.kind === "addNode") {
    const nextManifest = { ...manifest, nodes: [...manifest.nodes, intent.node] };
    const sideEffects =
      intent.node.type === "task" && intent.promptMarkdown !== undefined
        ? writePromptSideEffects(intent.node.prompt, intent.promptMarkdown)
        : [];
    return buildPlanPackageManifestChangeMutation(manifest, nextManifest, { sideEffects });
  }
  if (intent.kind === "addTaskNode") {
    const blockPromptMarkdown = new Map(
      intent.blockPromptMarkdown?.map((item) => [item.blockId, item.markdown]) ?? []
    );
    const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
    if (intent.taskPromptMarkdown !== undefined) {
      sideEffects.push(...writePromptSideEffects(intent.node.prompt, intent.taskPromptMarkdown));
    }
    for (const block of intent.node.blocks) {
      const markdown = blockPromptMarkdown.get(block.id);
      if (markdown !== undefined) {
        sideEffects.push(...writePromptSideEffects(block.prompt, markdown));
      }
    }
    const nextManifest = { ...manifest, nodes: [...manifest.nodes, intent.node] };
    return buildPlanPackageManifestChangeMutation(manifest, nextManifest, { sideEffects });
  }
  if (intent.kind === "addBlock") {
    const task = taskNode(manifest, intent.taskId);
    const nextTask: ManifestTaskNode = { ...task, blocks: [...task.blocks, intent.block] };
    const nextManifest = {
      ...manifest,
      nodes: manifest.nodes.map((node) =>
        node.type === "task" && node.id === intent.taskId ? nextTask : node
      )
    };
    return buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
      sideEffects: writePromptSideEffects(intent.block.prompt, intent.promptMarkdown)
    });
  }
  if (intent.kind === "updateNode") {
    const nextManifest = {
      ...manifest,
      nodes: manifest.nodes.map((node) => (node.id === intent.node.id ? intent.node : node))
    };
    return buildPlanPackageManifestChangeMutation(manifest, nextManifest);
  }
  if (intent.kind === "removeNode") {
    const node = manifest.nodes.find((candidate) => candidate.id === intent.nodeId);
    const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
    if (node?.type === "task" && intent.removeTaskDirectory) {
      sideEffects.push({ kind: "removeTaskDirectory", packagePath: packageDirname(node.prompt) });
    } else if (node?.type === "task" && intent.removePrompt) {
      sideEffects.push(removePromptSideEffect(node.prompt));
    }
    const nextManifest = {
      ...manifest,
      nodes: manifest.nodes.filter((node) => node.id !== intent.nodeId),
      edges: manifest.edges.filter(
        (edge) => edge.from !== intent.nodeId && edge.to !== intent.nodeId
      )
    };
    return buildPlanPackageManifestChangeMutation(manifest, nextManifest, { sideEffects });
  }
  if (intent.kind === "addEdge") {
    const nextManifest = { ...manifest, edges: [...manifest.edges, intent.edge] };
    return buildPlanPackageManifestChangeMutation(manifest, nextManifest);
  }
  if (intent.kind === "removeEdge") {
    const nextManifest = {
      ...manifest,
      edges: manifest.edges.filter((edge) => !sameEdge(edge, intent.edge))
    };
    return buildPlanPackageManifestChangeMutation(manifest, nextManifest);
  }
  if (intent.kind === "removeBlock") {
    return removeBlock(manifest, intent.blockRef);
  }
  if (intent.kind === "writeTaskPrompt") {
    const task = taskNode(manifest, intent.taskId);
    return {
      affectedTasks: [task.id],
      nextManifest: manifest,
      sideEffects: writePromptSideEffects(task.prompt, intent.markdown)
    };
  }
  const { taskId } = parseBlockRef(intent.blockRef);
  const task = taskNode(manifest, taskId);
  const block = task.blocks.find(
    (candidate) => candidate.id === parseBlockRef(intent.blockRef).blockId
  );
  if (!block) {
    throw new Error(`Block '${intent.blockRef}' does not exist.`);
  }
  return {
    affectedTasks: unique([task.id]),
    nextManifest: manifest,
    sideEffects: writePromptSideEffects(block.prompt, intent.markdown)
  };
}
