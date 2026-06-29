import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { vi } from "vitest";

export function createDesktopBridgeMock(overrides: Partial<DesktopBridgeApi> = {}): DesktopBridgeApi {
  const defaults: Partial<DesktopBridgeApi> = {
    detectRuntimeTools: vi.fn().mockResolvedValue({ tmux: { available: false, command: "tmux" } }),
    getRunTerminalAvailability: vi.fn().mockResolvedValue([]),
    onAutoRunChanged: () => () => undefined,
    onPackageFileChanged: () => () => undefined
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
