import { resolve } from "node:path";
import type { DesktopWatchRegistration } from "@planweave-ai/runtime";

export function desktopWatchBackendKey(registration: DesktopWatchRegistration): string {
  return JSON.stringify([
    resolve(registration.projectRoot),
    resolve(registration.workspaceRoot),
    registration.canvasId ?? null
  ]);
}

export function desktopWatchSubscriberKey(senderId: number, registrationId: string): string {
  return JSON.stringify([senderId, registrationId]);
}
