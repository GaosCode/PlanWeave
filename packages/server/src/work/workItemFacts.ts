import { blockRefSchema, type BlockRef } from "@planweave-ai/agent-host-protocol";
import type { CompiledExecutionGraph, PlanPackageManifest } from "@planweave-ai/runtime";
import { compileTaskGraph, parseBlockRef } from "@planweave-ai/runtime";
import {
  workItemPackageFactsSchema,
  workItemRefSchema,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";

/**
 * Read-only port for resolving WorkItemRef against current Plan Package truth.
 * Implementations must not write package files; B-001 only defines the contract + pure adapters.
 */
export type WorkItemPackagePort = {
  resolveWorkItem(workItem: WorkItemRef): WorkItemPackageFacts;
  /** Resolve one bounded request snapshot without reloading package state per item. */
  resolveWorkItems(workItems: readonly WorkItemRef[]): WorkItemPackageFacts[];
};

/**
 * Build package facts from a compiled execution graph (authoritative indexes).
 * Canvas id is supplied by the caller (multi-canvas projects).
 */
export function workItemFactsFromCompiledGraph(
  graph: CompiledExecutionGraph,
  canvasId: string,
  workItem: WorkItemRef
): WorkItemPackageFacts {
  return workItemPackageFactsSchema.parse(
    packageFactsFromCompiledGraph(graph, canvasId, workItemRefSchema.parse(workItem))
  );
}

function packageFactsFromCompiledGraph(
  graph: CompiledExecutionGraph,
  canvasId: string,
  workItem: WorkItemRef
): WorkItemPackageFacts {
  if (workItem.canvasId !== canvasId) {
    return {
      canvasId: workItem.canvasId,
      kind: workItem.kind,
      exists: false,
      taskId: workItem.kind === "task" ? workItem.taskId : undefined,
      blockRef: workItem.kind === "block" ? workItem.blockRef : undefined,
      requiredCapabilities: []
    };
  }

  if (workItem.kind === "task") {
    const task = graph.tasksById.get(workItem.taskId);
    return {
      canvasId,
      kind: "task",
      exists: task !== undefined,
      taskId: workItem.taskId,
      requiredCapabilities: []
    };
  }

  const block = graph.blocksByRef.get(workItem.blockRef);
  if (!block) {
    return {
      canvasId,
      kind: "block",
      exists: false,
      blockRef: workItem.blockRef,
      requiredCapabilities: []
    };
  }

  const requiredCapabilities =
    block.type === "implementation" ? [...(block.requirements?.capabilities ?? [])] : [];

  return {
    canvasId,
    kind: "block",
    exists: true,
    blockRef: workItem.blockRef,
    taskId: graph.blockTaskByRef.get(workItem.blockRef),
    blockType: block.type,
    requiredCapabilities
  };
}

/** Internal package projection: manifest identifiers are not request wire identifiers. */
export function* manifestWorkItemFacts(
  manifest: PlanPackageManifest,
  canvasId: string
): Generator<{ workItem: WorkItemRef; facts: WorkItemPackageFacts }> {
  const graph = compileTaskGraph(manifest);
  for (const task of manifest.nodes) {
    const workItems: WorkItemRef[] = [
      { kind: "task", canvasId, taskId: task.id },
      ...task.blocks.map(
        (block): WorkItemRef => ({
          kind: "block",
          canvasId,
          blockRef: `${task.id}#${block.id}`
        })
      )
    ];
    for (const workItem of workItems) {
      yield { workItem, facts: packageFactsFromCompiledGraph(graph, canvasId, workItem) };
    }
  }
}

/** Pure adapter: compile an in-memory Plan Package manifest and resolve one WorkItemRef. */
export function workItemFactsFromManifest(
  manifest: PlanPackageManifest,
  canvasId: string,
  workItem: WorkItemRef
): WorkItemPackageFacts {
  const graph = compileTaskGraph(manifest);
  return workItemFactsFromCompiledGraph(graph, canvasId, workItem);
}

export function createCompiledGraphWorkItemPort(
  graph: CompiledExecutionGraph,
  canvasId: string
): WorkItemPackagePort {
  return {
    resolveWorkItem(workItem) {
      return workItemFactsFromCompiledGraph(graph, canvasId, workItem);
    },
    resolveWorkItems(workItems) {
      return workItems.map((workItem) => workItemFactsFromCompiledGraph(graph, canvasId, workItem));
    }
  };
}

export function createManifestWorkItemPort(
  manifest: PlanPackageManifest,
  canvasId: string
): WorkItemPackagePort {
  const graph = compileTaskGraph(manifest);
  return createCompiledGraphWorkItemPort(graph, canvasId);
}

/**
 * Validate that a WorkItemRef exists in the current package facts.
 * Does not mutate Plan Package. Cross-canvas/project mismatches are treated as not found
 * at this port (callers enforce project id separately).
 */
export function validateWorkItemRef(
  port: WorkItemPackagePort,
  workItem: WorkItemRef
):
  | { ok: true; facts: WorkItemPackageFacts }
  | {
      ok: false;
      code: "work_item_not_found" | "work_input_invalid";
      facts?: WorkItemPackageFacts;
    } {
  const parsed = workItemRefSchema.safeParse(workItem);
  if (!parsed.success) {
    return { ok: false, code: "work_input_invalid" };
  }
  const facts = port.resolveWorkItem(parsed.data);
  if (!facts.exists) {
    return { ok: false, code: "work_item_not_found", facts };
  }
  if (facts.kind !== parsed.data.kind) {
    return { ok: false, code: "work_item_not_found", facts };
  }
  return { ok: true, facts };
}

/** Helper: portable block ref string → WorkItemRef block kind. */
export function blockWorkItemRef(canvasId: string, blockRef: string): WorkItemRef {
  return workItemRefSchema.parse({
    kind: "block",
    canvasId,
    blockRef: blockRefSchema.parse(blockRef)
  });
}

export function taskWorkItemRef(canvasId: string, taskId: string): WorkItemRef {
  return workItemRefSchema.parse({
    kind: "task",
    canvasId,
    taskId
  });
}

/** Split a validated block ref without filesystem assumptions. */
export function splitBlockRef(blockRef: BlockRef): { taskId: string; blockId: string } {
  return parseBlockRef(blockRef);
}
