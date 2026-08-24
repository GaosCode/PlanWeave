import { resolve } from "node:path";
import { desktopPackageRoot } from "./electron-build.mjs";

const agentHostCliPath = resolve(desktopPackageRoot, "..", "agent-host", "dist", "bin.js");

export function createDesktopDevelopmentLaunchEnvironment(rendererUrl) {
  const environment = {
    ...process.env,
    PLANWEAVE_DESKTOP_NODE_EXECUTABLE: process.execPath,
    PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH: agentHostCliPath
  };
  if (rendererUrl) environment.PLANWEAVE_DESKTOP_DEV_SERVER_URL = rendererUrl;
  return environment;
}
