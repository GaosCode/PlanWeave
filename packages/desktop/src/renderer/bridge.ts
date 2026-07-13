import type { DesktopBridgeApi, DesktopCanvasReference, DesktopProjectSummary } from "@planweave-ai/runtime";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";
import type { PlanWeaveRemoteApi } from "../shared/remoteTypes";

export const bridge: DesktopBridgeApi | null = typeof window !== "undefined" && "planweave" in window ? window.planweave : null;
export const settingsBridge: PlanWeaveDesktopSettingsApi | null =
  typeof window !== "undefined" && "planweaveDesktopSettings" in window ? window.planweaveDesktopSettings ?? null : null;
export const remoteBridge: PlanWeaveRemoteApi | null =
  typeof window !== "undefined" && "planweaveRemote" in window ? window.planweaveRemote ?? null : null;

export function desktopCanvasReference(project: DesktopProjectSummary, canvasId?: string | null): DesktopCanvasReference {
  return {
    projectRoot: project.rootPath,
    canvasId
  };
}
