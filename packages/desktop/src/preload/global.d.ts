import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { PlanWeaveCliInstallationApi } from "../shared/cliInstallation";
import type { CollaborationCaptureApi } from "../shared/collaborationCapture";
import type { PlanWeaveAppUpdateApi } from "../shared/appUpdate";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";
import type { PlanWeaveCredentialStorageSettingsApi } from "../shared/credentialStorageSettings";
import type { PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel";
import type { PlanWeaveOperatorControlApi } from "../shared/operatorControl";
import type { PlanWeaveWindowApi } from "../shared/windowAppearance";
import type { PlanWeaveWorkspaceExecutionPreloadApi } from "../shared/workspaceExecution";

declare global {
  interface Window {
    planweave: DesktopBridgeApi;
    planweaveCliInstallation?: PlanWeaveCliInstallationApi;
    planweaveAppUpdate?: PlanWeaveAppUpdateApi;
    planweaveCollaboration?: PlanWeaveCollaborationApi;
    planweaveCollaborationCapture?: CollaborationCaptureApi;
    planweaveDesktopSettings?: PlanWeaveDesktopSettingsApi;
    planweaveCredentialStorageSettings?: PlanWeaveCredentialStorageSettingsApi;
    planweaveMcpTunnel?: PlanWeaveMcpTunnelApi;
    planweaveOperatorControl?: PlanWeaveOperatorControlApi;
    planweaveWindow?: PlanWeaveWindowApi;
    planweaveWorkspaceExecution?: PlanWeaveWorkspaceExecutionPreloadApi;
  }
}

export {};
