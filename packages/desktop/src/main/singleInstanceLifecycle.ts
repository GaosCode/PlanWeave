export type SingleInstanceWindow = {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
};

export type SingleInstanceLifecycle = {
  requestLock(): boolean;
  quit(): void;
  onSecondInstance(listener: () => void): void;
  getPrimaryWindow(): SingleInstanceWindow | undefined;
  startPrimary(): void;
};

export function startSingleInstanceLifecycle(lifecycle: SingleInstanceLifecycle): void {
  if (!lifecycle.requestLock()) {
    lifecycle.quit();
    return;
  }

  lifecycle.onSecondInstance(() => {
    const existing = lifecycle.getPrimaryWindow();
    if (!existing) {
      return;
    }
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
  });
  lifecycle.startPrimary();
}
