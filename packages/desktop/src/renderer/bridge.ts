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
  typeof window !== "undefined" && "planweave" in window ? window.planweave : null;
export const settingsBridge: PlanWeaveDesktopSettingsApi | null =
  typeof window !== "undefined" && "planweaveDesktopSettings" in window
    ? (window.planweaveDesktopSettings ?? null)
    : null;
export const credentialStorageSettingsBridge: PlanWeaveCredentialStorageSettingsApi | null =
  typeof window !== "undefined" && "planweaveCredentialStorageSettings" in window
    ? (window.planweaveCredentialStorageSettings ?? null)
    : null;
export const collaborationBridge: PlanWeaveCollaborationApi | null =
  typeof window !== "undefined" && "planweaveCollaboration" in window
    ? (window.planweaveCollaboration ?? null)
    : null;
export const operatorControlBridge: PlanWeaveOperatorControlApi | null =
  typeof window !== "undefined" && "planweaveOperatorControl" in window
    ? (window.planweaveOperatorControl ?? null)
    : null;
export const workspaceExecutionBridge: PlanWeaveWorkspaceExecutionApi | null =
  typeof window !== "undefined" && "planweaveWorkspaceExecution" in window
    ? (window.planweaveWorkspaceExecution ?? null)
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
