import { cleanup } from "@testing-library/react";
import { vi } from "vitest";

export function cleanupRendererTestEnvironment() {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export function stubSelectLayoutApis() {
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: vi.fn(() => false) });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
}
