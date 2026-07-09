import type {
  BlockType,
  ManifestBlock,
  ManifestEdge,
  ManifestNode,
  ManifestTaskNode,
  ReviewHookDefinition
} from "./manifest.js";
import type { PackageFileChange, PackageFileSnapshot } from "./packageFiles.js";
import type { PackageWorkspaceRef } from "./workspace.js";
import type { ValidationIssue } from "./validation.js";

export type CompiledExecutionGraph = {
  nodesById: Map<string, ManifestNode>;
  taskNodesInManifestOrder: string[];
  tasksById: Map<string, ManifestTaskNode>;
  taskDependenciesByTask: Map<string, string[]>;
  taskDependentsByTask: Map<string, string[]>;
  blockRefsInManifestOrder: string[];
  blocksByRef: Map<string, ManifestBlock>;
  blockTaskByRef: Map<string, string>;
  blocksByTask: Map<string, string[]>;
  blockDependenciesByRef: Map<string, string[]>;
  blockDependentsByRef: Map<string, string[]>;
  reviewBlocksByTask: Map<string, string[]>;
  locksByBlockRef: Map<string, string[]>;
  diagnostics: {
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  };
  taskReachable(from: string, to: string): boolean;
  blockReachable(fromRef: string, toRef: string): boolean;
};

export type CompiledTaskGraph = CompiledExecutionGraph;

export type ExecutionGraphSession = {
  projectRoot: PackageWorkspaceRef;
  projectId: string;
  packageRoot: string;
  graph: CompiledExecutionGraph;
  fileSnapshot: PackageFileSnapshot;
  readQueue: GraphReadQueue;
  dirtyPromptRefs: Set<string>;
  diagnostics: ValidationIssue[];
};

export type GraphEditOperation =
  | {
      type: "add_node" | "update_node";
      node: ManifestNode;
    }
  | {
      type: "remove_node";
      nodeId: string;
    }
  | {
      type: "add_edge" | "remove_edge";
      edge: ManifestEdge;
    }
  | {
      type: "update_prompt";
      ref: string;
    };

export type GraphReadQueue = {
  fileChanges: PackageFileChange[];
  graphOps: GraphEditOperation[];
  enqueuedAt: string;
};

export type DrainGraphReadQueueResult = {
  session: ExecutionGraphSession;
  refreshed: boolean;
  dirtyPromptRefs: string[];
  diagnostics: ValidationIssue[];
};

export type GraphEditResult = {
  ok: boolean;
  affectedTasks: string[];
  diagnostics: ValidationIssue[];
  graph?: CompiledExecutionGraph;
};

export type EditTaskInput = {
  projectRoot: PackageWorkspaceRef;
  taskId: string;
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
  acceptance?: string[];
};

export type EditTaskResult = GraphEditResult & {
  taskId: string;
  updatedFields: string[];
};

export type EditBlockInput = {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
  dependsOn?: string[];
  /** @deprecated Prefer exclusive; maps to reserved exclusive lock. */
  parallelSafe?: boolean;
  exclusive?: boolean;
  parallelLocks?: string[];
  reviewRequired?: boolean;
  maxFeedbackCycles?: number;
  reviewHook?: ReviewHookDefinition | null;
};

export type EditBlockResult = GraphEditResult & {
  ref: string;
  taskId: string;
  blockId: string;
  blockType: BlockType;
  updatedFields: string[];
};
