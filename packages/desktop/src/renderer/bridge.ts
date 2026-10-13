import { desktopCommandBridge } from "./desktopCommandBridge.js";
import type {
  DesktopBridgeApi,
  DesktopCanvasReference,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";
import type { PlanWeaveCredentialStorageSettingsApi } from "../shared/credentialStorageSettings";
import type { PlanWeaveOperatorControlApi } from "../shared/operatorControl";
import type { PlanWeaveWorkspaceExecutionApi } from "../shared/workspaceExecution";

export const bridge: DesktopBridgeApi | null =
  typeof window !== "undefined" && "planweave" in window
    ? desktopCommandBridge(window.planweave)
    : null;
export const settingsBridge: PlanWeaveDesktopSettingsApi | null =
  typeof window !== "undefined" && "planweaveDesktopSettings" in window
    ? window.planweaveDesktopSettings
      ? desktopCommandBridge(window.planweaveDesktopSettings, { homeIndependent: true })
      : null
    : null;
export const credentialStorageSettingsBridge: PlanWeaveCredentialStorageSettingsApi | null =
  typeof window !== "undefined" && "planweaveCredentialStorageSettings" in window
    ? window.planweaveCredentialStorageSettings
      ? desktopCommandBridge(window.planweaveCredentialStorageSettings)
      : null
    : null;
export const collaborationBridge: PlanWeaveCollaborationApi | null =
  typeof window !== "undefined" && "planweaveCollaboration" in window
    ? window.planweaveCollaboration
      ? desktopCommandBridge(window.planweaveCollaboration)
      : null
    : null;
export const operatorControlBridge: PlanWeaveOperatorControlApi | null =
  typeof window !== "undefined" && "planweaveOperatorControl" in window
    ? window.planweaveOperatorControl
      ? desktopCommandBridge(window.planweaveOperatorControl)
      : null
    : null;
export const workspaceExecutionBridge: PlanWeaveWorkspaceExecutionApi | null =
  typeof window !== "undefined" && "planweaveWorkspaceExecution" in window
    ? window.planweaveWorkspaceExecution
      ? desktopCommandBridge(window.planweaveWorkspaceExecution)
      : null
    : null;

export function desktopCanvasReference(
  project: DesktopProjectSummary,
  canvasId?: string | null
): DesktopCanvasReference {
  return {
    projectRoot: project.rootPath,
    canvasId
  };
}
