import type {
  DesktopBridgeApi,
  TaskWorkspace,
  TaskWorkspaceRunListItem
} from "@planweave-ai/runtime";
import { composeTaskWorkspaceRuns } from "@planweave-ai/runtime/browser";
import {
  agentFamilyFromExecutorName,
  withRemoteLiveTimelineRuns,
  type RemoteLiveAgentHint
} from "./remoteLiveRun";

type PromptContent = Pick<TaskWorkspace["task"], "promptMarkdown" | "promptMissing">;

export type TaskWorkspacePromptWorkspace = Pick<TaskWorkspace, "project"> & {
  local?: {
    generation: number;
    task: PromptContent;
    blocks: ReadonlyMap<string, PromptContent>;
  };
};

export function projectLocalTaskWorkspaceHeader(input: {
  header: TaskWorkspace;
  graphTask: Awaited<ReturnType<DesktopBridgeApi["getGraphViewModel"]>>["tasks"][number];
  items: TaskWorkspaceRunListItem[];
  selectedRecordId: string | null;
  promptGeneration: number;
}) {
  const { header, graphTask, items, selectedRecordId, promptGeneration } = input;
  const pageItems = items.map((item) => ({
    ...item,
    selected: selectedRecordId !== null && item.run.record.recordId === selectedRecordId
  }));
  const pageIds = new Set(pageItems.map((item) => item.run.record.recordId));
  const composed = composeTaskWorkspaceRuns(
    {
      ...header,
      activeRecordIds: header.activeRecordIds.filter((recordId) => pageIds.has(recordId))
    },
    pageItems
  );
  const agentHints = new Map<string, RemoteLiveAgentHint>();
  for (const block of composed.blocks) {
    const graphBlock = graphTask.blocks.find((candidate) => candidate.ref === block.ref);
    const executorName =
      block.executor ??
      graphBlock?.executor ??
      composed.task.executor ??
      graphTask.executorLabel ??
      null;
    agentHints.set(block.ref, { executorName, agentId: agentFamilyFromExecutorName(executorName) });
  }
  const promptWorkspace: TaskWorkspacePromptWorkspace = {
    project: header.project,
    local: {
      generation: promptGeneration,
      task: {
        promptMarkdown: header.task.promptMarkdown,
        promptMissing: header.task.promptMissing
      },
      blocks: new Map(
        header.blocks.map(({ ref, promptMarkdown, promptMissing }) => [
          ref,
          { promptMarkdown, promptMissing }
        ])
      )
    }
  };
  return {
    workspace: withRemoteLiveTimelineRuns(composed, agentHints),
    pageItems,
    pageIds,
    promptWorkspace,
    requiredCapabilitiesByBlockRef: Object.fromEntries(
      graphTask.blocks.map((block) => [block.ref, [...block.requiredCapabilities]])
    ),
    taskRequiredCapabilities: [
      ...new Set(
        graphTask.blocks
          .filter((block) => block.executor === null)
          .flatMap((block) => block.requiredCapabilities)
      )
    ]
  };
}
