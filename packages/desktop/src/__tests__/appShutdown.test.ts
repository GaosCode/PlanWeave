import { describe, expect, it, vi } from "vitest";
import { createDesktopShutdownController } from "../main/appShutdown";

describe("Desktop shutdown", () => {
  it("stops renderer windows before collaboration cleanup can dispose its service", async () => {
    const order: string[] = [];
    const preventDefault = vi.fn();
    const requestQuit = vi.fn(() => order.push("quit"));
    const controller = createDesktopShutdownController({
      closeRendererWindows: () => order.push("renderers-closed"),
      cleanupTasks: [
        async () => {
          order.push("collaboration-cleanup");
        }
      ],
      reportError: vi.fn(),
      requestQuit,
      exit: vi.fn()
    });

    controller.handleBeforeQuit({ preventDefault });

    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(order).toEqual(["renderers-closed", "collaboration-cleanup", "quit"]);
  });

  it("starts cleanup once and reports failures before completing the quit", async () => {
    let finishCleanup: (() => void) | undefined;
    const cleanupPending = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const expectedError = new Error("cleanup failed");
    const cleanupTask = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(cleanupPending)
      .mockRejectedValueOnce(expectedError);
    const reportError = vi.fn();
    const requestQuit = vi.fn();
    const firstPreventDefault = vi.fn();
    const repeatedPreventDefault = vi.fn();
    const completedPreventDefault = vi.fn();
    const controller = createDesktopShutdownController({
      closeRendererWindows: vi.fn(),
      cleanupTasks: [cleanupTask, cleanupTask],
      reportError,
      requestQuit,
      exit: vi.fn()
    });

    controller.handleBeforeQuit({ preventDefault: firstPreventDefault });
    controller.handleBeforeQuit({ preventDefault: repeatedPreventDefault });
    await vi.waitFor(() => expect(cleanupTask).toHaveBeenCalledTimes(2));
    expect(requestQuit).not.toHaveBeenCalled();

    finishCleanup?.();
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(repeatedPreventDefault).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expectedError);

    controller.handleBeforeQuit({ preventDefault: completedPreventDefault });
    expect(completedPreventDefault).not.toHaveBeenCalled();
  });
});

it.each([0, 1])("waits for cleanup before exiting smoke with code %i", async (code) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exit = vi.fn();
  const cleanup = vi.fn(() => pending);
  const controller = createDesktopShutdownController({
    closeRendererWindows: vi.fn(),
    cleanupTasks: [cleanup],
    reportError: vi.fn(),
    requestQuit: () => controller.handleBeforeQuit({ preventDefault: vi.fn() }),
    exit
  });
  controller.requestExit(code);
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  expect(exit).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
});

it("fails a successful smoke when shutdown cleanup fails", async () => {
  const exit = vi.fn();
  const error = new Error("cleanup failed");
  const reportError = vi.fn();
  const controller = createDesktopShutdownController({
    closeRendererWindows: vi.fn(),
    cleanupTasks: [
      async () => {
        throw error;
      }
    ],
    reportError,
    requestQuit: () => controller.handleBeforeQuit({ preventDefault: vi.fn() }),
    exit
  });
  controller.requestExit(0);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(reportError).toHaveBeenCalledWith(error);
});
