import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsStore } from "../main/desktopSettingsStore";
import {
  defaultDesktopSettings,
  desktopAgentHostChangedChannel,
  desktopSettingsInvokeChannels
} from "../shared/desktopSettings";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    getAllWindows: vi.fn(
      (): Array<{
        webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
      }> => []
    ),
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, (event, ...args) =>
          handler(
            event && typeof event === "object" && "sender" in event ? event : { sender: {} },
            ...args
          )
        );
      })
    }
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: electronMock.getAllWindows },
  ipcMain: electronMock.ipcMain
}));

const tempRoots: string[] = [];

async function tempSettingsFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-desktop-settings-handlers-"));
  tempRoots.push(root);
  return join(root, "config", "desktop-settings.json");
}

async function tempStore(): Promise<DesktopSettingsStore> {
  return new DesktopSettingsStore({ settingsFile: await tempSettingsFile(), platform: "linux" });
}

function handler(channel: string): IpcHandler {
  const registered = electronMock.handlers.get(channel);
  if (!registered) {
    throw new Error(`Missing IPC handler for ${channel}`);
  }
  return registered;
}

afterEach(async () => {
  vi.resetModules();
  electronMock.handlers.clear();
  electronMock.ipcMain.handle.mockClear();
  electronMock.getAllWindows.mockReset();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop settings handlers", () => {
  it("notifies live windows only after the requested Host is persisted", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    const store = await tempStore();
    const createWindow = (destroyed = false) => ({
      webContents: {
        isDestroyed: () => destroyed,
        send: vi.fn(() => store.read())
      }
    });
    const windows = [createWindow(), createWindow(), createWindow(), createWindow(true)];
    const main = windows[0]!;
    electronMock.getAllWindows.mockReturnValue(windows);
    registerDesktopSettingsHandlers(store);
    const save = handler(desktopSettingsInvokeChannels.saveDesktopSettings);
    const sender = { sender: main.webContents };
    const ubuntu = { kind: "wsl", distribution: "Ubuntu" } as const;
    const debian = { kind: "wsl", distribution: "Debian" } as const;

    await save(sender, { execution: { agentHost: ubuntu } });
    for (const { webContents } of windows.slice(0, 3)) {
      expect(webContents.send).toHaveBeenCalledExactlyOnceWith(
        desktopAgentHostChangedChannel,
        ubuntu
      );
      await expect(webContents.send.mock.results[0]?.value).resolves.toMatchObject({
        execution: { agentHost: ubuntu }
      });
      webContents.send.mockClear();
    }
    expect(windows[3]!.webContents.send).not.toHaveBeenCalled();
    await save(sender, { appearance: "dark" });
    vi.spyOn(store, "mergePatch").mockRejectedValueOnce(new Error("write failed"));
    await expect(save(sender, { execution: { agentHost: debian } })).rejects.toThrow(
      "write failed"
    );
    for (const { webContents } of windows) expect(webContents.send).not.toHaveBeenCalled();
    await expect(store.read()).resolves.toMatchObject({ execution: { agentHost: ubuntu } });
  });

  it("registers desktop settings IPC handlers", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    registerDesktopSettingsHandlers(await tempStore());

    expect(electronMock.ipcMain.handle).toHaveBeenCalledWith(
      desktopSettingsInvokeChannels.getDesktopSettings,
      expect.any(Function)
    );
    expect(electronMock.ipcMain.handle).toHaveBeenCalledWith(
      desktopSettingsInvokeChannels.saveDesktopSettings,
      expect.any(Function)
    );
    expect(electronMock.ipcMain.handle).toHaveBeenCalledWith(
      desktopSettingsInvokeChannels.migrateLegacyDesktopSettings,
      expect.any(Function)
    );
  });

  it("saves normalized settings patches through the store", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    const store = await tempStore();
    registerDesktopSettingsHandlers(store);

    const saved = await handler(desktopSettingsInvokeChannels.saveDesktopSettings)(
      {},
      {
        appearance: "dark",
        layout: {
          leftSidebar: {
            collapsed: true,
            width: 1
          }
        }
      }
    );

    expect(saved).toMatchObject({
      appearance: "dark",
      layout: {
        leftSidebar: {
          collapsed: true,
          width: 220
        }
      }
    });
    await expect(store.read()).resolves.toEqual(saved);
  });

  it("normalizes partial nested patches without resetting existing nested settings", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    const store = await tempStore();
    await store.write({
      ...defaultDesktopSettings,
      notifications: {
        autoRunFailure: true,
        graphExceptions: false,
        dirtyPrompts: false,
        fileSyncConflict: true
      },
      layout: {
        leftSidebar: {
          collapsed: false,
          width: 280
        },
        rightSidebar: {
          collapsed: true,
          width: 420
        },
        autoRunControl: {
          position: {
            left: 24,
            top: 48
          }
        }
      },
      palette: {
        visible: {
          task: true,
          implementation: false,
          review: true
        },
        defaultBlockSet: ["review"],
        dragHint: false
      },
      agents: {
        ...defaultDesktopSettings.agents,
        codex: {
          enabled: true,
          fullAccess: true
        }
      }
    });
    registerDesktopSettingsHandlers(store);

    const saved = await handler(desktopSettingsInvokeChannels.saveDesktopSettings)(
      {},
      {
        notifications: {
          autoRunFailure: false
        },
        layout: {
          leftSidebar: {
            width: 320
          }
        },
        palette: {
          visible: {
            implementation: true
          }
        },
        agents: {
          codex: {
            enabled: false
          }
        }
      }
    );

    expect(saved).toMatchObject({
      notifications: {
        autoRunFailure: false,
        graphExceptions: false,
        dirtyPrompts: false,
        fileSyncConflict: true
      },
      layout: {
        leftSidebar: {
          collapsed: false,
          width: 320
        },
        rightSidebar: {
          collapsed: true,
          width: 420
        },
        autoRunControl: {
          position: {
            left: 24,
            top: 48
          }
        }
      },
      palette: {
        visible: {
          task: true,
          implementation: true,
          review: true
        },
        defaultBlockSet: ["review"],
        dragHint: false
      },
      agents: {
        codex: {
          enabled: false,
          fullAccess: true
        }
      }
    });
    await expect(store.read()).resolves.toEqual(saved);
  });

  it("migrates legacy settings only when the new settings file is missing", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    const store = await tempStore();
    await store.write({
      ...defaultDesktopSettings,
      appearance: "light"
    });
    registerDesktopSettingsHandlers(store);

    const migrated = await handler(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings)(
      {},
      JSON.stringify({ appearance: "dark" })
    );

    expect(migrated).toMatchObject({ appearance: "light" });
    expect(JSON.parse(await readFile(store.settingsFile, "utf8"))).toMatchObject({
      appearance: "light"
    });
  });

  it("writes legacy settings when the new settings file is missing", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    const store = await tempStore();
    registerDesktopSettingsHandlers(store);

    const migrated = await handler(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings)(
      {},
      JSON.stringify({ appearance: "dark" })
    );

    expect(migrated).toMatchObject({ appearance: "dark" });
    expect(JSON.parse(await readFile(store.settingsFile, "utf8"))).toMatchObject({
      appearance: "dark"
    });
  });

  it("serializes rapid saves so read-modify-write patches do not lose fields", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    const store = await tempStore();
    registerDesktopSettingsHandlers(store);

    const save = handler(desktopSettingsInvokeChannels.saveDesktopSettings);
    await Promise.all([
      save({}, { appearance: "dark" }),
      save({}, { notifications: { autoRunFailure: false } }),
      save({}, { windowMaterial: { enabled: true } })
    ]);

    await expect(store.read()).resolves.toMatchObject({
      appearance: "dark",
      notifications: {
        autoRunFailure: false,
        graphExceptions: true
      },
      windowMaterial: {
        enabled: true
      }
    });
  });

  it("does not let queued legacy migration overwrite a preceding save", async () => {
    const { registerDesktopSettingsHandlers } = await import("../main/desktopSettingsHandlers");
    const store = await tempStore();
    registerDesktopSettingsHandlers(store);

    const saved = handler(desktopSettingsInvokeChannels.saveDesktopSettings)(
      {},
      { appearance: "light" }
    );
    const migrated = handler(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings)(
      {},
      JSON.stringify({ appearance: "dark" })
    );

    await expect(saved).resolves.toMatchObject({ appearance: "light" });
    await expect(migrated).resolves.toMatchObject({ appearance: "light" });
    await expect(store.read()).resolves.toMatchObject({ appearance: "light" });
  });
});
