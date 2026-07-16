import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { vi } from "vitest";

export function createDesktopBridgeMock(
  overrides: Partial<DesktopBridgeApi> = {}
): DesktopBridgeApi {
  const defaults: Partial<DesktopBridgeApi> = {
    detectRuntimeTools: vi.fn().mockResolvedValue({ tmux: { available: false, command: "tmux" } }),
    getDesktopGraphDiagnostics: vi.fn().mockResolvedValue({
      graphQuality: { ok: true, diagnostics: [] },
      executionReadiness: { ok: true, diagnostics: [] },
      diagnostics: []
    }),
    getDesktopRuntimeRefresh: vi
      .fn()
      .mockResolvedValue({ latestAutoRun: null, diagnostics: [], errors: [] }),
    getLatestAutoRunSummaryWithDiagnostics: vi
      .fn()
      .mockResolvedValue({ state: null, diagnostics: [] }),
    // Match DesktopBridgeApi contract (non-null pipeline). Proxy null defaults break App load.
    getReviewPipeline: vi.fn().mockResolvedValue({
      taskId: "",
      taskTitle: "",
      packageDefaults: {
        maxFeedbackCycles: 1,
        completionPolicy: "strict" as const
      },
      steps: []
    }),
    getRunTerminalAvailability: vi.fn().mockResolvedValue([]),
    listPendingImportRecoveries: vi.fn().mockResolvedValue([]),
    onAutoRunChanged: () => () => undefined,
    onPackageFileChanged: () => () => undefined,
    onRuntimeStateChanged: () => () => undefined
  };

  return new Proxy({ ...defaults, ...overrides } as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (!(property in target)) {
        target[property] = vi.fn().mockResolvedValue(null);
      }
      return target[property];
    }
  }) as DesktopBridgeApi;
}
