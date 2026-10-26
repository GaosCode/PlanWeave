import type { DesktopSearchProjection } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import * as collaborationClient from "../main/collaboration/index";
import { runtimeBridgeHandlers } from "../main/runtimeBridgeHandlerRegistry";
import { createDesktopBridgeInvokeApi } from "../preload/bridgeInvocation";
import {
  desktopBridgeInvokeChannels,
  desktopBridgeWatchInvokeMethods,
  type DesktopBridgeInvokeMethod,
  type DesktopBridgeMainInvokeMethod
} from "../shared/ipcChannels";

type InvokeForwarder = (...args: unknown[]) => Promise<unknown>;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/planweave-desktop-contract-test"),
    getFileIcon: vi.fn()
  },
  BrowserWindow: {
    fromWebContents: vi.fn()
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn()
  }
}));

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe("desktop bridge end-to-end contract", () => {
  it("keeps invoke channels, main handlers, and preload invoke wrappers aligned", () => {
    const channelMethods = Object.keys(desktopBridgeInvokeChannels) as DesktopBridgeInvokeMethod[];
    const watchMethods = new Set<DesktopBridgeInvokeMethod>(desktopBridgeWatchInvokeMethods);
    const mainChannelMethods = channelMethods.filter((method) => !watchMethods.has(method));
    const handlerMethods = Object.keys(runtimeBridgeHandlers) as DesktopBridgeMainInvokeMethod[];
    const preloadApi = createDesktopBridgeInvokeApi(async () => null);

    expect(sortedStrings(Object.keys(preloadApi))).toEqual(sortedStrings(channelMethods));
    expect(sortedStrings(handlerMethods)).toEqual(sortedStrings(mainChannelMethods));

    for (const method of channelMethods) {
      expect(desktopBridgeInvokeChannels[method]).toBe(`planweave:${method}`);
      expect(typeof (preloadApi[method] as InvokeForwarder)).toBe("function");
    }
  });

  it("transports search truncation with its result batch while keeping the array method compatible", async () => {
    const projection: DesktopSearchProjection = { results: [], diagnostics: [], truncated: true };
    const invoke = vi.fn(async (channel: string) =>
      structuredClone(
        channel === desktopBridgeInvokeChannels.searchProjectWithDiagnostics
          ? projection
          : projection.results
      )
    );
    const api = createDesktopBridgeInvokeApi(invoke);
    const filters = { limit: 1, kinds: ["task" as const], canvasId: "canvas-a" };
    expect(await api.searchProjectWithDiagnostics("/tmp/project", "needle", filters)).toEqual(
      projection
    );
    expect(invoke).toHaveBeenLastCalledWith(
      desktopBridgeInvokeChannels.searchProjectWithDiagnostics,
      "/tmp/project",
      "needle",
      filters
    );
    expect(await api.searchProject("/tmp/project", "needle", filters)).toEqual([]);
  });

  it("keeps Electron handlers outside the collaboration client barrel", () => {
    expect(collaborationClient).not.toHaveProperty("registerCollaborationHandlers");
    expect(collaborationClient).not.toHaveProperty("shutdownCollaborationService");
  });
});
