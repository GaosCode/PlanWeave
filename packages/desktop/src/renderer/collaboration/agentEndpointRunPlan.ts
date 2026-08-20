import type {
  DesktopAutoRunScope,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { DesktopUiSettings } from "../../shared/desktopSettings";
import {
  applyAgentEndpointRequirements,
  type AvailableAgentEndpoint
} from "./agentEndpointViewModel";
import {
  agentEndpointPreferenceKey,
  remoteAgentEndpointPreferenceKey,
  selectedAgentEndpointId,
  type EndpointSelection
} from "./agentEndpointPreferences";

type GraphTask = DesktopGraphViewModel["tasks"][number];
type GraphBlock = GraphTask["blocks"][number];

export type AgentEndpointBlockSelection = {
  task: GraphTask;
  block: GraphBlock;
  endpoint: AvailableAgentEndpoint;
};

export type AgentEndpointRunPlan =
  | { kind: "noop" }
  | { kind: "rejected"; reason: string }
  | { kind: "local_scope"; scope: DesktopAutoRunScope }
  | { kind: "coordinated_block"; selection: AgentEndpointBlockSelection }
  | {
      kind: "coordinated_scope";
      tasks: readonly GraphTask[];
      selectionByBlockRef: ReadonlyMap<string, AgentEndpointBlockSelection>;
    };

function rejectedForMismatch(
  blockRef: string,
  selection: Extract<EndpointSelection, { kind: "mismatch" }>
): AgentEndpointRunPlan {
  if (selection.detail.startsWith("agent_endpoint_unknown:")) {
    const remoteEndpointId = selection.detail.slice("agent_endpoint_unknown:".length);
    return {
      kind: "rejected",
      reason: `agent_endpoint_unknown:${blockRef}:remote:${remoteEndpointId}:agent_endpoint_unknown`
    };
  }
  return {
    kind: "rejected",
    reason: `agent_endpoint_preference_mismatch:${blockRef}:${selection.detail}`
  };
}

function rejectedForUnavailable(input: {
  blockRef: string;
  endpoint: AvailableAgentEndpoint | undefined;
  endpointId: string;
}): AgentEndpointRunPlan {
  const sourceLabel = input.endpoint?.displayName ?? input.endpoint?.id ?? input.endpointId;
  const reasonCode =
    input.endpoint?.unavailableReason ??
    (input.endpoint ? "agent_endpoint_selection_unavailable" : "agent_endpoint_unknown");
  return {
    kind: "rejected",
    reason: `agent_endpoint_unavailable:${input.blockRef}:${sourceLabel}:${reasonCode}`
  };
}

export function createAgentEndpointRunPlan(input: {
  graph: DesktopGraphViewModel;
  scope: DesktopAutoRunScope;
  endpoints: readonly AvailableAgentEndpoint[];
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  project: DesktopProjectSummary | null;
  remoteCanvas?: { workspaceId: string; projectId: string; canvasId: string } | null;
  canvasId: string;
}): AgentEndpointRunPlan {
  let task: GraphTask | null = null;
  if (input.scope.kind === "task") {
    const taskId = input.scope.taskId;
    task = input.graph.tasks.find((candidate) => candidate.taskId === taskId) ?? null;
  } else if (input.scope.kind === "block") {
    const blockRef = input.scope.blockRef;
    task =
      input.graph.tasks.find((candidate) =>
        candidate.blocks.some((block) => block.ref === blockRef)
      ) ?? null;
  }
  if (input.scope.kind !== "project" && !task) return { kind: "noop" };

  const tasks = input.scope.kind === "project" ? input.graph.tasks : task ? [task] : [];
  const selectionByBlockRef = new Map<string, AgentEndpointBlockSelection>();
  for (const candidateTask of tasks) {
    for (const block of candidateTask.blocks) {
      const executorName = block.executor ?? candidateTask.executorLabel;
      const taskPreferenceKey = input.project
        ? agentEndpointPreferenceKey({
            projectRoot: input.project.rootPath,
            canvasId: input.canvasId,
            scope: { kind: "task", taskId: candidateTask.taskId }
          })
        : input.remoteCanvas
          ? remoteAgentEndpointPreferenceKey({
              ...input.remoteCanvas,
              scope: { kind: "task", taskId: candidateTask.taskId }
            })
          : null;
      const blockPreferenceKey = input.project
        ? agentEndpointPreferenceKey({
            projectRoot: input.project.rootPath,
            canvasId: input.canvasId,
            scope: { kind: "block", blockRef: block.ref }
          })
        : input.remoteCanvas
          ? remoteAgentEndpointPreferenceKey({
              ...input.remoteCanvas,
              scope: { kind: "block", blockRef: block.ref }
            })
          : null;
      const preference =
        (blockPreferenceKey ? input.preferences[blockPreferenceKey] : undefined) ??
        (taskPreferenceKey ? input.preferences[taskPreferenceKey] : undefined);
      const selection = selectedAgentEndpointId({
        executorName,
        preference,
        endpoints: input.endpoints
      });
      if (selection.kind === "mismatch") {
        return rejectedForMismatch(block.ref, selection);
      }
      const endpointId = selection.id;
      const endpoint = applyAgentEndpointRequirements(
        input.endpoints,
        block.requiredCapabilities
      ).find((candidate) => candidate.id === endpointId);
      if (!endpoint?.available) {
        return rejectedForUnavailable({
          blockRef: block.ref,
          endpoint,
          endpointId
        });
      }
      selectionByBlockRef.set(block.ref, { task: candidateTask, block, endpoint });
    }
  }

  if ([...selectionByBlockRef.values()].every(({ endpoint }) => endpoint.source === "local")) {
    return { kind: "local_scope", scope: input.scope };
  }
  if (input.scope.kind === "block") {
    const selection = selectionByBlockRef.get(input.scope.blockRef);
    return selection ? { kind: "coordinated_block", selection } : { kind: "noop" };
  }
  return { kind: "coordinated_scope", tasks, selectionByBlockRef };
}
