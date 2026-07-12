import type { Dispatch, SetStateAction } from "react";
import type { DesktopAgentDetection, DesktopGraphViewModel, DesktopProjectSummary, DesktopRuntimeToolAvailability, ProjectPromptPolicy } from "@planweave-ai/runtime";
import type { createTranslator, Language } from "./i18n";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "./types";
import { SettingsView } from "./views/SettingsView";
import type { SettingsSection } from "./settings/SettingsNav";

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
  section: SettingsSection;
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
  section,
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
    <div className="h-full min-w-0 flex-1 overflow-hidden text-foreground animate-in fade-in slide-in-from-right-2 duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)]">
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
        section={section}
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
