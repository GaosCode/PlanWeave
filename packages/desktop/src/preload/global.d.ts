import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { PlanWeaveAppUpdateApi } from "../shared/appUpdate";
import type { PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel";
import type { PlanWeaveWindowApi } from "../shared/windowAppearance";

declare global {
  interface Window {
    planweave: DesktopBridgeApi;
    planweaveAppUpdate?: PlanWeaveAppUpdateApi;
    planweaveMcpTunnel?: PlanWeaveMcpTunnelApi;
    planweaveWindow?: PlanWeaveWindowApi;
  }
}

export {};
