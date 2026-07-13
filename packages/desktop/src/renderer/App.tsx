import { useEffect, useMemo, useState } from "react";
import { bridge } from "./bridge";
import { createTranslator } from "./i18n";
import { ProjectSidebar } from "./sidebar/ProjectSidebar";
import { WorkspaceTabs } from "./views/WorkspaceTabs";
import { useAppViewHistory } from "./hooks/useAppViewHistory";
import { useDesktopSettingsEffects } from "./hooks/useDesktopSettingsEffects";
import { useDesktopSettingsBridge } from "./hooks/useDesktopSettingsBridge";
import { useDetectedAgents } from "./hooks/useDetectedAgents";
import { useRuntimeTools } from "./hooks/useRuntimeTools";
import { useResizableSidebarLayout } from "./hooks/useResizableSidebarLayout";
import { CollapsedSidebarControls, RightPaletteSidebar } from "./AppSidebars";
import { AppSettingsRoute } from "./AppSettingsRoute";
import { AppOverlays } from "./components/AppOverlays";
import {
  ProjectWorkspaceProvider,
  useProjectWorkspace,
  type ProjectWorkspaceShellInput
} from "./ProjectWorkspaceProvider";

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
        {activeView === "canvas-map" ? null : (
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
        )}
      </main>
      <CollapsedSidebarControls
        leftSidebarCollapsed={leftSidebarCollapsed}
        rightSidebarCollapsed={activeView === "canvas-map" ? false : rightSidebarCollapsed}
        setLeftSidebarCollapsed={setLeftSidebarCollapsedPreference}
        setRightSidebarCollapsed={setRightSidebarCollapsedPreference}
        t={shell.t}
      />
    </>
  );
}

function AppSettingsChrome({
  error,
  setError,
  setSuccessMessage,
  successMessage,
  t
}: {
  error: string | null;
  setError: (message: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  successMessage: string | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const { settingsRouteProps } = useProjectWorkspace();
  return (
    <>
      <AppSettingsRoute {...settingsRouteProps} />
      <AppOverlays
        error={error}
        successMessage={successMessage}
        setError={setError}
        setSuccessMessage={setSuccessMessage}
        t={t}
      />
    </>
  );
}

export function App() {
  const [error, setError] = useState<string | null>(null);
  const { settings, updateLayoutSettings, updateSettings, updateSettingsAndWait } =
    useDesktopSettingsBridge({ setError });
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const [activeView, setActiveView, appHistory] = useAppViewHistory("graph");
  const { agentDetectionRefreshing, agentDetections, refreshAgentDetections } = useDetectedAgents();
  const { refreshRuntimeTools, runtimeTools } = useRuntimeTools();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) {
      setError(t("bridgeUnavailable"));
    }
  }, [t]);

  useEffect(() => {
    if (appHistory.historyError) {
      setError(appHistory.historyError);
    }
  }, [appHistory.historyError]);

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
      agentDetectionRefreshing,
      agentDetections,
      language,
      refreshAgentDetections,
      refreshRuntimeTools,
      runtimeTools,
      setActiveView,
      setError,
      setSuccessMessage,
      settings,
      t,
      updateLayoutSettings,
      updateSettings,
      updateSettingsAndWait
    }),
    [
      activeView,
      appHistory,
      agentDetectionRefreshing,
      agentDetections,
      language,
      refreshAgentDetections,
      refreshRuntimeTools,
      runtimeTools,
      setActiveView,
      settings,
      t,
      updateLayoutSettings,
      updateSettings,
      updateSettingsAndWait
    ]
  );

  return (
    <ProjectWorkspaceProvider shell={shellInput}>
      <div className="glass-surface relative h-screen min-h-0 overflow-hidden text-foreground">
        {activeView === "settings" ? (
          <AppSettingsChrome
            error={error}
            setError={setError}
            setSuccessMessage={setSuccessMessage}
            successMessage={successMessage}
            t={t}
          />
        ) : (
          <>
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
            <AppOverlays
              error={error}
              successMessage={successMessage}
              setError={setError}
              setSuccessMessage={setSuccessMessage}
              t={t}
            />
          </>
        )}
      </div>
    </ProjectWorkspaceProvider>
  );
}
