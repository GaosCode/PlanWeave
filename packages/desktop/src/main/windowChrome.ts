import type { BrowserWindowConstructorOptions } from "electron";

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "titleBarStyle" | "trafficLightPosition"
>;

export function windowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 }
    };
  }

  return {
    autoHideMenuBar: true,
    titleBarStyle: "default"
  };
}
