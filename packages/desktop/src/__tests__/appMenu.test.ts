import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const builtMenus: unknown[] = [];
  return {
    builtMenus,
    app: {
      setName: vi.fn()
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
  Menu: electronMock.Menu
}));

describe("application menu", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.builtMenus.length = 0;
    electronMock.app.setName.mockClear();
    electronMock.Menu.buildFromTemplate.mockClear();
    electronMock.Menu.setApplicationMenu.mockClear();
  });

  it("adds Check for Updates to the app menu and wires it to the updater", async () => {
    const checkForUpdates = vi.fn().mockResolvedValue(undefined);
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
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(electronMock.Menu.setApplicationMenu).toHaveBeenCalledWith({ template });
  });

  it("keeps the standard desktop menu roles", async () => {
    const { registerApplicationMenu } = await import("../main/appMenu");

    registerApplicationMenu({ checkForUpdates: vi.fn() });

    const template = electronMock.builtMenus[0] as Array<{ role?: string }>;
    expect(template.slice(1).map((item) => item.role)).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
  });
});
