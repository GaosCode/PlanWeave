import type { BlockType, DesktopAgentKind } from "@planweave-ai/runtime";

export type AppearanceMode = "system" | "light" | "dark";
export type DesktopSettingsLanguage = "system" | "en" | "zh-CN";
export type DesktopAgentTransport = "cli" | "acp";
export type PaletteComponentKey = "task" | "implementation" | "review";
export type FloatingControlPosition = { left: number; top: number };

export type DesktopUiSettings = {
  runtimePath: string;
  planweaveHome: string;
  defaultExecutor: string;
  appearance: AppearanceMode;
  reducedMotion: boolean;
  language: DesktopSettingsLanguage;
  pinnedProjectIds: string[];
  readNotificationIds: string[];
  notifications: {
    autoRunFailure: boolean;
    graphExceptions: boolean;
    dirtyPrompts: boolean;
    fileSyncConflict: boolean;
  };
  execution: {
    tmuxMonitoring: boolean;
    agentTransport: DesktopAgentTransport;
  };
  windowMaterial: {
    enabled: boolean;
  };
  layout: {
    leftSidebar: {
      collapsed: boolean;
      width: number;
    };
    rightSidebar: {
      collapsed: boolean;
      width: number;
    };
    autoRunControl: {
      position: FloatingControlPosition | null;
    };
  };
  review: {
    pipelineEnabled: boolean;
    strictReview: boolean;
    feedbackLoop: boolean;
    autoAppendReviewBlock: boolean;
  };
  palette: {
    visible: Record<PaletteComponentKey, boolean>;
    defaultBlockSet: BlockType[];
    dragHint: boolean;
  };
  agents: Record<
    DesktopAgentKind,
    {
      enabled: boolean;
      fullAccess: boolean;
    }
  >;
};

export type DesktopSettingsPatch = Partial<{
  runtimePath: string;
  planweaveHome: string;
  defaultExecutor: string;
  appearance: AppearanceMode;
  reducedMotion: boolean;
  language: DesktopSettingsLanguage;
  pinnedProjectIds: string[];
  readNotificationIds: string[];
  notifications: Partial<DesktopUiSettings["notifications"]>;
  execution: Partial<DesktopUiSettings["execution"]>;
  windowMaterial: Partial<DesktopUiSettings["windowMaterial"]>;
  layout: Partial<{
    leftSidebar: Partial<DesktopUiSettings["layout"]["leftSidebar"]>;
    rightSidebar: Partial<DesktopUiSettings["layout"]["rightSidebar"]>;
    autoRunControl: Partial<DesktopUiSettings["layout"]["autoRunControl"]>;
  }>;
  review: Partial<DesktopUiSettings["review"]>;
  palette: Partial<{
    visible: Partial<Record<PaletteComponentKey, boolean>>;
    defaultBlockSet: BlockType[];
    dragHint: boolean;
  }>;
  agents: Partial<Record<DesktopAgentKind, Partial<DesktopUiSettings["agents"][DesktopAgentKind]>>>;
}>;

export const desktopSettingsKey = "planweave.desktop.settings.v1";
export const legacyDesktopSettingsKey = desktopSettingsKey;
export const legacyDesktopSettingsMigrationMarkerKey = "planweave.desktop.settings.migrated.v1";

export const desktopSettingsInvokeChannels = {
  getDesktopSettings: "planweave-desktop-settings:getDesktopSettings",
  saveDesktopSettings: "planweave-desktop-settings:saveDesktopSettings",
  migrateLegacyDesktopSettings: "planweave-desktop-settings:migrateLegacyDesktopSettings"
} as const;

export type PlanWeaveDesktopSettingsApi = {
  getDesktopSettings: () => Promise<DesktopUiSettings>;
  saveDesktopSettings: (patch: DesktopSettingsPatch) => Promise<DesktopUiSettings>;
  migrateLegacyDesktopSettings: (payload: unknown) => Promise<DesktopUiSettings>;
};

export const desktopSidebarWidthBounds = {
  left: { min: 220, max: 520, defaultValue: 280 },
  right: { min: 240, max: 520, defaultValue: 300 }
} as const;

export const defaultDesktopSettings: DesktopUiSettings = {
  runtimePath: "",
  planweaveHome: "",
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
    tmuxMonitoring: true,
    agentTransport: "cli"
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

export function mergeDesktopSettings(
  current: DesktopUiSettings,
  patch: DesktopSettingsPatch
): DesktopUiSettings {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "system" || value === "light" || value === "dark";
}

function isLanguage(value: unknown): value is DesktopUiSettings["language"] {
  return value === "system" || value === "en" || value === "zh-CN";
}

function isAgentTransport(value: unknown): value is DesktopAgentTransport {
  return value === "cli" || value === "acp";
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function booleanField<T extends Record<string, boolean>>(
  defaults: T,
  source: unknown
): Partial<T> | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  let hasValidField = false;
  const next: Partial<T> = {};
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
  bounds: { min: number; max: number },
  source: unknown
): Partial<DesktopUiSettings["layout"]["leftSidebar"]> | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const next: Partial<DesktopUiSettings["layout"]["leftSidebar"]> = {};
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

function normalizeFloatingControlPosition(
  source: unknown
): FloatingControlPosition | null | undefined {
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

export function normalizeDesktopSettingsPatch(value: unknown): DesktopSettingsPatch {
  if (!isRecord(value)) {
    return {};
  }
  const patch: DesktopSettingsPatch = {};

  if (typeof value.runtimePath === "string") {
    patch.runtimePath = value.runtimePath;
  }
  if (typeof value.planweaveHome === "string") {
    patch.planweaveHome = value.planweaveHome.trim();
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
  if (isRecord(value.execution)) {
    const execution = booleanField(
      { tmuxMonitoring: defaultDesktopSettings.execution.tmuxMonitoring },
      value.execution
    );
    const agentTransport = isAgentTransport(value.execution.agentTransport)
      ? value.execution.agentTransport
      : undefined;
    if (execution || agentTransport) {
      patch.execution = {
        ...execution,
        ...(agentTransport ? { agentTransport } : {})
      };
    }
  }
  const windowMaterial = booleanField(defaultDesktopSettings.windowMaterial, value.windowMaterial);
  if (windowMaterial) {
    patch.windowMaterial = windowMaterial;
  }

  if (isRecord(value.layout)) {
    const leftSidebar = normalizeSidebarLayout(
      desktopSidebarWidthBounds.left,
      value.layout.leftSidebar
    );
    const rightSidebar = normalizeSidebarLayout(
      desktopSidebarWidthBounds.right,
      value.layout.rightSidebar
    );
    const autoRunPosition = isRecord(value.layout.autoRunControl)
      ? normalizeFloatingControlPosition(value.layout.autoRunControl.position)
      : undefined;
    if (leftSidebar || rightSidebar || autoRunPosition !== undefined) {
      patch.layout = {};
      if (leftSidebar) {
        patch.layout.leftSidebar = leftSidebar;
      }
      if (rightSidebar) {
        patch.layout.rightSidebar = rightSidebar;
      }
      if (autoRunPosition !== undefined) {
        patch.layout.autoRunControl = { position: autoRunPosition };
      }
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
      value.palette.defaultBlockSet.every(
        (item): item is BlockType => item === "implementation" || item === "review"
      )
        ? value.palette.defaultBlockSet
        : undefined;
    if (visible || defaultBlockSet || typeof value.palette.dragHint === "boolean") {
      patch.palette = {};
      if (visible) {
        patch.palette.visible = visible;
      }
      if (defaultBlockSet) {
        patch.palette.defaultBlockSet = defaultBlockSet;
      }
      if (typeof value.palette.dragHint === "boolean") {
        patch.palette.dragHint = value.palette.dragHint;
      }
    }
  }

  if (isRecord(value.agents)) {
    const agents: DesktopSettingsPatch["agents"] = {};
    let hasValidAgent = false;
    for (const kind of Object.keys(defaultDesktopSettings.agents) as Array<
      keyof DesktopUiSettings["agents"]
    >) {
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

export function normalizeDesktopSettings(value: unknown): DesktopUiSettings {
  return mergeDesktopSettings(defaultDesktopSettings, normalizeDesktopSettingsPatch(value));
}

export function parseLegacyDesktopSettingsPayload(payload: unknown): unknown {
  if (typeof payload !== "string") {
    return payload;
  }
  return JSON.parse(payload) as unknown;
}

export function normalizeLegacyDesktopSettingsPayload(payload: unknown): DesktopUiSettings {
  return normalizeDesktopSettings(parseLegacyDesktopSettingsPayload(payload));
}

export function visibleBlockSet(settings: DesktopUiSettings): BlockType[] {
  const configured = settings.palette.defaultBlockSet.filter(
    (type): type is BlockType =>
      (["implementation", "review"] as BlockType[]).includes(type) && settings.palette.visible[type]
  );
  return configured.length > 0 ? configured : ["implementation"];
}
