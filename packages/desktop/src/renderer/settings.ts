import type { BlockType } from "@planweave/runtime";
import type { DesktopUiSettings } from "./types";

export const desktopSettingsKey = "planweave.desktop.settings.v1";

export const defaultDesktopSettings: DesktopUiSettings = {
  runtimePath: "",
  defaultExecutor: "",
  appearance: "system",
  language: "zh-CN",
  notifications: {
    autoRunFailure: true,
    graphExceptions: true,
    dirtyPrompts: true,
    fileSyncConflict: true
  },
  review: {
    pipelineEnabled: true,
    strictReview: true,
    feedbackLoop: true,
    autoAppendReviewBlock: true
  },
  palette: {
    visible: {
      task: true,
      implementation: true,
      check: true,
      review: true,
      context: true
    },
    defaultBlockSet: ["implementation", "check", "review"],
    dragHint: true
  },
  agents: {
    codex: {
      enabled: false,
      fullAccess: false
    },
    "claude-code": {
      enabled: false,
      fullAccess: false
    },
    opencode: {
      enabled: false,
      fullAccess: false
    }
  }
};

export function loadDesktopSettings(): DesktopUiSettings {
  if (typeof window === "undefined") {
    return defaultDesktopSettings;
  }
  try {
    const raw = window.localStorage.getItem(desktopSettingsKey);
    if (!raw) {
      return defaultDesktopSettings;
    }
    const parsed = JSON.parse(raw) as Partial<DesktopUiSettings>;
    return {
      ...defaultDesktopSettings,
      ...parsed,
      notifications: {
        ...defaultDesktopSettings.notifications,
        ...parsed.notifications
      },
      review: {
        ...defaultDesktopSettings.review,
        ...parsed.review
      },
      palette: {
        ...defaultDesktopSettings.palette,
        ...parsed.palette,
        visible: {
          ...defaultDesktopSettings.palette.visible,
          ...parsed.palette?.visible
        }
      },
      agents: {
        codex: {
          ...defaultDesktopSettings.agents.codex,
          ...parsed.agents?.codex
        },
        "claude-code": {
          ...defaultDesktopSettings.agents["claude-code"],
          ...parsed.agents?.["claude-code"]
        },
        opencode: {
          ...defaultDesktopSettings.agents.opencode,
          ...parsed.agents?.opencode
        }
      }
    };
  } catch {
    return defaultDesktopSettings;
  }
}

export function visibleBlockSet(settings: DesktopUiSettings): BlockType[] {
  const configured = settings.palette.defaultBlockSet.filter((type) => settings.palette.visible[type]);
  return configured.length > 0 ? configured : ["implementation"];
}
