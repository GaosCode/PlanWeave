import { defaultDesktopSettings } from "../shared/desktopSettings";
import type { DesktopUiSettings } from "./types";

export {
  defaultDesktopSettings,
  desktopSettingsKey,
  desktopSidebarWidthBounds,
  legacyDesktopSettingsKey,
  mergeDesktopSettings,
  normalizeDesktopSettings,
  normalizeDesktopSettingsPatch,
  normalizeLegacyDesktopSettingsPayload,
  parseLegacyDesktopSettingsPayload,
  visibleBlockSet
} from "../shared/desktopSettings";

export function orderProjectsByPinnedIds<T extends { projectId: string }>(
  projects: T[],
  pinnedProjectIds: string[]
): T[] {
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
  return defaultDesktopSettings;
}
