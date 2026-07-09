import { useState } from "react";
import type {
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopCanvasReference,
  DesktopPackageFileChangeEvent,
  DesktopPackageFileSyncResult,
  DesktopProjectSummary,
  ValidationIssue
} from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";
import type { AutoRunScopeMode, FloatingControlPosition } from "../types";
import { useAutoRunControl } from "../hooks/useAutoRunControl";
import { usePackageFileSync } from "../hooks/usePackageFileSync";
import type { WorkspaceTabsAutoRunProps, WorkspaceTabsFileSyncProps } from "../views/WorkspaceTabs";

export type AutoRunController = WorkspaceTabsAutoRunProps & {
  startAutoRunWithScope: ReturnType<typeof useAutoRunControl>["startAutoRunWithScope"];
};
export type FileSyncController = WorkspaceTabsFileSyncProps & {
  fileSyncDiagnostics: string[];
  lastFileChange: DesktopPackageFileChangeEvent | null;
};

export function createAutoRunController(props: AutoRunController): AutoRunController {
  return props;
}

export function createFileSyncController(props: FileSyncController): FileSyncController {
  return props;
}

export function useAutoRunController({
  autoRunState,
  handleOpenRunRecord,
  onAutoRunDerivedStateRefresh,
  onPositionCommit,
  position,
  selectedBlock,
  selectedCanvasId,
  selectedProject,
  selectedTaskPanelId,
  setAutoRunState,
  setError,
  t,
  tmuxMonitoringEnabled
}: {
  autoRunState: DesktopAutoRunState | null;
  handleOpenRunRecord: (
    recordId: string | null | undefined,
    canvasId?: string | null
  ) => Promise<void>;
  onAutoRunDerivedStateRefresh: () => Promise<void>;
  onPositionCommit: (position: FloatingControlPosition) => void;
  position: FloatingControlPosition | null;
  selectedBlock: DesktopBlockDetail | null;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setAutoRunState: (state: DesktopAutoRunState | null) => void;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
  tmuxMonitoringEnabled: boolean;
}): AutoRunController {
  const {
    autoRunControlRef,
    autoRunControlStyle,
    autoRunNextAction,
    autoRunRetrospective,
    autoRunScopeMode,
    autoRunState: currentAutoRunState,
    handleAutoRunClick,
    handleAutoRunNextAction,
    miniRunPanelOpen,
    moveAutoRunControl,
    resetRuntimeStateClick,
    setAutoRunScopeMode,
    setMiniRunPanelOpen,
    startAutoRunControlDrag,
    startAutoRunWithScope,
    stopAutoRunClick,
    stopAutoRunControlDrag
  } = useAutoRunControl({
    autoRunState,
    onAutoRunDerivedStateRefresh,
    selectedCanvasId,
    selectedBlock,
    selectedProject,
    selectedTaskPanelId,
    handleOpenRunRecord,
    setAutoRunState,
    setError,
    t,
    tmuxMonitoringEnabled,
    position,
    onPositionCommit
  });

  return createAutoRunController({
    autoRunControlRef,
    autoRunControlStyle,
    autoRunNextAction,
    autoRunRetrospective,
    autoRunScopeMode,
    autoRunState: currentAutoRunState,
    handleAutoRunClick,
    handleAutoRunNextAction,
    miniRunPanelOpen,
    moveAutoRunControl,
    resetRuntimeStateClick,
    setAutoRunScopeMode,
    setMiniRunPanelOpen,
    startAutoRunControlDrag,
    startAutoRunWithScope,
    stopAutoRunClick,
    stopAutoRunControlDrag
  });
}

export function useFileSyncController({
  projectDiagnostics,
  refreshProjectDerivedState,
  reloadCurrentCanvas,
  selectedCanvasId,
  selectedProject,
  setError,
  t
}: {
  projectDiagnostics: ValidationIssue[];
  refreshProjectDerivedState: (options?: { includeLayout?: boolean }) => Promise<void>;
  reloadCurrentCanvas: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
}): FileSyncController {
  const [lastFileChange, setLastFileChange] = useState<DesktopPackageFileChangeEvent | null>(null);
  const [fileSyncDiagnostics, setFileSyncDiagnostics] = useState<string[]>([]);
  const [fileSyncResult, setFileSyncResult] = useState<DesktopPackageFileSyncResult | null>(null);
  const { refreshPackageFiles } = usePackageFileSync({
    refreshProjectDerivedState,
    reloadCurrentCanvas,
    selectedCanvasId,
    selectedProject,
    setError,
    setFileSyncDiagnostics,
    setFileSyncResult,
    setLastFileChange
  });

  return createFileSyncController({
    applyCanvasLaneLayout: async (ref: DesktopCanvasReference) => {
      if (!bridge) {
        throw new Error(t("bridgeUnavailable"));
      }
      await bridge.applyCanvasLaneLayout(ref);
    },
    copyText: async (text: string) => {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t("manualCommandUnavailable"));
      }
      await navigator.clipboard.writeText(text);
    },
    fileSyncDiagnostics,
    fileSyncResult,
    lastFileChange,
    projectDiagnostics,
    refreshPackageFiles,
    refreshProjectDerivedState: async () => refreshProjectDerivedState({ includeLayout: true }),
    setError
  });
}
