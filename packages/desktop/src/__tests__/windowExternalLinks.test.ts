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
