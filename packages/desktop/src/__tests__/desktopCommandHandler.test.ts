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
  try {
    unwrapDesktopCommandFailure(value);
    throw new Error("failure was accepted");
  } catch (failure) {
    expect(failure).toMatchObject({
      kind: "offline",
      code: "SERVER_UNREACHABLE",
      message: "Server unreachable"
    });
    expect(failure).not.toBeInstanceOf(Error);
  }
  expect(recordDesktopError).toHaveBeenCalledWith("workspace.select", error);
});
it("preserves successful response shapes", async () => {
  handleDesktopCommand("workspace.list", async () => ({ items: ["team"] }));
  const handler: (event: Partial<IpcMainInvokeEvent>) => Promise<unknown> =
    handle.mock.calls.at(-1)?.[1];
  expect(await handler({})).toEqual({ items: ["team"] });
});

const { desktopCommandBridge } = await import("../renderer/desktopCommandBridge.js");
it.each([
  "conflict",
  "auth",
  "forbidden",
  "offline",
  "timeout",
  "rate_limited",
  "unknown"
])("restores %s after serialized rejection without changing sync subscriptions or success", async (kind) => {
  const failure = {
    kind,
    code: "boundary_code",
    message: "Boundary failed",
    retryable: true,
    httpStatus: 409,
    retryAfterMs: 2000
  };
  const dispose = vi.fn();
  const source = Object.freeze({
    command: async () => {
      throw structuredClone(failure);
    },
    list: async () => ({ items: ["team"] }),
    subscribe: () => dispose
  });
  const api = desktopCommandBridge(source);
  expect(desktopCommandBridge(source)).toBe(api);
  expect(api.command).toBe(api.command);
  expect(api.subscribe()).toBe(dispose);
  await expect(api.list()).resolves.toEqual({ items: ["team"] });
  await expect(api.command()).rejects.toBeInstanceOf(Error);
  await expect(api.command()).rejects.toMatchObject(failure);
});
it("preserves unclassified native errors and refuses malformed failure data", async () => {
  const error = new Error("native invoke failed");
  const malformed = { kind: "conflict", code: "bad", message: "bad", retryable: "invalid" };
  const api = desktopCommandBridge({
    native: async () => {
      throw error;
    },
    malformed: async () => {
      throw malformed;
    }
  });
  await expect(api.native()).rejects.toBe(error);
  await expect(api.malformed()).rejects.toBe(malformed);
});
