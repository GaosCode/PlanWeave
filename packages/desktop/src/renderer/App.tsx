import { useDesktopErrorState } from "./hooks/useDesktopErrorState";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { bridge } from "./bridge";
import { createTranslator } from "./i18n";
import { ProjectSidebar } from "./sidebar/ProjectSidebar";
import { WorkspaceTabs } from "./views/WorkspaceTabs";
import { useAppViewHistory } from "./hooks/useAppViewHistory";
import { useDesktopSettingsEffects } from "./hooks/useDesktopSettingsEffects";
import { useDesktopSettingsBridge } from "./hooks/useDesktopSettingsBridge";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useRuntimeTools } from "./hooks/useRuntimeTools";
import { useGlobalPrompt } from "./hooks/useGlobalPrompt";
import { useResizableSidebarLayout } from "./hooks/useResizableSidebarLayout";
import { CollapsedSidebarControls, RightPaletteSidebar } from "./AppSidebars";
import { AppErrorBanner } from "./components/AppErrorBanner";
import { AppOverlays } from "./components/AppOverlays";
import { AppUpdateProvider } from "./components/AppUpdateProvider";
import { detectRendererPlatform } from "./rendererPlatform";
import {
  ProjectWorkspaceProvider,
  useProjectWorkspace,
  type ProjectWorkspaceShellInput
} from "./ProjectWorkspaceProvider";

const AppSettingsRoute = lazy(async () => {
  const module = await import("./AppSettingsRoute");
  return { default: module.AppSettingsRoute };
});

export function AppWorkspaceChrome({
  leftSidebarCollapsed,
  leftSidebarWidth,
  rightSidebarCollapsed,
  rightSidebarWidth,
  setLeftSidebarCollapsedPreference,
  setRightSidebarCollapsedPreference,
  settings,
  startSidebarResize
}: {
  leftSidebarCollapsed: boolean;
  leftSidebarWidth: number;
  rightSidebarCollapsed: boolean;
  rightSidebarWidth: number;
  setLeftSidebarCollapsedPreference: ReturnType<
    typeof useResizableSidebarLayout
  >["setLeftSidebarCollapsedPreference"];
  setRightSidebarCollapsedPreference: ReturnType<
    typeof useResizableSidebarLayout
  >["setRightSidebarCollapsedPreference"];
  settings: ProjectWorkspaceShellInput["settings"];
  startSidebarResize: ReturnType<typeof useResizableSidebarLayout>["startSidebarResize"];
}) {
  const { palette, projectSidebar, shell } = useProjectWorkspace();
  const activeView = shell.activeView;
  const hasRightPalette =
    activeView !== "canvas-map" && activeView !== "people" && activeView !== "executors";

  if (activeView === "task-workspace") {
    return (
      <main className="relative flex h-full min-h-0 overflow-hidden">
        <WorkspaceTabs />
      </main>
    );
  }

  return (
    <>
      <main className="relative flex h-full min-h-0 overflow-hidden">
        <ProjectSidebar
          {...projectSidebar}
          collapsed={leftSidebarCollapsed}
          onResizeStart={(event) => startSidebarResize(event, "left")}
          onToggleSidebar={() => setLeftSidebarCollapsedPreference((current) => !current)}
          width={leftSidebarWidth}
        />
        <WorkspaceTabs />
        {hasRightPalette ? (
          <RightPaletteSidebar
            addPaletteComponent={palette.addPaletteComponent}
            handlePaletteDragStart={palette.handlePaletteDragStart}
            onResizeStart={(event) => startSidebarResize(event, "right")}
            rightSidebarCollapsed={rightSidebarCollapsed}
            setRightSidebarCollapsed={setRightSidebarCollapsedPreference}
            settings={settings}
            width={rightSidebarWidth}
            t={shell.t}
          />
        ) : null}
      </main>
      <CollapsedSidebarControls
        leftSidebarCollapsed={leftSidebarCollapsed}
        rightSidebarCollapsed={hasRightPalette ? rightSidebarCollapsed : false}
        setLeftSidebarCollapsed={setLeftSidebarCollapsedPreference}
        setRightSidebarCollapsed={setRightSidebarCollapsedPreference}
        t={shell.t}
      />
    </>
  );
}

function AppSettingsChrome({ t }: { t: ReturnType<typeof createTranslator> }) {
  const { settingsRouteProps } = useProjectWorkspace();
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-text-muted">
          {t("loadingProject")}
        </div>
      }
    >
      <AppSettingsRoute {...settingsRouteProps} />
    </Suspense>
  );
}

export function App() {
  const rendererPlatform = detectRendererPlatform();
  const { error, setError, captureErrorClear } = useDesktopErrorState();
  const {
    settings,
    settingsHydrated,
    updateLayoutSettings,
    updateSettings,
    updateSettingsAndWait
  } = useDesktopSettingsBridge({ setError });
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView, appHistory] = useAppViewHistory("graph");
  const {
    agentDetectionError,
    agentDetectionRefreshing,
    agentDetections,
    dismissAgentDetectionError,
    refreshAgentDetections
  } = useDetectedAgents(settingsHydrated ? settings.execution.agentHost : null);
  const { refreshRuntimeTools, runtimeTools } = useRuntimeTools();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const { globalPromptMarkdown, updateGlobalPrompt } = useGlobalPrompt(
    setError,
    settings.planweaveHome
  );

  useEffect(() => {
    if (!bridge) {
      setError(t("bridgeUnavailable"));
    }
  }, [t, setError]);

  useEffect(() => {
    if (appHistory.historyError) {
      setError(appHistory.historyError);
    }
  }, [appHistory.historyError, setError]);

  useDesktopSettingsEffects(settings);

  const {
    leftSidebarCollapsed,
    leftSidebarWidth,
    rightSidebarCollapsed,
    rightSidebarWidth,
    setLeftSidebarCollapsedPreference,
    setRightSidebarCollapsedPreference,
    startSidebarResize
  } = useResizableSidebarLayout({
    initialLayout: settings.layout,
    onLayoutPatch: updateLayoutSettings
  });

  const shellInput = useMemo<ProjectWorkspaceShellInput>(
    () => ({
      activeView,
      appHistory,
      agentDetectionError,
      agentDetectionRefreshing,
      agentDetections,
      captureErrorClear,
      globalPromptMarkdown,
      language,
      refreshAgentDetections,
      refreshRuntimeTools,
      runtimeTools,
      setActiveView,
      setError,
      setSuccessMessage,
      settings,
      settingsHydrated,
      t,
      updateLayoutSettings,
      updateGlobalPrompt,
      updateSettings,
      updateSettingsAndWait
    }),
    [
      activeView,
      appHistory,
      agentDetectionError,
      agentDetectionRefreshing,
      agentDetections,
      captureErrorClear,
      globalPromptMarkdown,
      language,
      refreshAgentDetections,
      refreshRuntimeTools,
      runtimeTools,
      setActiveView,
      setError,
      settings,
      settingsHydrated,
      t,
      updateLayoutSettings,
      updateGlobalPrompt,
      updateSettings,
      updateSettingsAndWait
    ]
  );

  return (
    <ProjectWorkspaceProvider shell={shellInput}>
      <AppUpdateProvider>
        <div
          className="glass-surface flex h-screen min-h-0 flex-col overflow-hidden text-foreground"
          data-window-platform={rendererPlatform}
        >
          <div className="relative min-h-0 flex-1">
            {activeView === "settings" ? (
              <AppSettingsChrome t={t} />
            ) : (
              <AppWorkspaceChrome
                leftSidebarCollapsed={leftSidebarCollapsed}
                leftSidebarWidth={leftSidebarWidth}
                rightSidebarCollapsed={rightSidebarCollapsed}
                rightSidebarWidth={rightSidebarWidth}
                setLeftSidebarCollapsedPreference={setLeftSidebarCollapsedPreference}
                setRightSidebarCollapsedPreference={setRightSidebarCollapsedPreference}
                settings={settings}
                startSidebarResize={startSidebarResize}
              />
            )}
            <AppOverlays
              successMessage={successMessage}
              setSuccessMessage={setSuccessMessage}
              t={t}
            />
          </div>
          <AppErrorBanner message={error} onDismiss={() => setError(null)} t={t} />
          <AppErrorBanner
            message={
              agentDetectionError && activeView !== "executors"
                ? t("agentDetectionFailed").replace("{error}", agentDetectionError)
                : null
            }
            onDismiss={dismissAgentDetectionError}
            t={t}
          />
        </div>
      </AppUpdateProvider>
    </ProjectWorkspaceProvider>
  );
}
