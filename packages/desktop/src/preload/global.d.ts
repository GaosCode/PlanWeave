import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { PlanWeaveWindowApi } from "../shared/windowAppearance";

declare global {
  interface Window {
    planweave: DesktopBridgeApi;
    planweaveWindow?: PlanWeaveWindowApi;
  }
}

export {};
