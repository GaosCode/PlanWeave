import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  BrowserWindow: vi.fn(),
  shell: {
    openExternal: vi.fn()
  }
}));

vi.mock("electron", () => ({
  BrowserWindow: electronMock.BrowserWindow,
  shell: electronMock.shell
}));

afterEach(() => {
  electronMock.shell.openExternal.mockClear();
  delete process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL;
});

describe("desktop external link handling", () => {
  it("opens the tunnel-client release page in the system browser and denies Electron child windows", async () => {
    const { configureExternalLinkHandling } = await import("../main/window");
    const setWindowOpenHandler = vi.fn();

    configureExternalLinkHandling({ webContents: { setWindowOpenHandler } } as never);
    const handler = setWindowOpenHandler.mock.calls[0]?.[0] as (details: { url: string }) => { action: "deny" };

    expect(handler({ url: "https://github.com/openai/tunnel-client/releases/latest" })).toEqual({ action: "deny" });
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith("https://github.com/openai/tunnel-client/releases/latest");
  });

  it("denies unlisted external links without opening them", async () => {
    const { configureExternalLinkHandling } = await import("../main/window");
    const setWindowOpenHandler = vi.fn();

    configureExternalLinkHandling({ webContents: { setWindowOpenHandler } } as never);
    const handler = setWindowOpenHandler.mock.calls[0]?.[0] as (details: { url: string }) => { action: "deny" };

    expect(handler({ url: "https://example.com/" })).toEqual({ action: "deny" });
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("desktop navigation handling", () => {
  it("allows only the configured dev-server origin while developing", async () => {
    process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL = "http://127.0.0.1:5173/";
    const { isAllowedNavigation } = await import("../main/window");

    expect(isAllowedNavigation("http://127.0.0.1:5173/index.html", { isDev: true })).toBe(true);
    expect(isAllowedNavigation("https://example.com/", { isDev: true })).toBe(false);
  });

  it("allows only file URLs inside the packaged renderer directory in production", async () => {
    const { isAllowedNavigation } = await import("../main/window");
    // window.ts resolves renderer as ../renderer from the window module directory.
    const windowModuleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "main");
    const allowedEntry = pathToFileURL(join(windowModuleDir, "..", "renderer", "index.html")).href;
    const outsideEntry = pathToFileURL(join(windowModuleDir, "..", "..", "package.json")).href;

    expect(isAllowedNavigation(allowedEntry, { isDev: false })).toBe(true);
    expect(isAllowedNavigation(outsideEntry, { isDev: false })).toBe(false);
    expect(isAllowedNavigation("https://example.com/", { isDev: false })).toBe(false);
  });

  it("prevents will-navigate for disallowed URLs", async () => {
    const { configureNavigationHandling } = await import("../main/window");
    const on = vi.fn();
    const preventDefault = vi.fn();

    configureNavigationHandling({ webContents: { on } } as never, { isDev: false });
    const handler = on.mock.calls.find((call) => call[0] === "will-navigate")?.[1] as (
      event: { preventDefault: () => void },
      url: string
    ) => void;

    handler({ preventDefault }, "https://example.com/");
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
