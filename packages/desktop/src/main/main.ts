import { app, BrowserWindow } from "electron";
import { registerApplicationMenu } from "./appMenu.js";
import { checkForAppUpdate, registerAppUpdateHandlers } from "./appUpdate.js";
import { autoStartMcpTunnel, registerMcpTunnelHandlers, stopMcpTunnelProcesses } from "./mcpTunnel/mcpTunnelHandlers.js";
import { registerGitIntegrationHandlers } from "./gitIntegrationHandlers.js";
import { registerDesktopSettingsHandlers } from "./desktopSettingsHandlers.js";
import { applyPersistedPlanweaveHomeSetting } from "./desktopSettingsStore.js";
import { registerPackageWatchHandlers } from "./packageWatch.js";
import { registerRemoteBridgeHandlers } from "./remoteBridgeHandlers.js";
import { stopLocalTeamHost } from "./localTeamHost.js";
import { registerRuntimeBridgeHandlers } from "./runtimeBridgeHandlers.js";
import { registerRuntimeStateWatchHandlers } from "./runtimeStateWatch.js";
import { registerWindowAppearanceHandlers } from "./windowAppearance.js";
import { createWindow } from "./window.js";

const isDev = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL !== undefined;
const isSmoke = process.env.PLANWEAVE_DESKTOP_SMOKE === "1";
const isStartupSmoke = process.env.PLANWEAVE_DESKTOP_STARTUP_SMOKE === "1";
const isSmokeRun = isSmoke || isStartupSmoke;

// Packaged app launches can inherit shell env from development tools; source runs still need PLANWEAVE_HOME for isolated demos and tests.
if (app.isPackaged && !isDev && !isSmokeRun) {
  delete process.env.PLANWEAVE_HOME;
}

const planweaveHomeBaseline = process.env.PLANWEAVE_HOME;
const planweaveHomeBaselineForSettingsStore = planweaveHomeBaseline ?? null;

try {
  applyPersistedPlanweaveHomeSetting(undefined, planweaveHomeBaseline);
} catch (caught) {
  console.error(caught instanceof Error ? caught.message : String(caught));
}

if (isSmokeRun && process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR) {
  app.setPath("userData", process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR);
}

registerRuntimeBridgeHandlers();
registerRemoteBridgeHandlers();
registerDesktopSettingsHandlers(undefined, { planweaveHomeBaseline: planweaveHomeBaselineForSettingsStore });
registerPackageWatchHandlers();
registerRuntimeStateWatchHandlers();
registerWindowAppearanceHandlers();
registerAppUpdateHandlers();
registerMcpTunnelHandlers();
registerGitIntegrationHandlers();
registerApplicationMenu({ checkForUpdates: checkForAppUpdate });

app.whenReady().then(() => {
  void (async () => {
    await createWindow({ isDev, isSmoke, isStartupSmoke });
    if (isStartupSmoke) {
      console.log(JSON.stringify({ event: "PLANWEAVE_DESKTOP_STARTUP_SMOKE_READY" }));
      app.exit(0);
      return;
    }
    void autoStartMcpTunnel();
    if (app.isPackaged && !isSmokeRun) {
      void checkForAppUpdate();
    }
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow({ isDev, isSmoke, isStartupSmoke });
  }
});

let mcpTunnelCleanupComplete = false;
app.on("before-quit", (event) => {
  if (mcpTunnelCleanupComplete) {
    return;
  }
  event.preventDefault();
  void Promise.all([stopMcpTunnelProcesses(), stopLocalTeamHost()]).finally(() => {
    mcpTunnelCleanupComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
