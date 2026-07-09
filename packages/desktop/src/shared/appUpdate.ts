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

/**
 * How the user obtains an update once one is available.
 * - `in-app`: electron-updater download + quitAndInstall (Windows/Linux, and signed macOS).
 * - `github-releases`: open GitHub Releases only — unsigned macOS cannot complete in-app install.
 */
export type AppUpdateDelivery = "in-app" | "github-releases";

export const PLANWEAVE_DESKTOP_RELEASES_URL =
  "https://github.com/GaosCode/PlanWeave/releases/latest";

/**
 * Resolve whether this process may promise in-app install.
 * macOS defaults to external Releases until a signed channel sets PLANWEAVE_DESKTOP_CODE_SIGNED=1.
 */
export function resolveAppUpdateDelivery(options: {
  platform: NodeJS.Platform;
  codeSigned: boolean;
}): AppUpdateDelivery {
  if (options.platform === "darwin" && !options.codeSigned) {
    return "github-releases";
  }
  return "in-app";
}

export type AppUpdateState =
  | {
      status: "idle" | "checking" | "not-available";
      checkedAt: string | null;
      currentVersion: string;
      delivery: AppUpdateDelivery;
      error: null;
      progress: null;
      update: AppUpdateInfo | null;
      updatedAt: string;
    }
  | {
      status: "available" | "downloaded";
      checkedAt: string | null;
      currentVersion: string;
      delivery: AppUpdateDelivery;
      error: null;
      progress: null;
      update: AppUpdateInfo;
      updatedAt: string;
    }
  | {
      status: "downloading";
      checkedAt: string | null;
      currentVersion: string;
      delivery: AppUpdateDelivery;
      error: null;
      progress: AppUpdateProgress;
      update: AppUpdateInfo;
      updatedAt: string;
    }
  | {
      status: "error" | "unsupported";
      checkedAt: string | null;
      currentVersion: string;
      delivery: AppUpdateDelivery;
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
