export type WindowMaterialSettings = {
  enabled: boolean;
  appearance: "system" | "light" | "dark";
};

export type WindowMaterialCapabilities = {
  supported: boolean;
  platform: string;
  reason: "supported" | "unsupported-platform" | "missing-electron-api";
};

export const windowAppearanceInvokeChannels = {
  getWindowMaterialCapabilities: "planweave-window:getWindowMaterialCapabilities",
  setWindowMaterial: "planweave-window:setWindowMaterial"
} as const;

export type PlanWeaveWindowApi = {
  getWindowMaterialCapabilities: () => Promise<WindowMaterialCapabilities>;
  setWindowMaterial: (settings: WindowMaterialSettings) => Promise<void>;
};
