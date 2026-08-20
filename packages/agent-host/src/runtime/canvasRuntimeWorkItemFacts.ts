import {
  parseResolveWorkItemsResult,
  resolveWorkItemsRequestSchema,
  type ResolveWorkItemsResult,
  type WorkItemPackageFacts
} from "@planweave-ai/collaboration-protocol/work/package-facts";
import { loadPlanGraphPackage } from "@planweave-ai/runtime";
import type { ResolvedCanvasRuntime } from "./canvasRuntimeResolver.js";

type LoadedPlanGraphPackage = Awaited<ReturnType<typeof loadPlanGraphPackage>>;
type WorkItemFactsLoader = (
  projectRoot: ResolvedCanvasRuntime["canvas"]
) => Promise<LoadedPlanGraphPackage>;

function resolveFacts(
  graph: LoadedPlanGraphPackage["graph"],
  workItem: ReturnType<typeof resolveWorkItemsRequestSchema.parse>["workItems"][number]
): WorkItemPackageFacts {
  if (workItem.kind === "task") {
    return {
      canvasId: workItem.canvasId,
      kind: "task",
      exists: graph.tasks.has(workItem.taskId),
      taskId: workItem.taskId,
      requiredCapabilities: []
    };
  }
  const block = graph.blocks.get(workItem.blockRef);
  if (!block) {
    return {
      canvasId: workItem.canvasId,
      kind: "block",
      exists: false,
      blockRef: workItem.blockRef,
      requiredCapabilities: []
    };
  }
  return {
    canvasId: workItem.canvasId,
    kind: "block",
    exists: true,
    taskId: block.taskId,
    blockRef: workItem.blockRef,
    blockType: block.type,
    requiredCapabilities: [...block.requiredCapabilities]
  };
}

/** Resolve one bounded request against one exact, path-verified canvas snapshot. */
export async function resolveCanvasRuntimeWorkItems(
  resolved: ResolvedCanvasRuntime,
  input: unknown,
  load: WorkItemFactsLoader = loadPlanGraphPackage
): Promise<ResolveWorkItemsResult> {
  const request = resolveWorkItemsRequestSchema.parse(input);
  if (request.workItems.some((workItem) => workItem.canvasId !== resolved.scope.canvasId)) {
    throw new Error("work_item_scope_mismatch");
  }
  const loaded = await load(resolved.canvas);
  if (loaded.promptReadFailuresByPath.size > 0 || loaded.graph.diagnostics.length > 0) {
    throw new Error("work_package_evidence_invalid");
  }
  const result = {
    sourceRevision: loaded.graph.graphVersion,
    graphFingerprint: loaded.graph.packageFingerprint,
    facts: request.workItems.map((workItem) => resolveFacts(loaded.graph, workItem))
  };
  return parseResolveWorkItemsResult(request, result);
}
