import { ipcRenderer } from "electron";
import { unwrapDesktopCommandFailure } from "../shared/desktopCommandFailure.js";

export async function invokeDesktopCommand(...args: Parameters<typeof ipcRenderer.invoke>) {
  const result = await ipcRenderer.invoke(...args);
  unwrapDesktopCommandFailure(result);
  return result;
}
