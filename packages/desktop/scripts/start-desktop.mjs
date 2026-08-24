#!/usr/bin/env node
import { resolve } from "node:path";
import electronPath from "electron";
import { createDesktopDevelopmentLaunchEnvironment } from "./desktop-launch-environment.mjs";
import { startDesktopChild } from "./desktop-launch-process.mjs";
import { desktopPackageRoot } from "./electron-build.mjs";

startDesktopChild({
  command: electronPath,
  args: [resolve(desktopPackageRoot, "dist", "main", "main.js")],
  options: {
    cwd: desktopPackageRoot,
    env: createDesktopDevelopmentLaunchEnvironment(),
    stdio: "inherit"
  }
});
