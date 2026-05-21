import type { DesktopBridgeApi } from "@planweave/runtime";

export const bridge: DesktopBridgeApi | null = typeof window !== "undefined" && "planweave" in window ? window.planweave : null;
