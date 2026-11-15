import { access } from "node:fs/promises";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  desktopAgentHostChangedChannel,
  desktopSettingsInvokeChannels,
  normalizeDesktopSettingsPatch,
  type DesktopAgentHost
} from "../shared/desktopSettings.js";
import { DesktopSettingsStore } from "./desktopSettingsStore.js";
import {
  assertDesktopInspectorHomeCurrent,
  captureDesktopInspectorHome,
  isDesktopInspectorHomeCurrent
} from "./desktopInspectorHome.js";

function broadcastAgentHost(agentHost: DesktopAgentHost): void {
  for (const { webContents } of BrowserWindow.getAllWindows()) {
    if (!webContents.isDestroyed() && isDesktopInspectorHomeCurrent(webContents)) {
      webContents.send(desktopAgentHostChangedChannel, agentHost);
    }
  }
}

function errorCode(caught: unknown): string | null {
  if (!caught || typeof caught !== "object" || !("code" in caught)) {
    return null;
  }
  const code = (caught as Record<"code", unknown>).code;
  return typeof code === "string" ? code : null;
}

async function settingsFileExists(settingsFile: string): Promise<boolean> {
  try {
    await access(settingsFile);
    return true;
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") {
      return false;
    }
    throw caught;
  }
}

type RegisterDesktopSettingsHandlersOptions = {
  planweaveHomeBaseline?: string | null | undefined;
};

export function registerDesktopSettingsHandlers(
  store: DesktopSettingsStore | undefined = undefined,
  options: RegisterDesktopSettingsHandlersOptions = {}
): void {
  const settingsStore =
    store ?? new DesktopSettingsStore({ planweaveHomeBaseline: options.planweaveHomeBaseline });
  let queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue
      .catch(() => undefined)
      .then(operation)
      .then((result) => {
        captureDesktopInspectorHome();
        return result;
      });
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
  const enqueueWrite = <T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<T> => {
    assertDesktopInspectorHomeCurrent(event.sender);
    return enqueue(() => {
      assertDesktopInspectorHomeCurrent(event.sender);
      return operation();
    });
  };

  ipcMain.handle(desktopSettingsInvokeChannels.getDesktopSettings, () =>
    enqueue(() => settingsStore.read())
  );
  ipcMain.handle(desktopSettingsInvokeChannels.saveDesktopSettings, (event, patch: unknown) =>
    enqueueWrite(event, async () => {
      const normalized = normalizeDesktopSettingsPatch(patch);
      const saved = await settingsStore.mergePatch(normalized);
      if (normalized.execution?.agentHost) broadcastAgentHost(saved.execution.agentHost);
      return saved;
    })
  );
  ipcMain.handle(
    desktopSettingsInvokeChannels.migrateLegacyDesktopSettings,
    (event, payload: unknown) =>
      enqueueWrite(event, async () => {
        if (await settingsFileExists(settingsStore.settingsFile)) {
          return settingsStore.read();
        }
        const saved = await settingsStore.migrateLegacy(payload);
        broadcastAgentHost(saved.execution.agentHost);
        return saved;
      })
  );
}
