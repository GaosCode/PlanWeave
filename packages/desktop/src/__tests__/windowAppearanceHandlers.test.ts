import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowAppearanceInvokeChannels } from "../shared/windowAppearance";

type RegisteredHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  const ownerWindow = {
    setBackgroundColor: vi.fn(),
    setBackgroundMaterial: vi.fn(),
    setVibrancy: vi.fn()
  };
  function BrowserWindowMock() {}
  BrowserWindowMock.prototype.setBackgroundMaterial = vi.fn();
  BrowserWindowMock.prototype.setVibrancy = vi.fn();
  return {
    handlers,
    ownerWindow,
    BrowserWindow: Object.assign(BrowserWindowMock, {
      fromWebContents: vi.fn(() => ownerWindow)
    }),
    ipcMain: {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      })
    },
    nativeTheme: {
      shouldUseDarkColors: false
    }
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMock.BrowserWindow,
  ipcMain: electronMock.ipcMain,
  nativeTheme: electronMock.nativeTheme
}));

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });
}

describe("window appearance handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.BrowserWindow.fromWebContents.mockClear();
    electronMock.ipcMain.handle.mockClear();
    electronMock.ownerWindow.setBackgroundColor.mockClear();
    electronMock.ownerWindow.setBackgroundMaterial.mockClear();
    electronMock.ownerWindow.setVibrancy.mockClear();
    electronMock.BrowserWindow.prototype.setBackgroundMaterial = vi.fn();
    electronMock.BrowserWindow.prototype.setVibrancy = vi.fn();
    electronMock.nativeTheme.shouldUseDarkColors = false;
    setPlatform("darwin");
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("registers a separate window material handler", async () => {
    const { registerWindowAppearanceHandlers } = await import("../main/windowAppearance");

    registerWindowAppearanceHandlers();

    expect(electronMock.ipcMain.handle).toHaveBeenCalledWith(
      windowAppearanceInvokeChannels.getWindowMaterialCapabilities,
      expect.any(Function)
    );
    expect(electronMock.ipcMain.handle).toHaveBeenCalledWith(
      windowAppearanceInvokeChannels.setWindowMaterial,
      expect.any(Function)
    );
  });

  it("reports unsupported platforms through the capability handler", async () => {
    setPlatform("linux");
    const { registerWindowAppearanceHandlers } = await import("../main/windowAppearance");
    registerWindowAppearanceHandlers();

    const handler = electronMock.handlers.get(
      windowAppearanceInvokeChannels.getWindowMaterialCapabilities
    );

    expect(await handler?.({ sender: "web-contents" })).toEqual({
      platform: "linux",
      reason: "unsupported-platform",
      supported: false
    });
  });

  it("reports missing Electron APIs through the capability handler", async () => {
    delete electronMock.BrowserWindow.prototype.setVibrancy;
    const { registerWindowAppearanceHandlers } = await import("../main/windowAppearance");
    registerWindowAppearanceHandlers();

    const handler = electronMock.handlers.get(
      windowAppearanceInvokeChannels.getWindowMaterialCapabilities
    );

    expect(await handler?.({ sender: "web-contents" })).toEqual({
      platform: "darwin",
      reason: "missing-electron-api",
      supported: false
    });
  });

  it("enables macOS vibrancy over a transparent owner window background", async () => {
    const { registerWindowAppearanceHandlers } = await import("../main/windowAppearance");
    registerWindowAppearanceHandlers();

    const handler = electronMock.handlers.get(windowAppearanceInvokeChannels.setWindowMaterial);
    await handler?.({ sender: "web-contents" }, { appearance: "dark", enabled: true });

    expect(electronMock.BrowserWindow.fromWebContents).toHaveBeenCalledWith("web-contents");
    expect(electronMock.ownerWindow.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(electronMock.ownerWindow.setVibrancy).toHaveBeenCalledWith("under-window");
    expect(electronMock.ownerWindow.setBackgroundMaterial).not.toHaveBeenCalled();
  });

  it("keeps unsupported platforms on a solid fallback background", async () => {
    setPlatform("linux");
    const { registerWindowAppearanceHandlers } = await import("../main/windowAppearance");
    registerWindowAppearanceHandlers();

    const handler = electronMock.handlers.get(windowAppearanceInvokeChannels.setWindowMaterial);
    await handler?.({ sender: "web-contents" }, { appearance: "dark", enabled: true });

    expect(electronMock.ownerWindow.setBackgroundColor).toHaveBeenCalledWith("#1f211f");
    expect(electronMock.ownerWindow.setBackgroundMaterial).not.toHaveBeenCalled();
    expect(electronMock.ownerWindow.setVibrancy).not.toHaveBeenCalled();
  });

  it("disables Windows background material with a solid fallback", async () => {
    setPlatform("win32");
    const { registerWindowAppearanceHandlers } = await import("../main/windowAppearance");
    registerWindowAppearanceHandlers();

    const handler = electronMock.handlers.get(windowAppearanceInvokeChannels.setWindowMaterial);
    await handler?.({ sender: "web-contents" }, { appearance: "light", enabled: false });

    expect(electronMock.ownerWindow.setBackgroundColor).toHaveBeenCalledWith("#f7f8fa");
    expect(electronMock.ownerWindow.setBackgroundMaterial).toHaveBeenCalledWith("none");
    expect(electronMock.ownerWindow.setVibrancy).not.toHaveBeenCalled();
  });
});
