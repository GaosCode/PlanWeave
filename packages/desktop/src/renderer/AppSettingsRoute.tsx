import type { Dispatch, SetStateAction } from "react";
import type {
  DesktopAgentDetection,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopRuntimeToolAvailability,
  ProjectPromptPolicy
} from "@planweave-ai/runtime";
import type { createTranslator, Language } from "./i18n";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "./types";
import { SettingsView } from "./views/SettingsView";

type AppSettingsRouteProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  graph: DesktopGraphViewModel | null;
  globalPromptMarkdown: string | null;
  language: Language;
  refreshAgentDetections: () => Promise<void>;
  refreshRuntimeTools: () => Promise<void>;
  runtimeTools: DesktopRuntimeToolAvailability;
  projects: DesktopProjectSummary[];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  loadProject: (project: DesktopProjectSummary) => Promise<void>;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setError?: (message: string | null) => void;
  settings: DesktopUiSettings;
  projectPromptMarkdown: string | null;
  projectPromptPolicy: ProjectPromptPolicy | null;
  t: ReturnType<typeof createTranslator>;
  updateProjectPrompt: (markdown: string) => Promise<boolean>;
  updateProjectPromptPolicy: (patch: Partial<ProjectPromptPolicy>) => Promise<void>;
  updateGlobalPrompt: (markdown: string) => Promise<boolean>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
  updateSettingsAndWait: (update: DesktopSettingsUpdate) => Promise<void>;
};

export function AppSettingsRoute({
  agentDetectionRefreshing,
  agents,
  graph,
  globalPromptMarkdown,
  language,
  refreshAgentDetections,
  refreshRuntimeTools,
  runtimeTools,
  projects,
  selectedCanvasId,
  selectedProject,
  loadProject,
  setActiveView,
  setError,
  settings,
  projectPromptMarkdown,
  projectPromptPolicy,
  t,
  updateProjectPrompt,
  updateProjectPromptPolicy,
  updateGlobalPrompt,
  updateSettingsAndWait,
  updateSettings
}: AppSettingsRouteProps) {
  return (
    <div className="h-screen min-h-0 overflow-hidden text-foreground">
      <SettingsView
        graph={graph}
        globalPromptMarkdown={globalPromptMarkdown}
        agents={agents}
        agentDetectionRefreshing={agentDetectionRefreshing}
        language={language}
        refreshAgentDetections={refreshAgentDetections}
        refreshRuntimeTools={refreshRuntimeTools}
        runtimeTools={runtimeTools}
        projects={projects}
        selectedCanvasId={selectedCanvasId}
        selectedProject={selectedProject}
        loadProject={loadProject}
        setActiveView={setActiveView}
        setError={setError}
        settings={settings}
        projectPromptMarkdown={projectPromptMarkdown}
        projectPromptPolicy={projectPromptPolicy}
        t={t}
        updateProjectPrompt={updateProjectPrompt}
        updateProjectPromptPolicy={updateProjectPromptPolicy}
        updateGlobalPrompt={updateGlobalPrompt}
        updateSettingsAndWait={updateSettingsAndWait}
        updateSettings={updateSettings}
      />
    </div>
  );
}
