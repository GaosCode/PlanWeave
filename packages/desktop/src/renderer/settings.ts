import type { BlockType } from "@planweave-ai/runtime";
import type { AppearanceMode, DesktopUiSettings, FloatingControlPosition } from "./types";

export const desktopSettingsKey = "planweave.desktop.settings.v1";

export const desktopSidebarWidthBounds = {
  left: { min: 220, max: 520, defaultValue: 280 },
  right: { min: 240, max: 520, defaultValue: 300 }
} as const;

export const defaultDesktopSettings: DesktopUiSettings = {
  runtimePath: "",
  defaultExecutor: "",
  appearance: "system",
  reducedMotion: false,
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
  windowMaterial: {
    enabled: false
  },
  layout: {
    leftSidebar: {
      collapsed: false,
      width: desktopSidebarWidthBounds.left.defaultValue
    },
    rightSidebar: {
      collapsed: false,
      width: desktopSidebarWidthBounds.right.defaultValue
    },
    autoRunControl: {
      position: null
    }
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
    defaultBlockSet: ["implementation"],
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
    },
    pi: {
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
    windowMaterial: {
      ...current.windowMaterial,
      ...patch.windowMaterial
    },
    layout: {
      ...current.layout,
      ...patch.layout,
      leftSidebar: {
        ...current.layout.leftSidebar,
        ...patch.layout?.leftSidebar
      },
      rightSidebar: {
        ...current.layout.rightSidebar,
        ...patch.layout?.rightSidebar
      },
      autoRunControl: {
        ...current.layout.autoRunControl,
        ...patch.layout?.autoRunControl
      }
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
      },
      pi: {
        ...current.agents.pi,
        ...patch.agents?.pi
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "system" || value === "light" || value === "dark";
}

function isLanguage(value: unknown): value is DesktopUiSettings["language"] {
  return value === "system" || value === "en" || value === "zh-CN";
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function booleanField<T extends Record<string, boolean>>(defaults: T, source: unknown): T | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  let hasValidField = false;
  const next = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const value = source[key as string];
    if (typeof value === "boolean") {
      next[key] = value as T[keyof T];
      hasValidField = true;
    }
  }
  return hasValidField ? next : undefined;
}

function validPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeSidebarLayout(
  defaults: DesktopUiSettings["layout"]["leftSidebar"],
  bounds: { min: number; max: number },
  source: unknown
): DesktopUiSettings["layout"]["leftSidebar"] | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const next = { ...defaults };
  let hasValidField = false;
  if (typeof source.collapsed === "boolean") {
    next.collapsed = source.collapsed;
    hasValidField = true;
  }
  if (validPositiveNumber(source.width)) {
    next.width = Math.min(bounds.max, Math.max(bounds.min, Math.round(source.width)));
    hasValidField = true;
  }
  return hasValidField ? next : undefined;
}

function normalizeFloatingControlPosition(source: unknown): FloatingControlPosition | null | undefined {
  if (source === null) {
    return null;
  }
  if (!isRecord(source)) {
    return undefined;
  }
  return validNonNegativeNumber(source.left) && validNonNegativeNumber(source.top)
    ? { left: source.left, top: source.top }
    : undefined;
}

function normalizeDesktopSettingsPatch(value: unknown): Partial<DesktopUiSettings> {
  if (!isRecord(value)) {
    return {};
  }
  const patch: Partial<DesktopUiSettings> = {};

  if (typeof value.runtimePath === "string") {
    patch.runtimePath = value.runtimePath;
  }
  if (typeof value.defaultExecutor === "string") {
    patch.defaultExecutor = value.defaultExecutor;
  }
  if (isAppearanceMode(value.appearance)) {
    patch.appearance = value.appearance;
  }
  if (typeof value.reducedMotion === "boolean") {
    patch.reducedMotion = value.reducedMotion;
  }
  if (isLanguage(value.language)) {
    patch.language = value.language;
  }
  patch.pinnedProjectIds = stringArray(value.pinnedProjectIds) ?? patch.pinnedProjectIds;
  patch.readNotificationIds = stringArray(value.readNotificationIds) ?? patch.readNotificationIds;

  const notifications = booleanField(defaultDesktopSettings.notifications, value.notifications);
  if (notifications) {
    patch.notifications = notifications;
  }
  const execution = booleanField(defaultDesktopSettings.execution, value.execution);
  if (execution) {
    patch.execution = execution;
  }
  const windowMaterial = booleanField(defaultDesktopSettings.windowMaterial, value.windowMaterial);
  if (windowMaterial) {
    patch.windowMaterial = windowMaterial;
  }

  if (isRecord(value.layout)) {
    const leftSidebar = normalizeSidebarLayout(defaultDesktopSettings.layout.leftSidebar, desktopSidebarWidthBounds.left, value.layout.leftSidebar);
    const rightSidebar = normalizeSidebarLayout(defaultDesktopSettings.layout.rightSidebar, desktopSidebarWidthBounds.right, value.layout.rightSidebar);
    const autoRunPosition = isRecord(value.layout.autoRunControl)
      ? normalizeFloatingControlPosition(value.layout.autoRunControl.position)
      : undefined;
    if (leftSidebar || rightSidebar || autoRunPosition !== undefined) {
      patch.layout = {
        ...defaultDesktopSettings.layout,
        leftSidebar: leftSidebar ?? defaultDesktopSettings.layout.leftSidebar,
        rightSidebar: rightSidebar ?? defaultDesktopSettings.layout.rightSidebar,
        autoRunControl: {
          position: autoRunPosition !== undefined ? autoRunPosition : defaultDesktopSettings.layout.autoRunControl.position
        }
      };
    }
  }

  const review = booleanField(defaultDesktopSettings.review, value.review);
  if (review) {
    patch.review = review;
  }

  if (isRecord(value.palette)) {
    const visible = booleanField(defaultDesktopSettings.palette.visible, value.palette.visible);
    const defaultBlockSet =
      Array.isArray(value.palette.defaultBlockSet) &&
      value.palette.defaultBlockSet.every((item): item is BlockType => item === "implementation" || item === "review")
        ? value.palette.defaultBlockSet
        : undefined;
    if (visible || defaultBlockSet || typeof value.palette.dragHint === "boolean") {
      patch.palette = {
        ...defaultDesktopSettings.palette,
        visible: visible ?? defaultDesktopSettings.palette.visible,
        defaultBlockSet: defaultBlockSet ?? defaultDesktopSettings.palette.defaultBlockSet,
        dragHint: typeof value.palette.dragHint === "boolean" ? value.palette.dragHint : defaultDesktopSettings.palette.dragHint
      };
    }
  }

  if (isRecord(value.agents)) {
    const agents = { ...defaultDesktopSettings.agents };
    let hasValidAgent = false;
    for (const kind of Object.keys(defaultDesktopSettings.agents) as Array<keyof DesktopUiSettings["agents"]>) {
      const agent = booleanField(defaultDesktopSettings.agents[kind], value.agents[kind]);
      if (agent) {
        agents[kind] = agent;
        hasValidAgent = true;
      }
    }
    if (hasValidAgent) {
      patch.agents = agents;
    }
  }

  return patch;
}

const materialDefaultMigrationKey = "planweave.desktop.material-default-macos.v1";

function isMacOs(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Macintosh|Mac OS X/i.test(navigator.userAgent);
}

export function loadDesktopSettings(): DesktopUiSettings {
  if (typeof window === "undefined") {
    return defaultDesktopSettings;
  }
  try {
    const raw = window.localStorage.getItem(desktopSettingsKey);
    if (!raw) {
      window.localStorage.setItem(materialDefaultMigrationKey, "1");
      return mergeDesktopSettings(defaultDesktopSettings, {
        windowMaterial: { enabled: isMacOs() }
      });
    }
    const parsed: unknown = JSON.parse(raw);
    const merged = mergeDesktopSettings(defaultDesktopSettings, normalizeDesktopSettingsPatch(parsed));
    // One-time migration: existing macOS users adopt the glass window material
    // once. After this runs we never force it again, so a later manual opt-out sticks.
    if (isMacOs() && !window.localStorage.getItem(materialDefaultMigrationKey)) {
      window.localStorage.setItem(materialDefaultMigrationKey, "1");
      return mergeDesktopSettings(merged, { windowMaterial: { enabled: true } });
    }
    return merged;
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
