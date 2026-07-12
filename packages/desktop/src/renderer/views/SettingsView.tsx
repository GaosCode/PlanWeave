import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopAgentDetection, DesktopGraphViewModel, DesktopProjectSummary, DesktopRuntimeToolAvailability, ProjectPromptPolicy } from "@planweave-ai/runtime";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingsAgentsSection } from "../settings/SettingsAgentsSection";
import { SettingsComponentsSection } from "../settings/SettingsComponentsSection";
import { SettingsGeneralSection } from "../settings/SettingsGeneralSection";
import { SettingsNav } from "../settings/SettingsNav";
import type { SettingsSection } from "../settings/SettingsNav";
import { SettingsMcpSection } from "../settings/SettingsMcpSection";
import { SettingsReviewSection } from "../settings/SettingsReviewSection";
import type { createTranslator, Language } from "../i18n";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import { RemoteProfilesSection } from "../components/RemoteProfilesSection";
import { remoteBridge } from "../bridge";
import type { RemoteProfile } from "../../shared/remoteTypes";

type SettingsViewProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  graph: DesktopGraphViewModel | null;
  language: Language;
  refreshAgentDetections: () => Promise<void>;
  refreshRuntimeTools: () => Promise<void>;
  runtimeTools: DesktopRuntimeToolAvailability;
  projects?: DesktopProjectSummary[];
  selectedCanvasId?: string | null;
  selectedProject?: DesktopProjectSummary | null;
  loadProject?: (project: DesktopProjectSummary) => Promise<void>;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setError?: (message: string | null) => void;
  settings: DesktopUiSettings;
  projectPromptMarkdown?: string | null;
  projectPromptPolicy?: ProjectPromptPolicy | null;
  t: ReturnType<typeof createTranslator>;
  updateProjectPrompt?: (markdown: string) => Promise<void>;
  updateProjectPromptPolicy?: (patch: Partial<ProjectPromptPolicy>) => Promise<void>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

export function SettingsView({
  agentDetectionRefreshing,
  agents,
  graph,
  language,
  refreshAgentDetections,
  refreshRuntimeTools,
  runtimeTools,
  projects = [],
  selectedCanvasId = null,
  selectedProject,
  loadProject,
  setActiveView,
  setError = () => undefined,
  settings,
  projectPromptMarkdown,
  projectPromptPolicy,
  t,
  updateProjectPrompt,
  updateProjectPromptPolicy,
  updateSettings
}: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [projectPromptDraft, setProjectPromptDraft] = useState(projectPromptMarkdown ?? "");
  const [projectPromptSaving, setProjectPromptSaving] = useState(false);
  const [remoteProfiles, setRemoteProfiles] = useState<RemoteProfile[]>([]);
  const projectPromptAvailable = Boolean(selectedProject && updateProjectPrompt);
  const projectPromptPolicyAvailable = Boolean(selectedProject && projectPromptPolicy && updateProjectPromptPolicy);
  const projectSelectorAvailable = projects.length > 0 && Boolean(loadProject);
  const selectedCanvasRef = selectedProject ? { projectRoot: selectedProject.rootPath, canvasId: selectedCanvasId } : null;

  useEffect(() => {
    setProjectPromptDraft(projectPromptMarkdown ?? "");
  }, [projectPromptMarkdown]);

  useEffect(() => { void remoteBridge?.listRemoteProfiles().then(setRemoteProfiles); }, []);

  const selectProject = (projectId: string) => {
    const project = projects.find((item) => item.projectId === projectId);
    if (project) {
      void loadProject?.(project);
    }
  };

  const saveProjectPrompt = () => {
    if (!updateProjectPrompt) {
      return;
    }
    setProjectPromptSaving(true);
    void updateProjectPrompt(projectPromptDraft).finally(() => setProjectPromptSaving(false));
  };

  return (
    <main className="flex h-full min-h-0 text-text">
      <SettingsNav section={section} setSection={setSection} onBackToApp={() => setActiveView("graph")} t={t} />
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-l-xl bg-app-shell text-text">
        <div className="app-drag-region h-11 shrink-0 border-b border-border/80 bg-app-topbar" />
        <ScrollArea
          className="min-h-0 min-w-0 flex-1 bg-app-canvas"
          viewportClassName="h-full [&>div]:!block [&>div]:!min-h-full [&>div]:!w-full"
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-12 py-10 pb-16">
          {section === "general" ? (
            <SettingsGeneralSection
              language={language}
              onProjectPromptDraftChange={setProjectPromptDraft}
              onProjectPromptSave={saveProjectPrompt}
              onProjectSelect={selectProject}
              projectPromptAvailable={projectPromptAvailable}
              projectPromptDraft={projectPromptDraft}
              projectPromptPolicy={projectPromptPolicy}
              projectPromptPolicyAvailable={projectPromptPolicyAvailable}
              projectPromptSaving={projectPromptSaving}
              projectSelectorAvailable={projectSelectorAvailable}
              projects={projects}
              refreshRuntimeTools={refreshRuntimeTools}
              runtimeTools={runtimeTools}
              selectedProjectId={selectedProject?.projectId}
              settings={settings}
              t={t}
              updateProjectPromptPolicy={updateProjectPromptPolicy}
              updateSettings={updateSettings}
            />
          ) : null}
          {section === "components" ? <SettingsComponentsSection settings={settings} t={t} updateSettings={updateSettings} /> : null}
          {section === "review" ? <SettingsReviewSection graph={graph} settings={settings} t={t} updateSettings={updateSettings} /> : null}
          {section === "agents" ? (
            <SettingsAgentsSection
              agentDetectionRefreshing={agentDetectionRefreshing}
              agents={agents}
              canvasRef={selectedCanvasRef}
              graph={graph}
              refreshAgentDetections={refreshAgentDetections}
              settings={settings}
              t={t}
              updateSettings={updateSettings}
            />
          ) : null}
          {section === "mcp" ? <><SettingsMcpSection setError={setError} t={t} /><RemoteProfilesSection profiles={remoteProfiles} onProfilesChange={setRemoteProfiles} /></> : null}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}
