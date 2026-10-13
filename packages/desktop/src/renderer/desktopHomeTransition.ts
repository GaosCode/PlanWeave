let pendingTransitions = 0;
let settledNotificationQueued = false;
const settledListeners = new Set<() => void>();

function notifySettledTransitions(): void {
  if (pendingTransitions > 0 || settledNotificationQueued) return;
  settledNotificationQueued = true;
  // Watch owners retire registrations later in the same renderer layout commit.
  queueMicrotask(() => {
    settledNotificationQueued = false;
    if (pendingTransitions > 0) return;
    for (const listener of [...settledListeners]) listener();
  });
}

export function beginDesktopHomeTransition(): () => void {
  pendingTransitions += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingTransitions -= 1;
    notifySettledTransitions();
  };
}

export function onDesktopHomeTransitionSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

export function isDesktopHomeTransitionPending(): boolean {
  return pendingTransitions > 0;
}
