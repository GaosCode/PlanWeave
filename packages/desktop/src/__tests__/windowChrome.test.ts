import { describe, expect, it } from "vitest";
import { windowChromeOptions } from "../main/windowChrome";

describe("desktop window chrome", () => {
  it("integrates macOS traffic lights into the app title bar", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 }
    });
  });

  it.each([
    "win32",
    "linux"
  ] as const)("uses native %s window controls and hides the application menu by default", (platform) => {
    expect(windowChromeOptions(platform)).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: "default"
    });
  });
});
