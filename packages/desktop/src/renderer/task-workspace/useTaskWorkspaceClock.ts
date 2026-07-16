import { useEffect, useState } from "react";

const DEFAULT_INTERVAL_MS = 1_000;

/**
 * 1 Hz clock for leaves that render live duration/relative labels.
 * The interval runs only while `enabled` is true and is cleared on disable/unmount.
 */
export function useTaskWorkspaceClock(
  enabled: boolean,
  options: { intervalMs?: number } = {}
): number {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return nowMs;
}
