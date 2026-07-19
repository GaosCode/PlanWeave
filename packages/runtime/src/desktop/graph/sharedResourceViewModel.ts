import { z } from "zod";
import { requireMapValue } from "../../graph/requireMapValue.js";
import type { CompiledExecutionGraph, RuntimeState } from "../../types.js";
import type { ClaimHint } from "../../types/taskManager.js";
import type {
  DesktopBlockPreview,
  DesktopGraphViewModel,
  DesktopSharedResourceGroup,
  DesktopTaskNodeViewModel
} from "../types/graphTypes.js";

export const desktopSharedResourceGroupSchema = z
  .object({
    name: z.string().min(1),
    memberTaskIds: z.array(z.string().min(1)),
    memberBlockRefs: z.array(z.string().min(1)),
    activeBlockRefs: z.array(z.string().min(1))
  })
  .strict();

export type DesktopSharedResourceGroupDto = z.infer<typeof desktopSharedResourceGroupSchema>;

export function buildSharedResourceGroups(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): DesktopSharedResourceGroup[] {
  const memberBlockRefsByResource = new Map<string, Set<string>>();
  for (const [ref, resources] of graph.sharedResourcesByBlockRef.entries()) {
    for (const resource of resources) {
      const members = memberBlockRefsByResource.get(resource) ?? new Set<string>();
      members.add(ref);
      memberBlockRefsByResource.set(resource, members);
    }
  }
  return [...memberBlockRefsByResource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, members]) => {
      const memberBlockRefs = [...members].sort((left, right) => left.localeCompare(right));
      const memberTaskIds = [
        ...new Set(
          memberBlockRefs.map((ref) => requireMapValue(graph.blockTaskByRef, ref, "blockTaskByRef"))
        )
      ].sort((left, right) => left.localeCompare(right));
      return {
        name,
        memberTaskIds,
        memberBlockRefs,
        activeBlockRefs: memberBlockRefs.filter(
          (ref) => state.blocks[ref]?.status === "in_progress"
        )
      };
    });
}

function enrichBlockPreview(
  block: DesktopBlockPreview,
  claimHintByRef: Map<string, ClaimHint>
): DesktopBlockPreview {
  return {
    ...block,
    dispatchable: claimHintByRef.get(block.ref)?.dispatchable ?? false
  };
}

function taskSharedResources(
  graph: CompiledExecutionGraph,
  task: DesktopTaskNodeViewModel
): string[] {
  const resources = new Set<string>();
  for (const block of task.blocks) {
    for (const resource of requireMapValue(
      graph.sharedResourcesByBlockRef,
      block.ref,
      "sharedResourcesByBlockRef"
    )) {
      resources.add(resource);
    }
  }
  return [...resources].sort((left, right) => left.localeCompare(right));
}

export function enrichGraphViewModelSharedResources(
  graphView: Omit<DesktopGraphViewModel, "sharedResourceGroups">,
  options: {
    graph: CompiledExecutionGraph;
    state: RuntimeState;
    claimHints: ClaimHint[];
  }
): DesktopGraphViewModel {
  const claimHintByRef = new Map(options.claimHints.map((hint) => [hint.ref, hint]));
  const tasks = graphView.tasks.map((task) => {
    const blocks = task.blocks.map((block) => enrichBlockPreview(block, claimHintByRef));
    const visibleCount = task.blockPreview.length;
    return {
      ...task,
      sharedResources: taskSharedResources(options.graph, { ...task, blocks }),
      blocks,
      blockPreview: blocks.slice(0, visibleCount)
    };
  });
  return {
    ...graphView,
    tasks,
    sharedResourceGroups: buildSharedResourceGroups(options.graph, options.state)
  };
}
