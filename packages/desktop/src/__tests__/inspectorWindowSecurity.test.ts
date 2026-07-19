import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockWindowOptions {
  webPreferences?: {
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    sandbox?: boolean;
  };
}

const electronMock = vi.hoisted(() => {
  const windows: Array<{
    options: MockWindowOptions;
    window: {
      focus: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      loadFile: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      show: ReturnType<typeof vi.fn>;
      webContents: {
        on: ReturnType<typeof vi.fn>;
        setWindowOpenHandler: ReturnType<typeof vi.fn>;
      };
    };
  }> = [];
  const browserWindow = vi.fn(function BrowserWindowMock(options: MockWindowOptions) {
    const window = {
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      loadFile: vi.fn(async () => undefined),
      loadURL: vi.fn(async () => undefined),
      on: vi.fn(),
      show: vi.fn(),
      webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn()
      }
    };
    windows.push({ options, window });
    return window;
  });

  return {
    app: { getLocale: vi.fn(() => "en-US") },
    browserWindow,
    shell: { openExternal: vi.fn() },
    windows
  };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.browserWindow,
  shell: electronMock.shell
}));

afterEach(() => {
  vi.unstubAllEnvs();
  electronMock.browserWindow.mockClear();
  electronMock.shell.openExternal.mockClear();
  electronMock.windows.length = 0;
  vi.resetModules();
});

function windowOpenHandler(
  window: (typeof electronMock.windows)[number]["window"]
): (details: { url: string }) => { action: "deny" } {
  return window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
    url: string;
  }) => { action: "deny" };
}

function navigationHandler(
  window: (typeof electronMock.windows)[number]["window"]
): (event: { preventDefault: () => void }, url: string) => void {
  return window.webContents.on.mock.calls.find((call) => call[0] === "will-navigate")?.[1] as (
    event: { preventDefault: () => void },
    url: string
  ) => void;
}

describe("task inspector window security", () => {
  it("sandboxes the task inspector and permits its dev-server URL with query parameters", async () => {
    vi.stubEnv("PLANWEAVE_DESKTOP_DEV_SERVER_URL", "http://127.0.0.1:5173/app");
    const { openTaskInspectorWindow } = await import("../main/taskInspectorWindow");

    await openTaskInspectorWindow({
      canvas: { canvasId: "audit", projectRoot: "/workspace/project" },
      language: "en",
      taskId: "T-026"
    });

    const [created] = electronMock.windows;
    expect(created).toBeDefined();
    if (!created) {
      return;
    }
    expect(created.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
    expect(windowOpenHandler(created.window)({ url: "https://example.com/" })).toEqual({
      action: "deny"
    });
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();

    const loadedUrl = created.window.loadURL.mock.calls[0]?.[0] as string;
    const loaded = new URL(loadedUrl);
    expect(loaded.origin).toBe("http://127.0.0.1:5173");
    expect(Object.fromEntries(loaded.searchParams)).toMatchObject({
      canvasId: "audit",
      projectRoot: "/workspace/project",
      taskId: "T-026",
      window: "task-inspector"
    });

    const handleNavigation = navigationHandler(created.window);
    const allowedNavigation = { preventDefault: vi.fn() };
    handleNavigation(allowedNavigation, loadedUrl);
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();

    const deniedNavigation = { preventDefault: vi.fn() };
    handleNavigation(deniedNavigation, "https://example.com/");
    expect(deniedNavigation.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("block inspector window security", () => {
  it("sandboxes the block inspector and permits its packaged renderer file", async () => {
    const { openBlockInspectorWindow } = await import("../main/blockInspectorWindow");

    await openBlockInspectorWindow({
      blockRef: "T-026#B-001",
      canvas: { canvasId: "audit", projectRoot: "/workspace/project" },
      language: "en"
    });

    const [created] = electronMock.windows;
    expect(created).toBeDefined();
    if (!created) {
      return;
    }
    expect(created.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
    expect(windowOpenHandler(created.window)({ url: "https://example.com/" })).toEqual({
      action: "deny"
    });
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();

    const [rendererEntry, loadOptions] = created.window.loadFile.mock.calls[0] as [
      string,
      { query: Record<string, string> }
    ];
    expect(loadOptions.query).toMatchObject({
      blockRef: "T-026#B-001",
      canvasId: "audit",
      projectRoot: "/workspace/project",
      window: "block-inspector"
    });

    const handleNavigation = navigationHandler(created.window);
    const allowedNavigation = { preventDefault: vi.fn() };
    handleNavigation(allowedNavigation, pathToFileURL(rendererEntry).href);
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();

    const deniedNavigation = { preventDefault: vi.fn() };
    handleNavigation(deniedNavigation, "https://example.com/");
    expect(deniedNavigation.preventDefault).toHaveBeenCalledOnce();
  });
});
