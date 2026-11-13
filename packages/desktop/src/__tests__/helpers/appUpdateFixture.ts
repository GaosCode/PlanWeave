import { vi } from "vitest";
import type { AppUpdateState, PlanWeaveAppUpdateApi } from "../../shared/appUpdate";

const update = { version: "0.6.0" };
export const idle: AppUpdateState = {
  status: "idle",
  checkedAt: null,
  currentVersion: "0.5.0",
  delivery: "in-app",
  error: null,
  progress: null,
  update: null,
  updatedAt: "2026-11-13T00:00:00.000Z"
};
export const available: AppUpdateState = { ...idle, status: "available", update };
export const downloading: AppUpdateState = {
  ...idle,
  status: "downloading",
  progress: { bytesPerSecond: 1024, percent: 42, total: 100, transferred: 42 },
  update,
  updatedAt: "2026-11-13T00:00:00.001Z"
};
export const downloaded: AppUpdateState = {
  ...available,
  status: "downloaded",
  updatedAt: "2026-11-13T00:00:00.002Z"
};

export function updateBridge(initial: AppUpdateState) {
  const listeners = new Set<(state: AppUpdateState) => void>();
  let current = initial;
  const bridge = {
    checkForAppUpdate: vi.fn<PlanWeaveAppUpdateApi["checkForAppUpdate"]>(async () => current),
    downloadAppUpdate: vi.fn<PlanWeaveAppUpdateApi["downloadAppUpdate"]>(async () => current),
    getAppUpdateState: vi.fn<PlanWeaveAppUpdateApi["getAppUpdateState"]>(async () => current),
    installAppUpdate: vi.fn<PlanWeaveAppUpdateApi["installAppUpdate"]>(async () => current),
    onAppUpdateChanged: (listener: (state: AppUpdateState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  } satisfies PlanWeaveAppUpdateApi;
  vi.stubGlobal("planweaveAppUpdate", bridge);
  return {
    ...bridge,
    publish(state: AppUpdateState) {
      current = state;
      for (const listener of listeners) listener(state);
    }
  };
}
