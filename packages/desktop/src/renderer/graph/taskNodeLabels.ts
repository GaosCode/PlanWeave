import type { createTranslator } from "../i18n";
import type { TaskNodeLabels } from "../types";

export function taskNodeLabels(t: ReturnType<typeof createTranslator>): TaskNodeLabels {
  return {
    blockStack: t("blockStack"),
    exception: t("exception"),
    exceptionOverlay: t("exceptionOverlay"),
    inherit: t("inherit"),
    more: t("more"),
    noBlockRecords: t("noBlockRecords"),
    openRecord: t("openRecord"),
    savePrompt: t("savePrompt"),
    selectedBlock: t("selectedBlock"),
    sourcePrompt: t("sourcePrompt"),
    taskException: t("taskException"),
    taskPrompt: t("taskPrompt"),
    title: t("title"),
    agent: t("agent"),
    blockExecutionSummary: t("blockExecutionSummary"),
    latestRun: t("latestRun"),
    latestReviewAttempt: t("latestReviewAttempt"),
    feedbackMarker: t("feedbackMarker"),
    deleteTask: t("deleteTask"),
    deleteBlock: t("deleteBlock"),
    deleteTaskConfirm: t("deleteTaskConfirm"),
    deleteBlockConfirm: t("deleteBlockConfirm")
  };
}
