import { app, BrowserWindow } from "electron";
import { registerApplicationMenu } from "./appMenu.js";
import { checkForAppUpdate, registerAppUpdateHandlers } from "./appUpdate.js";
import { registerMcpTunnelHandlers, stopMcpTunnelProcesses } from "./mcpTunnel/mcpTunnelHandlers.js";
import { registerPackageWatchHandlers } from "./packageWatch.js";
import { registerRuntimeBridgeHandlers } from "./runtimeBridgeHandlers.js";
import { registerWindowAppearanceHandlers } from "./windowAppearance.js";
import { createWindow } from "./window.js";

const isDev = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL !== undefined;
const isSmoke = process.env.PLANWEAVE_DESKTOP_SMOKE === "1";

// Production app launches can inherit shell env from development tools; keep PLANWEAVE_HOME scoped to dev and smoke runs.
if (!isDev && !isSmoke) {
  delete process.env.PLANWEAVE_HOME;
}

if (isSmoke && process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR) {
  app.setPath("userData", process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR);
}

registerRuntimeBridgeHandlers();
registerPackageWatchHandlers();
registerWindowAppearanceHandlers();
registerAppUpdateHandlers();
registerMcpTunnelHandlers();
registerApplicationMenu({ checkForUpdates: checkForAppUpdate });

app.whenReady().then(() => {
  void (async () => {
    await createWindow({ isDev, isSmoke });
    if (app.isPackaged) {
      void checkForAppUpdate();
    }
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow({ isDev, isSmoke });
  }
});

let mcpTunnelCleanupComplete = false;
app.on("before-quit", (event) => {
  if (mcpTunnelCleanupComplete) {
    return;
  }
  event.preventDefault();
  void stopMcpTunnelProcesses().finally(() => {
    mcpTunnelCleanupComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
