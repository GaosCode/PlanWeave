import { app, BrowserWindow, safeStorage } from "electron";
import { shutdownDesktopAutoRuns } from "@planweave-ai/runtime";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerApplicationMenu } from "./appMenu.js";
import { configureDesktopAgentShellEnvironment } from "./agentShellEnvironment.js";
import { checkForAppUpdate, registerAppUpdateHandlers } from "./appUpdate.js";
import {
  autoStartMcpTunnel,
  registerMcpTunnelHandlers,
  stopMcpTunnelProcesses
} from "./mcpTunnel/mcpTunnelHandlers.js";
import {
  registerCollaborationHandlers,
  shutdownCollaborationHandlers
} from "./collaboration/collaborationHandlers.js";
import {
  registerOperatorControlHandlers,
  shutdownOperatorControlService
} from "./operatorControl/operatorControlHandlers.js";
import { registerDesktopSettingsHandlers } from "./desktopSettingsHandlers.js";
import { applyPersistedPlanweaveHomeSetting } from "./desktopSettingsStore.js";
import { initializeFirstLaunchExample } from "./firstLaunchExample.js";
import { registerPackageWatchHandlers } from "./packageWatch.js";
import { registerRuntimeBridgeHandlers } from "./runtimeBridgeHandlers.js";
import { registerWorkspaceExecutionHandlers } from "./workspaceExecutionHandlers.js";
import { registerRuntimeStateWatchHandlers } from "./runtimeStateWatch.js";
import { registerWindowAppearanceHandlers } from "./windowAppearance.js";
import { createWindow } from "./window.js";
import { runPackagedStartupSmoke } from "./smoke.js";
import { startSingleInstanceLifecycle } from "./singleInstanceLifecycle.js";
import { runDesktopAgentHostServiceMode } from "./desktopAgentHostServiceMode.js";
import { createDesktopShutdownController } from "./appShutdown.js";
import {
  selectDesktopCredentialStorage,
  type DesktopCredentialStorage
} from "./credentialStorage/applicationCredentialStorage.js";
import { CredentialStoragePreferenceStore } from "./credentialStorage/credentialStoragePreferenceStore.js";
import { credentialStoragePaths } from "./credentialStorage/credentialStoragePaths.js";
import { registerCredentialStorageSettingsHandlers } from "./credentialStorage/credentialStorageSettingsHandlers.js";
import { migrateCredentialStorage } from "./credentialStorage/credentialStorageMigration.js";
import { mcpTunnelConfigStorePaths } from "./mcpTunnel/tunnelClientStore.js";
import type { CredentialStorageMode } from "../shared/credentialStorageSettings.js";

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

async function loadFirstLaunchExample(): Promise<void> {
  if (!app.isPackaged || isSmokeRun) {
    return;
  }
  try {
    await initializeFirstLaunchExample({
      userDataDir: app.getPath("userData"),
      examplePackageDir: join(process.resourcesPath, "planweave-example-package")
    });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    console.error(`Could not load the first-launch example: ${diagnostic}`);
  }
}

async function loadDesktopAgentShellEnvironment(): Promise<void> {
  if (!app.isPackaged || isSmokeRun || process.platform === "win32") return;
  const result = await configureDesktopAgentShellEnvironment();
  if (result.kind === "unavailable") {
    console.warn(result.reason);
  }
}

function startDesktopApplication(): void {
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

  const preferencePaths = credentialStoragePaths("application");
  const credentialStoragePreferenceStore = new CredentialStoragePreferenceStore(
    preferencePaths.preferenceFile
  );
  const activeCredentialStorageMode = credentialStoragePreferenceStore.readSync().mode;
  const activeCredentialPaths = credentialStoragePaths(activeCredentialStorageMode);
  const systemCredentialStorage: DesktopCredentialStorage = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value)
  };
  const credentialStorage = selectDesktopCredentialStorage({
    mode: activeCredentialStorageMode,
    applicationKeyPath: activeCredentialPaths.applicationKeyFile,
    systemStorage: systemCredentialStorage
  });
  const credentialStorageForMode = (mode: CredentialStorageMode): DesktopCredentialStorage =>
    selectDesktopCredentialStorage({
      mode,
      applicationKeyPath: credentialStoragePaths(mode).applicationKeyFile,
      systemStorage: systemCredentialStorage
    });

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
      registerCredentialStorageSettingsHandlers({
        store: credentialStoragePreferenceStore,
        activeMode: activeCredentialStorageMode,
        migration: {
          migrate: (targetMode) =>
            migrateCredentialStorage({
              sourceMode: activeCredentialStorageMode,
              targetMode,
              sourcePaths: activeCredentialPaths,
              targetPaths: credentialStoragePaths(targetMode),
              sourceStorage: credentialStorage,
              targetStorage: credentialStorageForMode(targetMode),
              mcpTunnelPaths: mcpTunnelConfigStorePaths(app.getPath("userData"))
            })
        }
      });
      registerMcpTunnelHandlers({
        credentialStorage,
        credentialStorageMode: activeCredentialStorageMode
      });
      registerOperatorControlHandlers({
        safeStorage: credentialStorage,
        credentialsPath: activeCredentialPaths.operatorCredentialsFile
      });
      const collaboration = registerCollaborationHandlers({
        safeStorage: credentialStorage,
        credentialsPath: activeCredentialPaths.collaborationCredentialsFile,
        invitationsPath: activeCredentialPaths.collaborationInvitationsFile,
        coordinatorCredentialsPath: activeCredentialPaths.coordinatorCredentialsFile
      });
      registerWorkspaceExecutionHandlers({ collaboration });
      registerApplicationMenu({ checkForUpdates: checkForAppUpdate });

      app.whenReady().then(() => {
        void (async () => {
          await loadDesktopAgentShellEnvironment();
          await loadFirstLaunchExample();
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
              console.error(
                reportError instanceof Error ? reportError.message : String(reportError)
              );
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

      const shutdownController = createDesktopShutdownController({
        closeRendererWindows: () => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.destroy();
          }
        },
        cleanupTasks: [
          stopMcpTunnelProcesses,
          async () => {
            await shutdownCollaborationHandlers();
            await shutdownOperatorControlService();
          },
          () => shutdownDesktopAutoRuns("PlanWeave Desktop is quitting.")
        ],
        reportError: (error) => {
          console.error(error instanceof Error ? error.message : String(error));
        },
        requestQuit: () => app.quit()
      });
      app.on("before-quit", (event) => shutdownController.handleBeforeQuit(event));

      app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
          app.quit();
        }
      });
    }
  });
}

const agentHostServiceExitCode = await runDesktopAgentHostServiceMode(process.argv);
if (agentHostServiceExitCode === null) {
  startDesktopApplication();
} else {
  app.exit(agentHostServiceExitCode);
}
