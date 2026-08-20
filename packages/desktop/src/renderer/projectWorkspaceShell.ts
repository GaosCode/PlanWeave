import type { DesktopAgentDetection, DesktopRuntimeToolAvailability } from "@planweave-ai/runtime";
import type { Dispatch, SetStateAction } from "react";
import type { createTranslator } from "./i18n";
import type {
  AppView,
  DesktopSettingsUpdate,
  DesktopUiSettings,
  FloatingControlPosition
} from "./types";
import type { AppViewHistoryController } from "./hooks/useAppViewHistory";

type LayoutSettingsPatch = {
  leftSidebar?: Partial<DesktopUiSettings["layout"]["leftSidebar"]>;
  rightSidebar?: Partial<DesktopUiSettings["layout"]["rightSidebar"]>;
  autoRunControl?: Partial<DesktopUiSettings["layout"]["autoRunControl"]> & {
    position?: FloatingControlPosition | null;
  };
  collaborationScope?: Partial<DesktopUiSettings["layout"]["collaborationScope"]>;
};

export type ProjectWorkspaceShellInput = {
  activeView: AppView;
  appHistory: AppViewHistoryController;
  agentDetectionRefreshing: boolean;
  agentDetections: DesktopAgentDetection[];
  globalPromptMarkdown: string | null;
  language: DesktopUiSettings["language"];
  refreshAgentDetections: () => Promise<void>;
  refreshRuntimeTools: () => Promise<void>;
  runtimeTools: DesktopRuntimeToolAvailability;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setError: (message: string | null) => void;
  setSuccessMessage: Dispatch<SetStateAction<string | null>>;
  settings: DesktopUiSettings;
  settingsHydrated: boolean;
  t: ReturnType<typeof createTranslator>;
  updateLayoutSettings: (patch: LayoutSettingsPatch) => void;
  updateGlobalPrompt: (markdown: string) => Promise<void>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
  updateSettingsAndWait: (update: DesktopSettingsUpdate) => Promise<void>;
};
