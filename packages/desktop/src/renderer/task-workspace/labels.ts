import type { createTranslator } from "../i18n";
import type { TaskWorkspaceLabels } from "./contracts";

export function taskWorkspaceLabels(t: ReturnType<typeof createTranslator>): TaskWorkspaceLabels {
  return {
    backToCanvas: t("taskWorkspaceBackToCanvas"),
    composer: t("taskWorkspaceComposer"),
    conversation: t("taskWorkspaceConversation"),
    inspector: t("taskWorkspaceInspector"),
    loading: t("taskWorkspaceLoading"),
    liveUnavailable: t("taskWorkspaceLiveUnavailable"),
    noConversation: t("taskWorkspaceNoConversation"),
    noInspector: t("taskWorkspaceNoInspector"),
    noRuns: t("taskWorkspaceNoRuns"),
    noTask: t("taskWorkspaceNoTask"),
    timeline: t("taskWorkspaceTimeline")
  };
}
