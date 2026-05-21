import type { DesktopBridgeApi } from "@planweave/runtime";

declare global {
  interface Window {
    planweave: DesktopBridgeApi;
  }
}

export {};
