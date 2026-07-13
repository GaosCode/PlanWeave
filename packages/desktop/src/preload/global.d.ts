import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { PlanWeaveAppUpdateApi } from "../shared/appUpdate";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";
import type { PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel";
import type { PlanWeaveRemoteApi } from "../shared/remoteTypes";
import type { PlanWeaveWindowApi } from "../shared/windowAppearance";
import type { PlanWeaveGitIntegrationApi } from "../shared/gitIntegration";

declare global {
  interface Window {
    planweave: DesktopBridgeApi;
    planweaveAppUpdate?: PlanWeaveAppUpdateApi;
    planweaveDesktopSettings?: PlanWeaveDesktopSettingsApi;
    planweaveMcpTunnel?: PlanWeaveMcpTunnelApi;
    planweaveRemote?: PlanWeaveRemoteApi;
    planweaveWindow?: PlanWeaveWindowApi;
    planweaveGitIntegration?: PlanWeaveGitIntegrationApi;
  }
}

export {};
