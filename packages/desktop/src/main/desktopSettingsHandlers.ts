import { access } from "node:fs/promises";
import { ipcMain } from "electron";
import { desktopSettingsInvokeChannels, normalizeDesktopSettingsPatch } from "../shared/desktopSettings.js";
import { DesktopSettingsStore } from "./desktopSettingsStore.js";

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

export function registerDesktopSettingsHandlers(store = new DesktopSettingsStore()): void {
  let queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(operation);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  ipcMain.handle(desktopSettingsInvokeChannels.getDesktopSettings, () => enqueue(() => store.read()));
  ipcMain.handle(desktopSettingsInvokeChannels.saveDesktopSettings, (_event, patch: unknown) =>
    enqueue(() => store.mergePatch(normalizeDesktopSettingsPatch(patch)))
  );
  ipcMain.handle(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings, (_event, payload: unknown) =>
    enqueue(async () => {
      if (await settingsFileExists(store.settingsFile)) {
        return store.read();
      }
      return store.migrateLegacy(payload);
    })
  );
}
