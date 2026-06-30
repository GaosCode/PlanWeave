import { cloneDesktopGraphEditResult, type GraphEditResult } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate";
import { desktopSettingsInvokeChannels } from "../shared/desktopSettings";
import { autoRunChangedChannel, desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels } from "../shared/mcpTunnel";
import { windowAppearanceInvokeChannels } from "../shared/windowAppearance";

describe("desktop IPC contract", () => {
  it("uses stable, unique invoke channel names", () => {
    const entries = Object.entries(desktopBridgeInvokeChannels);
    const channels = entries.map(([, channel]) => channel);

    for (const [method, channel] of entries) {
      expect(channel).toBe(`planweave:${method}`);
    }
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps subscription event channels outside the invoke channel registry", () => {
    expect(packageFileChangedChannel).toBe("planweave:packageFileChanged");
    expect(autoRunChangedChannel).toBe("planweave:autoRunChanged");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(packageFileChangedChannel);
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(autoRunChangedChannel);
  });

  it("keeps window appearance channels outside the runtime bridge registry", () => {
    expect(windowAppearanceInvokeChannels.getWindowMaterialCapabilities).toBe("planweave-window:getWindowMaterialCapabilities");
    expect(windowAppearanceInvokeChannels.setWindowMaterial).toBe("planweave-window:setWindowMaterial");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(windowAppearanceInvokeChannels.getWindowMaterialCapabilities);
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(windowAppearanceInvokeChannels.setWindowMaterial);
  });

  it("keeps app update channels outside the runtime bridge registry", () => {
    expect(appUpdateInvokeChannels.getAppUpdateState).toBe("planweave-app-update:getAppUpdateState");
    expect(appUpdateInvokeChannels.checkForAppUpdate).toBe("planweave-app-update:checkForAppUpdate");
    expect(appUpdateInvokeChannels.downloadAppUpdate).toBe("planweave-app-update:downloadAppUpdate");
    expect(appUpdateInvokeChannels.installAppUpdate).toBe("planweave-app-update:installAppUpdate");
    expect(appUpdateChangedChannel).toBe("planweave-app-update:changed");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(appUpdateChangedChannel);
    for (const channel of Object.values(appUpdateInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("keeps desktop settings channels outside the runtime bridge registry", () => {
    expect(desktopSettingsInvokeChannels.getDesktopSettings).toBe("planweave-desktop-settings:getDesktopSettings");
    expect(desktopSettingsInvokeChannels.saveDesktopSettings).toBe("planweave-desktop-settings:saveDesktopSettings");
    expect(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings).toBe("planweave-desktop-settings:migrateLegacyDesktopSettings");
    for (const channel of Object.values(desktopSettingsInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("keeps MCP tunnel channels outside the runtime bridge registry", () => {
    expect(mcpTunnelInvokeChannels.getMcpTunnelStatus).toBe("planweave-mcp-tunnel:getStatus");
    expect(mcpTunnelInvokeChannels.downloadTunnelClient).toBe("planweave-mcp-tunnel:downloadTunnelClient");
    expect(mcpTunnelInvokeChannels.setTunnelClientPath).toBe("planweave-mcp-tunnel:setTunnelClientPath");
    expect(mcpTunnelInvokeChannels.setTunnelAutoStart).toBe("planweave-mcp-tunnel:setTunnelAutoStart");
    expect(mcpTunnelInvokeChannels.startLocalMcp).toBe("planweave-mcp-tunnel:startLocalMcp");
    expect(mcpTunnelInvokeChannels.stopLocalMcp).toBe("planweave-mcp-tunnel:stopLocalMcp");
    expect(mcpTunnelInvokeChannels.startTunnel).toBe("planweave-mcp-tunnel:startTunnel");
    expect(mcpTunnelInvokeChannels.stopTunnel).toBe("planweave-mcp-tunnel:stopTunnel");
    expect(mcpTunnelChangedChannel).toBe("planweave-mcp-tunnel:changed");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(mcpTunnelChangedChannel);
    for (const channel of Object.values(mcpTunnelInvokeChannels)) {
      expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(channel);
    }
  });

  it("uses the desktop canvas reference channel for canvas-scoped bridge calls", () => {
    expect(desktopBridgeInvokeChannels.getGraphViewModel).toBe("planweave:getGraphViewModel");
    expect(desktopBridgeInvokeChannels.getCanvasGraphViewModel).toBe("planweave:getCanvasGraphViewModel");
    expect(desktopBridgeInvokeChannels.getCanvasMapLayout).toBe("planweave:getCanvasMapLayout");
    expect(desktopBridgeInvokeChannels.getDesktopLayout).toBe("planweave:getDesktopLayout");
    expect(desktopBridgeInvokeChannels.getDesktopProjectSnapshot).toBe("planweave:getDesktopProjectSnapshot");
    expect(desktopBridgeInvokeChannels.watchPackageFiles).toBe("planweave:watchPackageFiles");
    expect(desktopBridgeInvokeChannels.getTodoGroups).toBe("planweave:getTodoGroups");
  });

  it("strips compiled graph internals from graph edit IPC results", () => {
    const result: GraphEditResult = {
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: [],
      graph: { indexes: "not cloneable over IPC" } as never
    };

    expect(cloneDesktopGraphEditResult(result)).toEqual({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    });
  });
});
