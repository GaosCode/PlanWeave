export type AppUpdateInfo = {
  version: string;
  releaseDate?: string | null;
  releaseName?: string | null;
};

export type AppUpdateProgress = {
  bytesPerSecond: number;
  percent: number;
  total: number;
  transferred: number;
};

export type AppUpdateState =
  | {
      status: "idle" | "checking" | "not-available";
      checkedAt: string | null;
      currentVersion: string;
      error: null;
      progress: null;
      update: AppUpdateInfo | null;
      updatedAt: string;
    }
  | {
      status: "available" | "downloaded";
      checkedAt: string | null;
      currentVersion: string;
      error: null;
      progress: null;
      update: AppUpdateInfo;
      updatedAt: string;
    }
  | {
      status: "downloading";
      checkedAt: string | null;
      currentVersion: string;
      error: null;
      progress: AppUpdateProgress;
      update: AppUpdateInfo;
      updatedAt: string;
    }
  | {
      status: "error" | "unsupported";
      checkedAt: string | null;
      currentVersion: string;
      error: string;
      progress: null;
      update: AppUpdateInfo | null;
      updatedAt: string;
    };

export const appUpdateInvokeChannels = {
  checkForAppUpdate: "planweave-app-update:checkForAppUpdate",
  downloadAppUpdate: "planweave-app-update:downloadAppUpdate",
  getAppUpdateState: "planweave-app-update:getAppUpdateState",
  installAppUpdate: "planweave-app-update:installAppUpdate"
} as const;

export const appUpdateChangedChannel = "planweave-app-update:changed";

export type PlanWeaveAppUpdateApi = {
  checkForAppUpdate: () => Promise<AppUpdateState>;
  downloadAppUpdate: () => Promise<AppUpdateState>;
  getAppUpdateState: () => Promise<AppUpdateState>;
  installAppUpdate: () => Promise<AppUpdateState>;
  onAppUpdateChanged: (callback: (state: AppUpdateState) => void) => () => void;
};
