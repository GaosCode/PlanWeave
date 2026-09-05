import { formatTaskException } from "./formatTaskException";
import type { createTranslator } from "../i18n";
import type { TaskNodeLabels } from "../types";
import { fileManagerLabel } from "../fileManagerLabels";
import { formatAgentEndpointUnavailableReason } from "../collaboration/formatAgentEndpointUnavailableReason";

export function taskNodeLabels(t: ReturnType<typeof createTranslator>): TaskNodeLabels {
  return {
    blockStack: t("blockStack"),
    customExecutor: t("customExecutor"),
    exception: t("exception"),
    stopped: t("acpTaskStopped"),
    exceptionOverlay: t("exceptionOverlay"),
    exceptionReason: (reason) => formatTaskException(reason, t),
    diagnostics: t("diagnostics"),
    more: t("more"),
    noBlockRecords: t("noBlockRecords"),
    openRecord: t("openRecord"),
    savePrompt: t("savePrompt"),
    selectedBlock: t("selectedBlock"),
    selectedTask: t("selectedTask"),
    sourcePrompt: t("sourcePrompt"),
    taskException: t("taskException"),
    taskPrompt: t("taskPrompt"),
    title: t("title"),
    agent: t("agent"),
    agentEndpointSelectionRequired: t("agentEndpointSelectionRequired"),
    agentEndpointSelectionUnavailable: t("agentEndpointSelectionUnavailable"),
    agentEndpointUnavailableReason: (reason) => formatAgentEndpointUnavailableReason(reason, t),
    unavailable: t("unavailable"),
    blockExecutionSummary: t("blockExecutionSummary"),
    latestRun: t("latestRun"),
    latestReviewAttempt: t("latestReviewAttempt"),
    feedbackMarker: t("feedbackMarker"),
    deleteTask: t("deleteTask"),
    deleteBlock: t("deleteBlock"),
    copyAgentPrompt: t("copyAgentPrompt"),
    openTaskInFileManager: fileManagerLabel(t, "task"),
    runTask: t("runTask"),
    runBlock: t("runBlock"),
    inspectTask: t("inspectTask"),
    inspectBlock: t("inspectBlock"),
    deleteTaskConfirm: t("deleteTaskConfirm"),
    deleteBlockConfirm: t("deleteBlockConfirm"),
    sharedResource: t("sharedResourceHint"),
    sharedResourceActive: t("sharedResourceActive"),
    moreResources: (count: number) => t("moreResources").replace("{count}", String(count)),
    assignee: t("assignee"),
    runtimeStatusUnavailable: t("collaborationRuntimeStatusUnavailable")
  };
}
