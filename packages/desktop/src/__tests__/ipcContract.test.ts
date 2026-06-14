import { cloneDesktopGraphEditResult, type GraphEditResult } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels";

describe("desktop IPC contract", () => {
  it("uses stable, unique invoke channel names", () => {
    const entries = Object.entries(desktopBridgeInvokeChannels);
    const channels = entries.map(([, channel]) => channel);

    for (const [method, channel] of entries) {
      expect(channel).toBe(`planweave:${method}`);
    }
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps package file change events outside the invoke channel registry", () => {
    expect(packageFileChangedChannel).toBe("planweave:packageFileChanged");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(packageFileChangedChannel);
  });

  it("uses the desktop canvas reference channel for canvas-scoped bridge calls", () => {
    expect(desktopBridgeInvokeChannels.getGraphViewModel).toBe("planweave:getGraphViewModel");
    expect(desktopBridgeInvokeChannels.getCanvasGraphViewModel).toBe("planweave:getCanvasGraphViewModel");
    expect(desktopBridgeInvokeChannels.getCanvasMapLayout).toBe("planweave:getCanvasMapLayout");
    expect(desktopBridgeInvokeChannels.getDesktopLayout).toBe("planweave:getDesktopLayout");
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
