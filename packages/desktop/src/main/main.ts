import { app, BrowserWindow } from "electron";
import { shutdownDesktopAutoRuns } from "@planweave-ai/runtime";
import { writeFile } from "node:fs/promises";
import { registerApplicationMenu } from "./appMenu.js";
import { checkForAppUpdate, registerAppUpdateHandlers } from "./appUpdate.js";
import {
  autoStartMcpTunnel,
  registerMcpTunnelHandlers,
  stopMcpTunnelProcesses
} from "./mcpTunnel/mcpTunnelHandlers.js";
import { registerDesktopSettingsHandlers } from "./desktopSettingsHandlers.js";
import { applyPersistedPlanweaveHomeSetting } from "./desktopSettingsStore.js";
import { registerPackageWatchHandlers } from "./packageWatch.js";
import { registerRuntimeBridgeHandlers } from "./runtimeBridgeHandlers.js";
import { registerRuntimeStateWatchHandlers } from "./runtimeStateWatch.js";
import { registerWindowAppearanceHandlers } from "./windowAppearance.js";
import { createWindow } from "./window.js";
import { runPackagedStartupSmoke } from "./smoke.js";
import { startSingleInstanceLifecycle } from "./singleInstanceLifecycle.js";

const isDev = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL !== undefined;
const isSmoke = process.env.PLANWEAVE_DESKTOP_SMOKE === "1";
const isStartupSmoke = process.env.PLANWEAVE_DESKTOP_STARTUP_SMOKE === "1";
const isSmokeRun = isSmoke || isStartupSmoke;
const startupSmokeErrorEvent = "PLANWEAVE_DESKTOP_STARTUP_SMOKE_ERROR";

async function writeStartupSmokeReport(payload: unknown): Promise<void> {
  const reportPath = process.env.PLANWEAVE_DESKTOP_STARTUP_SMOKE_REPORT_PATH;
  if (!reportPath) {
    throw new Error("Packaged startup smoke report path is required.");
  }
  await writeFile(reportPath, `${JSON.stringify(payload)}\n`, "utf8");
}

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

// Single Desktop main process per userData profile. Runtime locks still protect
// independent writers, while this keeps Desktop handlers and windows primary-only.
startSingleInstanceLifecycle({
  requestLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  onSecondInstance: (listener) => app.on("second-instance", listener),
  getPrimaryWindow: () => BrowserWindow.getAllWindows()[0],
  startPrimary: () => {
    registerRuntimeBridgeHandlers();
    registerDesktopSettingsHandlers(undefined, {
      planweaveHomeBaseline: planweaveHomeBaselineForSettingsStore
    });
    registerPackageWatchHandlers();
    registerRuntimeStateWatchHandlers();
    registerWindowAppearanceHandlers();
    registerAppUpdateHandlers();
    registerMcpTunnelHandlers();
    registerApplicationMenu({ checkForUpdates: checkForAppUpdate });

    app.whenReady().then(() => {
      void (async () => {
        const window = await createWindow({ isDev, isSmoke, isStartupSmoke });
        if (isStartupSmoke) {
          const result = await runPackagedStartupSmoke(window);
          await writeStartupSmokeReport(result);
          console.log(JSON.stringify(result));
          return;
        }
        void autoStartMcpTunnel();
        if (app.isPackaged && !isSmokeRun) {
          void checkForAppUpdate();
        }
      })().catch(async (error: unknown) => {
        const diagnostic = error instanceof Error ? error.message : String(error);
        if (isStartupSmoke) {
          try {
            await writeStartupSmokeReport({ event: startupSmokeErrorEvent, diagnostic });
          } catch (reportError) {
            console.error(reportError instanceof Error ? reportError.message : String(reportError));
          }
        }
        console.error(diagnostic);
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
      void Promise.allSettled([
        stopMcpTunnelProcesses(),
        shutdownDesktopAutoRuns("PlanWeave Desktop is quitting.")
      ])
        .then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              console.error(
                result.reason instanceof Error ? result.reason.message : String(result.reason)
              );
            }
          }
        })
        .finally(() => {
          mcpTunnelCleanupComplete = true;
          app.quit();
        });
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  }
});
