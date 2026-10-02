import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  DesktopAgentDetection,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopRuntimeToolAvailability,
  ProjectPromptPolicy
} from "@planweave-ai/runtime";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePromptDraft } from "../hooks/usePromptDraft";
import { SettingsComponentsSection } from "../settings/SettingsComponentsSection";
import { SettingsGeneralSection } from "../settings/SettingsGeneralSection";
import { SettingsNav } from "../settings/SettingsNav";
import type { SettingsSection } from "../settings/SettingsNav";
import { SettingsMcpSection } from "../settings/SettingsMcpSection";
import { SettingsProjectDoctorSection } from "../settings/SettingsProjectDoctorSection";
import { SettingsReviewSection } from "../settings/SettingsReviewSection";
import { SettingsConnectionsSection } from "../settings/SettingsConnectionsSection";
import {
  consumeSettingsConnectionsTab,
  peekSettingsConnectionsTab
} from "../settings/settingsEntry";
import { SettingsSecuritySection } from "../settings/SettingsSecuritySection";
import type { createTranslator, Language } from "../i18n";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "../types";

type SettingsViewProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  graph: DesktopGraphViewModel | null;
  globalPromptMarkdown?: string | null;
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
  updateProjectPrompt?: (markdown: string) => Promise<boolean>;
  updateProjectPromptPolicy?: (patch: Partial<ProjectPromptPolicy>) => Promise<void>;
  updateGlobalPrompt?: (markdown: string) => Promise<boolean>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
  updateSettingsAndWait: (update: DesktopSettingsUpdate) => Promise<void>;
};

export function SettingsView({
  graph,
  globalPromptMarkdown,
  language,
  refreshRuntimeTools,
  runtimeTools,
  projects = [],
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
  updateGlobalPrompt,
  updateSettings
}: SettingsViewProps) {
  const [queuedConnectionsTab] = useState(() => peekSettingsConnectionsTab());
  const [section, setSection] = useState<SettingsSection>(
    queuedConnectionsTab ? "connections" : "general"
  );
  useEffect(() => {
    consumeSettingsConnectionsTab();
  }, []);
  const projectDraft = usePromptDraft(
    JSON.stringify([settings.planweaveHome, selectedProject?.rootPath ?? null]),
    projectPromptMarkdown,
    updateProjectPrompt,
    setError
  );
  const globalDraft = usePromptDraft(
    settings.planweaveHome,
    globalPromptMarkdown,
    updateGlobalPrompt,
    setError
  );
  const settingsViewportRef = useRef<HTMLDivElement>(null);
  const projectPromptAvailable = Boolean(selectedProject && updateProjectPrompt);
  const projectPromptPolicyAvailable = Boolean(
    selectedProject && projectPromptPolicy && updateProjectPromptPolicy
  );
  const projectSelectorAvailable = projects.length > 0 && Boolean(loadProject);

  useEffect(() => {
    if (!settings.developerMode && section === "project-doctor") {
      setSection("general");
    }
  }, [section, settings.developerMode]);

  const resetSettingsViewport = useCallback(() => {
    const viewport = settingsViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = 0;
  }, []);

  const selectProject = (projectId: string) => {
    const project = projects.find((item) => item.projectId === projectId);
    if (project) {
      void loadProject?.(project);
    }
  };

  return (
    <main className="flex h-full min-h-0 text-text">
      <SettingsNav
        developerMode={settings.developerMode}
        section={section}
        setSection={setSection}
        onBackToApp={() => setActiveView("graph")}
        t={t}
      />
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-l-xl bg-app-shell text-text">
        <div className="app-drag-region h-11 shrink-0 border-b border-border/80 bg-app-topbar" />
        <ScrollArea
          className="min-h-0 min-w-0 flex-1 bg-app-canvas"
          viewportRef={settingsViewportRef}
          viewportClassName="h-full [overflow-anchor:none] [&>div]:!block [&>div]:!min-h-full [&>div]:!w-full"
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-12 py-10 pb-16">
            {section === "general" ? (
              <SettingsGeneralSection
                globalPromptAvailable={Boolean(updateGlobalPrompt)}
                globalPromptDraft={globalDraft.draft}
                globalPromptSaving={globalDraft.saving}
                language={language}
                onGlobalPromptDraftChange={globalDraft.edit}
                onGlobalPromptSave={globalDraft.save}
                onProjectPromptDraftChange={projectDraft.edit}
                onProjectPromptSave={projectDraft.save}
                onProjectSelect={selectProject}
                projectPromptAvailable={projectPromptAvailable}
                projectPromptDraft={projectDraft.draft}
                projectPromptPolicy={projectPromptPolicy}
                projectPromptPolicyAvailable={projectPromptPolicyAvailable}
                projectPromptSaving={projectDraft.saving}
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
            {section === "components" ? (
              <SettingsComponentsSection
                settings={settings}
                t={t}
                updateSettings={updateSettings}
              />
            ) : null}
            {section === "review" ? (
              <SettingsReviewSection
                graph={graph}
                settings={settings}
                t={t}
                updateSettings={updateSettings}
              />
            ) : null}
            {settings.developerMode && section === "project-doctor" ? (
              <SettingsProjectDoctorSection
                selectedProject={selectedProject ?? null}
                setError={setError}
                t={t}
              />
            ) : null}
            {section === "mcp" ? <SettingsMcpSection setError={setError} t={t} /> : null}
            {section === "connections" ? (
              <SettingsConnectionsSection
                t={t}
                initialTab={queuedConnectionsTab ?? "server"}
                onTabChange={resetSettingsViewport}
              />
            ) : null}
            {section === "security" ? <SettingsSecuritySection t={t} /> : null}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}
