import type { Dispatch, SetStateAction } from "react";
import type { DesktopAgentDetection, DesktopGraphViewModel, DesktopProjectSummary, DesktopRuntimeToolAvailability, ProjectPromptPolicy } from "@planweave-ai/runtime";
import type { createTranslator, Language } from "./i18n";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "./types";
import { SettingsView } from "./views/SettingsView";

type AppSettingsRouteProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  graph: DesktopGraphViewModel | null;
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
  updateProjectPrompt: (markdown: string) => Promise<void>;
  updateProjectPromptPolicy: (patch: Partial<ProjectPromptPolicy>) => Promise<void>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

export function AppSettingsRoute({
  agentDetectionRefreshing,
  agents,
  graph,
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
  updateSettings
}: AppSettingsRouteProps) {
  return (
    <div className="h-screen min-h-0 overflow-hidden text-foreground">
      <SettingsView
        graph={graph}
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
        updateSettings={updateSettings}
      />
    </div>
  );
}
