import { expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
const handle = vi.hoisted(() => vi.fn());
const recordDesktopError = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("electron", () => ({ ipcMain: { handle } }));
vi.mock("../main/desktopDiagnosticsLog.js", () => ({
  recordDesktopError,
  redactDiagnostic: (text: string) => text
}));
import { handleDesktopCommand } from "../main/desktopCommandHandler.js";
import { unwrapDesktopCommandFailure } from "../shared/desktopCommandFailure.js";
it("transports a classified failure without throwing inside Electron's handler and logs it once", async () => {
  const error = Object.assign(new Error("Server unreachable"), {
    kind: "offline",
    code: "SERVER_UNREACHABLE",
    retryable: true
  });
  handleDesktopCommand("workspace.select", async () => {
    throw error;
  });
  const handler: (event: Partial<IpcMainInvokeEvent>) => Promise<unknown> =
    handle.mock.calls.at(-1)?.[1];
  const value = await handler({});
  expect(value).toMatchObject({
    desktopCommandFailure: true,
    error: { kind: "offline", code: "SERVER_UNREACHABLE", retryable: true }
  });
  expect(() => unwrapDesktopCommandFailure(value)).toThrow("Server unreachable");
  expect(recordDesktopError).toHaveBeenCalledWith("workspace.select", error);
});
it("preserves successful response shapes", async () => {
  handleDesktopCommand("workspace.list", async () => ({ items: ["team"] }));
  const handler: (event: Partial<IpcMainInvokeEvent>) => Promise<unknown> =
    handle.mock.calls.at(-1)?.[1];
  expect(await handler({})).toEqual({ items: ["team"] });
});
