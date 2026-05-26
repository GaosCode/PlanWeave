import type { BlockType } from "@planweave/runtime";
import type { DesktopUiSettings } from "./types";

export const desktopSettingsKey = "planweave.desktop.settings.v1";

export const defaultDesktopSettings: DesktopUiSettings = {
  runtimePath: "",
  defaultExecutor: "",
  appearance: "system",
  language: "zh-CN",
  pinnedProjectIds: [],
  readNotificationIds: [],
  notifications: {
    autoRunFailure: true,
    graphExceptions: true,
    dirtyPrompts: true,
    fileSyncConflict: true
  },
  execution: {
    tmuxMonitoring: true
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
      review: true
    },
    defaultBlockSet: ["implementation", "review"],
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

export function mergeDesktopSettings(current: DesktopUiSettings, patch: Partial<DesktopUiSettings>): DesktopUiSettings {
  return {
    ...current,
    ...patch,
    pinnedProjectIds: patch.pinnedProjectIds ?? current.pinnedProjectIds,
    readNotificationIds: patch.readNotificationIds ?? current.readNotificationIds,
    notifications: {
      ...current.notifications,
      ...patch.notifications
    },
    execution: {
      ...current.execution,
      ...patch.execution
    },
    review: {
      ...current.review,
      ...patch.review
    },
    palette: {
      ...current.palette,
      ...patch.palette,
      visible: {
        ...current.palette.visible,
        ...patch.palette?.visible
      }
    },
    agents: {
      codex: {
        ...current.agents.codex,
        ...patch.agents?.codex
      },
      "claude-code": {
        ...current.agents["claude-code"],
        ...patch.agents?.["claude-code"]
      },
      opencode: {
        ...current.agents.opencode,
        ...patch.agents?.opencode
      }
    }
  };
}

export function orderProjectsByPinnedIds<T extends { projectId: string }>(projects: T[], pinnedProjectIds: string[]): T[] {
  if (pinnedProjectIds.length === 0) {
    return projects;
  }
  const pinOrder = new Map(pinnedProjectIds.map((projectId, index) => [projectId, index]));
  return [...projects].sort((left, right) => {
    const leftOrder = pinOrder.get(left.projectId);
    const rightOrder = pinOrder.get(right.projectId);
    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder;
    }
    if (leftOrder !== undefined) {
      return -1;
    }
    if (rightOrder !== undefined) {
      return 1;
    }
    return 0;
  });
}

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
    return mergeDesktopSettings(defaultDesktopSettings, parsed);
  } catch {
    return defaultDesktopSettings;
  }
}

export function visibleBlockSet(settings: DesktopUiSettings): BlockType[] {
  const configured = settings.palette.defaultBlockSet.filter((type): type is BlockType =>
    (["implementation", "review"] as BlockType[]).includes(type) && settings.palette.visible[type]
  );
  return configured.length > 0 ? configured : ["implementation"];
}
