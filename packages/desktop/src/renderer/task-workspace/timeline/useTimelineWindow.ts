import { useCallback, useMemo, useState } from "react";
import type { UIEvent } from "react";

export const timelineWindowThreshold = 200;
export const timelineWindowSize = 80;
const timelineRowExtent = 120;
const timelineOverscan = 8;

function clampStart(start: number, count: number): number {
  return Math.max(0, Math.min(start, Math.max(0, count - timelineWindowSize)));
}

export function useTimelineWindow(recordCount: number) {
  const windowed = recordCount > timelineWindowThreshold;
  const [windowStart, setWindowStart] = useState(0);
  const start = windowed ? clampStart(windowStart, recordCount) : 0;
  const end = windowed ? Math.min(recordCount, start + timelineWindowSize) : recordCount;

  const ensureIndexVisible = useCallback(
    (index: number) => {
      if (!windowed) return;
      setWindowStart((current) => {
        const normalized = clampStart(current, recordCount);
        if (index < normalized) return clampStart(index - timelineOverscan, recordCount);
        if (index >= normalized + timelineWindowSize) {
          return clampStart(index - timelineWindowSize + timelineOverscan + 1, recordCount);
        }
        return normalized;
      });
    },
    [recordCount, windowed]
  );

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!windowed) return;
      const visibleStart = Math.floor(event.currentTarget.scrollTop / timelineRowExtent);
      setWindowStart(clampStart(visibleStart - timelineOverscan, recordCount));
    },
    [recordCount, windowed]
  );

  return useMemo(
    () => ({
      afterHeight: windowed ? (recordCount - end) * timelineRowExtent : 0,
      beforeHeight: windowed ? start * timelineRowExtent : 0,
      end,
      ensureIndexVisible,
      onScroll,
      start,
      windowed
    }),
    [end, ensureIndexVisible, onScroll, recordCount, start, windowed]
  );
}
