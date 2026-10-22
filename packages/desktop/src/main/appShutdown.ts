export type DesktopBeforeQuitEvent = {
  preventDefault(): void;
};

export type DesktopShutdownController = {
  handleBeforeQuit(event: DesktopBeforeQuitEvent): void;
  requestExit(code: number): void;
};

export function createDesktopShutdownController(input: {
  closeRendererWindows(): void;
  cleanupTasks: readonly (() => Promise<void>)[];
  reportError(error: unknown): void;
  requestQuit(): void;
  exit(code: number): void;
}): DesktopShutdownController {
  let cleanupStarted = false;
  let cleanupComplete = false;
  let exitCode: number | undefined;
  const reportError = (error: unknown) => {
    if (exitCode !== undefined) exitCode = 1;
    input.reportError(error);
  };

  return {
    requestExit(code) {
      exitCode = Math.max(exitCode ?? 0, code);
      input.requestQuit();
    },
    handleBeforeQuit(event) {
      if (cleanupComplete) return;
      event.preventDefault();
      if (cleanupStarted) return;
      cleanupStarted = true;

      void (async () => {
        try {
          input.closeRendererWindows();
        } catch (error) {
          reportError(error);
        }

        const results = await Promise.allSettled(
          input.cleanupTasks.map((task) => Promise.resolve().then(task))
        );
        for (const result of results) {
          if (result.status === "rejected") reportError(result.reason);
        }

        cleanupComplete = true;
        if (exitCode === undefined) input.requestQuit();
        else input.exit(exitCode);
      })();
    }
  };
}
