import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const builtMenus: unknown[] = [];
  return {
    builtMenus,
    app: {
      getLocale: vi.fn(() => "en"),
      setName: vi.fn()
    },
    dialog: {
      showMessageBox: vi.fn()
    },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        builtMenus.push(template);
        return { template };
      }),
      setApplicationMenu: vi.fn()
    }
  };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  dialog: electronMock.dialog,
  Menu: electronMock.Menu
}));

describe("application menu", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.builtMenus.length = 0;
    electronMock.app.getLocale.mockReset();
    electronMock.app.getLocale.mockReturnValue("en");
    electronMock.app.setName.mockClear();
    electronMock.dialog.showMessageBox.mockClear();
    electronMock.Menu.buildFromTemplate.mockClear();
    electronMock.Menu.setApplicationMenu.mockClear();
  });

  it("adds Check for Updates to the app menu and wires it to the updater", async () => {
    const checkForUpdates = vi.fn().mockResolvedValue({
      status: "available",
      checkedAt: "2026-06-19T00:00:00.000Z",
      currentVersion: "0.1.2",
      error: null,
      progress: null,
      update: { version: "0.1.3", releaseDate: null, releaseName: null },
      updatedAt: "2026-06-19T00:00:01.000Z"
    });
    const { registerApplicationMenu } = await import("../main/appMenu");

    registerApplicationMenu({ checkForUpdates });

    const template = electronMock.builtMenus[0] as Array<{ label?: string; submenu?: Array<{ label?: string; click?: () => void; role?: string }> }>;
    const appMenu = template[0];
    const updateItem = appMenu.submenu?.find((item) => item.label === "Check for Updates");

    expect(electronMock.app.setName).toHaveBeenCalledWith("PlanWeave");
    expect(appMenu.label).toBe("PlanWeave");
    expect(appMenu.submenu?.[0]).toMatchObject({ label: "About PlanWeave", role: "about" });
    expect(updateItem).toBeDefined();
    updateItem?.click?.();
    await Promise.resolve();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(electronMock.Menu.setApplicationMenu).toHaveBeenCalledWith({ template });
  });

  it("shows a localized up-to-date dialog with the current version when no update is available", async () => {
    electronMock.app.getLocale.mockReturnValue("zh-CN");
    const checkForUpdates = vi.fn().mockResolvedValue({
      status: "not-available",
      checkedAt: "2026-06-19T00:00:00.000Z",
      currentVersion: "0.1.2",
      error: null,
      progress: null,
      update: { version: "0.1.2", releaseDate: null, releaseName: null },
      updatedAt: "2026-06-19T00:00:01.000Z"
    });
    const { registerApplicationMenu } = await import("../main/appMenu");

    registerApplicationMenu({ checkForUpdates });

    const template = electronMock.builtMenus[0] as Array<{ label?: string; submenu?: Array<{ label?: string; click?: () => void }> }>;
    const updateItem = template[0].submenu?.find((item) => item.label === "检查更新");
    updateItem?.click?.();
    await Promise.resolve();

    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith({
      buttons: ["好"],
      cancelId: 0,
      defaultId: 0,
      detail: "PlanWeave 0.1.2 是当前的最新版本。",
      message: "您使用的就是最新版！",
      title: "PlanWeave",
      type: "info"
    });
  });

  it("falls back to an English up-to-date dialog for non-Chinese locales", async () => {
    electronMock.app.getLocale.mockReturnValue("en-US");
    const checkForUpdates = vi.fn().mockResolvedValue({
      status: "not-available",
      checkedAt: "2026-06-19T00:00:00.000Z",
      currentVersion: "0.1.2",
      error: null,
      progress: null,
      update: { version: "0.1.2", releaseDate: null, releaseName: null },
      updatedAt: "2026-06-19T00:00:01.000Z"
    });
    const { registerApplicationMenu } = await import("../main/appMenu");

    registerApplicationMenu({ checkForUpdates });

    const template = electronMock.builtMenus[0] as Array<{ label?: string; submenu?: Array<{ label?: string; click?: () => void }> }>;
    const updateItem = template[0].submenu?.find((item) => item.label === "Check for Updates");
    updateItem?.click?.();
    await Promise.resolve();

    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith({
      buttons: ["OK"],
      cancelId: 0,
      defaultId: 0,
      detail: "PlanWeave 0.1.2 is currently the latest version.",
      message: "You're up to date!",
      title: "PlanWeave",
      type: "info"
    });
  });

  it("keeps the standard desktop menu roles", async () => {
    const { registerApplicationMenu } = await import("../main/appMenu");

    registerApplicationMenu({ checkForUpdates: vi.fn() });

    const template = electronMock.builtMenus[0] as Array<{ role?: string }>;
    expect(template.slice(1).map((item) => item.role)).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
  });
});
