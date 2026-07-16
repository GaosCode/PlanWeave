import { describe, expect, it, vi } from "vitest";
import { startSingleInstanceLifecycle } from "../main/singleInstanceLifecycle.js";

function createLifecycle(lockGranted: boolean) {
  const quit = vi.fn();
  const startPrimary = vi.fn();
  let secondInstanceListener: (() => void) | undefined;
  const lifecycle = {
    requestLock: vi.fn(() => lockGranted),
    quit,
    onSecondInstance: vi.fn((listener: () => void) => {
      secondInstanceListener = listener;
    }),
    getPrimaryWindow: vi.fn<() =>
      | { isMinimized(): boolean; restore(): void; focus(): void }
      | undefined>(() => undefined),
    startPrimary
  };
  return { lifecycle, quit, startPrimary, secondInstanceListener: () => secondInstanceListener };
}

describe("desktop single-instance lifecycle", () => {
  it("quits the second instance without starting primary handlers or windows", () => {
    const { lifecycle, quit, startPrimary } = createLifecycle(false);

    startSingleInstanceLifecycle(lifecycle);

    expect(quit).toHaveBeenCalledOnce();
    expect(lifecycle.onSecondInstance).not.toHaveBeenCalled();
    expect(startPrimary).not.toHaveBeenCalled();
  });

  it("registers second-instance handling and starts only the primary instance", () => {
    const { lifecycle, quit, startPrimary } = createLifecycle(true);

    startSingleInstanceLifecycle(lifecycle);

    expect(quit).not.toHaveBeenCalled();
    expect(lifecycle.onSecondInstance).toHaveBeenCalledOnce();
    expect(startPrimary).toHaveBeenCalledOnce();
  });

  it.each([
    { minimized: true, restores: 1 },
    { minimized: false, restores: 0 }
  ])("restores minimized=$minimized and focuses the primary window", ({ minimized, restores }) => {
    const { lifecycle, secondInstanceListener } = createLifecycle(true);
    const window = {
      isMinimized: vi.fn(() => minimized),
      restore: vi.fn(),
      focus: vi.fn()
    };
    lifecycle.getPrimaryWindow.mockReturnValue(window);
    startSingleInstanceLifecycle(lifecycle);

    secondInstanceListener()?.();

    expect(window.restore).toHaveBeenCalledTimes(restores);
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
