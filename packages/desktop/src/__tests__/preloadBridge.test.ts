import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { createDesktopBridgeInvokeApi } from "../preload/bridgeInvocation";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";

describe("preload bridge invocation", () => {
  it("maps every invoke bridge method to its channel and forwards raw args", async () => {
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async (channel: string, ...args: unknown[]) => ({
      channel,
      args
    }));
    const api = createDesktopBridgeInvokeApi(invoke);
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };

    for (const [method, channel] of Object.entries(desktopBridgeInvokeChannels)) {
      invoke.mockClear();

      await api[method as keyof typeof desktopBridgeInvokeChannels](ref, "arg-1", { nested: true });

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(channel, ref, "arg-1", { nested: true });
    }
  });

  it("passes through typed call results", async () => {
    const projects: DesktopProjectSummary[] = [
      {
        id: "project-a",
        title: "Project A",
        rootPath: "/tmp/project-a",
        taskCount: 1,
        blockCount: 2,
        reviewCount: 0,
        lastOpenedAt: null
      }
    ];
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async () => projects);
    const api = createDesktopBridgeInvokeApi(invoke);

    await expect(api.listProjects()).resolves.toBe(projects);
    expect(invoke).toHaveBeenCalledWith(desktopBridgeInvokeChannels.listProjects);
  });
});
